// The forge's HTTP server: one Node process serving all four surfaces.
//
//   GET  /healthz                    the env's boot probe: 200 {"ok":true}
//   git  /{owner}/{repo}.git/*       smart HTTP (upload-pack v2/v0, receive-pack v0)
//   REST /api/v3/*                   GitHub REST v3
//   GQL  /api/graphql               GraphQL (single documents and batches)
//   MCP  /mcp                       Model Context Protocol over Streamable HTTP
//
// Every API call carries `Authorization: Bearer <MAKEFUN_SHOP_TOKEN>`; a
// request without the token, or with the wrong one, is 401. /healthz is the
// only unauthenticated route. Every REST reply is application/json and
// carries a non-empty X-GitHub-Request-Id header; a malformed JSON body is
// 400; an unknown route is a 404 JSON body with a string message.
//
// The store is in-memory and deterministic: no wall clock in state, no
// unseeded randomness. Request ids are a per-process counter, so the same
// request sequence answers the same ids on every run.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import {
  advertiseV0,
  advertiseV2,
  handleFetchV0,
  handleFetchV2,
  handleLsRefs,
  handleReceivePack,
  parsePktLines,
  pushReport,
  splitPktSection,
  type FetchArgs,
  type LsRefsArg,
  type PushCommand,
} from './git.ts';
import { handleGraphQL } from './graphql.ts';
import { handleMcp } from './mcp.ts';
import { handleRest } from './rest.ts';
import { Store, type Repo } from './store.ts';

const JSON_TYPE = 'application/json; charset=utf-8';
/** The one empty query-parameter set, shared by every query-less request. */
const EMPTY_PARAMS = new URLSearchParams();
/** A request body larger than this is refused outright (no push in the suite is near it). */
const MAX_BODY_BYTES = 64 * 1024 * 1024;

/** The token this process's env gave it; the suite presents it as a bearer token. */
function shopToken(): string {
  return process.env.MAKEFUN_SHOP_TOKEN ?? '';
}

/** The origin a request reached us on, for absolute URLs in REST bodies. */
function originOf(req: IncomingMessage): string {
  const host = req.headers.host ?? '127.0.0.1';
  return `http://${host}`;
}

/**
 * Split a request target into its path and raw query string without building
 * a URL object: the router only needs the path, and only the REST branch
 * ever needs parsed query parameters.
 */
function splitTarget(req: IncomingMessage): { path: string; query: string } {
  const raw = req.url ?? '/';
  const q = raw.indexOf('?');
  if (q < 0) return { path: raw === '' ? '/' : raw, query: '' };
  return { path: raw.slice(0, q) === '' ? '/' : raw.slice(0, q), query: raw.slice(q + 1) };
}

/** One query parameter out of a raw query string, or null. */
function queryValue(query: string, name: string): string | null {
  if (query === '') return null;
  const want = `${name}=`;
  for (const part of query.split('&')) {
    if (part.startsWith(want)) return decodeURIComponent(part.slice(want.length));
  }
  return null;
}

/** Whether this request carries the shop token. With no token configured (local dev only), any non-empty bearer token is accepted. */
function authorized(req: IncomingMessage, token: string): boolean {
  const header = req.headers.authorization ?? '';
  if (token === '') return header.startsWith('Bearer ') && header.length > 7;
  return header === `Bearer ${token}`;
}

/** Read the whole request body, or null when it is over the limit. A body
 * that arrives in one chunk — every small REST or pkt-line body — is
 * returned as that chunk, with no array and no concat. */
function readBody(req: IncomingMessage): Promise<Buffer | null> {
  return new Promise((resolve) => {
    let first: Buffer | null = null;
    const chunks: Buffer[] = [];
    let size = 0;
    let tooBig = false;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        tooBig = true;
        return;
      }
      if (first === null && chunks.length === 0) first = chunk;
      else chunks.push(chunk);
    });
    req.on('end', () => {
      if (tooBig) {
        resolve(null);
        return;
      }
      if (chunks.length === 0) {
        resolve(first ?? Buffer.alloc(0));
        return;
      }
      if (first !== null) chunks.unshift(first);
      resolve(Buffer.concat(chunks));
    });
    req.on('error', () => resolve(Buffer.alloc(0)));
  });
}

