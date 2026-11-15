// GraphQL v4 for the documents gh and github-mcp-server send: a small parser and
// executor over the store. Unknown fields are HTTP 200 with an `errors` array
// naming the field; an unknown repository is data.repository = null, no errors.

import type { Issue, PullRequest, Repo, Store } from './store.ts';
import { globalId } from './store.ts';
import { dropIssueBody } from './rest.ts';
import {
  buildCommit,
  buildTreeFromMap,
  flattenTree,
  ident,
  mergeBase,
  parseCommit,
  storeObject,
  threeWayMerge,
} from './git.ts';

// ---------------------------------------------------------------- values and AST nodes

type GqlValue = string | number | boolean | null | GqlValue[] | { [key: string]: GqlValue };

interface FieldNode {
  alias: string | null;
  name: string;
  args: Record<string, GqlValue>;
  selection: FieldNode[] | null;
  fragmentType: string | null;
}

interface Operation {
  kind: 'query' | 'mutation';
  name: string | null;
  variables: Record<string, GqlValue>;
  selection: FieldNode[];
}

interface GqlError {
  message: string;
  path?: (string | number)[];
}

// ---------------------------------------------------------------- lexer

function lex(src: string): string[] {
  const out: string[] = [];
  let i = 0;
  const isSpace = (c: string | undefined): boolean => c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === ',';
  while (i < src.length) {
    const c = src[i]!;
    if (isSpace(c)) {
      i += 1;
      continue;
    }
    if (c === '#') {
      while (i < src.length && src[i] !== '\n') i += 1;
      continue;
    }
    if (c === '.' && src.slice(i, i + 3) === '...') {
      out.push('...');
      i += 3;
      continue;
    }
    if ('{}():[]!=$@'.includes(c)) {
      out.push(c);
      i += 1;
      continue;
    }
    if (c === '"') {
      let j = i + 1;
      let text = '';
      while (j < src.length && src[j] !== '"') {
        if (src[j] === '\\' && j + 1 < src.length) {
          const esc = src[j + 1]!;
          text += esc === 'n' ? '\n' : esc === 't' ? '\t' : esc === 'r' ? '\r' : esc;
          j += 2;
        } else {
          text += src[j]!;
          j += 1;
        }
      }
      out.push(JSON.stringify(text));
      i = j + 1;
      continue;
    }
    if (/[0-9-]/.test(c)) {
      let j = i;
      while (j < src.length && /[0-9.eE+-]/.test(src[j]!)) j += 1;
      out.push(src.slice(i, j));
      i = j;
      continue;
    }
    if (/[A-Za-z_]/.test(c)) {
      let j = i;
      while (j < src.length && /[A-Za-z0-9_]/.test(src[j]!)) j += 1;
      out.push(src.slice(i, j));
      i = j;
      continue;
    }
    i += 1;
  }
  return out;
}

// ---------------------------------------------------------------- parser

class DocumentParser {
  tokens: string[];
  pos = 0;
  variables: Record<string, GqlValue>;
  fragments = new Map<string, FieldNode[]>();

  constructor(src: string, variables: Record<string, GqlValue>) {
    this.tokens = lex(src);
    this.variables = variables;
  }

  peek(): string {
    return this.tokens[this.pos] ?? '';
  }

  take(): string {
    return this.tokens[this.pos++] ?? '';
  }

  expect(tok: string): void {
    if (this.take() !== tok) throw new Error(`expected ${tok}`);
  }

  readValue(): GqlValue {
    const tok = this.take();
    if (tok === '$') {
      const name = this.take();
      return this.variables[name] ?? null;
    }
    if (tok === '{') {
      const obj: Record<string, GqlValue> = {};
      while (this.peek() !== '}') {
        const key = this.take();
        this.expect(':');
        obj[key] = this.readValue();
      }
      this.expect('}');
      return obj;
    }
    if (tok === '[') {
      const arr: GqlValue[] = [];
      while (this.peek() !== ']') arr.push(this.readValue());
      this.expect(']');
      return arr;
    }
    if (tok === 'true') return true;
    if (tok === 'false') return false;
    if (tok === 'null') return null;
    if (tok.startsWith('"')) return JSON.parse(tok) as string;
    if (/^-?\d+(\.\d+)?([eE][+-]?\d+)?$/.test(tok)) return Number(tok);
    return tok; // enum literal
  }

