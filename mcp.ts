// MCP (Model Context Protocol) over Streamable HTTP, served at /mcp.
//
// Two protocol eras, matching the suite's client:
//  * modern  2026-07-28 — no handshake: every request declares its revision in
//    `_meta['io.modelcontextprotocol/protocolVersion']` and the
//    `MCP-Protocol-Version` header, and `server/discover` returns identity,
//    capabilities and `supportedVersions` in one request.
//  * legacy  2025-11-25 and earlier — `initialize` (offering a revision) then
//    `notifications/initialized`; a `Mcp-Session-Id` header may be carried.
//
// The tools act on the same in-memory store as the REST and GraphQL surfaces,
// so an object created over MCP is the same object over REST, with stable ids.
// Tools are answered with both a text content block (a JSON string of the
// result) and `structuredContent` (the result object itself).

import { buildCommit, buildTreeFromMap, ident, mergeBase, storeObject, threeWayMerge } from './git.ts';
import { issueJson, pullJson, repoJson } from './rest.ts';
import { globalId, type Issue, type PullRequest, type Repo, type Store } from './store.ts';

export const MCP_SERVER_NAME = 'github-core-clone';
export const MCP_SERVER_VERSION = '1.0.0';
/** Revisions this server speaks, newest first. */
export const MCP_SUPPORTED_VERSIONS: readonly string[] = ['2026-07-28', '2025-11-25'];
const MCP_CURRENT_REVISION = MCP_SUPPORTED_VERSIONS[0]!;

export interface McpHttpAnswer {
  status: number;
  /** JSON text, or '' for a notification (no JSON-RPC response). */
  body: string;
}

type JsonRecord = Record<string, unknown>;
type ToolOutcome = { payload: unknown; isError: boolean };

const isObj = (v: unknown): v is JsonRecord => typeof v === 'object' && v !== null && !Array.isArray(v);

function strArg(v: unknown): string | null {
  return typeof v === 'string' ? v : null;
}

function intArg(v: unknown): number | null {
  if (typeof v === 'number' && Number.isInteger(v)) return v;
  if (typeof v === 'string' && /^\d+$/.test(v)) return Number(v);
  return null;
}

const ok = (payload: unknown): ToolOutcome => ({ payload, isError: false });
const fail = (message: string): ToolOutcome => ({ payload: { error: message, message }, isError: true });

const stringProp = (description: string): JsonRecord => ({ type: 'string', description });
const integerProp = (description: string): JsonRecord => ({ type: 'integer', description });
const booleanProp = (description: string): JsonRecord => ({ type: 'boolean', description });

/** Split owner/repo out of tool arguments (owner+repo, or a full_name "owner/repo"). */
function repoRefOf(args: JsonRecord): { owner: string; repo: string } | null {
  const owner = strArg(args['owner']);
  const repo = strArg(args['repo']);
  if (owner && repo) return { owner, repo };
  const full = strArg(args['full_name']);
  if (full) {
    const slash = full.indexOf('/');
    if (slash > 0) return { owner: full.slice(0, slash), repo: full.slice(slash + 1) };
  }
  return null;
}

function repoOf(store: Store, args: JsonRecord): Repo | null {
  const ref = repoRefOf(args);
  return ref === null ? null : (store.getRepo(ref.owner, ref.repo) ?? null);
}

/** First required argument that is missing or blank, or null when all are present. */
function firstMissing(args: JsonRecord, required: readonly string[]): string | null {
  for (const name of required) {
    const v = args[name];
    if (v === undefined || v === null) return name;
    if (typeof v === 'string' && v.trim() === '') return name;
  }
  return null;
}

function newIssue(store: Store, repo: Repo, title: string, body: string): Issue {
  const number = repo.nextIssue++;
  const now = store.nowIso();
  const issue = {} as Issue;
  issue.number = number;
  issue.id = repo.id * 100000 + number;
  issue.nodeId = globalId('Issue', `${repo.id}:${number}`);
  issue.title = title;
  issue.body = body;
  issue.state = 'open';
  issue.labels = [];
  issue.user = store.viewer.login;
  issue.comments = [];
  issue.createdAt = now;
  issue.updatedAt = now;
  issue.seq = number;
  repo.issues.set(number, issue);
  return issue;
}

