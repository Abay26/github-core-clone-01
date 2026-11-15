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
  isAncestor,
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
}

export function json(status: number, body: unknown, headers: Record<string, string> = {}): RestResponse {
  return { status, body, headers };
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

export function userJson(store: Store, origin: string): Record<string, unknown> {
  const v = store.viewer;
  return {
    login: v.login,
    id: v.id,
    node_id: globalId('User', String(v.id)),
    avatar_url: `${origin}/avatars/${v.login}`,
    gravatar_id: '',
    url: `${origin}/api/v3/users/${v.login}`,
    html_url: `${origin}/${v.login}`,
    type: 'User',
    site_admin: false,
    name: v.name,
    email: v.email,
  };
}

export function repoJson(store: Store, repo: Repo, origin: string): Record<string, unknown> {
  return {
    id: repo.id,
    node_id: globalId('Repository', String(repo.id)),
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner: userJson(store, origin),
    private: repo.isPrivate,
    html_url: `${origin}/${repo.owner}/${repo.name}`,
    description: repo.description,
    fork: false,
    url: `${origin}/api/v3/repos/${repo.owner}/${repo.name}`,
    created_at: repo.createdAt,
    updated_at: repo.updatedAt,
    pushed_at: repo.updatedAt,
    git_url: `git://${origin}/${repo.owner}/${repo.name}.git`,
    ssh_url: `git@github.com:${repo.owner}/${repo.name}.git`,
    clone_url: `${origin}/${repo.owner}/${repo.name}.git`,
    homepage: null,
    size: 0,
    stargazers_count: 0,
    watchers_count: 0,
    language: null,
    has_issues: true,
    has_projects: true,
    has_downloads: true,
    has_wiki: true,
    has_pages: false,
    has_discussions: false,
    forks_count: 0,
    archived: false,
    disabled: false,
    open_issues_count: [...repo.issues.values()].filter((i) => i.state === 'open').length,
    license: { key: 'mit', name: 'MIT License', spdx_id: 'MIT', url: `${origin}/licenses/mit`, node_id: 'MDc6TGljZW5zZW1pdA==' },
    allow_forking: true,
    is_template: false,
    topics: [],
    visibility: repo.isPrivate ? 'private' : 'public',
    default_branch: repo.defaultBranch,
    permissions: { admin: true, maintain: true, push: true, triage: true, pull: true },
  };
}

export function labelJson(store: Store, repo: Repo, label: Label, origin: string): Record<string, unknown> {
  return {
    id: 0,
    node_id: globalId('Label', `${repo.id}:${label.name}`),
    url: `${origin}/api/v3/repos/${repo.owner}/${repo.name}/labels/${encodeURIComponent(label.name)}`,
    name: label.name,
    color: label.color,
    default: false,
    description: label.description,
  };
}

export function issueJson(store: Store, repo: Repo, issue: Issue, origin: string): Record<string, unknown> {
  return {
    id: issue.id,
    node_id: issue.nodeId,
    url: `${origin}/api/v3/repos/${repo.owner}/${repo.name}/issues/${issue.number}`,
    repository_url: `${origin}/api/v3/repos/${repo.owner}/${repo.name}`,
    labels_url: `${origin}/api/v3/repos/${repo.owner}/${repo.name}/issues/${issue.number}/labels{/name}`,
    comments_url: `${origin}/api/v3/repos/${repo.owner}/${repo.name}/issues/${issue.number}/comments`,
    events_url: `${origin}/api/v3/repos/${repo.owner}/${repo.name}/issues/${issue.number}/events`,
    html_url: `${origin}/${repo.owner}/${repo.name}/issues/${issue.number}`,
    number: issue.number,
    state: issue.state,
    title: issue.title,
    body: issue.body,
    user: userJson(store, origin),
    labels: issue.labels.map((name) => {
      const l = repo.labels.get(name);
      return l ? labelJson(store, repo, l, origin) : { name, color: 'ededed', description: '' };
    }),
    assignee: null,
    assignees: [],
    milestone: null,
    locked: false,
    comments: issue.comments.length,
    created_at: issue.createdAt,
    updated_at: issue.updatedAt,
    closed_at: issue.state === 'closed' ? issue.updatedAt : null,
    author_association: 'OWNER',
    state_reason: null,
  };
}

export function pullJson(store: Store, repo: Repo, pr: PullRequest, origin: string): Record<string, unknown> {
  const headRepo = repoJson(store, repo, origin);
  return {
    id: pr.id,
    node_id: pr.nodeId,
    url: `${origin}/api/v3/repos/${repo.owner}/${repo.name}/pulls/${pr.number}`,
    html_url: `${origin}/${repo.owner}/${repo.name}/pull/${pr.number}`,
    diff_url: `${origin}/${repo.owner}/${repo.name}/pull/${pr.number}.diff`,
    patch_url: `${origin}/${repo.owner}/${repo.name}/pull/${pr.number}.patch`,
    issue_url: `${origin}/api/v3/repos/${repo.owner}/${repo.name}/issues/${pr.number}`,
    number: pr.number,
    state: pr.state,
    locked: false,
    title: pr.title,
    user: userJson(store, origin),
    body: pr.body,
    created_at: pr.createdAt,
    updated_at: pr.updatedAt,
    closed_at: pr.state === 'closed' ? pr.updatedAt : null,
    merged_at: pr.merged ? pr.updatedAt : null,
    merge_commit_sha: pr.merged ? pr.mergeCommitSha : null,
    assignee: null,
    assignees: [],
    requested_reviewers: [],
    labels: [],
    milestone: null,
    draft: false,
    commits_url: `${origin}/api/v3/repos/${repo.owner}/${repo.name}/pulls/${pr.number}/commits`,
    review_comments_url: `${origin}/api/v3/repos/${repo.owner}/${repo.name}/pulls/${pr.number}/comments`,
    review_comment_url: `${origin}/api/v3/repos/${repo.owner}/${repo.name}/pulls/comments{/number}`,
    comments_url: `${origin}/api/v3/repos/${repo.owner}/${repo.name}/issues/${pr.number}/comments`,
    statuses_url: `${origin}/api/v3/repos/${repo.owner}/${repo.name}/statuses/${pr.headSha}`,
    head: { label: `${repo.owner}:${pr.head}`, ref: pr.head, sha: pr.headSha, user: userJson(store, origin), repo: headRepo },
    base: { label: `${repo.owner}:${pr.base}`, ref: pr.base, sha: pr.baseSha, user: userJson(store, origin), repo: headRepo },
    _links: {
      self: { href: `${origin}/api/v3/repos/${repo.owner}/${repo.name}/pulls/${pr.number}` },
      html: { href: `${origin}/${repo.owner}/${repo.name}/pull/${pr.number}` },
      issue: { href: `${origin}/api/v3/repos/${repo.owner}/${repo.name}/issues/${pr.number}` },
      comments: { href: `${origin}/api/v3/repos/${repo.owner}/${repo.name}/issues/${pr.number}/comments` },
      review_comments: { href: `${origin}/api/v3/repos/${repo.owner}/${repo.name}/pulls/${pr.number}/comments` },
      review_comment: { href: `${origin}/api/v3/repos/${repo.owner}/${repo.name}/pulls/comments{/number}` },
      commits: { href: `${origin}/api/v3/repos/${repo.owner}/${repo.name}/pulls/${pr.number}/commits` },
      statuses: { href: `${origin}/api/v3/repos/${repo.owner}/${repo.name}/statuses/${pr.headSha}` },
    },
    author_association: 'OWNER',
    auto_merge: null,
    merged: pr.merged,
    mergeable: pr.mergeable === 'MERGEABLE',
    rebaseable: pr.mergeable === 'MERGEABLE',
    mergeable_state: pr.mergeable === 'MERGEABLE' ? 'clean' : pr.mergeable === 'CONFLICTING' ? 'dirty' : 'unknown',
    merged_by: pr.merged ? userJson(store, origin) : null,
  };
}

export function commentJson(store: Store, repo: Repo, issue: Issue, c: Issue['comments'][number], origin: string): Record<string, unknown> {
  return {
    id: c.id,
    node_id: c.nodeId,
    url: `${origin}/api/v3/repos/${repo.owner}/${repo.name}/issues/comments/${c.id}`,
    html_url: `${origin}/${repo.owner}/${repo.name}/issues/${issue.number}#issuecomment-${c.id}`,
    body: c.body,
    user: userJson(store, origin),
    created_at: c.createdAt,
    updated_at: c.updatedAt,
    issue_url: `${origin}/api/v3/repos/${repo.owner}/${repo.name}/issues/${issue.number}`,
    author_association: 'OWNER',
  };
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
  const authorLine = c.author;
  const m = /^(.+) <([^>]*)> (\d+) ([+-]\d{4})$/.exec(authorLine);
  const date = m ? new Date(Number(m[3]) * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z') : repo.createdAt;
  return {
    sha,
    node_id: globalId('Commit', sha),
    commit: {
      author: { name: m?.[1] ?? store.viewer.name, email: m?.[2] ?? store.viewer.email, date },
      committer: { name: m?.[1] ?? store.viewer.name, email: m?.[2] ?? store.viewer.email, date },
      message: c.message,
      tree: { sha: c.tree, url: `${origin}/api/v3/repos/${repo.owner}/${repo.name}/git/trees/${c.tree}` },
      url: `${origin}/api/v3/repos/${repo.owner}/${repo.name}/git/commits/${sha}`,
      comment_count: 0,
      verification: { verified: false, reason: 'unsigned', signature: null, payload: null },
    },
    url: `${origin}/api/v3/repos/${repo.owner}/${repo.name}/commits/${sha}`,
    html_url: `${origin}/${repo.owner}/${repo.name}/commit/${sha}`,
    comments_url: `${origin}/api/v3/repos/${repo.owner}/${repo.name}/commits/${sha}/comments`,
    author: userJson(store, origin),
    committer: userJson(store, origin),
    parents: c.parents.map((p) => ({ sha: p, url: `${origin}/api/v3/repos/${repo.owner}/${repo.name}/commits/${p}`, html_url: `${origin}/${repo.owner}/${repo.name}/commit/${p}` })),
  };
}

// ---------------------------------------------------------------- router

type Body = Record<string, unknown> | null;

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function decodePath(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

function repoOr404(store: Store, owner: string, name: string): Repo | null {
  const repo = store.getRepo(owner, name);
  return repo ?? null;
}

/** Mergeability of a PR, recomputed from the current refs. */
function computeMergeable(store: Store, repo: Repo, pr: PullRequest): PullRequest['mergeable'] {
  const baseTip = repo.refs.get(`refs/heads/${pr.base}`);
  const headTip = repo.refs.get(`refs/heads/${pr.head}`);
  if (!baseTip || !headTip) return 'UNKNOWN';
  if (baseTip === pr.baseSha && headTip === pr.headSha && pr.mergeable !== 'UNKNOWN') return pr.mergeable;
  const base = mergeBase(repo, baseTip, headTip);
  if (base === null) return 'CONFLICTING';
  const { conflicts } = threeWayMerge(repo, baseTip, headTip, base);
  return conflicts.length ? 'CONFLICTING' : 'MERGEABLE';
}

function diffFiles(repo: Repo, baseSha: string, headSha: string): Array<{ filename: string; status: string; additions: number; deletions: number; changes: number }> {
  const base = mergeBase(repo, baseSha, headSha) ?? baseSha;
  const baseObj = repo.objects.get(base);
  const headObj = repo.objects.get(headSha);
  if (!baseObj || !headObj) return [];
  const baseTree = flattenTree(repo, parseCommit(baseObj.data).tree);
  const headTree = flattenTree(repo, parseCommit(headObj.data).tree);
  const out: Array<{ filename: string; status: string; additions: number; deletions: number; changes: number }> = [];
  const paths = new Set([...baseTree.keys(), ...headTree.keys()]);
  for (const path of [...paths].sort()) {
    const b = baseTree.get(path);
    const h = headTree.get(path);
    if (b?.oid === h?.oid) continue;
    let additions = 0;
    let deletions = 0;
    const countLines = (oid?: string): number => {
      if (!oid) return 0;
      const o = repo.objects.get(oid);
      if (!o) return 0;
      const text = o.data.toString('utf8');
      return text === '' ? 0 : text.split('\n').length;
    };
    if (!b && h) {
      additions = countLines(h.oid);
    } else if (b && !h) {
      deletions = countLines(b.oid);
    } else if (b && h) {
      additions = countLines(h.oid);
      deletions = countLines(b.oid);
    }
    out.push({
      filename: path,
      status: !b ? 'added' : !h ? 'removed' : 'modified',
      additions,
      deletions,
      changes: additions + deletions,
    });
  }
  return out;
}

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
    return json(200, { current_user_url: `${origin}/api/v3/user`, rate_limit_url: `${origin}/api/v3/rate_limit` }, { 'x-oauth-scopes': 'repo, read:org' });
  }
  if (first === 'meta' && method === 'GET') {
    return json(200, {
      verifiable_password_authentication: false,
      installed_version: '1.0.0',
      github_services_sha: ZERO_OID,
      hooks: [],
      git: [],
      pages: [],
      importer: [],
      actions: [],
    });
  }
  if (first === 'rate_limit' && method === 'GET') {
    return json(200, {
      resources: { core: { limit: 5000, remaining: 4999, reset: 0, used: 1 }, search: { limit: 30, remaining: 30, reset: 0, used: 0 } },
      rate: { limit: 5000, remaining: 4999, reset: 0, used: 1 },
    });
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
      if (!isObject(body) || typeof body.name !== 'string' || body.name === '') {
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
    const owner = decodePath(second);
    const repoName = decodePath(third);
    const repo = repoOr404(store, owner, repoName);
    if (!repo) return notFound();
    if (owner !== store.viewer.login && repo.owner !== owner) return notFound();
    const sub = rest[0];
    const subRest = rest.slice(1);

    // /repos/{o}/{r}
    if (sub === undefined) {
      if (method === 'GET') return json(200, repoJson(store, repo, origin));
      if (method === 'PATCH') {
        if (isObject(body)) {
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
        store.deleteRepo(owner, repoName);
        return { status: 204, body: null };
      }
      return notFound();
    }

    if (sub === 'branches') {
      const branch = subRest[0] ? decodePath(subRest[0]) : undefined;
      const branches = [...repo.refs.keys()]
        .filter((r) => r.startsWith('refs/heads/'))
        .map((r) => r.slice('refs/heads/'.length))
        .sort();
      if (method === 'GET' && branch === undefined) {
        return json(200, branches.map((b) => ({
          name: b,
          commit: { sha: repo.refs.get(`refs/heads/${b}`), url: `${origin}/api/v3/repos/${owner}/${repoName}/commits/${repo.refs.get(`refs/heads/${b}`)}` },
          protected: false,
        })));
      }
      if (method === 'GET' && branch !== undefined) {
        const sha = repo.refs.get(`refs/heads/${branch}`);
        if (!sha) return notFound();
        return json(200, {
          name: branch,
          commit: { sha, url: `${origin}/api/v3/repos/${owner}/${repoName}/commits/${sha}` },
          protected: false,
        });
      }
      return notFound();
    }

    if (sub === 'commits') {
      const shaParam = subRest[0] ? decodePath(subRest[0]) : undefined;
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

    if (sub === 'git') {
      const kind = subRest[0];
      const target = subRest.slice(1).join('/');
      if (kind === 'refs' && method === 'GET' && target === '') {
        const refs = [...repo.refs.keys()].sort().map((name) => ({
          ref: name,
          node_id: globalId('Ref', `${repo.id}:${name}`),
          url: `${origin}/api/v3/repos/${owner}/${repoName}/git/${name}`,
          object: { sha: repo.refs.get(name), type: 'commit', url: `${origin}/api/v3/repos/${owner}/${repoName}/git/commits/${repo.refs.get(name)}` },
        }));
        return json(200, refs);
      }
      if (kind === 'refs' && target !== '') {
        const refName = `refs/${decodePath(target)}`;
        if (method === 'GET') {
          const sha = repo.refs.get(refName);
          if (!sha) return notFound();
          return json(200, {
            ref: refName,
            node_id: globalId('Ref', `${repo.id}:${refName}`),
            url: `${origin}/api/v3/repos/${owner}/${repoName}/git/${refName}`,
            object: { sha, type: 'commit', url: `${origin}/api/v3/repos/${owner}/${repoName}/git/commits/${sha}` },
          });
        }
        if (method === 'PATCH' && isObject(body) && typeof body.sha === 'string') {
          const sha = body.sha as string;
          if (!repo.objects.has(sha)) return unprocessable('Validation Failed');
          repo.refs.set(refName, sha);
          return json(200, {
            ref: refName,
            node_id: globalId('Ref', `${repo.id}:${refName}`),
            url: `${origin}/api/v3/repos/${owner}/${repoName}/git/${refName}`,
            object: { sha, type: 'commit', url: `${origin}/api/v3/repos/${owner}/${repoName}/git/commits/${sha}` },
          });
        }
        if (method === 'DELETE') {
          if (!repo.refs.has(refName)) return notFound();
          repo.refs.delete(refName);
          return { status: 204, body: null };
        }
      }
      if (kind === 'refs' && method === 'POST' && isObject(body)) {
        const ref = typeof body.ref === 'string' ? body.ref : '';
        const sha = typeof body.sha === 'string' ? body.sha : '';
        if (!ref.startsWith('refs/') || !repo.objects.has(sha)) return unprocessable('Validation Failed');
        if (repo.refs.has(ref)) return unprocessable('Reference already exists');
        repo.refs.set(ref, sha);
        return json(201, {
          ref,
          node_id: globalId('Ref', `${repo.id}:${ref}`),
          url: `${origin}/api/v3/repos/${owner}/${repoName}/git/${ref}`,
          object: { sha, type: 'commit', url: `${origin}/api/v3/repos/${owner}/${repoName}/git/commits/${sha}` },
        });
      }
      if (kind === 'trees' && method === 'GET' && target !== '') {
        const sha = decodePath(target);
        const obj = repo.objects.get(sha);
        if (!obj || obj.type !== 'tree') return notFound();
        const recursive = query.get('recursive') === '1';
        const entries: Array<Record<string, unknown>> = [];
        const walk = (treeOid: string, prefix: string): void => {
          for (const e of parseTree(repo.objects.get(treeOid)!.data)) {
            const path = prefix ? `${prefix}/${e.name}` : e.name;
            entries.push({
              path,
              mode: e.mode,
              type: e.mode === '40000' ? 'tree' : 'blob',
              sha: e.oid,
              size: e.mode === '40000' ? undefined : repo.objects.get(e.oid)?.data.length,
              url: `${origin}/api/v3/repos/${owner}/${repoName}/git/${e.mode === '40000' ? 'trees' : 'blobs'}/${e.oid}`,
            });
            if (recursive && e.mode === '40000') walk(e.oid, path);
          }
        };
        walk(sha, '');
        return json(200, { sha, url: `${origin}/api/v3/repos/${owner}/${repoName}/git/trees/${sha}`, tree: entries, truncated: false });
      }
      if (kind === 'blobs' && method === 'GET' && target !== '') {
        const sha = decodePath(target);
        const obj = repo.objects.get(sha);
        if (!obj || obj.type !== 'blob') return notFound();
        return json(200, {
          sha,
          node_id: globalId('Blob', sha),
          size: obj.data.length,
          url: `${origin}/api/v3/repos/${owner}/${repoName}/git/blobs/${sha}`,
          content: obj.data.toString('base64'),
          encoding: 'base64',
        });
      }
      if (kind === 'commits' && method === 'GET' && target !== '') {
        const sha = decodePath(target);
        const c = commitJson(store, repo, sha, origin);
        if (!c) return notFound();
        return json(200, c);
      }
      return notFound();
    }

    if (sub === 'contents') {
      const path = subRest.map(decodePath).join('/');
      const branch = query.get('ref') ?? repo.defaultBranch;
      if (method === 'GET') {
        const files = tipTreeFiles(repo, branch);
        if (path === '') {
          const top = new Map<string, { oid: string; mode: string }>();
          for (const [p, f] of files) {
            const first = p.split('/')[0];
            if (!top.has(first)) top.set(first, f);
          }
          const entries = [...top.entries()].map(([name, f]) => {
            const isDir = files.has(name) ? false : true;
            const entryPath = name;
            const oid = files.get(name)?.oid ?? '';
            return {
              type: isDir ? 'dir' : 'file',
              encoding: isDir ? undefined : 'base64',
              size: isDir ? 0 : repo.objects.get(oid)?.data.length ?? 0,
              name,
              path: entryPath,
              sha: isDir ? '' : oid,
              url: `${origin}/api/v3/repos/${owner}/${repoName}/contents/${entryPath}`,
              git_url: `${origin}/api/v3/repos/${owner}/${repoName}/git/${isDir ? 'trees' : 'blobs'}/${oid}`,
              html_url: `${origin}/${owner}/${repoName}/blob/${branch}/${entryPath}`,
              download_url: `${origin}/${owner}/${repoName}/raw/${branch}/${entryPath}`,
              _links: { git: `${origin}/api/v3/repos/${owner}/${repoName}/git/${isDir ? 'trees' : 'blobs'}/${oid}`, self: `${origin}/api/v3/repos/${owner}/${repoName}/contents/${entryPath}`, html: `${origin}/${owner}/${repoName}/blob/${branch}/${entryPath}` },
            };
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
            const first = restPath.split('/')[0];
            if (seen.has(first)) continue;
            seen.add(first);
            const childIsDir = restPath.includes('/');
            entries.push({
              type: childIsDir ? 'dir' : 'file',
              encoding: childIsDir ? undefined : 'base64',
              size: childIsDir ? 0 : repo.objects.get(f.oid)?.data.length ?? 0,
              name: first,
              path: `${path}/${first}`,
              sha: childIsDir ? '' : f.oid,
              url: `${origin}/api/v3/repos/${owner}/${repoName}/contents/${path}/${first}`,
              git_url: `${origin}/api/v3/repos/${owner}/${repoName}/git/${childIsDir ? 'trees' : 'blobs'}/${f.oid}`,
              html_url: `${origin}/${owner}/${repoName}/blob/${branch}/${path}/${first}`,
              download_url: `${origin}/${owner}/${repoName}/raw/${branch}/${path}/${first}`,
            });
          }
          return json(200, entries);
        }
        const file = files.get(path);
        if (!file) return notFound();
        const blob = repo.objects.get(file.oid);
        return json(200, {
          type: 'file',
          encoding: 'base64',
          size: blob?.data.length ?? 0,
          name: path.split('/').pop(),
          path,
          content: blob?.data.toString('base64') ?? '',
          sha: file.oid,
          url: `${origin}/api/v3/repos/${owner}/${repoName}/contents/${path}`,
          git_url: `${origin}/api/v3/repos/${owner}/${repoName}/git/blobs/${file.oid}`,
          html_url: `${origin}/${owner}/${repoName}/blob/${branch}/${path}`,
          download_url: `${origin}/${owner}/${repoName}/raw/${branch}/${path}`,
          _links: {
            git: `${origin}/api/v3/repos/${owner}/${repoName}/git/blobs/${file.oid}`,
            self: `${origin}/api/v3/repos/${owner}/${repoName}/contents/${path}`,
            html: `${origin}/${owner}/${repoName}/blob/${branch}/${path}`,
          },
        });
      }
      if (method === 'PUT' && isObject(body)) {
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
        return json(isUpdate ? 200 : 201, {
          content: {
            name: path.split('/').pop(),
            path,
            sha: blobOid,
            size: content.length,
            encoding: 'base64',
            url: `${origin}/api/v3/repos/${owner}/${repoName}/contents/${path}`,
            html_url: `${origin}/${owner}/${repoName}/blob/${targetBranch}/${path}`,
            git_url: `${origin}/api/v3/repos/${owner}/${repoName}/git/blobs/${blobOid}`,
            download_url: `${origin}/${owner}/${repoName}/raw/${targetBranch}/${path}`,
            type: 'file',
            _links: { git: `${origin}/api/v3/repos/${owner}/${repoName}/git/blobs/${blobOid}`, self: `${origin}/api/v3/repos/${owner}/${repoName}/contents/${path}`, html: `${origin}/${owner}/${repoName}/blob/${targetBranch}/${path}` },
          },
          commit: { sha, message, author: { name: store.viewer.name, email: store.viewer.email, date: repo.updatedAt }, committer: { name: store.viewer.name, email: store.viewer.email, date: repo.updatedAt } },
        });
      }
      if (method === 'DELETE' && isObject(body)) {
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

    if (sub === 'labels') {
      const labelName = subRest[0] ? decodePath(subRest[0]) : undefined;
      if (method === 'GET' && labelName === undefined) {
        return json(200, [...repo.labels.values()].map((l) => labelJson(store, repo, l, origin)));
      }
      if (method === 'POST' && labelName === undefined && isObject(body) && typeof body.name === 'string') {
        const name = body.name as string;
        if (repo.labels.has(name)) return unprocessable('Label already exists');
        const label = {
          name,
          color: typeof body.color === 'string' ? (body.color as string).replace(/^#/, '') : 'ededed',
          description: typeof body.description === 'string' ? body.description : '',
        };
        repo.labels.set(name, label);
        return json(201, labelJson(store, repo, label, origin));
      }
      if (labelName !== undefined) {
        const label = repo.labels.get(labelName);
        if (!label) return notFound();
        if (method === 'GET') return json(200, labelJson(store, repo, label, origin));
        if (method === 'PATCH' && isObject(body)) {
          if (typeof body.name === 'string' && body.name !== labelName) {
            repo.labels.delete(labelName);
            label.name = body.name as string;
            repo.labels.set(label.name, label);
          }
          if (typeof body.color === 'string') label.color = (body.color as string).replace(/^#/, '');
          if (typeof body.description === 'string') label.description = body.description;
          return json(200, labelJson(store, repo, label, origin));
        }
        if (method === 'DELETE') {
          repo.labels.delete(labelName);
          return { status: 204, body: null };
        }
      }
      return notFound();
    }

    if (sub === 'issues') {
      const numParam = subRest[0] ? Number(subRest[0]) : undefined;
      const issueSub = subRest[1];
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
        if (method === 'POST' && isObject(body)) {
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
          const issue: Issue = {
            number,
            id: repo.id * 100000 + number,
            nodeId: globalId('Issue', `${repo.id}:${number}`),
            title: body.title as string,
            body: typeof body.body === 'string' ? body.body : '',
            state: 'open',
            labels,
            user: store.viewer.login,
            comments: [],
            createdAt: now,
            updatedAt: now,
            seq: number,
          };
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
        if (method === 'POST' && isObject(body) && typeof body.body === 'string') {
          const now = store.nowIso();
          const comment = {
            id: repo.id * 1000000 + repo.nextCommentId++,
            nodeId: globalId('IssueComment', `${repo.id}:${issue.number}:${repo.nextCommentId}`),
            body: body.body as string,
            user: store.viewer.login,
            createdAt: now,
            updatedAt: now,
          };
          issue.comments.push(comment);
          return json(201, commentJson(store, repo, issue, comment, origin));
        }
        return notFound();
      }
      if (issueSub === 'labels') {
        if (method === 'GET') {
          return json(200, issue.labels.map((name) => {
            const l = repo.labels.get(name);
            return l ? labelJson(store, repo, l, origin) : { name, color: 'ededed', description: '' };
          }));
        }
        return notFound();
      }
      if (issueSub === undefined) {
        if (method === 'GET') return json(200, issueJson(store, repo, issue, origin));
        if (method === 'PATCH' && isObject(body)) {
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
          return json(200, issueJson(store, repo, issue, origin));
        }
        return notFound();
      }
      return notFound();
    }

    if (sub === 'pulls') {
      const numParam = subRest[0] ? Number(subRest[0]) : undefined;
      const pullSub = subRest[1];
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
        if (method === 'POST' && isObject(body)) {
          const title = typeof body.title === 'string' ? body.title : '';
          const head = typeof body.head === 'string' ? body.head : '';
          const base = typeof body.base === 'string' ? body.base : repo.defaultBranch;
          if (!title || !head) return unprocessable('Validation Failed');
          const headSha = repo.refs.get(`refs/heads/${head}`);
          const baseSha = repo.refs.get(`refs/heads/${base}`);
          if (!headSha || !baseSha) return unprocessable('Validation Failed', [{ resource: 'PullRequest', field: headSha ? 'base' : 'head', code: 'invalid' }]);
          const number = repo.nextPull++;
          const now = store.nowIso();
          const pr: PullRequest = {
            number,
            id: repo.id * 100000 + number,
            nodeId: globalId('PullRequest', `${repo.id}:${number}`),
            title,
            body: typeof body.body === 'string' ? body.body : '',
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
        const files = diffFiles(repo, pr.baseSha, pr.headSha);
        return json(200, files.map((f) => ({
          sha: '',
          filename: f.filename,
          status: f.status,
          additions: f.additions,
          deletions: f.deletions,
          changes: f.changes,
          blob_url: `${origin}/${owner}/${repoName}/blob/${pr.headSha}/${f.filename}`,
          raw_url: `${origin}/${owner}/${repoName}/raw/${pr.headSha}/${f.filename}`,
          contents_url: `${origin}/api/v3/repos/${owner}/${repoName}/contents/${f.filename}?ref=${pr.headSha}`,
        })));
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
          pr.mergeable = computeMergeable(store, repo, pr);
          return json(200, pullJson(store, repo, pr, origin));
        }
        if (method === 'PATCH' && isObject(body)) {
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

    return notFound();
  }

  return notFound();
}