  readArgs(): Record<string, GqlValue> {
    const args: Record<string, GqlValue> = {};
    if (this.peek() !== '(') return args;
    this.expect('(');
    while (this.peek() !== ')') {
      const key = this.take();
      this.expect(':');
      args[key] = this.readValue();
    }
    this.expect(')');
    return args;
  }

  readSelection(): FieldNode[] {
    this.expect('{');
    const fields: FieldNode[] = [];
    while (this.peek() !== '}') {
      if (this.peek() === '...') {
        this.take();
        if (this.peek() === 'on') {
          this.take();
          const typeName = this.take();
          const sub = this.readSelection();
          fields.push({ alias: null, name: '', args: {}, selection: sub, fragmentType: typeName });
        } else {
          const fragName = this.take();
          const sub = this.fragments.get(fragName) ?? [];
          fields.push({ alias: null, name: '', args: {}, selection: sub, fragmentType: null });
        }
        continue;
      }
      let alias: string | null = null;
      let name = this.take();
      if (this.peek() === ':') {
        this.take();
        alias = name;
        name = this.take();
      }
      const args = this.readArgs();
      const selection = this.peek() === '{' ? this.readSelection() : null;
      fields.push({ alias, name, args, selection, fragmentType: null });
    }
    this.expect('}');
    return fields;
  }

  readOperation(): Operation {
    let kind: 'query' | 'mutation' = 'query';
    const first = this.peek();
    if (first === 'query' || first === 'mutation') {
      kind = this.take() as 'query' | 'mutation';
    }
    let name: string | null = null;
    if (this.peek() !== '{' && this.peek() !== '(' && this.peek() !== '') {
      name = this.take();
    }
    // Variable definitions: ($x: Type! = default, ...)
    if (this.peek() === '(') {
      let depth = 0;
      while (this.pos < this.tokens.length) {
        const t = this.take();
        if (t === '(') depth += 1;
        else if (t === ')') {
          depth -= 1;
          if (depth === 0) break;
        }
      }
    }
    // Fragment definitions before the operation body are not used by the suite;
    // skip any `fragment X on Y { ... }` blocks.
    while (this.peek() === 'fragment') {
      this.take();
      this.take();
      this.take();
      this.take();
      this.readSelection();
    }
    const selection = this.readSelection();
    return { kind, name, variables: this.variables, selection };
  }
}

// ---------------------------------------------------------------- schema tables for __type

function tableOf(pairs: Array<[string, string[]]>): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const [name, fields] of pairs) out[name] = fields;
  return out;
}

const TYPE_FIELDS = tableOf([
  ['Issue', ['id', 'number', 'title', 'state', 'body', 'createdAt', 'updatedAt', 'author', 'labels', 'comments', 'url', 'repository']],
  ['PullRequest', ['id', 'number', 'title', 'body', 'state', 'merged', 'headRefName', 'baseRefName', 'mergeable', 'files', 'headRef', 'baseRef', 'author', 'createdAt', 'updatedAt', 'url', 'commits', 'reviews']],
  ['Repository', ['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest', 'description', 'url', 'createdAt', 'updatedAt']],
  ['User', ['login', 'id', 'name', 'email', 'url']],
  ['Query', ['viewer', 'repository', 'node', '__type']],
  ['Mutation', ['createIssue', 'closeIssue', 'createPullRequest', 'mergePullRequest', 'addComment']],
]);