function newPull(store: Store, repo: Repo, title: string, body: string, head: string, base: string): PullRequest | { error: string } {
  const headSha = repo.refs.get(`refs/heads/${head}`);
  const baseSha = repo.refs.get(`refs/heads/${base}`);
  if (!headSha || !baseSha) {
    return { error: `Validation Failed: ${headSha ? 'base' : 'head'} branch does not exist` };
  }
  const number = repo.nextPull++;
  const now = store.nowIso();
  const pr = {} as PullRequest;
  pr.number = number;
  pr.id = repo.id * 100000 + number;
  pr.nodeId = globalId('PullRequest', `${repo.id}:${number}`);
  pr.title = title;
  pr.body = body;
  pr.state = 'open';
  pr.merged = false;
  pr.head = head;
  pr.base = base;
  pr.headSha = headSha;
  pr.baseSha = baseSha;
  pr.mergeable = 'UNKNOWN';
  pr.mergeCommitSha = '';
  pr.user = store.viewer.login;
  pr.createdAt = now;
  pr.updatedAt = now;
  pr.seq = number;
  const mb = mergeBase(repo, baseSha, headSha);
  if (mb === null) {
    pr.mergeable = 'CONFLICTING';
  } else {
    pr.mergeable = threeWayMerge(repo, baseSha, headSha, mb).conflicts.length ? 'CONFLICTING' : 'MERGEABLE';
  }
  repo.pulls.set(number, pr);
  return pr;
}

function mergePull(store: Store, repo: Repo, pr: PullRequest): { sha: string } | { error: string } {
  if (pr.merged || pr.state === 'closed') return { error: 'Pull request has already been merged' };
  const baseTip = repo.refs.get(`refs/heads/${pr.base}`) ?? pr.baseSha;
  const headTip = repo.refs.get(`refs/heads/${pr.head}`) ?? pr.headSha;
  const mb = mergeBase(repo, baseTip, headTip);
  if (mb === null) {
    pr.mergeable = 'CONFLICTING';
    return { error: 'Merge conflict' };
  }
  const merged = threeWayMerge(repo, baseTip, headTip, mb);
  if (merged.conflicts.length) {
    pr.mergeable = 'CONFLICTING';
    return { error: 'Merge conflict' };
  }
  const treeOid = buildTreeFromMap(repo, merged.tree);
  const epoch = store.nowSec();
  const author = ident(store.viewer.name, store.viewer.email, epoch);
  const sha = storeObject(
    repo,
    'commit',
    buildCommit({ tree: treeOid, parents: [baseTip], author, committer: author, message: `${pr.title} (#${pr.number})` }),
  );
  repo.refs.set(`refs/heads/${pr.base}`, sha);
  pr.state = 'closed';
  pr.merged = true;
  pr.mergeCommitSha = sha;
  pr.updatedAt = store.nowIso();
  repo.updatedAt = pr.updatedAt;
  return { sha };
}

// ---------------------------------------------------------------- tools

interface ToolSpec {
  name: string;
  description: string;
  props: Array<[string, JsonRecord]>;
  required: string[];
  run: (store: Store, args: JsonRecord, origin: string) => ToolOutcome;
}

function defineTool(
  name: string,
  description: string,
  props: Array<[string, JsonRecord]>,
  required: string[],
  run: (store: Store, args: JsonRecord, origin: string) => ToolOutcome,
): ToolSpec {
  return { name, description, props, required, run };
}

function doCreateRepo(store: Store, args: JsonRecord, origin: string): ToolOutcome {
  const name = strArg(args['name']);
  if (!name) return fail('Missing required argument: name');
  const owner = strArg(args['owner']) ?? store.viewer.login;
  const description = strArg(args['description']) ?? '';
  const isPrivate = args['private'] === true;
  const repo = store.createRepo(owner, name, description, isPrivate);
  if (repo === null) return fail('Repository already exists');
  return ok(repoJson(store, repo, origin));
}

function doGetRepo(store: Store, args: JsonRecord, origin: string): ToolOutcome {
  const repo = repoOf(store, args);
  if (repo === null) return fail('Repository not found');
  return ok(repoJson(store, repo, origin));
}

function doCreateIssue(store: Store, args: JsonRecord, origin: string): ToolOutcome {
  const repo = repoOf(store, args);
  if (repo === null) return fail('Repository not found');
  const title = strArg(args['title']);
  if (!title) return fail('Missing required argument: title');
  const body = strArg(args['body']) ?? '';
  return ok(issueJson(store, repo, newIssue(store, repo, title, body), origin));
}