/** Parse a JSON body; returns { ok: false } when the bytes are not JSON. */
function parseJsonBody(raw: Buffer): { ok: true; value: unknown } | { ok: false } {
  if (raw.length === 0) return { ok: true, value: null };
  try {
    return { ok: true, value: JSON.parse(raw.toString('utf8')) };
  } catch {
    return { ok: false };
  }
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Parse one pkt-line payload as a text line (without its trailing newline). */
function pktText(line: Buffer): string {
  return line.toString('utf8').replace(/\n$/, '');
}

const OID_RE = /^[0-9a-f]{40}$/;

/** Collect want/have/shallow/deepen/filter arguments out of parsed pkt-lines. */
function fetchArgsOf(lines: Array<Buffer | 'flush' | 'delim'>): FetchArgs {
  const args: FetchArgs = { wants: [], haves: [], shallow: [] };
  for (const item of lines) {
    if (item === 'flush' || item === 'delim') continue;
    const line = pktText(item);
    if (line.startsWith('want ')) {
      const oid = line.slice(5, 45);
      if (OID_RE.test(oid)) args.wants.push(oid);
    } else if (line.startsWith('have ')) {
      const oid = line.slice(5, 45);
      if (OID_RE.test(oid)) args.haves.push(oid);
    } else if (line.startsWith('shallow ')) {
      const oid = line.slice(8, 48);
      if (OID_RE.test(oid)) args.shallow.push(oid);
    } else if (line.startsWith('deepen ')) {
      const n = Number(line.slice(7).trim());
      if (Number.isInteger(n) && n > 0) args.depth = n;
    } else if (line.startsWith('deepen-since ')) {
      const n = Number(line.slice(12).trim());
      if (Number.isInteger(n) && n > 0) args.deepenSince = n;
    } else if (line.startsWith('filter ')) {
      args.filter = line.slice(7).trim();
    }
  }
  return args;
}

/** Parse a v2 ls-refs request body into its arguments. */
function lsRefsArgsOf(lines: Array<Buffer | 'flush' | 'delim'>): LsRefsArg {
  const args: LsRefsArg = { peel: false, symrefs: false, unborn: false, prefixes: [] };
  for (const item of lines) {
    if (item === 'flush' || item === 'delim') continue;
    const line = pktText(item);
    if (line === 'peel') args.peel = true;
    else if (line === 'symref' || line === 'symrefs') args.symrefs = true;
    else if (line === 'unborn') args.unborn = true;
    else if (line.startsWith('ref-prefix ')) args.prefixes.push(line.slice('ref-prefix '.length));
  }
  return args;
}

/** Parse receive-pack command lines (the first may carry NUL + capabilities). */
function pushCommandsOf(lines: Array<Buffer | 'flush' | 'delim'>): PushCommand[] {
  const commands: PushCommand[] = [];
  for (const item of lines) {
    if (item === 'flush' || item === 'delim') continue;
    const raw = pktText(item);
    const line = raw.split('\0')[0]!;
    const parts = line.split(' ');
    if (parts.length !== 3) continue;
    const [oldOid, newOid, ref] = parts as [string, string, string];
    if (!OID_RE.test(oldOid) || !OID_RE.test(newOid) || !ref.startsWith('refs/')) continue;
    commands.push({ oldOid, newOid, ref });
  }
  return commands;
}

/**
 * A fetch's answer, keyed by everything that determines it. Objects are
 * content-addressed and only ever added, refs only ever move, so a
 * fingerprint of (object count, every ref tip) changes on any mutation that
 * could change a pack: the same fingerprint + the same fetch arguments always
 * build the same bytes. This makes fifty concurrent identical clones pay for
 * one pack build instead of fifty. Bounded: the oldest entries are dropped
 * when it grows past 32, so a long trial cannot grow it without limit.
 */
function repoFingerprint(repo: Repo): string {
  const names = [...repo.refs.keys()].sort();
  let fp = `${repo.objects.size}|`;
  for (const name of names) fp += `${name}=${repo.refs.get(name)},`;
  return fp;
}

/** The fetch cache key, built by plain string joins (no JSON.stringify of the args object). */
function fetchKey(version: 'v2' | 'v0', owner: string, repoName: string, repo: Repo, args: FetchArgs): string {
  return (
    `${version}|${owner}/${repoName}|${repoFingerprint(repo)}` +
    `|w:${args.wants.join(',')}|h:${args.haves.join(',')}|s:${args.shallow.join(',')}` +
    `|d:${args.depth ?? ''}|f:${args.filter ?? ''}`
  );
}

/** Build the server. It binds nothing until the caller listens; the entry listens on an ephemeral port. */
export function createApp(): Server {
  const store = new Store(shopToken());
  const token = store.token;
  let requestSeq = 0;
  const fetchCache = new Map<string, Buffer>();
  // Advertisements and ls-refs answers are pure functions of the repo's
  // fingerprint too (refs only ever move, objects only ever arrive), so they
  // share the fetch cache's invalidation story: same fingerprint, same bytes.
  // Bounded the same way, so a long trial cannot grow them without limit.
  const advertCache = new Map<string, Buffer>();
  const lsRefsCache = new Map<string, Buffer>();
  const cachedAdvert = (key: string, build: () => Buffer): Buffer => {
    const hit = advertCache.get(key);
    if (hit !== undefined) return hit;
    const built = build();
    if (advertCache.size >= 32) advertCache.clear();
    advertCache.set(key, built);
    return built;
  };

  const requestId = (): string => {
    requestSeq += 1;
    return `req-${requestSeq.toString(16).padStart(8, '0')}`;
  };

  function sendJson(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}, rawBody?: Buffer): void {
    if (rawBody !== undefined) {
      res.writeHead(status, {
        'content-type': JSON_TYPE,
        'content-length': rawBody.length,
        'x-github-request-id': requestId(),
        ...headers,
      });
      res.end(rawBody);
      return;
    }
    const text = `${JSON.stringify(body)}\n`;
    res.writeHead(status, {
      'content-type': JSON_TYPE,
      'content-length': Buffer.byteLength(text),
      'x-github-request-id': requestId(),
      ...headers,
    });
    res.end(text);
  }

  function sendRaw(res: ServerResponse, status: number, body: Buffer, contentType: string, headers: Record<string, string> = {}): void {
    res.writeHead(status, {
      'content-type': contentType,
      'content-length': body.length,
      'x-github-request-id': requestId(),
      ...headers,
    });
    res.end(body);
  }

  function sendText(res: ServerResponse, status: number, body: string, contentType = JSON_TYPE): void {
    res.writeHead(status, {
      'content-type': contentType,
      'content-length': Buffer.byteLength(body),
      'x-github-request-id': requestId(),
    });
    res.end(body);
  }

  return createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      const { path, query } = splitTarget(req);
      const method = req.method ?? 'GET';
      const origin = originOf(req);

      try {
        // The env's boot check calls this twice: 200 {"ok":true}. No auth.
        if (method === 'GET' && path === '/healthz') {
          sendJson(res, 200, { ok: true });
          return;
        }

        if (!authorized(req, token)) {
          sendJson(res, 401, { message: 'Bad credentials', documentation_url: 'https://docs.github.com/rest' });
          return;
        }

        // GET and HEAD carry no body: answer without waiting for the stream
        // to end. Anything else reads the whole body first.
        const rawBody = method === 'GET' || method === 'HEAD' ? Buffer.alloc(0) : await readBody(req);
        if (rawBody === null) {
          sendJson(res, 413, { message: 'Request body too large' });
          return;
        }

        const segments = path.split('/').filter((s) => s !== '');

        // ---- MCP: POST /mcp (JSON-RPC), DELETE /mcp (close a legacy session).
        if (path === '/mcp') {
          if (method === 'DELETE') {
            res.writeHead(204, { 'x-github-request-id': requestId() });
            res.end();
            return;
          }
          if (method !== 'POST') {
            sendJson(res, 405, { message: 'Method Not Allowed' });
            return;
          }
          const answer = handleMcp(store, rawBody.toString('utf8'), origin);
          if (answer.body === '') {
            // A notification: no JSON-RPC response, just 200.
            res.writeHead(200, { 'x-github-request-id': requestId() });
            res.end();
            return;
          }
          sendText(res, answer.status, answer.body);
          return;
        }

        // ---- GraphQL: POST /api/graphql (a document, or a batch array).
        if (path === '/api/graphql') {
          if (method !== 'POST') {
            sendJson(res, 405, { message: 'Method Not Allowed' });
            return;
          }
          const parsed = parseJsonBody(rawBody);
          if (!parsed.ok) {
            sendJson(res, 400, { message: 'Problems parsing JSON' });
            return;
          }
          const { status, payload } = handleGraphQL(store, parsed.value);
          sendJson(res, status, payload);
          return;
        }

        // ---- REST v3: /api/v3/*
        if (segments[0] === 'api' && segments[1] === 'v3') {
          const restSegments = segments.slice(2);
          let body: Record<string, unknown> | null = null;
          if (method === 'POST' || method === 'PUT' || method === 'PATCH' || method === 'DELETE') {
            const parsed = parseJsonBody(rawBody);
            if (!parsed.ok) {
              sendJson(res, 400, { message: 'Problems parsing JSON' });
              return;
            }
            body = isRecord(parsed.value) ? parsed.value : null;
          }
          // An empty query string needs no parser: most REST calls carry none.
          const params = query === '' ? EMPTY_PARAMS : new URLSearchParams(query);
          const answer = handleRest(store, method, restSegments, params, body, origin, `${origin}${path}`);
          sendJson(res, answer.status, answer.body, answer.headers ?? {}, answer.rawBody);
          return;
        }

        // ---- Git smart HTTP: /{owner}/{repo}.git/*
        if (segments.length >= 2 && segments[1]!.endsWith('.git')) {
          const owner = segments[0]!;
          const repoName = segments[1]!.slice(0, -'.git'.length);
          const repo = store.getRepo(owner, repoName);
          if (repo === undefined) {
            sendJson(res, 404, { message: 'Not Found' });
            return;
          }
          const gitPath = segments.slice(2);

          // GET /{owner}/{repo}.git/info/refs?service=...
          if (method === 'GET' && gitPath[0] === 'info' && gitPath[1] === 'refs') {
            const service = queryValue(query, 'service') ?? 'git-upload-pack';
            if (service === 'git-receive-pack') {
              sendRaw(res, 200, cachedAdvert(`rp|${repoFingerprint(repo)}`, () => advertiseV0(repo, 'git-receive-pack')), 'application/x-git-receive-pack-advertisement');
              return;
            }
            if (service === 'git-upload-pack') {
              if ((req.headers['git-protocol'] ?? '') === 'version=2') {
                sendRaw(res, 200, advertiseV2(), 'application/x-git-upload-pack-advertisement');
              } else {
                sendRaw(res, 200, cachedAdvert(`up|${repoFingerprint(repo)}`, () => advertiseV0(repo, 'git-upload-pack')), 'application/x-git-upload-pack-advertisement');
              }
              return;
            }
            sendJson(res, 400, { message: 'Invalid service' });
            return;
          }

          // POST /{owner}/{repo}.git/git-upload-pack
          if (method === 'POST' && gitPath[0] === 'git-upload-pack') {
            let lines: Array<Buffer | 'flush' | 'delim'>;
            try {
              lines = parsePktLines(rawBody);
            } catch {
              // A malformed pkt-line must not crash the server.
              sendJson(res, 400, { message: 'Invalid pkt-line' });
              return;
            }
            const first = lines[0];
            const firstLine = first !== undefined && first !== 'flush' && first !== 'delim' ? pktText(first) : '';
            const resultType = 'application/x-git-upload-pack-result';
            if (firstLine === 'command=ls-refs') {
              const lsArgs = lsRefsArgsOf(lines);
              const lsKey = `ls|${repoFingerprint(repo)}|p:${lsArgs.peel ? 1 : 0}|s:${lsArgs.symrefs ? 1 : 0}|u:${lsArgs.unborn ? 1 : 0}|x:${lsArgs.prefixes.join(',')}`;
              const lsHit = lsRefsCache.get(lsKey);
              if (lsHit !== undefined) {
                sendRaw(res, 200, lsHit, resultType);
                return;
              }
              const lsBuilt = handleLsRefs(repo, lsArgs);
              if (lsRefsCache.size >= 32) lsRefsCache.clear();
              lsRefsCache.set(lsKey, lsBuilt);
              sendRaw(res, 200, lsBuilt, resultType);
              return;
            }
            // A fetch's bytes are a pure function of the fetch arguments and
            // the repo's fingerprint (see repoFingerprint): identical
            // concurrent clones share one pack build.
            const fetch = (version: 'v2' | 'v0', args: FetchArgs): Buffer => {
              const key = fetchKey(version, owner, repoName, repo, args);
              const hit = fetchCache.get(key);
              if (hit !== undefined) return hit;
              const built = version === 'v2' ? handleFetchV2(repo, args) : handleFetchV0(repo, args);
              if (fetchCache.size >= 32) fetchCache.clear();
              fetchCache.set(key, built);
              return built;
            };
            if (firstLine === 'command=fetch') {
              sendRaw(res, 200, fetch('v2', fetchArgsOf(lines)), resultType);
              return;
            }
            // Anything else is a v0 fetch: want/have/shallow/deepen across both sections.
            sendRaw(res, 200, fetch('v0', fetchArgsOf(lines)), resultType);
            return;
          }

          // POST /{owner}/{repo}.git/git-receive-pack
          if (method === 'POST' && gitPath[0] === 'git-receive-pack') {
            let section: { lines: Array<Buffer | 'flush' | 'delim'>; rest: Buffer };
            try {
              section = splitPktSection(rawBody);
            } catch {
              sendJson(res, 400, { message: 'Invalid pkt-line' });
              return;
            }
            const commands = pushCommandsOf(section.lines);
            const pack = section.rest.length > 0 ? section.rest : null;
            const outcome = handleReceivePack(repo, commands, pack);
            sendRaw(res, 200, pushReport(outcome), 'application/x-git-receive-pack-result');
            return;
          }

          sendJson(res, 404, { message: 'Not Found' });
          return;
        }

        // Everything else, every method: GitHub's 404 body.
        sendJson(res, 404, { message: 'Not Found' });
      } catch (err) {
        // No request ever crashes the server: answer 500 and keep serving.
        if (!res.headersSent) {
          sendJson(res, 500, { message: err instanceof Error ? err.message : 'Internal Server Error' });
        } else {
          res.end();
        }
      }
    })();
  });
}