const TYPE_ENUM_VALUES = tableOf([
  ['SearchType', ['ISSUE', 'REPOSITORY', 'USER', 'DISCUSSION', 'COMMIT', 'CODE']],
  ['IssueState', ['OPEN', 'CLOSED']],
  ['PullRequestState', ['OPEN', 'CLOSED', 'MERGED']],
  ['MergeableState', ['MERGEABLE', 'CONFLICTING', 'UNKNOWN']],
  ['RepositoryPermission', ['ADMIN', 'MAINTAIN', 'WRITE', 'TRIAGE', 'READ']],
  ['IssueOrderField', ['CREATED_AT', 'UPDATED_AT', 'COMMENTS']],
  ['OrderDirection', ['ASC', 'DESC']],
]);

// ---------------------------------------------------------------- executor

interface Ctx {
  store: Store;
  errors: GqlError[];
}

function addError(ctx: Ctx, message: string, path: (string | number)[]): void {
  ctx.errors.push({ message, path });
}

function decodeGlobalId(id: string): { kind: string; key: string } | null {
  try {
    const text = Buffer.from(id, 'base64url').toString('utf8');
    const colon = text.indexOf(':');
    if (colon < 0) return null;
    return { kind: text.slice(0, colon), key: text.slice(colon + 1) };
  } catch {
    return null;
  }
}

function repoByGlobalId(store: Store, id: string): Repo | undefined {
  const decoded = decodeGlobalId(id);
  if (!decoded || decoded.kind !== 'Repository') return undefined;
  const dbId = Number(decoded.key);
  return store.allRepos().find((r) => r.id === dbId);
}

function issueByGlobalId(store: Store, id: string): { repo: Repo; issue: Issue } | undefined {
  const decoded = decodeGlobalId(id);
  if (!decoded || decoded.kind !== 'Issue') return undefined;
  const [repoId, num] = decoded.key.split(':');
  const repo = store.allRepos().find((r) => r.id === Number(repoId));
  if (!repo) return undefined;
  const issue = repo.issues.get(Number(num));
  return issue ? { repo, issue } : undefined;
}

function pullByGlobalId(store: Store, id: string): { repo: Repo; pr: PullRequest } | undefined {
  const decoded = decodeGlobalId(id);
  if (!decoded || decoded.kind !== 'PullRequest') return undefined;
  const [repoId, num] = decoded.key.split(':');
  const repo = store.allRepos().find((r) => r.id === Number(repoId));
  if (!repo) return undefined;
  const pr = repo.pulls.get(Number(num));
  return pr ? { repo, pr } : undefined;
}

function issueStateName(issue: Issue): string {
  return issue.state === 'open' ? 'OPEN' : 'CLOSED';
}

function pullStateName(pr: PullRequest): string {
  if (pr.merged) return 'MERGED';
  return pr.state === 'open' ? 'OPEN' : 'CLOSED';
}

function resolveUser(ctx: Ctx, fields: FieldNode[], path: (string | number)[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const f of fields) {
    if (f.fragmentType) continue;
    const key = f.alias ?? f.name;
    if (f.name === 'login') {
      out[key] = ctx.store.viewer.login;
    } else if (f.name === 'id') {
      out[key] = globalId('User', String(ctx.store.viewer.id));
    } else if (f.name === 'name') {
      out[key] = ctx.store.viewer.name;
    } else {
      addError(ctx, `Cannot query field "${f.name}" on type "User".`, [...path, key]);
      out[key] = null;
    }
  }
  return out;
}

function resolveIssue(ctx: Ctx, repo: Repo, issue: Issue, fields: FieldNode[], path: (string | number)[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const f of fields) {
    if (f.fragmentType) continue;
    const key = f.alias ?? f.name;
    if (f.name === 'id') out[key] = issue.nodeId;
    else if (f.name === 'number') out[key] = issue.number;
    else if (f.name === 'title') out[key] = issue.title;
    else if (f.name === 'state') out[key] = issueStateName(issue);
    else if (f.name === 'body') out[key] = issue.body;
    else if (f.name === 'createdAt') out[key] = issue.createdAt;
    else if (f.name === 'updatedAt') out[key] = issue.updatedAt;
    else if (f.name === 'url') out[key] = `/${repo.owner}/${repo.name}/issues/${issue.number}`;
    else if (f.name === 'author') out[key] = f.selection ? resolveUser(ctx, f.selection, [...path, key]) : { login: issue.user };
    else if (f.name === 'labels') out[key] = { nodes: issue.labels.map((l) => ({ name: l })) };
    else if (f.name === 'comments') out[key] = { nodes: issue.comments.map((c) => ({ id: c.nodeId, body: c.body })) };
    else if (f.name === 'repository') out[key] = f.selection ? resolveRepo(ctx, repo, f.selection, [...path, key]) : null;
    else {
      addError(ctx, `Cannot query field "${f.name}" on type "Issue".`, [...path, key]);
      out[key] = null;
    }
  }
  return out;
}