function doListIssues(store: Store, args: JsonRecord, origin: string): ToolOutcome {
  const repo = repoOf(store, args);
  if (repo === null) return fail('Repository not found');
  const state = strArg(args['state']) ?? 'open';
  let list = [...repo.issues.values()].sort((a, b) => b.seq - a.seq);
  if (state !== 'all') list = list.filter((i) => i.state === state);
  return ok({ issues: list.map((i) => issueJson(store, repo, i, origin)) });
}

function doGetIssue(store: Store, args: JsonRecord, origin: string): ToolOutcome {
  const repo = repoOf(store, args);
  if (repo === null) return fail('Repository not found');
  const number = intArg(args['issue_number']) ?? intArg(args['number']);
  if (number === null) return fail('Missing required argument: issue_number');
  const issue = repo.issues.get(number);
  if (!issue) return fail('Issue not found');
  return ok(issueJson(store, repo, issue, origin));
}

function doListRepos(store: Store, args: JsonRecord, origin: string): ToolOutcome {
  const owner = strArg(args['owner']) ?? store.viewer.login;
  return ok({ repositories: store.reposOf(owner).map((r) => repoJson(store, r, origin)) });
}

function doCreatePull(store: Store, args: JsonRecord, origin: string): ToolOutcome {
  const repo = repoOf(store, args);
  if (repo === null) return fail('Repository not found');
  const title = strArg(args['title']);
  const head = strArg(args['head']);
  const base = strArg(args['base']);
  if (!title) return fail('Missing required argument: title');
  if (!head) return fail('Missing required argument: head');
  if (!base) return fail('Missing required argument: base');
  const body = strArg(args['body']) ?? '';
  const pr = newPull(store, repo, title, body, head, base);
  if ('error' in pr) return fail(pr.error);
  return ok(pullJson(store, repo, pr, origin));
}

function doGetPull(store: Store, args: JsonRecord, origin: string): ToolOutcome {
  const repo = repoOf(store, args);
  if (repo === null) return fail('Repository not found');
  const number = intArg(args['pull_number']) ?? intArg(args['number']);
  if (number === null) return fail('Missing required argument: pull_number');
  const pr = repo.pulls.get(number);
  if (!pr) return fail('Pull request not found');
  return ok(pullJson(store, repo, pr, origin));
}

function doListPulls(store: Store, args: JsonRecord, origin: string): ToolOutcome {
  const repo = repoOf(store, args);
  if (repo === null) return fail('Repository not found');
  const state = strArg(args['state']) ?? 'open';
  let list = [...repo.pulls.values()].sort((a, b) => b.seq - a.seq);
  if (state !== 'all') list = list.filter((p) => p.state === state);
  return ok({ pull_requests: list.map((p) => pullJson(store, repo, p, origin)) });
}

function doMergePull(store: Store, args: JsonRecord, origin: string): ToolOutcome {
  const repo = repoOf(store, args);
  if (repo === null) return fail('Repository not found');
  const number = intArg(args['pull_number']) ?? intArg(args['number']);
  if (number === null) return fail('Missing required argument: pull_number');
  const pr = repo.pulls.get(number);
  if (!pr) return fail('Pull request not found');
  const merged = mergePull(store, repo, pr);
  if ('error' in merged) return fail(merged.error);
  return ok({ ...pullJson(store, repo, pr, origin), sha: merged.sha, message: 'Pull request successfully merged' });
}

