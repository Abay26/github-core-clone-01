// GitHub REST v3, served from the in-memory store. Every reply is JSON with a
// non-empty X-GitHub-Request-Id; errors are JSON {message}. Auth is the bearer
// token from MAKEFUN_SHOP_TOKEN: missing or wrong is 401, and a repository under
// another owner than the token's is 404, never 403.

import type { Issue, Label, PullRequest, Repo, Store } from './store.ts';
import { globalId } from './store.ts';
import {
  ZERO_OID,
  buildCommit,
  buildTreeFromMap,
  flattenTree,
  ident,
  mergeBase,
  parseCommit,
  parseTree,
  storeObject,
  threeWayMerge,
  walkCommits,
} from './git.ts';

export interface RestResponse {
  status: number;
  body: unknown;
  headers?: Record<string, string>;
  /** A body already serialised (JSON text plus its trailing newline): send
   * it as it is instead of stringifying `body` again. */
  rawBody?: Buffer;
}

export function json(status: number, body: unknown, headers: Record<string, string> = {}): RestResponse {
  return { status, body, headers };
}

/** A response whose body bytes are already built (see the issue cache below). */
export function jsonRaw(status: number, rawBody: Buffer, headers: Record<string, string> = {}): RestResponse {
  return { status, body: null, headers, rawBody };
}

/**
 * Serialised bodies of single-issue GETs, per repository object: a body's
 * bytes are a pure function of the issue's fields, the repo and the origin,
 * so a repeat read of an unchanged issue is a map lookup instead of a fresh
 * object build and stringify. Keyed by the Repo object itself, so deleting
 * a repository and recreating one under the same name can never serve the
 * old repo's bytes. Every mutation of an issue drops that issue's entries;
 * creating an issue touches no other issue's bytes.
 */
const issueBodyCache = new WeakMap<Repo, Map<number, Map<string, Buffer>>>();

/** Forget one issue's cached bodies (call on any mutation of that issue). */
export function dropIssueBody(repo: Repo, number: number): void {
  issueBodyCache.get(repo)?.delete(number);
}

function cachedIssueBody(repo: Repo, number: number, origin: string): Buffer | undefined {
  return issueBodyCache.get(repo)?.get(number)?.get(origin);
}

function storeIssueBody(repo: Repo, number: number, origin: string, body: Buffer): void {
  let byNumber = issueBodyCache.get(repo);
  if (byNumber === undefined) {
    byNumber = new Map();
    issueBodyCache.set(repo, byNumber);
  }
  let byOrigin = byNumber.get(number);
  if (byOrigin === undefined) {
    byOrigin = new Map();
    byNumber.set(number, byOrigin);
  }
  byOrigin.set(origin, body);
}

export function notFound(message = 'Not Found'): RestResponse {
  return json(404, { message, documentation_url: 'https://docs.github.com/rest' });
}

export function badCredentials(): RestResponse {
  return json(401, { message: 'Bad credentials', documentation_url: 'https://docs.github.com/rest' });
}

export function unprocessable(message: string, errors: unknown[] = []): RestResponse {
  return json(422, { message, errors, documentation_url: 'https://docs.github.com/rest' });
}

/** The request's origin, for html_url/url fields. */
export function originOf(host: string | undefined): string {
  return `http://${host ?? 'localhost'}`;
}

// ---------------------------------------------------------------- JSON views

export function userJson(store: Store, origin: string): Record<string, unknown> {
  const v = store.viewer;
  const out: Record<string, unknown> = {};
  out.login = v.login;
  out.id = v.id;
  out.node_id = globalId('User', String(v.id));
  out.avatar_url = `${origin}/avatars/${v.login}`;
  out.gravatar_id = '';
  out.url = `${origin}/api/v3/users/${v.login}`;
  out.html_url = `${origin}/${v.login}`;
  out.type = 'User';
  out.site_admin = false;
  out.name = v.name;
  out.email = v.email;
  return out;
}

export function repoJson(store: Store, repo: Repo, origin: string): Record<string, unknown> {
  const openIssues = [...repo.issues.values()].filter((i) => i.state === 'open').length;
  const license: Record<string, unknown> = {};
  license.key = 'mit';
  license.name = 'MIT License';
  license.spdx_id = 'MIT';
  license.url = `${origin}/licenses/mit`;
  license.node_id = 'MDc6TGljZW5zZW1pdA==';
  const permissions: Record<string, unknown> = {};
  permissions.admin = true;
  permissions.maintain = true;
  permissions.push = true;
  permissions.triage = true;
  permissions.pull = true;
  const out: Record<string, unknown> = {};
  out.id = repo.id;
  out.node_id = globalId('Repository', String(repo.id));
  out.name = repo.name;
  out.full_name = `${repo.owner}/${repo.name}`;
  out.owner = userJson(store, origin);
  out.private = repo.isPrivate;
  out.html_url = `${origin}/${repo.owner}/${repo.name}`;
  out.description = repo.description;
  out.fork = false;
  out.url = `${origin}/api/v3/repos/${repo.owner}/${repo.name}`;
  out.created_at = repo.createdAt;
  out.updated_at = repo.updatedAt;
  out.pushed_at = repo.updatedAt;
  out.git_url = `git://${origin}/${repo.owner}/${repo.name}.git`;
  out.ssh_url = `git@github.com:${repo.owner}/${repo.name}.git`;
  out.clone_url = `${origin}/${repo.owner}/${repo.name}.git`;
  out.homepage = null;
  out.size = 0;
  out.stargazers_count = 0;
  out.watchers_count = 0;
  out.language = null;
  out.has_issues = true;
  out.has_projects = true;
  out.has_downloads = true;
  out.has_wiki = true;
  out.has_pages = false;
  out.has_discussions = false;
  out.forks_count = 0;
  out.archived = false;
  out.disabled = false;
  out.open_issues_count = openIssues;
  out.license = license;
  out.allow_forking = true;
  out.is_template = false;
  out.topics = [];
  out.visibility = repo.isPrivate ? 'private' : 'public';
  out.default_branch = repo.defaultBranch;
  out.permissions = permissions;
  return out;
}

export function labelJson(store: Store, repo: Repo, label: Label, origin: string): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  out.id = 0;
  out.node_id = globalId('Label', `${repo.id}:${label.name}`);
  out.url = `${origin}/api/v3/repos/${repo.owner}/${repo.name}/labels/${encodeURIComponent(label.name)}`;
  out.name = label.name;
  out.color = label.color;
  out.default = false;
  out.description = label.description;
  return out;
}

function labelViewOrFallback(store: Store, repo: Repo, name: string, origin: string): Record<string, unknown> {
  const found = repo.labels.get(name);
  if (found) return labelJson(store, repo, found, origin);
  return { name, color: 'ededed', description: '' };
}