function resolvePull(ctx: Ctx, repo: Repo, pr: PullRequest, fields: FieldNode[], path: (string | number)[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const f of fields) {
    if (f.fragmentType) continue;
    const key = f.alias ?? f.name;
    if (f.name === 'id') out[key] = pr.nodeId;
    else if (f.name === 'number') out[key] = pr.number;
    else if (f.name === 'title') out[key] = pr.title;
    else if (f.name === 'body') out[key] = pr.body;
    else if (f.name === 'state') out[key] = pullStateName(pr);
    else if (f.name === 'merged') out[key] = pr.merged;
    else if (f.name === 'headRefName') out[key] = pr.head;
    else if (f.name === 'baseRefName') out[key] = pr.base;
    else if (f.name === 'mergeable') out[key] = pr.mergeable;
    else if (f.name === 'files') out[key] = pullFilesConnection(repo, pr, f);
    else if (f.name === 'author') out[key] = f.selection ? resolveUser(ctx, f.selection, [...path, key]) : { login: pr.user };
    else if (f.name === 'createdAt') out[key] = pr.createdAt;
    else if (f.name === 'updatedAt') out[key] = pr.updatedAt;
    else if (f.name === 'url') out[key] = `/${repo.owner}/${repo.name}/pull/${pr.number}`;
    else {
      addError(ctx, `Cannot query field "${f.name}" on type "PullRequest".`, [...path, key]);
      out[key] = null;
    }
  }
  return out;
}

function pullFilesConnection(repo: Repo, pr: PullRequest, field: FieldNode): Record<string, unknown> {
  const first = typeof field.args['first'] === 'number' ? (field.args['first'] as number) : 10;
  const nodes = changedPaths(repo, pr).slice(0, first).map((p) => ({ path: p }));
  return { nodes };
}

function resolveRepo(ctx: Ctx, repo: Repo, fields: FieldNode[], path: (string | number)[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const f of fields) {
    if (f.fragmentType) continue;
    const key = f.alias ?? f.name;
    if (f.name === 'id') out[key] = globalId('Repository', String(repo.id));
    else if (f.name === 'databaseId') out[key] = repo.id;
    else if (f.name === 'name') out[key] = repo.name;
    else if (f.name === 'nameWithOwner') out[key] = `${repo.owner}/${repo.name}`;
    else if (f.name === 'owner') out[key] = f.selection ? resolveUser(ctx, f.selection, [...path, key]) : { login: repo.owner };
    else if (f.name === 'defaultBranchRef') {
      const tip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
      out[key] = tip ? { name: repo.defaultBranch } : null;
    }
    else if (f.name === 'viewerPermission') out[key] = 'ADMIN';
    else if (f.name === 'hasIssuesEnabled') out[key] = true;
    else if (f.name === 'description') out[key] = repo.description;
    else if (f.name === 'url') out[key] = `/${repo.owner}/${repo.name}`;
    else if (f.name === 'createdAt') out[key] = repo.createdAt;
    else if (f.name === 'updatedAt') out[key] = repo.updatedAt;
    else if (f.name === 'issue') {
      const num = f.args['number'];
      const issue = typeof num === 'number' ? repo.issues.get(num) : undefined;
      if (!issue) out[key] = null;
      else if (f.selection) out[key] = resolveIssue(ctx, repo, issue, f.selection, [...path, key]);
      else out[key] = { number: issue.number };
    }
    else if (f.name === 'issues') out[key] = issuesConnection(ctx, repo, f, [...path, key]);
    else if (f.name === 'pullRequests') {
      const first = typeof f.args['first'] === 'number' ? (f.args['first'] as number) : 10;
      const nodes = [...repo.pulls.values()].sort((a, b) => b.number - a.number).slice(0, first);
      const sub = f.selection?.find((s) => s.name === 'nodes');
      out[key] = { nodes: nodes.map((pr) => resolvePull(ctx, repo, pr, sub?.selection ?? [], [...path, key, 'nodes'])) };
    }
    else if (f.name === 'pullRequest') {
      const num = f.args['number'];
      const pr = typeof num === 'number' ? repo.pulls.get(num) : undefined;
      if (!pr) out[key] = null;
      else if (f.selection) out[key] = resolvePull(ctx, repo, pr, f.selection, [...path, key]);
      else out[key] = { number: pr.number };
    }
    else {
      addError(ctx, `Cannot query field "${f.name}" on type "Repository".`, [...path, key]);
      out[key] = null;
    }
  }
  return out;
}

