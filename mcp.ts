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

function isRecord(v: unknown): v is JsonRecord {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function asString(v: unknown): string | null {
  return typeof v === 'string' ? v : null;
}

function asNumber(v: unknown): number | null {
  if (typeof v === 'number' && Number.isInteger(v)) return v;
  if (typeof v === 'string' && /^\d+$/.test(v)) return Number(v);
  return null;
}

/** One tool as `tools/list` answers it. Built once, serialized identically every call. */
interface McpToolDef {
  name: string;
  description: string;
  inputSchema: { type: 'object'; properties: Record<string, JsonRecord>; required: string[] };
  run: (store: Store, args: JsonRecord, origin: string) => { payload: unknown; isError: boolean };
}

const strProp = (description: string): JsonRecord => ({ type: 'string', description });
const intProp = (description: string): JsonRecord => ({ type: 'integer', description });
const boolProp = (description: string): JsonRecord => ({ type: 'boolean', description });

function toolResult(payload: unknown, isError = false): { payload: unknown; isError: boolean } {
  return { payload, isError };
}

function toolError(message: string): { payload: unknown; isError: boolean } {
  return { payload: { error: message, message }, isError: true };
}

/** Resolve owner/repo from tool arguments (owner+repo, or a full_name "owner/repo"). */
function resolveRepoRef(args: JsonRecord): { owner: string; repo: string } | null {
  const owner = asString(args['owner']);
  const repo = asString(args['repo']);
  if (owner && repo) return { owner, repo };
  const full = asString(args['full_name']);
  if (full) {
    const slash = full.indexOf('/');
    if (slash > 0) return { owner: full.slice(0, slash), repo: full.slice(slash + 1) };
  }
  return null;
}

function findRepo(store: Store, args: JsonRecord): Repo | null {
  const ref = resolveRepoRef(args);
  if (ref === null) return null;
  return store.getRepo(ref.owner, ref.repo) ?? null;
}

function missingArg(args: JsonRecord, required: string[]): string | null {
  for (const name of required) {
    const v = args[name];
    if (v === undefined || v === null || (typeof v === 'string' && v.trim() === '')) return name;
  }
  return null;
}

function createIssueRecord(store: Store, repo: Repo, title: string, body: string): Issue {
  const number = repo.nextIssue++;
  const now = store.nowIso();
  const issue: Issue = {
    number,
    id: repo.id * 100000 + number,
    nodeId: globalId('Issue', `${repo.id}:${number}`),
    title,
    body,
    state: 'open',
    labels: [],
    user: store.viewer.login,
    comments: [],
    createdAt: now,
    updatedAt: now,
    seq: number,
  };
  repo.issues.set(number, issue);
  return issue;
}

function createPullRecord(store: Store, repo: Repo, title: string, body: string, head: string, base: string): PullRequest | { error: string } {
  const headSha = repo.refs.get(`refs/heads/${head}`);
  const baseSha = repo.refs.get(`refs/heads/${base}`);
  if (!headSha || !baseSha) return { error: `Validation Failed: ${headSha ? 'base' : 'head'} branch does not exist` };
  const number = repo.nextPull++;
  const now = store.nowIso();
  const pr: PullRequest = {
    number,
    id: repo.id * 100000 + number,
    nodeId: globalId('PullRequest', `${repo.id}:${number}`),
    title,
    body,
    state: 'open',
    merged: false,
    head,
    base,
    headSha,
    baseSha,
    mergeable: 'UNKNOWN',
    mergeCommitSha: '',
    user: store.viewer.login,
    createdAt: now,
    updatedAt: now,
    seq: number,
  };
  const mb = mergeBase(repo, baseSha, headSha);
  pr.mergeable = mb === null ? 'CONFLICTING' : threeWayMerge(repo, baseSha, headSha, mb).conflicts.length ? 'CONFLICTING' : 'MERGEABLE';
  repo.pulls.set(number, pr);
  return pr;
}

function mergePullRecord(store: Store, repo: Repo, pr: PullRequest): { sha: string } | { error: string } {
  if (pr.merged || pr.state === 'closed') return { error: 'Pull request has already been merged' };
  const baseTip = repo.refs.get(`refs/heads/${pr.base}`) ?? pr.baseSha;
  const headTip = repo.refs.get(`refs/heads/${pr.head}`) ?? pr.headSha;
  const mb = mergeBase(repo, baseTip, headTip);
  if (mb === null) {
    pr.mergeable = 'CONFLICTING';
    return { error: 'Merge conflict' };
  }
  const { tree, conflicts } = threeWayMerge(repo, baseTip, headTip, mb);
  if (conflicts.length) {
    pr.mergeable = 'CONFLICTING';
    return { error: 'Merge conflict' };
  }
  const treeOid = buildTreeFromMap(repo, tree);
  const epoch = store.nowSec();
  const author = ident(store.viewer.name, store.viewer.email, epoch);
  const sha = storeObject(repo, 'commit', buildCommit({ tree: treeOid, parents: [baseTip], author, committer: author, message: `${pr.title} (#${pr.number})` }));
  repo.refs.set(`refs/heads/${pr.base}`, sha);
  pr.state = 'closed';
  pr.merged = true;
  pr.mergeCommitSha = sha;
  pr.updatedAt = store.nowIso();
  repo.updatedAt = pr.updatedAt;
  return { sha };
}

const TOOLS: McpToolDef[] = [
  {
    name: 'create_repo',
    description: 'Create a repository owned by the authenticated user.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: strProp('Login of the repository owner.'),
        name: strProp('Name of the repository to create.'),
        description: strProp('A short description of the repository.'),
        private: boolProp('Whether the repository is private.'),
        full_name: strProp('Full name "owner/name" of the repository (alternative to owner and name).'),
      },
      required: ['name'],
    },
    run(store, args, origin) {
      const name = asString(args['name']);
      if (!name) return toolError('Missing required argument: name');
      const owner = asString(args['owner']) ?? store.viewer.login;
      const description = asString(args['description']) ?? '';
      const isPrivate = args['private'] === true;
      const repo = store.createRepo(owner, name, description, isPrivate);
      if (repo === null) return toolError('Repository already exists');
      return toolResult(repoJson(store, repo, origin));
    },
  },
  {
    name: 'get_repo',
    description: 'Get a repository by owner and name.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: strProp('Login of the repository owner.'),
        repo: strProp('Name of the repository.'),
        full_name: strProp('Full name "owner/name" of the repository (alternative to owner and repo).'),
      },
      required: ['owner', 'repo'],
    },
    run(store, args, origin) {
      const repo = findRepo(store, args);
      if (repo === null) return toolError('Repository not found');
      return toolResult(repoJson(store, repo, origin));
    },
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: strProp('Login of the repository owner.'),
        repo: strProp('Name of the repository.'),
        full_name: strProp('Full name "owner/name" of the repository (alternative to owner and repo).'),
        title: strProp('Title of the issue.'),
        body: strProp('Body of the issue.'),
      },
      required: ['owner', 'repo', 'title'],
    },
    run(store, args, origin) {
      const repo = findRepo(store, args);
      if (repo === null) return toolError('Repository not found');
      const title = asString(args['title']);
      if (!title) return toolError('Missing required argument: title');
      const body = asString(args['body']) ?? '';
      const issue = createIssueRecord(store, repo, title, body);
      return toolResult(issueJson(store, repo, issue, origin));
    },
  },
  {
    name: 'list_issues',
    description: 'List issues in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: strProp('Login of the repository owner.'),
        repo: strProp('Name of the repository.'),
        full_name: strProp('Full name "owner/name" of the repository (alternative to owner and repo).'),
        state: strProp('Issue state to list: open, closed, or all.'),
      },
      required: ['owner', 'repo'],
    },
    run(store, args, origin) {
      const repo = findRepo(store, args);
      if (repo === null) return toolError('Repository not found');
      const state = asString(args['state']) ?? 'open';
      let all = [...repo.issues.values()].sort((a, b) => b.seq - a.seq);
      if (state !== 'all') all = all.filter((i) => i.state === state);
      return toolResult({ issues: all.map((i) => issueJson(store, repo, i, origin)) });
    },
  },
  {
    name: 'get_issue',
    description: 'Get a single issue by number.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: strProp('Login of the repository owner.'),
        repo: strProp('Name of the repository.'),
        full_name: strProp('Full name "owner/name" of the repository (alternative to owner and repo).'),
        issue_number: intProp('Number of the issue.'),
        number: intProp('Number of the issue (alias for issue_number).'),
      },
      required: ['owner', 'repo', 'issue_number'],
    },
    run(store, args, origin) {
      const repo = findRepo(store, args);
      if (repo === null) return toolError('Repository not found');
      const number = asNumber(args['issue_number']) ?? asNumber(args['number']);
      if (number === null) return toolError('Missing required argument: issue_number');
      const issue = repo.issues.get(number);
      if (!issue) return toolError('Issue not found');
      return toolResult(issueJson(store, repo, issue, origin));
    },
  },
  {
    name: 'list_repos',
    description: 'List repositories owned by a user.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: strProp('Login of the user whose repositories to list.'),
      },
      required: [],
    },
    run(store, args, origin) {
      const owner = asString(args['owner']) ?? store.viewer.login;
      const repos = store.reposOf(owner);
      return toolResult({ repositories: repos.map((r) => repoJson(store, r, origin)) });
    },
  },
  {
    name: 'create_pull_request',
    description: 'Create a pull request from a head branch into a base branch.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: strProp('Login of the repository owner.'),
        repo: strProp('Name of the repository.'),
        full_name: strProp('Full name "owner/name" of the repository (alternative to owner and repo).'),
        title: strProp('Title of the pull request.'),
        body: strProp('Body of the pull request.'),
        head: strProp('Name of the head branch.'),
        base: strProp('Name of the base branch.'),
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
    },
    run(store, args, origin) {
      const repo = findRepo(store, args);
      if (repo === null) return toolError('Repository not found');
      const title = asString(args['title']);
      const head = asString(args['head']);
      const base = asString(args['base']);
      if (!title) return toolError('Missing required argument: title');
      if (!head) return toolError('Missing required argument: head');
      if (!base) return toolError('Missing required argument: base');
      const body = asString(args['body']) ?? '';
      const pr = createPullRecord(store, repo, title, body, head, base);
      if ('error' in pr) return toolError(pr.error);
      return toolResult(pullJson(store, repo, pr, origin));
    },
  },
  {
    name: 'get_pull_request',
    description: 'Get a single pull request by number.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: strProp('Login of the repository owner.'),
        repo: strProp('Name of the repository.'),
        full_name: strProp('Full name "owner/name" of the repository (alternative to owner and repo).'),
        pull_number: intProp('Number of the pull request.'),
        number: intProp('Number of the pull request (alias for pull_number).'),
      },
      required: ['owner', 'repo', 'pull_number'],
    },
    run(store, args, origin) {
      const repo = findRepo(store, args);
      if (repo === null) return toolError('Repository not found');
      const number = asNumber(args['pull_number']) ?? asNumber(args['number']);
      if (number === null) return toolError('Missing required argument: pull_number');
      const pr = repo.pulls.get(number);
      if (!pr) return toolError('Pull request not found');
      return toolResult(pullJson(store, repo, pr, origin));
    },
  },
  {
    name: 'list_pull_requests',
    description: 'List pull requests in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: strProp('Login of the repository owner.'),
        repo: strProp('Name of the repository.'),
        full_name: strProp('Full name "owner/name" of the repository (alternative to owner and repo).'),
        state: strProp('Pull request state to list: open, closed, or all.'),
      },
      required: ['owner', 'repo'],
    },
    run(store, args, origin) {
      const repo = findRepo(store, args);
      if (repo === null) return toolError('Repository not found');
      const state = asString(args['state']) ?? 'open';
      let all = [...repo.pulls.values()].sort((a, b) => b.seq - a.seq);
      if (state !== 'all') all = all.filter((p) => p.state === state);
      return toolResult({ pull_requests: all.map((p) => pullJson(store, repo, p, origin)) });
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request with a squash commit onto its base branch.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: strProp('Login of the repository owner.'),
        repo: strProp('Name of the repository.'),
        full_name: strProp('Full name "owner/name" of the repository (alternative to owner and repo).'),
        pull_number: intProp('Number of the pull request to merge.'),
        number: intProp('Number of the pull request (alias for pull_number).'),
      },
      required: ['owner', 'repo', 'pull_number'],
    },
    run(store, args, origin) {
      const repo = findRepo(store, args);
      if (repo === null) return toolError('Repository not found');
      const number = asNumber(args['pull_number']) ?? asNumber(args['number']);
      if (number === null) return toolError('Missing required argument: pull_number');
      const pr = repo.pulls.get(number);
      if (!pr) return toolError('Pull request not found');
      const merged = mergePullRecord(store, repo, pr);
      if ('error' in merged) return toolError(merged.error);
      return toolResult({ ...pullJson(store, repo, pr, origin), sha: merged.sha, message: 'Pull request successfully merged' });
    },
  },
];