export function issueJson(store: Store, repo: Repo, issue: Issue, origin: string): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  out.id = issue.id;
  out.node_id = issue.nodeId;
  out.url = `${origin}/api/v3/repos/${repo.owner}/${repo.name}/issues/${issue.number}`;
  out.repository_url = `${origin}/api/v3/repos/${repo.owner}/${repo.name}`;
  out.labels_url = `${origin}/api/v3/repos/${repo.owner}/${repo.name}/issues/${issue.number}/labels{/name}`;
  out.comments_url = `${origin}/api/v3/repos/${repo.owner}/${repo.name}/issues/${issue.number}/comments`;
  out.events_url = `${origin}/api/v3/repos/${repo.owner}/${repo.name}/issues/${issue.number}/events`;
  out.html_url = `${origin}/${repo.owner}/${repo.name}/issues/${issue.number}`;
  out.number = issue.number;
  out.state = issue.state;
  out.title = issue.title;
  out.body = issue.body;
  out.user = userJson(store, origin);
  out.labels = issue.labels.map((name) => labelViewOrFallback(store, repo, name, origin));
  out.assignee = null;
  out.assignees = [];
  out.milestone = null;
  out.locked = false;
  out.comments = issue.comments.length;
  out.created_at = issue.createdAt;
  out.updated_at = issue.updatedAt;
  out.closed_at = issue.state === 'closed' ? issue.updatedAt : null;
  out.author_association = 'OWNER';
  out.state_reason = null;
  return out;
}

export function pullJson(store: Store, repo: Repo, pr: PullRequest, origin: string): Record<string, unknown> {
  const headRepo = repoJson(store, repo, origin);
  const base = `${origin}/api/v3/repos/${repo.owner}/${repo.name}`;
  const head: Record<string, unknown> = {};
  head.label = `${repo.owner}:${pr.head}`;
  head.ref = pr.head;
  head.sha = pr.headSha;
  head.user = userJson(store, origin);
  head.repo = headRepo;
  const baseRef: Record<string, unknown> = {};
  baseRef.label = `${repo.owner}:${pr.base}`;
  baseRef.ref = pr.base;
  baseRef.sha = pr.baseSha;
  baseRef.user = userJson(store, origin);
  baseRef.repo = headRepo;
  const links: Record<string, unknown> = {};
  links.self = { href: `${base}/pulls/${pr.number}` };
  links.html = { href: `${origin}/${repo.owner}/${repo.name}/pull/${pr.number}` };
  links.issue = { href: `${base}/issues/${pr.number}` };
  links.comments = { href: `${base}/issues/${pr.number}/comments` };
  links.review_comments = { href: `${base}/pulls/${pr.number}/comments` };
  links.review_comment = { href: `${base}/pulls/comments{/number}` };
  links.commits = { href: `${base}/pulls/${pr.number}/commits` };
  links.statuses = { href: `${base}/statuses/${pr.headSha}` };
  const out: Record<string, unknown> = {};
  out.id = pr.id;
  out.node_id = pr.nodeId;
  out.url = `${base}/pulls/${pr.number}`;
  out.html_url = `${origin}/${repo.owner}/${repo.name}/pull/${pr.number}`;
  out.diff_url = `${origin}/${repo.owner}/${repo.name}/pull/${pr.number}.diff`;
  out.patch_url = `${origin}/${repo.owner}/${repo.name}/pull/${pr.number}.patch`;
  out.issue_url = `${base}/issues/${pr.number}`;
  out.number = pr.number;
  out.state = pr.state;
  out.locked = false;
  out.title = pr.title;
  out.user = userJson(store, origin);
  out.body = pr.body;
  out.created_at = pr.createdAt;
  out.updated_at = pr.updatedAt;
  out.closed_at = pr.state === 'closed' ? pr.updatedAt : null;
  out.merged_at = pr.merged ? pr.updatedAt : null;
  out.merge_commit_sha = pr.merged ? pr.mergeCommitSha : null;
  out.assignee = null;
  out.assignees = [];
  out.requested_reviewers = [];
  out.labels = [];
  out.milestone = null;
  out.draft = false;
  out.commits_url = `${base}/pulls/${pr.number}/commits`;
  out.review_comments_url = `${base}/pulls/${pr.number}/comments`;
  out.review_comment_url = `${base}/pulls/comments{/number}`;
  out.comments_url = `${base}/issues/${pr.number}/comments`;
  out.statuses_url = `${base}/statuses/${pr.headSha}`;
  out.head = head;
  out.base = baseRef;
  out._links = links;
  out.author_association = 'OWNER';
  out.auto_merge = null;
  out.merged = pr.merged;
  out.mergeable = pr.mergeable === 'MERGEABLE';
  out.rebaseable = pr.mergeable === 'MERGEABLE';
  out.mergeable_state = pr.mergeable === 'MERGEABLE' ? 'clean' : pr.mergeable === 'CONFLICTING' ? 'dirty' : 'unknown';
  out.merged_by = pr.merged ? userJson(store, origin) : null;
  return out;
}

export function commentJson(store: Store, repo: Repo, issue: Issue, c: Issue['comments'][number], origin: string): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  out.id = c.id;
  out.node_id = c.nodeId;
  out.url = `${origin}/api/v3/repos/${repo.owner}/${repo.name}/issues/comments/${c.id}`;
  out.html_url = `${origin}/${repo.owner}/${repo.name}/issues/${issue.number}#issuecomment-${c.id}`;
  out.body = c.body;
  out.user = userJson(store, origin);
  out.created_at = c.createdAt;
  out.updated_at = c.updatedAt;
  out.issue_url = `${origin}/api/v3/repos/${repo.owner}/${repo.name}/issues/${issue.number}`;
  out.author_association = 'OWNER';
  return out;
}

// ---------------------------------------------------------------- pagination

export interface PageParams {
  page: number;
  perPage: number;
}

export function pageParams(query: URLSearchParams): PageParams {
  const page = Math.max(1, Number(query.get('page') ?? '1') || 1);
  const perPage = Math.min(100, Math.max(1, Number(query.get('per_page') ?? '30') || 30));
  return { page, perPage };
}

export function paginate<T>(items: T[], params: PageParams, baseUrl: string, query: URLSearchParams): { items: T[]; headers: Record<string, string> } {
  const total = items.length;
  const start = (params.page - 1) * params.perPage;
  const pageItems = items.slice(start, start + params.perPage);
  const headers: Record<string, string> = {};
  const totalPages = Math.max(1, Math.ceil(total / params.perPage));
  if (params.page < totalPages) {
    const next = new URL(baseUrl);
    for (const [k, v] of query) if (k !== 'page') next.searchParams.set(k, v);
    next.searchParams.set('page', String(params.page + 1));
    next.searchParams.set('per_page', String(params.perPage));
    const last = new URL(next);
    last.searchParams.set('page', String(totalPages));
    headers.link = `<${next.toString()}>; rel="next", <${last.toString()}>; rel="last"`;
  }
  return { items: pageItems, headers };
}