function issuesConnection(ctx: Ctx, repo: Repo, field: FieldNode, path: (string | number)[]): Record<string, unknown> {
  const first = typeof field.args['first'] === 'number' ? (field.args['first'] as number) : 10;
  const states = Array.isArray(field.args['states']) ? (field.args['states'] as GqlValue[]).map(String) : null;
  const orderBy = (field.args['orderBy'] as Record<string, GqlValue> | undefined) ?? {};
  const orderField = String(orderBy['field'] ?? 'CREATED_AT');
  const direction = String(orderBy['direction'] ?? 'DESC');
  const after = field.args['after'];
  let list = [...repo.issues.values()];
  if (states) list = list.filter((i) => states.includes(issueStateName(i)));
  list.sort((a, b) => {
    let cmp = 0;
    if (orderField === 'COMMENTS') cmp = a.comments.length - b.comments.length;
    else if (orderField === 'UPDATED_AT') cmp = a.updatedAt < b.updatedAt ? -1 : a.updatedAt > b.updatedAt ? 1 : 0;
    else cmp = a.number - b.number; // CREATED_AT: creation order is number order
    if (cmp === 0) cmp = a.number - b.number;
    return direction === 'DESC' ? -cmp : cmp;
  });
  if (typeof after === 'string' && after !== '') {
    const decoded = decodeCursor(after);
    if (decoded !== null) {
      list = list.filter((i) => (direction === 'DESC' ? i.number < decoded : i.number > decoded));
    }
  }
  const page = list.slice(0, first);
  const hasNextPage = list.length > first;
  const endCursor = page.length ? encodeCursor(page[page.length - 1].number) : null;
  const nodesField = field.selection?.find((s) => s.name === 'nodes');
  const pageInfoField = field.selection?.find((s) => s.name === 'pageInfo');
  const nodes = page.map((issue) => resolveIssue(ctx, repo, issue, nodesField?.selection ?? [], [...path, 'nodes']));
  const pageInfo: Record<string, unknown> = {};
  if (pageInfoField?.selection) {
    for (const pf of pageInfoField.selection) {
      if (pf.name === 'hasNextPage') pageInfo[pf.alias ?? pf.name] = hasNextPage;
      else if (pf.name === 'endCursor') pageInfo[pf.alias ?? pf.name] = endCursor;
      else if (pf.name === 'hasPreviousPage') pageInfo[pf.alias ?? pf.name] = false;
      else if (pf.name === 'startCursor') pageInfo[pf.alias ?? pf.name] = page.length ? encodeCursor(page[0].number) : null;
    }
  }
  return { nodes, pageInfo };
}

function encodeCursor(n: number): string {
  return Buffer.from(`issue-cursor:${n}`, 'utf8').toString('base64url');
}

function decodeCursor(cursor: string): number | null {
  try {
    const text = Buffer.from(cursor, 'base64url').toString('utf8');
    const m = /^issue-cursor:(\d+)$/.exec(text);
    return m ? Number(m[1]) : null;
  } catch {
    return null;
  }
}