const TOOLS_LIST = TOOLS.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema }));

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

function serverInfo(): JsonRecord {
  return { name: MCP_SERVER_NAME, version: MCP_SERVER_VERSION };
}

function capabilities(): JsonRecord {
  return { tools: {} };
}

/** Normalize a tool name: strip a `prefix__` namespace and compare case-insensitively. */
function normalizeToolName(name: string): string {
  const bare = name.includes('__') ? name.slice(name.lastIndexOf('__') + 2) : name;
  return bare.toLowerCase().replace(/[^a-z0-9]/g, '');
}

function findTool(name: string): McpToolDef | null {
  const wanted = normalizeToolName(name);
  for (const tool of TOOLS) if (normalizeToolName(tool.name) === wanted) return tool;
  return null;
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
  if (!isRecord(parsed)) {
    return { status: 400, body: rpcError(null, -32600, 'Invalid Request') };
  }
  const id = parsed['id'];
  const method = parsed['method'];
  const params = isRecord(parsed['params']) ? parsed['params'] : {};
  const isNotification = id === undefined;

  if (typeof method !== 'string') {
    return { status: 200, body: rpcError(id ?? null, -32600, 'Invalid Request') };
  }

  if (method === 'notifications/initialized' || method.startsWith('notifications/')) {
    // A notification has no id and no JSON-RPC response.
    return { status: 200, body: '' };
  }

  if (method === 'server/discover') {
    const result: JsonRecord = {
      protocolVersion: MCP_CURRENT_REVISION,
      supportedVersions: [...MCP_SUPPORTED_VERSIONS],
      capabilities: capabilities(),
      serverInfo: serverInfo(),
      _meta: { 'io.modelcontextprotocol/serverInfo': serverInfo() },
    };
    return { status: 200, body: rpcResult(id, result) };
  }

  if (method === 'initialize') {
    const offered = asString(params['protocolVersion']);
    const negotiated = offered !== null && (MCP_SUPPORTED_VERSIONS as readonly string[]).includes(offered) ? offered : MCP_CURRENT_REVISION;
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
    const name = asString(params['name']);
    if (name === null) {
      return { status: 200, body: rpcError(id, -32602, 'Invalid params: tools/call requires a tool name') };
    }
    const tool = findTool(name);
    if (tool === null) {
      return { status: 200, body: rpcError(id, -32602, `Unknown tool: ${name}`) };
    }
    const args = isRecord(params['arguments']) ? params['arguments'] : {};
    const missing = missingArg(args, tool.inputSchema.required);
    if (missing !== null) {
      const text = `Missing required argument: ${missing}`;
      return {
        status: 200,
        body: rpcResult(id, {
          content: [{ type: 'text', text }],
          structuredContent: { error: text, message: text },
          isError: true,
        }),
      };
    }
    try {
      const { payload, isError } = tool.run(store, args, origin);
      const text = typeof payload === 'string' ? payload : JSON.stringify(payload);
      return {
        status: 200,
        body: rpcResult(id, {
          content: [{ type: 'text', text }],
          structuredContent: payload,
          isError,
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