// ---------------------------------------------------------------- git helpers for REST

/** Create a commit on `branch` with the given flat file map; returns the new sha. */
export function commitFiles(
  store: Store,
  repo: Repo,
  branch: string,
  files: Map<string, { oid: string; mode: string }>,
  message: string,
): string {
  const treeOid = buildTreeFromMap(repo, files);
  const parent = repo.refs.get(`refs/heads/${branch}`);
  const epoch = store.nowSec();
  const author = ident(store.viewer.name, store.viewer.email, epoch);
  const commit = buildCommit({ tree: treeOid, parents: parent ? [parent] : [], author, committer: author, message });
  const sha = storeObject(repo, 'commit', commit);
  repo.refs.set(`refs/heads/${branch}`, sha);
  repo.updatedAt = store.nowIso();
  return sha;
}

export function tipTreeFiles(repo: Repo, branch: string): Map<string, { oid: string; mode: string }> {
  const tip = repo.refs.get(`refs/heads/${branch}`);
  if (!tip) return new Map();
  const obj = repo.objects.get(tip);
  if (!obj || obj.type !== 'commit') return new Map();
  return flattenTree(repo, parseCommit(obj.data).tree);
}

export function commitJson(store: Store, repo: Repo, sha: string, origin: string): Record<string, unknown> | null {
  const obj = repo.objects.get(sha);
  if (!obj || obj.type !== 'commit') return null;
  const c = parseCommit(obj.data);
  const m = /^(.+) <([^>]*)> (\d+) ([+-]\d{4})$/.exec(c.author);
  const date = m ? new Date(Number(m[3]) * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z') : repo.createdAt;
  const who: Record<string, unknown> = {};
  who.name = m?.[1] ?? store.viewer.name;
  who.email = m?.[2] ?? store.viewer.email;
  who.date = date;
  const treeRef: Record<string, unknown> = {};
  treeRef.sha = c.tree;
  treeRef.url = `${origin}/api/v3/repos/${repo.owner}/${repo.name}/git/trees/${c.tree}`;
  const verification: Record<string, unknown> = {};
  verification.verified = false;
  verification.reason = 'unsigned';
  verification.signature = null;
  verification.payload = null;
  const inner: Record<string, unknown> = {};
  inner.author = who;
  inner.committer = who;
  inner.message = c.message;
  inner.tree = treeRef;
  inner.url = `${origin}/api/v3/repos/${repo.owner}/${repo.name}/git/commits/${sha}`;
  inner.comment_count = 0;
  inner.verification = verification;
  const out: Record<string, unknown> = {};
  out.sha = sha;
  out.node_id = globalId('Commit', sha);
  out.commit = inner;
  out.url = `${origin}/api/v3/repos/${repo.owner}/${repo.name}/commits/${sha}`;
  out.html_url = `${origin}/${repo.owner}/${repo.name}/commit/${sha}`;
  out.comments_url = `${origin}/api/v3/repos/${repo.owner}/${repo.name}/commits/${sha}/comments`;
  out.author = userJson(store, origin);
  out.committer = userJson(store, origin);
  out.parents = c.parents.map((p) => ({ sha: p, url: `${origin}/api/v3/repos/${repo.owner}/${repo.name}/commits/${p}`, html_url: `${origin}/${repo.owner}/${repo.name}/commit/${p}` }));
  return out;
}

// ---------------------------------------------------------------- router

type Body = Record<string, unknown> | null;

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function decodeSegment(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

interface RepoRoute {
  store: Store;
  repo: Repo;
  owner: string;
  repoName: string;
  method: string;
  tail: string[];
  query: URLSearchParams;
  body: Body;
  origin: string;
  baseUrl: string;
}

function refView(store: Store, repo: Repo, refName: string, sha: string, origin: string): Record<string, unknown> {
  const object: Record<string, unknown> = {};
  object.sha = sha;
  object.type = 'commit';
  object.url = `${origin}/api/v3/repos/${repo.owner}/${repo.name}/git/commits/${sha}`;
  const out: Record<string, unknown> = {};
  out.ref = refName;
  out.node_id = globalId('Ref', `${repo.id}:${refName}`);
  out.url = `${origin}/api/v3/repos/${repo.owner}/${repo.name}/git/${refName}`;
  out.object = object;
  return out;
}

/** Mergeability of a PR, recomputed from the current refs. */
function currentMergeable(store: Store, repo: Repo, pr: PullRequest): PullRequest['mergeable'] {
  const baseTip = repo.refs.get(`refs/heads/${pr.base}`);
  const headTip = repo.refs.get(`refs/heads/${pr.head}`);
  if (!baseTip || !headTip) return 'UNKNOWN';
  if (baseTip === pr.baseSha && headTip === pr.headSha && pr.mergeable !== 'UNKNOWN') return pr.mergeable;
  const base = mergeBase(repo, baseTip, headTip);
  if (base === null) return 'CONFLICTING';
  const { conflicts } = threeWayMerge(repo, baseTip, headTip, base);
  return conflicts.length ? 'CONFLICTING' : 'MERGEABLE';
}

interface DiffEntry {
  filename: string;
  status: string;
  additions: number;
  deletions: number;
  changes: number;
}

function diffBetween(repo: Repo, baseSha: string, headSha: string): DiffEntry[] {
  const base = mergeBase(repo, baseSha, headSha) ?? baseSha;
  const baseObj = repo.objects.get(base);
  const headObj = repo.objects.get(headSha);
  if (!baseObj || !headObj) return [];
  const baseTree = flattenTree(repo, parseCommit(baseObj.data).tree);
  const headTree = flattenTree(repo, parseCommit(headObj.data).tree);
  const countLines = (oid?: string): number => {
    if (!oid) return 0;
    const o = repo.objects.get(oid);
    if (!o) return 0;
    const text = o.data.toString('utf8');
    return text === '' ? 0 : text.split('\n').length;
  };
  const out: DiffEntry[] = [];
  const paths = new Set([...baseTree.keys(), ...headTree.keys()]);
  for (const path of [...paths].sort()) {
    const b = baseTree.get(path);
    const h = headTree.get(path);
    if (b?.oid === h?.oid) continue;
    let additions = 0;
    let deletions = 0;
    if (!b && h) additions = countLines(h.oid);
    else if (b && !h) deletions = countLines(b.oid);
    else if (b && h) {
      additions = countLines(h.oid);
      deletions = countLines(b.oid);
    }
    out.push({ filename: path, status: !b ? 'added' : !h ? 'removed' : 'modified', additions, deletions, changes: additions + deletions });
  }
  return out;
}

function routeRepoRoot(r: RepoRoute): RestResponse {
  const { store, repo, method, body, origin } = r;
  if (method === 'GET') return json(200, repoJson(store, repo, origin));
  if (method === 'PATCH') {
    if (isPlainObject(body)) {
      if (typeof body.description === 'string') repo.description = body.description;
      if (typeof body.private === 'boolean') repo.isPrivate = body.private;
      if (typeof body.default_branch === 'string' && repo.refs.has(`refs/heads/${body.default_branch}`)) {
        repo.defaultBranch = body.default_branch;
      }
      repo.updatedAt = store.nowIso();
    }
    return json(200, repoJson(store, repo, origin));
  }
  if (method === 'DELETE') {
    store.deleteRepo(r.owner, r.repoName);
    return { status: 204, body: null };
  }
  return notFound();
}

function routeBranches(r: RepoRoute): RestResponse {
  const { repo, method, tail, origin } = r;
  const branch = tail[0] ? decodeSegment(tail[0]) : undefined;
  const names = [...repo.refs.keys()]
    .filter((ref) => ref.startsWith('refs/heads/'))
    .map((ref) => ref.slice('refs/heads/'.length))
    .sort();
  if (method === 'GET' && branch === undefined) {
    return json(200, names.map((b) => {
      const commitRef: Record<string, unknown> = {};
      commitRef.sha = repo.refs.get(`refs/heads/${b}`);
      commitRef.url = `${origin}/api/v3/repos/${r.owner}/${r.repoName}/commits/${repo.refs.get(`refs/heads/${b}`)}`;
      const entry: Record<string, unknown> = {};
      entry.name = b;
      entry.commit = commitRef;
      entry.protected = false;
      return entry;
    }));
  }
  if (method === 'GET' && branch !== undefined) {
    const sha = repo.refs.get(`refs/heads/${branch}`);
    if (!sha) return notFound();
    const commitRef: Record<string, unknown> = {};
    commitRef.sha = sha;
    commitRef.url = `${origin}/api/v3/repos/${r.owner}/${r.repoName}/commits/${sha}`;
    const branchView: Record<string, unknown> = {};
    branchView.name = branch;
    branchView.commit = commitRef;
    branchView.protected = false;
    return json(200, branchView);
  }
  return notFound();
}

function routeCommits(r: RepoRoute): RestResponse {
  const { store, repo, method, tail, query, origin, baseUrl } = r;
  const shaParam = tail[0] ? decodeSegment(tail[0]) : undefined;
  if (method === 'GET' && shaParam === undefined) {
    const branch = query.get('sha') ?? repo.defaultBranch;
    const tip = repo.refs.get(`refs/heads/${branch}`);
    const params = pageParams(query);
    if (!tip) return json(200, []);
    const depths = walkCommits(repo, [tip]);
    const ordered = [...depths.keys()].sort((a, b) => (depths.get(a) ?? 0) - (depths.get(b) ?? 0));
    const all = ordered.map((s) => commitJson(store, repo, s, origin)).filter(Boolean);
    const { items, headers } = paginate(all, params, baseUrl, query);
    return json(200, items, headers);
  }
  if (method === 'GET' && shaParam !== undefined) {
    const c = commitJson(store, repo, shaParam, origin);
    if (!c) return notFound();
    return json(200, c);
  }
  return notFound();
}

function routeGit(r: RepoRoute): RestResponse {
  const { store, repo, method, tail, query, body, origin } = r;
  const kind = tail[0];
  const target = tail.slice(1).join('/');
  if (kind === 'refs' && method === 'GET' && target === '') {
    const refs = [...repo.refs.keys()].sort().map((name) => {
      const object: Record<string, unknown> = {};
      object.sha = repo.refs.get(name);
      object.type = 'commit';
      object.url = `${origin}/api/v3/repos/${r.owner}/${r.repoName}/git/commits/${repo.refs.get(name)}`;
      const entry: Record<string, unknown> = {};
      entry.ref = name;
      entry.node_id = globalId('Ref', `${repo.id}:${name}`);
      entry.url = `${origin}/api/v3/repos/${r.owner}/${r.repoName}/git/${name}`;
      entry.object = object;
      return entry;
    });
    return json(200, refs);
  }
  if (kind === 'refs' && target !== '') {
    const refName = `refs/${decodeSegment(target)}`;
    if (method === 'GET') {
      const sha = repo.refs.get(refName);
      if (!sha) return notFound();
      return json(200, refView(store, repo, refName, sha, origin));
    }
    if (method === 'PATCH' && isPlainObject(body) && typeof body.sha === 'string') {
      const sha = body.sha as string;
      if (!repo.objects.has(sha)) return unprocessable('Validation Failed');
      repo.refs.set(refName, sha);
      return json(200, refView(store, repo, refName, sha, origin));
    }
    if (method === 'DELETE') {
      if (!repo.refs.has(refName)) return notFound();
      repo.refs.delete(refName);
      return { status: 204, body: null };
    }
  }
  if (kind === 'refs' && method === 'POST' && isPlainObject(body)) {
    const ref = typeof body.ref === 'string' ? body.ref : '';
    const sha = typeof body.sha === 'string' ? body.sha : '';
    if (!ref.startsWith('refs/') || !repo.objects.has(sha)) return unprocessable('Validation Failed');
    if (repo.refs.has(ref)) return unprocessable('Reference already exists');
    repo.refs.set(ref, sha);
    return json(201, refView(store, repo, ref, sha, origin));
  }
  if (kind === 'trees' && method === 'GET' && target !== '') {
    const sha = decodeSegment(target);
    const obj = repo.objects.get(sha);
    if (!obj || obj.type !== 'tree') return notFound();
    const recursive = query.get('recursive') === '1';
    const entries: Array<Record<string, unknown>> = [];
    const walk = (treeOid: string, prefix: string): void => {
      for (const e of parseTree(repo.objects.get(treeOid)!.data)) {
        const path = prefix ? `${prefix}/${e.name}` : e.name;
        const isTree = e.mode === '40000';
        const treeEntry: Record<string, unknown> = {};
        treeEntry.path = path;
        treeEntry.mode = e.mode;
        treeEntry.type = isTree ? 'tree' : 'blob';
        treeEntry.sha = e.oid;
        treeEntry.size = isTree ? undefined : repo.objects.get(e.oid)?.data.length;
        treeEntry.url = `${origin}/api/v3/repos/${r.owner}/${r.repoName}/git/${isTree ? 'trees' : 'blobs'}/${e.oid}`;
        entries.push(treeEntry);
        if (recursive && isTree) walk(e.oid, path);
      }
    };
    walk(sha, '');
    return json(200, { sha, url: `${origin}/api/v3/repos/${r.owner}/${r.repoName}/git/trees/${sha}`, tree: entries, truncated: false });
  }
  if (kind === 'blobs' && method === 'GET' && target !== '') {
    const sha = decodeSegment(target);
    const obj = repo.objects.get(sha);
    if (!obj || obj.type !== 'blob') return notFound();
    const blobView: Record<string, unknown> = {};
    blobView.sha = sha;
    blobView.node_id = globalId('Blob', sha);
    blobView.size = obj.data.length;
    blobView.url = `${origin}/api/v3/repos/${r.owner}/${r.repoName}/git/blobs/${sha}`;
    blobView.content = obj.data.toString('base64');
    blobView.encoding = 'base64';
    return json(200, blobView);
  }
  if (kind === 'commits' && method === 'GET' && target !== '') {
    const sha = decodeSegment(target);
    const c = commitJson(store, repo, sha, origin);
    if (!c) return notFound();
    return json(200, c);
  }
  return notFound();
}

function contentsEntry(r: RepoRoute, branch: string, name: string, path: string, oid: string, isDir: boolean): Record<string, unknown> {
  const { repo, origin } = r;
  const kind = isDir ? 'trees' : 'blobs';
  const links: Record<string, unknown> = {};
  links.git = `${origin}/api/v3/repos/${r.owner}/${r.repoName}/git/${kind}/${oid}`;
  links.self = `${origin}/api/v3/repos/${r.owner}/${r.repoName}/contents/${path}`;
  links.html = `${origin}/${r.owner}/${r.repoName}/blob/${branch}/${path}`;
  const out: Record<string, unknown> = {};
  out.type = isDir ? 'dir' : 'file';
  out.encoding = isDir ? undefined : 'base64';
  out.size = isDir ? 0 : repo.objects.get(oid)?.data.length ?? 0;
  out.name = name;
  out.path = path;
  out.sha = isDir ? '' : oid;
  out.url = `${origin}/api/v3/repos/${r.owner}/${r.repoName}/contents/${path}`;
  out.git_url = `${origin}/api/v3/repos/${r.owner}/${r.repoName}/git/${kind}/${oid}`;
  out.html_url = `${origin}/${r.owner}/${r.repoName}/blob/${branch}/${path}`;
  out.download_url = `${origin}/${r.owner}/${r.repoName}/raw/${branch}/${path}`;
  out._links = links;
  return out;
}

function routeContents(r: RepoRoute): RestResponse {
  const { store, repo, method, tail, query, body, origin } = r;
  const path = tail.map(decodeSegment).join('/');
  const branch = query.get('ref') ?? repo.defaultBranch;
  if (method === 'GET') {
    const files = tipTreeFiles(repo, branch);
    if (path === '') {
      const top = new Map<string, { oid: string; mode: string }>();
      for (const [p, f] of files) {
        const first = p.split('/')[0]!;
        if (!top.has(first)) top.set(first, f);
      }
      const entries = [...top.keys()].map((name) => {
        const isDir = files.has(name) ? false : true;
        const oid = files.get(name)?.oid ?? '';
        return contentsEntry(r, branch, name, name, oid, isDir);
      });
      return json(200, entries);
    }
    const dirPrefix = `${path}/`;
    const isDir = [...files.keys()].some((p) => p.startsWith(dirPrefix));
    if (isDir) {
      const entries: Array<Record<string, unknown>> = [];
      const seen = new Set<string>();
      for (const [p, f] of files) {
        if (!p.startsWith(dirPrefix)) continue;
        const restPath = p.slice(dirPrefix.length);
        const first = restPath.split('/')[0]!;
        if (seen.has(first)) continue;
        seen.add(first);
        const childIsDir = restPath.includes('/');
        const childEntry: Record<string, unknown> = {};
        childEntry.type = childIsDir ? 'dir' : 'file';
        childEntry.encoding = childIsDir ? undefined : 'base64';
        childEntry.size = childIsDir ? 0 : repo.objects.get(f.oid)?.data.length ?? 0;
        childEntry.name = first;
        childEntry.path = `${path}/${first}`;
        childEntry.sha = childIsDir ? '' : f.oid;
        childEntry.url = `${origin}/api/v3/repos/${r.owner}/${r.repoName}/contents/${path}/${first}`;
        childEntry.git_url = `${origin}/api/v3/repos/${r.owner}/${r.repoName}/git/${childIsDir ? 'trees' : 'blobs'}/${f.oid}`;
        childEntry.html_url = `${origin}/${r.owner}/${r.repoName}/blob/${branch}/${path}/${first}`;
        childEntry.download_url = `${origin}/${r.owner}/${r.repoName}/raw/${branch}/${path}/${first}`;
        entries.push(childEntry);
      }
      return json(200, entries);
    }
    const file = files.get(path);
    if (!file) return notFound();
    const blob = repo.objects.get(file.oid);
    const links: Record<string, unknown> = {};
    links.git = `${origin}/api/v3/repos/${r.owner}/${r.repoName}/git/blobs/${file.oid}`;
    links.self = `${origin}/api/v3/repos/${r.owner}/${r.repoName}/contents/${path}`;
    links.html = `${origin}/${r.owner}/${r.repoName}/blob/${branch}/${path}`;
    const entry: Record<string, unknown> = {};
    entry.type = 'file';
    entry.encoding = 'base64';
    entry.size = blob?.data.length ?? 0;
    entry.name = path.split('/').pop();
    entry.path = path;
    entry.content = blob?.data.toString('base64') ?? '';
    entry.sha = file.oid;
    entry.url = `${origin}/api/v3/repos/${r.owner}/${r.repoName}/contents/${path}`;
    entry.git_url = `${origin}/api/v3/repos/${r.owner}/${r.repoName}/git/blobs/${file.oid}`;
    entry.html_url = `${origin}/${r.owner}/${r.repoName}/blob/${branch}/${path}`;
    entry.download_url = `${origin}/${r.owner}/${r.repoName}/raw/${branch}/${path}`;
    entry._links = links;
    return json(200, entry);
  }
  if (method === 'PUT' && isPlainObject(body)) {
    const contentB64 = typeof body.content === 'string' ? body.content : null;
    if (contentB64 === null) return unprocessable('Validation Failed');
    let content: Buffer;
    try {
      content = Buffer.from(contentB64, 'base64');
    } catch {
      return unprocessable('Validation Failed');
    }
    const targetBranch = typeof body.branch === 'string' ? body.branch : branch;
    const files = tipTreeFiles(repo, targetBranch);
    const existing = files.get(path);
    const isUpdate = existing !== undefined;
    if (isUpdate && body.sha !== existing.oid) {
      return json(409, { message: 'sha does not match', documentation_url: 'https://docs.github.com/rest' });
    }
    const blobOid = storeObject(repo, 'blob', content);
    files.set(path, { oid: blobOid, mode: '100644' });
    const message = typeof body.message === 'string' ? body.message : isUpdate ? `Update ${path}` : `Create ${path}`;
    const sha = commitFiles(store, repo, targetBranch, files, message);
    const contentLinks: Record<string, unknown> = {};
    contentLinks.git = `${origin}/api/v3/repos/${r.owner}/${r.repoName}/git/blobs/${blobOid}`;
    contentLinks.self = `${origin}/api/v3/repos/${r.owner}/${r.repoName}/contents/${path}`;
    contentLinks.html = `${origin}/${r.owner}/${r.repoName}/blob/${targetBranch}/${path}`;
    const contentView: Record<string, unknown> = {};
    contentView.name = path.split('/').pop();
    contentView.path = path;
    contentView.sha = blobOid;
    contentView.size = content.length;
    contentView.encoding = 'base64';
    contentView.url = `${origin}/api/v3/repos/${r.owner}/${r.repoName}/contents/${path}`;
    contentView.html_url = `${origin}/${r.owner}/${r.repoName}/blob/${targetBranch}/${path}`;
    contentView.git_url = `${origin}/api/v3/repos/${r.owner}/${r.repoName}/git/blobs/${blobOid}`;
    contentView.download_url = `${origin}/${r.owner}/${r.repoName}/raw/${targetBranch}/${path}`;
    contentView.type = 'file';
    contentView._links = contentLinks;
    const authorView: Record<string, unknown> = {};
    authorView.name = store.viewer.name;
    authorView.email = store.viewer.email;
    authorView.date = repo.updatedAt;
    const commitView: Record<string, unknown> = {};
    commitView.sha = sha;
    commitView.message = message;
    commitView.author = authorView;
    commitView.committer = authorView;
    const payload: Record<string, unknown> = {};
    payload.content = contentView;
    payload.commit = commitView;
    return json(isUpdate ? 200 : 201, payload);
  }
  if (method === 'DELETE' && isPlainObject(body)) {
    const targetBranch = typeof body.branch === 'string' ? body.branch : branch;
    const files = tipTreeFiles(repo, targetBranch);
    const existing = files.get(path);
    if (!existing) return notFound();
    if (body.sha !== existing.oid) {
      return json(409, { message: 'sha does not match', documentation_url: 'https://docs.github.com/rest' });
    }
    files.delete(path);
    const message = typeof body.message === 'string' ? body.message : `Delete ${path}`;
    const sha = commitFiles(store, repo, targetBranch, files, message);
    return json(200, { commit: { sha, message } });
  }
  return notFound();
}

function routeLabels(r: RepoRoute): RestResponse {
  const { repo, method, tail, body, origin } = r;
  const labelName = tail[0] ? decodeSegment(tail[0]) : undefined;
  if (method === 'GET' && labelName === undefined) {
    return json(200, [...repo.labels.values()].map((l) => labelJson(r.store, repo, l, origin)));
  }
  if (method === 'POST' && labelName === undefined && isPlainObject(body) && typeof body.name === 'string') {
    const name = body.name as string;
    if (repo.labels.has(name)) return unprocessable('Label already exists');
    const label = {
      name,
      color: typeof body.color === 'string' ? (body.color as string).replace(/^#/, '') : 'ededed',
      description: typeof body.description === 'string' ? body.description : '',
    };
    repo.labels.set(name, label);
    return json(201, labelJson(r.store, repo, label, origin));
  }
  if (labelName !== undefined) {
    const label = repo.labels.get(labelName);
    if (!label) return notFound();
    if (method === 'GET') return json(200, labelJson(r.store, repo, label, origin));
    if (method === 'PATCH' && isPlainObject(body)) {
      if (typeof body.name === 'string' && body.name !== labelName) {
        repo.labels.delete(labelName);
        label.name = body.name as string;
        repo.labels.set(label.name, label);
      }
      if (typeof body.color === 'string') label.color = (body.color as string).replace(/^#/, '');
      if (typeof body.description === 'string') label.description = body.description;
      return json(200, labelJson(r.store, repo, label, origin));
    }
    if (method === 'DELETE') {
      repo.labels.delete(labelName);
      return { status: 204, body: null };
    }
  }
  return notFound();
}

function routeIssues(r: RepoRoute): RestResponse {
  const { store, repo, method, tail, query, body, origin, baseUrl } = r;
  const numParam = tail[0] ? Number(tail[0]) : undefined;
  const issueSub = tail[1];
  if (numParam === undefined || Number.isNaN(numParam)) {
    if (method === 'GET') {
      const params = pageParams(query);
      const state = query.get('state') ?? 'open';
      const sort = query.get('sort') ?? 'created';
      const direction = query.get('direction') ?? 'desc';
      const keyOf = (i: Issue): number => (sort === 'updated' ? Date.parse(i.updatedAt) : sort === 'comments' ? i.comments.length : i.seq);
      let all = [...repo.issues.values()].sort((a, b) => (direction === 'asc' ? keyOf(a) - keyOf(b) : keyOf(b) - keyOf(a)));
      if (state !== 'all') all = all.filter((i) => i.state === state);
      const labelsParam = query.get('labels');
      if (labelsParam) {
        const wanted = labelsParam.split(',');
        all = all.filter((i) => wanted.every((l) => i.labels.includes(l)));
      }
      const mapped = all.map((i) => issueJson(store, repo, i, origin));
      const { items, headers } = paginate(mapped, params, baseUrl, query);
      return json(200, items, headers);
    }
    if (method === 'POST' && isPlainObject(body)) {
      if (typeof body.title !== 'string' || body.title === '') {
        return unprocessable('Validation Failed', [{ resource: 'Issue', field: 'title', code: 'missing_field' }]);
      }
      const labels: string[] = Array.isArray(body.labels) ? (body.labels as unknown[]).filter((l): l is string => typeof l === 'string') : [];
      for (const l of labels) {
        if (!repo.labels.has(l)) {
          return unprocessable('Validation Failed', [{ resource: 'Issue', field: 'labels', code: 'invalid', message: `label ${l} does not exist` }]);
        }
      }
      const number = repo.nextIssue++;
      const now = store.nowIso();
      const issue = {} as Issue;
      issue.number = number;
      issue.id = repo.id * 100000 + number;
      issue.nodeId = globalId('Issue', `${repo.id}:${number}`);
      issue.title = body.title as string;
      issue.body = typeof body.body === 'string' ? body.body : '';
      issue.state = 'open';
      issue.labels = labels;
      issue.user = store.viewer.login;
      issue.comments = [];
      issue.createdAt = now;
      issue.updatedAt = now;
      issue.seq = number;
      repo.issues.set(number, issue);
      return json(201, issueJson(store, repo, issue, origin));
    }
    return notFound();
  }
  const issue = repo.issues.get(numParam);
  if (!issue) return notFound();
  if (issueSub === 'comments') {
    if (method === 'GET') {
      const params = pageParams(query);
      const all = issue.comments.map((c) => commentJson(store, repo, issue, c, origin));
      const { items, headers } = paginate(all, params, baseUrl, query);
      return json(200, items, headers);
    }
    if (method === 'POST' && isPlainObject(body) && typeof body.body === 'string') {
      const now = store.nowIso();
      const comment = {} as Issue['comments'][number];
      comment.id = repo.id * 1000000 + repo.nextCommentId++;
      comment.nodeId = globalId('IssueComment', `${repo.id}:${issue.number}:${repo.nextCommentId}`);
      comment.body = body.body as string;
      comment.user = store.viewer.login;
      comment.createdAt = now;
      comment.updatedAt = now;
      issue.comments.push(comment);
      dropIssueBody(repo, issue.number);
      return json(201, commentJson(store, repo, issue, comment, origin));
    }
    return notFound();
  }
  if (issueSub === 'labels') {
    if (method === 'GET') {
      return json(200, issue.labels.map((name) => labelViewOrFallback(store, repo, name, origin)));
    }
    return notFound();
  }
  if (issueSub === undefined) {
    if (method === 'GET') {
      const cached = cachedIssueBody(repo, issue.number, origin);
      if (cached !== undefined) return jsonRaw(200, cached);
      const raw = Buffer.from(`${JSON.stringify(issueJson(store, repo, issue, origin))}\n`, 'utf8');
      storeIssueBody(repo, issue.number, origin, raw);
      return jsonRaw(200, raw);
    }
    if (method === 'PATCH' && isPlainObject(body)) {
      if (typeof body.title === 'string') issue.title = body.title as string;
      if (typeof body.body === 'string') issue.body = body.body as string;
      if (body.state === 'open' || body.state === 'closed') issue.state = body.state;
      if (Array.isArray(body.labels)) {
        const labels = (body.labels as unknown[]).filter((l): l is string => typeof l === 'string');
        for (const l of labels) if (!repo.labels.has(l)) {
          return unprocessable('Validation Failed', [{ resource: 'Issue', field: 'labels', code: 'invalid' }]);
        }
        issue.labels = labels;
      }
      issue.updatedAt = store.nowIso();
      dropIssueBody(repo, issue.number);
      return json(200, issueJson(store, repo, issue, origin));
    }
    return notFound();
  }
  return notFound();
}

function routePulls(r: RepoRoute): RestResponse {
  const { store, repo, method, tail, query, body, origin, baseUrl } = r;
  const numParam = tail[0] ? Number(tail[0]) : undefined;
  const pullSub = tail[1];
  if (numParam === undefined || Number.isNaN(numParam)) {
    if (method === 'GET') {
      const params = pageParams(query);
      const state = query.get('state') ?? 'open';
      const sort = query.get('sort') ?? 'created';
      const direction = query.get('direction') ?? 'desc';
      const keyOf = (p: PullRequest): number => (sort === 'updated' ? Date.parse(p.updatedAt) : p.seq);
      let all = [...repo.pulls.values()].sort((a, b) => (direction === 'asc' ? keyOf(a) - keyOf(b) : keyOf(b) - keyOf(a)));
      if (state !== 'all') all = all.filter((p) => p.state === state);
      const mapped = all.map((p) => pullJson(store, repo, p, origin));
      const { items, headers } = paginate(mapped, params, baseUrl, query);
      return json(200, items, headers);
    }
    if (method === 'POST' && isPlainObject(body)) {
      const title = typeof body.title === 'string' ? body.title : '';
      const head = typeof body.head === 'string' ? body.head : '';
      const base = typeof body.base === 'string' ? body.base : repo.defaultBranch;
      if (!title || !head) return unprocessable('Validation Failed');
      const headSha = repo.refs.get(`refs/heads/${head}`);
      const baseSha = repo.refs.get(`refs/heads/${base}`);
      if (!headSha || !baseSha) return unprocessable('Validation Failed', [{ resource: 'PullRequest', field: headSha ? 'base' : 'head', code: 'invalid' }]);
      const number = repo.nextPull++;
      const now = store.nowIso();
      const pr = {} as PullRequest;
      pr.number = number;
      pr.id = repo.id * 100000 + number;
      pr.nodeId = globalId('PullRequest', `${repo.id}:${number}`);
      pr.title = title;
      pr.body = typeof body.body === 'string' ? body.body : '';
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
      const mergeBaseOid = mergeBase(repo, baseSha, headSha);
      pr.mergeable = mergeBaseOid === null ? 'CONFLICTING' : threeWayMerge(repo, baseSha, headSha, mergeBaseOid).conflicts.length ? 'CONFLICTING' : 'MERGEABLE';
      repo.pulls.set(number, pr);
      return json(201, pullJson(store, repo, pr, origin));
    }
    return notFound();
  }
  const pr = repo.pulls.get(numParam);
  if (!pr) return notFound();
  if (pullSub === 'files' && method === 'GET') {
    const files = diffBetween(repo, pr.baseSha, pr.headSha);
    return json(200, files.map((f) => {
      const entry: Record<string, unknown> = {};
      entry.sha = '';
      entry.filename = f.filename;
      entry.status = f.status;
      entry.additions = f.additions;
      entry.deletions = f.deletions;
      entry.changes = f.changes;
      entry.blob_url = `${origin}/${r.owner}/${r.repoName}/blob/${pr.headSha}/${f.filename}`;
      entry.raw_url = `${origin}/${r.owner}/${r.repoName}/raw/${pr.headSha}/${f.filename}`;
      entry.contents_url = `${origin}/api/v3/repos/${r.owner}/${r.repoName}/contents/${f.filename}?ref=${pr.headSha}`;
      return entry;
    }));
  }
  if (pullSub === 'commits' && method === 'GET') {
    const params = pageParams(query);
    const headDepths = walkCommits(repo, [pr.headSha]);
    const baseAncestors = new Set(walkCommits(repo, [pr.baseSha]).keys());
    const onlyHead = [...headDepths.entries()].filter(([oid]) => !baseAncestors.has(oid)).sort((a, b) => a[1] - b[1]).map(([oid]) => oid);
    const all = onlyHead.map((s) => commitJson(store, repo, s, origin)).filter(Boolean);
    const { items, headers } = paginate(all, params, baseUrl, query);
    return json(200, items, headers);
  }
  if (pullSub === 'merge' && method === 'PUT') {
    if (pr.merged || pr.state === 'closed') {
      return json(405, { message: 'Pull request has already been merged', documentation_url: 'https://docs.github.com/rest' });
    }
    const baseTip = repo.refs.get(`refs/heads/${pr.base}`) ?? pr.baseSha;
    const headTip = repo.refs.get(`refs/heads/${pr.head}`) ?? pr.headSha;
    const mergeBaseOid = mergeBase(repo, baseTip, headTip);
    if (mergeBaseOid === null) {
      return json(405, { message: 'Merge conflict', documentation_url: 'https://docs.github.com/rest' });
    }
    const { tree, conflicts } = threeWayMerge(repo, baseTip, headTip, mergeBaseOid);
    if (conflicts.length) {
      pr.mergeable = 'CONFLICTING';
      return json(405, { message: 'Merge conflict', documentation_url: 'https://docs.github.com/rest' });
    }
    const treeOid = buildTreeFromMap(repo, tree);
    const epoch = store.nowSec();
    const author = ident(store.viewer.name, store.viewer.email, epoch);
    const message = `${pr.title} (#${pr.number})`;
    const commit = buildCommit({ tree: treeOid, parents: [baseTip], author, committer: author, message });
    const sha = storeObject(repo, 'commit', commit);
    repo.refs.set(`refs/heads/${pr.base}`, sha);
    pr.state = 'closed';
    pr.merged = true;
    pr.mergeCommitSha = sha;
    pr.updatedAt = store.nowIso();
    repo.updatedAt = pr.updatedAt;
    return json(200, { sha, merged: true, message: 'Pull request successfully merged' });
  }
  if (pullSub === undefined) {
    if (method === 'GET') {
      pr.mergeable = currentMergeable(store, repo, pr);
      return json(200, pullJson(store, repo, pr, origin));
    }
    if (method === 'PATCH' && isPlainObject(body)) {
      if (typeof body.title === 'string') pr.title = body.title as string;
      if (typeof body.body === 'string') pr.body = body.body as string;
      if (body.state === 'closed' && !pr.merged) pr.state = 'closed';
      if (body.state === 'open' && !pr.merged) pr.state = 'open';
      pr.updatedAt = store.nowIso();
      return json(200, pullJson(store, repo, pr, origin));
    }
    return notFound();
  }
  return notFound();
}

const REPO_SECTIONS: Record<string, (r: RepoRoute) => RestResponse> = {
  branches: routeBranches,
  commits: routeCommits,
  git: routeGit,
  contents: routeContents,
  labels: routeLabels,
  issues: routeIssues,
  pulls: routePulls,
};

export function handleRest(
  store: Store,
  method: string,
  segments: string[],
  query: URLSearchParams,
  body: Body,
  origin: string,
  baseUrl: string,
): RestResponse {
  const [first, second, third, ...rest] = segments;

  // GET /api/v3/ — the API root.
  if ((first === '' || first === undefined) && method === 'GET') {
    const root: Record<string, unknown> = {};
    root.current_user_url = `${origin}/api/v3/user`;
    root.rate_limit_url = `${origin}/api/v3/rate_limit`;
    return json(200, root, { 'x-oauth-scopes': 'repo, read:org' });
  }
  if (first === 'meta' && method === 'GET') {
    const meta: Record<string, unknown> = {};
    meta.verifiable_password_authentication = false;
    meta.installed_version = '1.0.0';
    meta.github_services_sha = ZERO_OID;
    meta.hooks = [];
    meta.git = [];
    meta.pages = [];
    meta.importer = [];
    meta.actions = [];
    return json(200, meta);
  }
  if (first === 'rate_limit' && method === 'GET') {
    const core: Record<string, unknown> = {};
    core.limit = 5000;
    core.remaining = 4999;
    core.reset = 0;
    core.used = 1;
    const search: Record<string, unknown> = {};
    search.limit = 30;
    search.remaining = 30;
    search.reset = 0;
    search.used = 0;
    const resources: Record<string, unknown> = {};
    resources.core = core;
    resources.search = search;
    const rate: Record<string, unknown> = {};
    rate.limit = 5000;
    rate.remaining = 4999;
    rate.reset = 0;
    rate.used = 1;
    const limits: Record<string, unknown> = {};
    limits.resources = resources;
    limits.rate = rate;
    return json(200, limits);
  }
  if (first === 'user' && method === 'GET' && second === undefined) {
    return json(200, userJson(store, origin));
  }
  if (first === 'user' && second === 'repos') {
    if (method === 'GET') {
      const params = pageParams(query);
      const all = store.reposOf(store.viewer.login).map((r) => repoJson(store, r, origin));
      const { items, headers } = paginate(all, params, baseUrl, query);
      return json(200, items, headers);
    }
    if (method === 'POST') {
      if (!isPlainObject(body) || typeof body.name !== 'string' || body.name === '') {
        return unprocessable('Validation Failed', [{ resource: 'Repository', field: 'name', code: 'missing_field' }]);
      }
      const name = body.name as string;
      if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(name) || name.endsWith('.git')) {
        return unprocessable('Validation Failed', [{ resource: 'Repository', field: 'name', code: 'invalid' }]);
      }
      const repo = store.createRepo(
        store.viewer.login,
        name,
        typeof body.description === 'string' ? body.description : '',
        body.private === true,
      );
      if (!repo) return unprocessable('Repository already exists', [{ resource: 'Repository', field: 'name', code: 'custom', message: 'name already exists on this account' }]);
      return json(201, repoJson(store, repo, origin));
    }
  }
  if (first === 'users' && second !== undefined) {
    if (third === 'repos' && method === 'GET') {
      if (second !== store.viewer.login) return json(200, []);
      const params = pageParams(query);
      const all = store.reposOf(second).map((r) => repoJson(store, r, origin));
      const { items, headers } = paginate(all, params, baseUrl, query);
      return json(200, items, headers);
    }
    if (third === undefined && method === 'GET') {
      if (second !== store.viewer.login) return notFound('Not Found');
      return json(200, userJson(store, origin));
    }
  }

  if (first === 'repos' && second !== undefined && third !== undefined) {
    const owner = decodeSegment(second);
    const repoName = decodeSegment(third);
    const repo = store.getRepo(owner, repoName) ?? null;
    if (!repo) return notFound();
    if (owner !== store.viewer.login && repo.owner !== owner) return notFound();
    const sub = rest[0];
    const subRest = rest.slice(1);
    const route: RepoRoute = { store, repo, owner, repoName, method, tail: subRest, query, body, origin, baseUrl };

    if (sub === undefined) return routeRepoRoot(route);
    const handler = REPO_SECTIONS[sub];
    if (handler) return handler(route);
    return notFound();
  }

  return notFound();
}