function changedPaths(repo: Repo, pr: PullRequest): string[] {
  // Changed paths between the merge-base tree and the head tree.
  const base = mergeBase(repo, pr.baseSha, pr.headSha) ?? pr.baseSha;
  const baseObj = repo.objects.get(base);
  const headObj = repo.objects.get(pr.headSha);
  if (!baseObj || !headObj) return [];
  const baseTree = flattenTree(repo, parseCommit(baseObj.data).tree);
  const headTree = flattenTree(repo, parseCommit(headObj.data).tree);
  const paths = new Set([...baseTree.keys(), ...headTree.keys()]);
  const out: string[] = [];
  for (const p of [...paths].sort()) {
    if (baseTree.get(p)?.oid !== headTree.get(p)?.oid) out.push(p);
  }
  return out;
}

function resolveType(ctx: Ctx, name: string, fields: FieldNode[], path: (string | number)[]): Record<string, unknown> | null {
  const out: Record<string, unknown> = {};
  for (const f of fields) {
    if (f.fragmentType) continue;
    const key = f.alias ?? f.name;
    if (f.name === 'name') {
      out[key] = name;
    } else if (f.name === 'kind') {
      out[key] = TYPE_ENUM_VALUES[name] ? 'ENUM' : 'OBJECT';
    } else if (f.name === 'fields') {
      const list = TYPE_FIELDS[name] ?? [];
      out[key] = list.map((n) => ({ name: n }));
    } else if (f.name === 'enumValues') {
      const list = TYPE_ENUM_VALUES[name] ?? [];
      out[key] = list.map((n) => ({ name: n }));
    } else {
      addError(ctx, `Cannot query field "${f.name}" on type "__Type".`, [...path, key]);
      out[key] = null;
    }
  }
  return out;
}

function runQueryField(ctx: Ctx, store: Store, f: FieldNode, data: Record<string, unknown>): void {
  const key = f.alias ?? f.name;
  if (f.name === 'viewer') {
    data[key] = f.selection ? resolveUser(ctx, f.selection, [key]) : { login: store.viewer.login };
  } else if (f.name === 'repository') {
    const owner = String(f.args['owner'] ?? '');
    const name = String(f.args['name'] ?? '');
    const repo = owner === store.viewer.login ? store.getRepo(owner, name) : undefined;
    if (!repo) data[key] = null;
    else if (f.selection) data[key] = resolveRepo(ctx, repo, f.selection, [key]);
    else data[key] = { name: repo.name };
  } else if (f.name === 'node') {
    const id = String(f.args['id'] ?? '');
    const decoded = decodeGlobalId(id);
    let node: Record<string, unknown> | null = null;
    if (decoded?.kind === 'Repository') {
      const repo = repoByGlobalId(store, id);
      if (repo) {
        node = { id };
        for (const sub of f.selection ?? []) {
          if (sub.fragmentType === 'Repository') {
            node = { ...node, ...resolveRepo(ctx, repo, sub.selection ?? [], [key]) };
          } else if (sub.name === 'id') node[sub.alias ?? sub.name] = id;
        }
      }
    } else if (decoded?.kind === 'Issue') {
      const found = issueByGlobalId(store, id);
      if (found) {
        node = { id };
        for (const sub of f.selection ?? []) {
          if (sub.fragmentType === 'Issue') node = { ...node, ...resolveIssue(ctx, found.repo, found.issue, sub.selection ?? [], [key]) };
          else if (sub.name === 'id') node[sub.alias ?? sub.name] = id;
        }
      }
    }
    data[key] = node;
  } else if (f.name === '__type') {
    const name = String(f.args['name'] ?? '');
    if (!TYPE_FIELDS[name] && !TYPE_ENUM_VALUES[name]) data[key] = null;
    else data[key] = f.selection ? resolveType(ctx, name, f.selection, [key]) : { name };
  } else {
    addError(ctx, `Cannot query field "${f.name}" on type "Query".`, [key]);
    data[key] = null;
  }
}