const TOOLS: ToolSpec[] = [
  defineTool(
    'create_repo',
    'Create a repository owned by the authenticated user.',
    [
      ['owner', stringProp('Login of the repository owner.')],
      ['name', stringProp('Name of the repository to create.')],
      ['description', stringProp('A short description of the repository.')],
      ['private', booleanProp('Whether the repository is private.')],
      ['full_name', stringProp('Full name "owner/name" of the repository (alternative to owner and name).')],
    ],
    ['name'],
    doCreateRepo,
  ),
  defineTool(
    'get_repo',
    'Get a repository by owner and name.',
    [
      ['owner', stringProp('Login of the repository owner.')],
      ['repo', stringProp('Name of the repository.')],
      ['full_name', stringProp('Full name "owner/name" of the repository (alternative to owner and repo).')],
    ],
    ['owner', 'repo'],
    doGetRepo,
  ),
  defineTool(
    'create_issue',
    'Create an issue in a repository.',
    [
      ['owner', stringProp('Login of the repository owner.')],
      ['repo', stringProp('Name of the repository.')],
      ['full_name', stringProp('Full name "owner/name" of the repository (alternative to owner and repo).')],
      ['title', stringProp('Title of the issue.')],
      ['body', stringProp('Body of the issue.')],
    ],
    ['owner', 'repo', 'title'],
    doCreateIssue,
  ),
  defineTool(
    'list_issues',
    'List issues in a repository.',
    [
      ['owner', stringProp('Login of the repository owner.')],
      ['repo', stringProp('Name of the repository.')],
      ['full_name', stringProp('Full name "owner/name" of the repository (alternative to owner and repo).')],
      ['state', stringProp('Issue state to list: open, closed, or all.')],
    ],
    ['owner', 'repo'],
    doListIssues,
  ),
  defineTool(
    'get_issue',
    'Get a single issue by number.',
    [
      ['owner', stringProp('Login of the repository owner.')],
      ['repo', stringProp('Name of the repository.')],
      ['full_name', stringProp('Full name "owner/name" of the repository (alternative to owner and repo).')],
      ['issue_number', integerProp('Number of the issue.')],
      ['number', integerProp('Number of the issue (alias for issue_number).')],
    ],
    ['owner', 'repo', 'issue_number'],
    doGetIssue,
  ),
  defineTool(
    'list_repos',
    'List repositories owned by a user.',
    [['owner', stringProp('Login of the user whose repositories to list.')]],
    [],
    doListRepos,
  ),
  defineTool(
    'create_pull_request',
    'Create a pull request from a head branch into a base branch.',
    [
      ['owner', stringProp('Login of the repository owner.')],
      ['repo', stringProp('Name of the repository.')],
      ['full_name', stringProp('Full name "owner/name" of the repository (alternative to owner and repo).')],
      ['title', stringProp('Title of the pull request.')],
      ['body', stringProp('Body of the pull request.')],
      ['head', stringProp('Name of the head branch.')],
      ['base', stringProp('Name of the base branch.')],
    ],
    ['owner', 'repo', 'title', 'head', 'base'],
    doCreatePull,
  ),
  defineTool(
    'get_pull_request',
    'Get a single pull request by number.',
    [
      ['owner', stringProp('Login of the repository owner.')],
      ['repo', stringProp('Name of the repository.')],
      ['full_name', stringProp('Full name "owner/name" of the repository (alternative to owner and repo).')],
      ['pull_number', integerProp('Number of the pull request.')],
      ['number', integerProp('Number of the pull request (alias for pull_number).')],
    ],
    ['owner', 'repo', 'pull_number'],
    doGetPull,
  ),
  defineTool(
    'list_pull_requests',
    'List pull requests in a repository.',
    [
      ['owner', stringProp('Login of the repository owner.')],
      ['repo', stringProp('Name of the repository.')],
      ['full_name', stringProp('Full name "owner/name" of the repository (alternative to owner and repo).')],
      ['state', stringProp('Pull request state to list: open, closed, or all.')],
    ],
    ['owner', 'repo'],
    doListPulls,
  ),
  defineTool(
    'merge_pull_request',
    'Merge a pull request with a squash commit onto its base branch.',
    [
      ['owner', stringProp('Login of the repository owner.')],
      ['repo', stringProp('Name of the repository.')],
      ['full_name', stringProp('Full name "owner/name" of the repository (alternative to owner and repo).')],
      ['pull_number', integerProp('Number of the pull request to merge.')],
      ['number', integerProp('Number of the pull request (alias for pull_number).')],
    ],
    ['owner', 'repo', 'pull_number'],
    doMergePull,
  ),
];

/** One tool as `tools/list` answers it. Built once, serialized identically every call. */
const TOOLS_LIST = TOOLS.map((t) => {
  const schema: Record<string, unknown> = {};
  schema.type = 'object';
  schema.properties = Object.fromEntries(t.props);
  schema.required = t.required;
  const entry: Record<string, unknown> = {};
  entry.name = t.name;
  entry.description = t.description;
  entry.inputSchema = schema;
  return entry;
});

// ---------------------------------------------------------------- JSON-RPC plumbing

function rpcResult(id: unknown, result: unknown): string {
  return JSON.stringify({ jsonrpc: '2.0', id, result });
}

function rpcError(id: unknown, code: number, message: string, data?: unknown): string {
  const error: JsonRecord = { code, message };
  if (data !== undefined) error['data'] = data;
  return JSON.stringify({ jsonrpc: '2.0', id, error });
}