function runMutationField(ctx: Ctx, store: Store, f: FieldNode, data: Record<string, unknown>): void {
  const key = f.alias ?? f.name;
  const input = (f.args['input'] as Record<string, GqlValue> | undefined) ?? {};
  if (f.name === 'createIssue') {
    const repo = repoByGlobalId(store, String(input['repositoryId'] ?? ''));
    if (!repo) {
      addError(ctx, 'Could not resolve to a Repository with the id provided.', [key]);
      data[key] = null;
    } else {
      const number = repo.nextIssue++;
      const now = store.nowIso();
      const issue = {} as Issue;
      issue.number = number;
      issue.id = repo.id * 100000 + number;
      issue.nodeId = globalId('Issue', `${repo.id}:${number}`);
      issue.title = String(input['title'] ?? '');
      issue.body = typeof input['body'] === 'string' ? input['body'] : '';
      issue.state = 'open';
      issue.labels = [];
      issue.user = store.viewer.login;
      issue.comments = [];
      issue.createdAt = now;
      issue.updatedAt = now;
      issue.seq = number;
      repo.issues.set(number, issue);
      const sub = f.selection?.find((s) => s.name === 'issue');
      data[key] = { issue: sub?.selection ? resolveIssue(ctx, repo, issue, sub.selection, [key, 'issue']) : { number: issue.number, id: issue.nodeId } };
    }
  } else if (f.name === 'closeIssue') {
    const found = issueByGlobalId(store, String(input['issueId'] ?? ''));
    if (!found) {
      addError(ctx, 'Could not resolve to an Issue with the id provided.', [key]);
      data[key] = null;
    } else {
      found.issue.state = 'closed';
      found.issue.updatedAt = store.nowIso();
      dropIssueBody(found.repo, found.issue.number);
      const sub = f.selection?.find((s) => s.name === 'issue');
      data[key] = { issue: sub?.selection ? resolveIssue(ctx, found.repo, found.issue, sub.selection, [key, 'issue']) : { number: found.issue.number, id: found.issue.nodeId, state: 'CLOSED' } };
    }
  } else if (f.name === 'createPullRequest') {
    const repo = repoByGlobalId(store, String(input['repositoryId'] ?? ''));
    const head = String(input['headRefName'] ?? '');
    const base = String(input['baseRefName'] ?? repo?.defaultBranch ?? 'main');
    if (!repo) {
      addError(ctx, 'Could not resolve to a Repository with the id provided.', [key]);
      data[key] = null;
    } else {
      const headSha = repo.refs.get(`refs/heads/${head}`);
      const baseSha = repo.refs.get(`refs/heads/${base}`);
      if (!headSha || !baseSha) {
        addError(ctx, 'Head or base ref does not exist.', [key]);
        data[key] = null;
      } else {
        const number = repo.nextPull++;
        const now = store.nowIso();
        const pr = {} as PullRequest;
        pr.number = number;
        pr.id = repo.id * 100000 + number;
        pr.nodeId = globalId('PullRequest', `${repo.id}:${number}`);
        pr.title = String(input['title'] ?? '');
        pr.body = typeof input['body'] === 'string' ? input['body'] : '';
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
        pr.mergeable = mb === null ? 'CONFLICTING' : threeWayMerge(repo, baseSha, headSha, mb).conflicts.length ? 'CONFLICTING' : 'MERGEABLE';
        repo.pulls.set(number, pr);
        const sub = f.selection?.find((s) => s.name === 'pullRequest');
        data[key] = { pullRequest: sub?.selection ? resolvePull(ctx, repo, pr, sub.selection, [key, 'pullRequest']) : { number: pr.number, id: pr.nodeId, state: 'OPEN', headRefName: head, baseRefName: base } };
      }
    }
  } else if (f.name === 'mergePullRequest') {
    const found = pullByGlobalId(store, String(input['pullRequestId'] ?? ''));
    if (!found) {
      addError(ctx, 'Could not resolve to a PullRequest with the id provided.', [key]);
      data[key] = null;
    } else {
      const { repo, pr } = found;
      if (!pr.merged && pr.state === 'open') {
        const baseTip = repo.refs.get(`refs/heads/${pr.base}`) ?? pr.baseSha;
        const headTip = repo.refs.get(`refs/heads/${pr.head}`) ?? pr.headSha;
        const mb = mergeBase(repo, baseTip, headTip);
        if (mb !== null) {
          const merged = threeWayMerge(repo, baseTip, headTip, mb);
          if (!merged.conflicts.length) {
            const treeOid = buildTreeFromMap(repo, merged.tree);
            const epoch = store.nowSec();
            const author = ident(store.viewer.name, store.viewer.email, epoch);
            const sha = storeObject(repo, 'commit', buildCommit({ tree: treeOid, parents: [baseTip], author, committer: author, message: `${pr.title} (#${pr.number})` }));
            repo.refs.set(`refs/heads/${pr.base}`, sha);
            pr.state = 'closed';
            pr.merged = true;
            pr.mergeCommitSha = sha;
            pr.updatedAt = store.nowIso();
          }
        }
      }
      const sub = f.selection?.find((s) => s.name === 'pullRequest');
      data[key] = { pullRequest: sub?.selection ? resolvePull(ctx, repo, pr, sub.selection, [key, 'pullRequest']) : { number: pr.number, merged: pr.merged, state: pullStateName(pr) } };
    }
  } else if (f.name === 'addComment') {
    const found = issueByGlobalId(store, String(input['subjectId'] ?? ''));
    if (!found) {
      addError(ctx, 'Could not resolve to an Issue with the id provided.', [key]);
      data[key] = null;
    } else {
      const now = store.nowIso();
      const comment = {} as Issue['comments'][number];
      comment.id = found.repo.id * 1000000 + found.repo.nextCommentId++;
      comment.nodeId = globalId('IssueComment', `${found.repo.id}:${found.issue.number}:${found.repo.nextCommentId}`);
      comment.body = String(input['body'] ?? '');
      comment.user = store.viewer.login;
      comment.createdAt = now;
      comment.updatedAt = now;
      found.issue.comments.push(comment);
      dropIssueBody(found.repo, found.issue.number);
      data[key] = { commentEdge: { node: { id: comment.nodeId, body: comment.body } } };
    }
  } else {
    addError(ctx, `Cannot query field "${f.name}" on type "Mutation".`, [key]);
    data[key] = null;
  }
}

function executeOperation(store: Store, op: Operation): { data: Record<string, unknown> | null; errors?: GqlError[] } {
  const ctx: Ctx = { store, errors: [] };
  const data: Record<string, unknown> = {};
  for (const f of op.selection) {
    if (f.fragmentType) continue;
    if (op.kind === 'query') runQueryField(ctx, store, f, data);
    else runMutationField(ctx, store, f, data);
  }
  return ctx.errors.length ? { data, errors: ctx.errors } : { data };
}

/** Run one GraphQL operation document (or a batch array of them). */
export function handleGraphQL(store: Store, body: unknown): { status: number; payload: unknown } {
  if (Array.isArray(body)) {
    if (body.length === 0) return { status: 400, payload: { errors: [{ message: 'Batch must contain at least one operation.' }] } };
    const out = body.map((item) => runOne(store, item));
    return { status: 200, payload: out };
  }
  return { status: 200, payload: runOne(store, body) };
}

function runOne(store: Store, item: unknown): Record<string, unknown> {
  if (typeof item !== 'object' || item === null) {
    return { data: null, errors: [{ message: 'Request body must be a JSON object.' }] };
  }
  const { query, variables } = item as { query?: unknown; variables?: unknown };
  if (typeof query !== 'string' || query.trim() === '') {
    return { data: null, errors: [{ message: 'No query provided.' }] };
  }
  const vars = (variables !== null && typeof variables === 'object' && !Array.isArray(variables) ? variables : {}) as Record<string, GqlValue>;
  try {
    const op = new DocumentParser(query, vars).readOperation();
    return executeOperation(store, op);
  } catch (e) {
    return { data: null, errors: [{ message: e instanceof Error ? e.message : 'Parse error.' }] };
  }
}