/** Try to recover a JSON-RPC id from a malformed body, so the parse error names it. */
function idFromRaw(raw: string): unknown {
  const m = /"id"\s*:\s*(-?\d+|"[^"\\]*(?:\\.[^"\\]*)*")/.exec(raw);
  if (m === null) return null;
  try {
    return JSON.parse(m[1]!);
  } catch {
    return null;
  }
}

const serverInfo = (): JsonRecord => ({ name: MCP_SERVER_NAME, version: MCP_SERVER_VERSION });
const capabilities = (): JsonRecord => ({ tools: {} });

/** Normalize a tool name: strip a `prefix__` namespace and compare case-insensitively. */
function normalizeToolName(name: string): string {
  const bare = name.includes('__') ? name.slice(name.lastIndexOf('__') + 2) : name;
  return bare.toLowerCase().replace(/[^a-z0-9]/g, '');
}

function findTool(name: string): ToolSpec | null {
  const wanted = normalizeToolName(name);
  for (const tool of TOOLS) {
    if (normalizeToolName(tool.name) === wanted) return tool;
  }
  return null;
}

function errorResult(id: unknown, text: string): McpHttpAnswer {
  return {
    status: 200,
    body: rpcResult(id, {
      content: [{ type: 'text', text }],
      structuredContent: { error: text, message: text },
      isError: true,
    }),
  };
}

/**
 * Handle one POST /mcp body. Auth is decided by the caller before this runs.
 * Returns the HTTP status and the JSON response text ('' for a notification).
 */
export function handleMcp(store: Store, rawBody: string, origin: string): McpHttpAnswer {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody);
  } catch {
    // A body that is not JSON: HTTP 400 with JSON-RPC -32700 (2026-07-28 transport).
    return { status: 400, body: rpcError(idFromRaw(rawBody), -32700, 'Parse error') };
  }
  if (!isObj(parsed)) {
    return { status: 400, body: rpcError(null, -32600, 'Invalid Request') };
  }
  const id = parsed['id'];
  const method = parsed['method'];
  const params = isObj(parsed['params']) ? parsed['params'] : {};

  if (typeof method !== 'string') {
    return { status: 200, body: rpcError(id ?? null, -32600, 'Invalid Request') };
  }

  if (method === 'notifications/initialized' || method.startsWith('notifications/')) {
    // A notification has no id and no JSON-RPC response.
    return { status: 200, body: '' };
  }

  if (method === 'server/discover') {
    return {
      status: 200,
      body: rpcResult(id, {
        protocolVersion: MCP_CURRENT_REVISION,
        supportedVersions: [...MCP_SUPPORTED_VERSIONS],
        capabilities: capabilities(),
        serverInfo: serverInfo(),
        _meta: { 'io.modelcontextprotocol/serverInfo': serverInfo() },
      }),
    };
  }

  if (method === 'initialize') {
    const offered = strArg(params['protocolVersion']);
    const known = (MCP_SUPPORTED_VERSIONS as readonly string[]).includes(offered ?? '');
    const negotiated = offered !== null && known ? offered : MCP_CURRENT_REVISION;
    return {
      status: 200,
      body: rpcResult(id, { protocolVersion: negotiated, capabilities: capabilities(), serverInfo: serverInfo() }),
    };
  }

  if (method === 'ping') {
    return { status: 200, body: rpcResult(id, {}) };
  }

  if (method === 'tools/list') {
    return { status: 200, body: rpcResult(id, { tools: TOOLS_LIST }) };
  }

  if (method === 'tools/call') {
    const name = strArg(params['name']);
    if (name === null) {
      return { status: 200, body: rpcError(id, -32602, 'Invalid params: tools/call requires a tool name') };
    }
    const tool = findTool(name);
    if (tool === null) {
      return { status: 200, body: rpcError(id, -32602, `Unknown tool: ${name}`) };
    }
    const args = isObj(params['arguments']) ? params['arguments'] : {};
    const missing = firstMissing(args, tool.required);
    if (missing !== null) {
      return errorResult(id, `Missing required argument: ${missing}`);
    }
    try {
      const outcome = tool.run(store, args, origin);
      const text = typeof outcome.payload === 'string' ? outcome.payload : JSON.stringify(outcome.payload);
      return {
        status: 200,
        body: rpcResult(id, {
          content: [{ type: 'text', text }],
          structuredContent: outcome.payload,
          isError: outcome.isError,
        }),
      };
    } catch (error) {
      const text = error instanceof Error ? error.message : String(error);
      return {
        status: 200,
        body: rpcResult(id, {
          content: [{ type: 'text', text: `Tool error: ${text}` }],
          structuredContent: { error: text, message: text },
          isError: true,
        }),
      };
    }
  }

  return { status: 200, body: rpcError(id, -32601, `Method not found: ${method}`) };
}
