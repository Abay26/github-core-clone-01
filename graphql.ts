// GraphQL v4 for the documents gh and github-mcp-server send: a small parser and
// executor over the store. Unknown fields are HTTP 200 with an `errors` array
// naming the field; an unknown repository is data.repository = null, no errors.

import type { Issue, PullRequest, Repo, Store } from './store.ts';
import { globalId } from './store.ts';
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

// ---------------------------------------------------------------- parser

type Value = string | number | boolean | null | Value[] | { [key: string]: Value };

interface FieldNode {
  alias: string | null;
  name: string;
  args: Record<string, Value>;
  selection: FieldNode[] | null;
  fragmentType: string | null;
}

interface Operation {
  kind: 'query' | 'mutation';
  name: string | null;
  variables: Record<string, Value>;
  selection: FieldNode[];
}

interface GqlError {
  message: string;
  path?: (string | number)[];
}

function tokenize(src: string): string[] {
  const tokens: string[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === ',') {
      i += 1;
      continue;
    }
    if (c === '#') {
      while (i < src.length && src[i] !== '\n') i += 1;
      continue;
    }
    if (c === '.' && src.slice(i, i + 3) === '...') {
      tokens.push('...');
      i += 3;
      continue;
    }
    if ('{}():[]!=$@'.includes(c)) {
      tokens.push(c);
      i += 1;
      continue;
    }
    if (c === '"') {
      let j = i + 1;
      let out = '';
      while (j < src.length && src[j] !== '"') {
        if (src[j] === '\\' && j + 1 < src.length) {
          const esc = src[j + 1];
          out += esc === 'n' ? '\n' : esc === 't' ? '\t' : esc === 'r' ? '\r' : esc;
          j += 2;
        } else {
          out += src[j];
          j += 1;
        }
      }
      tokens.push(JSON.stringify(out));
      i = j + 1;
      continue;
    }
    if (/[0-9-]/.test(c)) {
      let j = i;
      while (j < src.length && /[0-9.eE+-]/.test(src[j])) j += 1;
      tokens.push(src.slice(i, j));
      i = j;
      continue;
    }
    if (/[A-Za-z_]/.test(c)) {
      let j = i;
      while (j < src.length && /[A-Za-z0-9_]/.test(src[j])) j += 1;
      tokens.push(src.slice(i, j));
      i = j;
      continue;
    }
    i += 1;
  }
  return tokens;
}

class Parser {
  tokens: string[];
  pos = 0;
  variables: Record<string, Value>;
  fragments = new Map<string, FieldNode[]>();

  constructor(src: string, variables: Record<string, Value>) {
    this.tokens = tokenize(src);
    this.variables = variables;
  }

  peek(): string {
    return this.tokens[this.pos] ?? '';
  }

  next(): string {
    return this.tokens[this.pos++] ?? '';
  }

  expect(tok: string): void {
    if (this.next() !== tok) throw new Error(`expected ${tok}`);
  }

  parseValue(): Value {
    const tok = this.next();
    if (tok === '$') {
      const name = this.next();
      return this.variables[name] ?? null;
    }
    if (tok === '{') {
      const obj: Record<string, Value> = {};
      while (this.peek() !== '}') {
        const key = this.next();
        this.expect(':');
        obj[key] = this.parseValue();
      }
      this.expect('}');
      return obj;
    }
    if (tok === '[') {
      const arr: Value[] = [];
      while (this.peek() !== ']') arr.push(this.parseValue());
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

  parseArgs(): Record<string, Value> {
    const args: Record<string, Value> = {};
    if (this.peek() !== '(') return args;
    this.expect('(');
    while (this.peek() !== ')') {
      const key = this.next();
      this.expect(':');
      args[key] = this.parseValue();
    }
    this.expect(')');
    return args;
  }

  parseSelection(): FieldNode[] {
    this.expect('{');
    const fields: FieldNode[] = [];
    while (this.peek() !== '}') {
      if (this.peek() === '...') {
        this.next();
        if (this.peek() === 'on') {
          this.next();
          const typeName = this.next();
          const sub = this.parseSelection();
          fields.push({ alias: null, name: '', args: {}, selection: sub, fragmentType: typeName });
        } else {
          const fragName = this.next();
          const sub = this.fragments.get(fragName) ?? [];
          fields.push({ alias: null, name: '', args: {}, selection: sub, fragmentType: null });
        }
        continue;
      }
      let alias: string | null = null;
      let name = this.next();
      if (this.peek() === ':') {
        this.next();
        alias = name;
        name = this.next();
      }
      const args = this.parseArgs();
      const selection = this.peek() === '{' ? this.parseSelection() : null;
      fields.push({ alias, name, args, selection, fragmentType: null });
    }
    this.expect('}');
    return fields;
  }

  parseOperation(): Operation {
    let kind: 'query' | 'mutation' = 'query';
    const first = this.peek();
    if (first === 'query' || first === 'mutation') {
      kind = this.next() as 'query' | 'mutation';
    }
    let name: string | null = null;
    if (this.peek() !== '{' && this.peek() !== '(' && this.peek() !== '') {
      name = this.next();
    }
    // Variable definitions: ($x: Type! = default, ...)
    if (this.peek() === '(') {
      let depth = 0;
      while (this.pos < this.tokens.length) {
        const t = this.next();
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
      this.next();
      this.next();
      this.next();
      this.next();
      this.parseSelection();
    }
    const selection = this.parseSelection();
    return { kind, name, variables: this.variables, selection };
  }
}

// ---------------------------------------------------------------- schema tables for __type

const TYPE_FIELDS: Record<string, string[]> = {
  Issue: ['id', 'number', 'title', 'state', 'body', 'createdAt', 'updatedAt', 'author', 'labels', 'comments', 'url', 'repository'],
  PullRequest: ['id', 'number', 'title', 'body', 'state', 'merged', 'headRefName', 'baseRefName', 'mergeable', 'files', 'headRef', 'baseRef', 'author', 'createdAt', 'updatedAt', 'url', 'commits', 'reviews'],
  Repository: ['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest', 'description', 'url', 'createdAt', 'updatedAt'],
  User: ['login', 'id', 'name', 'email', 'url'],
  Query: ['viewer', 'repository', 'node', '__type'],
  Mutation: ['createIssue', 'closeIssue', 'createPullRequest', 'mergePullRequest', 'addComment'],
};

const TYPE_ENUM_VALUES: Record<string, string[]> = {
  SearchType: ['ISSUE', 'REPOSITORY', 'USER', 'DISCUSSION', 'COMMIT', 'CODE'],
  IssueState: ['OPEN', 'CLOSED'],
  PullRequestState: ['OPEN', 'CLOSED', 'MERGED'],
  MergeableState: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'],
  RepositoryPermission: ['ADMIN', 'MAINTAIN', 'WRITE', 'TRIAGE', 'READ'],
  IssueOrderField: ['CREATED_AT', 'UPDATED_AT', 'COMMENTS'],
  OrderDirection: ['ASC', 'DESC'],
};

// ---------------------------------------------------------------- executor

interface Ctx {
  store: Store;
  errors: GqlError[];
}

function err(ctx: Ctx, message: string, path: (string | number)[]): void {
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

function findRepoByGlobalId(store: Store, id: string): Repo | undefined {
  const decoded = decodeGlobalId(id);
  if (!decoded || decoded.kind !== 'Repository') return undefined;
  const dbId = Number(decoded.key);
  return store.allRepos().find((r) => r.id === dbId);
}

function findIssueByGlobalId(store: Store, id: string): { repo: Repo; issue: Issue } | undefined {
  const decoded = decodeGlobalId(id);
  if (!decoded || decoded.kind !== 'Issue') return undefined;
  const [repoId, num] = decoded.key.split(':');
  const repo = store.allRepos().find((r) => r.id === Number(repoId));
  if (!repo) return undefined;
  const issue = repo.issues.get(Number(num));
  return issue ? { repo, issue } : undefined;
}

function findPullByGlobalId(store: Store, id: string): { repo: Repo; pr: PullRequest } | undefined {
  const decoded = decodeGlobalId(id);
  if (!decoded || decoded.kind !== 'PullRequest') return undefined;
  const [repoId, num] = decoded.key.split(':');
  const repo = store.allRepos().find((r) => r.id === Number(repoId));
  if (!repo) return undefined;
  const pr = repo.pulls.get(Number(num));
  return pr ? { repo, pr } : undefined;
}

function issueState(issue: Issue): string {
  return issue.state === 'open' ? 'OPEN' : 'CLOSED';
}

function prState(pr: PullRequest): string {
  if (pr.merged) return 'MERGED';
  return pr.state === 'open' ? 'OPEN' : 'CLOSED';
}

function issueValue(ctx: Ctx, repo: Repo, issue: Issue, fields: FieldNode[], path: (string | number)[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const f of fields) {
    if (f.fragmentType) continue;
    const key = f.alias ?? f.name;
    switch (f.name) {
      case 'id': out[key] = issue.nodeId; break;
      case 'number': out[key] = issue.number; break;
      case 'title': out[key] = issue.title; break;
      case 'state': out[key] = issueState(issue); break;
      case 'body': out[key] = issue.body; break;
      case 'createdAt': out[key] = issue.createdAt; break;
      case 'updatedAt': out[key] = issue.updatedAt; break;
      case 'url': out[key] = `/${repo.owner}/${repo.name}/issues/${issue.number}`; break;
      case 'author': out[key] = f.selection ? userValue(ctx, repo, f.selection, [...path, key]) : { login: issue.user }; break;
      case 'labels': out[key] = { nodes: issue.labels.map((l) => ({ name: l })) }; break;
      case 'comments': out[key] = { nodes: issue.comments.map((c) => ({ id: c.nodeId, body: c.body })) }; break;
      case 'repository': out[key] = f.selection ? repoValue(ctx, repo, f.selection, [...path, key]) : null; break;
      default:
        err(ctx, `Cannot query field "${f.name}" on type "Issue".`, [...path, key]);
        out[key] = null;
    }
  }
  return out;
}

function userValue(ctx: Ctx, _repo: Repo, fields: FieldNode[], path: (string | number)[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const f of fields) {
    if (f.fragmentType) continue;
    const key = f.alias ?? f.name;
    if (f.name === 'login') out[key] = ctx.store.viewer.login;
    else if (f.name === 'id') out[key] = globalId('User', String(ctx.store.viewer.id));
    else if (f.name === 'name') out[key] = ctx.store.viewer.name;
    else {
      err(ctx, `Cannot query field "${f.name}" on type "User".`, [...path, key]);
      out[key] = null;
    }
  }
  return out;
}

function prValue(ctx: Ctx, repo: Repo, pr: PullRequest, fields: FieldNode[], path: (string | number)[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const f of fields) {
    if (f.fragmentType) continue;
    const key = f.alias ?? f.name;
    switch (f.name) {
      case 'id': out[key] = pr.nodeId; break;
      case 'number': out[key] = pr.number; break;
      case 'title': out[key] = pr.title; break;
      case 'body': out[key] = pr.body; break;
      case 'state': out[key] = prState(pr); break;
      case 'merged': out[key] = pr.merged; break;
      case 'headRefName': out[key] = pr.head; break;
      case 'baseRefName': out[key] = pr.base; break;
      case 'mergeable': out[key] = pr.mergeable; break;
      case 'files': out[key] = prFilesValue(ctx, repo, pr, f); break;
      case 'author': out[key] = f.selection ? userValue(ctx, repo, f.selection, [...path, key]) : { login: pr.user }; break;
      case 'createdAt': out[key] = pr.createdAt; break;
      case 'updatedAt': out[key] = pr.updatedAt; break;
      case 'url': out[key] = `/${repo.owner}/${repo.name}/pull/${pr.number}`; break;
      default:
        err(ctx, `Cannot query field "${f.name}" on type "PullRequest".`, [...path, key]);
        out[key] = null;
    }
  }
  return out;
}

function prFilesValue(ctx: Ctx, repo: Repo, pr: PullRequest, field: FieldNode): Record<string, unknown> {
  void ctx;
  const first = typeof field.args['first'] === 'number' ? (field.args['first'] as number) : 10;
  const nodes = prChangedPaths(repo, pr).slice(0, first).map((p) => ({ path: p }));
  return { nodes };
}

function repoValue(ctx: Ctx, repo: Repo, fields: FieldNode[], path: (string | number)[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const f of fields) {
    if (f.fragmentType) continue;
    const key = f.alias ?? f.name;
    switch (f.name) {
      case 'id': out[key] = globalId('Repository', String(repo.id)); break;
      case 'databaseId': out[key] = repo.id; break;
      case 'name': out[key] = repo.name; break;
      case 'nameWithOwner': out[key] = `${repo.owner}/${repo.name}`; break;
      case 'owner': out[key] = f.selection ? userValue(ctx, repo, f.selection, [...path, key]) : { login: repo.owner }; break;
      case 'defaultBranchRef': {
        const tip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
        out[key] = tip ? { name: repo.defaultBranch } : null;
        break;
      }
      case 'viewerPermission': out[key] = 'ADMIN'; break;
      case 'hasIssuesEnabled': out[key] = true; break;
      case 'description': out[key] = repo.description; break;
      case 'url': out[key] = `/${repo.owner}/${repo.name}`; break;
      case 'createdAt': out[key] = repo.createdAt; break;
      case 'updatedAt': out[key] = repo.updatedAt; break;
      case 'issue': {
        const num = f.args['number'];
        const issue = typeof num === 'number' ? repo.issues.get(num) : undefined;
        out[key] = issue && f.selection ? issueValue(ctx, repo, issue, f.selection, [...path, key]) : issue ? { number: issue.number } : null;
        break;
      }
      case 'issues': out[key] = issuesConnection(ctx, repo, f, [...path, key]); break;
      case 'pullRequests': {
        const first = typeof f.args['first'] === 'number' ? (f.args['first'] as number) : 10;
        const nodes = [...repo.pulls.values()].sort((a, b) => b.number - a.number).slice(0, first);
        const sub = f.selection?.find((s) => s.name === 'nodes');
        out[key] = { nodes: nodes.map((pr) => prValue(ctx, repo, pr, sub?.selection ?? [], [...path, key, 'nodes'])) };
        break;
      }
      case 'pullRequest': {
        const num = f.args['number'];
        const pr = typeof num === 'number' ? repo.pulls.get(num) : undefined;
        out[key] = pr && f.selection ? prValue(ctx, repo, pr, f.selection, [...path, key]) : pr ? { number: pr.number } : null;
        break;
      }
      default:
        err(ctx, `Cannot query field "${f.name}" on type "Repository".`, [...path, key]);
        out[key] = null;
    }
  }
  return out;
}

function issuesConnection(ctx: Ctx, repo: Repo, field: FieldNode, path: (string | number)[]): Record<string, unknown> {
  const first = typeof field.args['first'] === 'number' ? (field.args['first'] as number) : 10;
  const states = Array.isArray(field.args['states']) ? (field.args['states'] as Value[]).map(String) : null;
  const orderBy = (field.args['orderBy'] as Record<string, Value> | undefined) ?? {};
  const orderField = String(orderBy['field'] ?? 'CREATED_AT');
  const direction = String(orderBy['direction'] ?? 'DESC');
  const after = field.args['after'];
  let list = [...repo.issues.values()];
  if (states) list = list.filter((i) => states.includes(issueState(i)));
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
  const nodes = page.map((issue) => issueValue(ctx, repo, issue, nodesField?.selection ?? [], [...path, 'nodes']));
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

function prChangedPaths(repo: Repo, pr: PullRequest): string[] {
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

function typeValue(ctx: Ctx, name: string, fields: FieldNode[], path: (string | number)[]): Record<string, unknown> | null {
  const out: Record<string, unknown> = {};
  for (const f of fields) {
    if (f.fragmentType) continue;
    const key = f.alias ?? f.name;
    if (f.name === 'name') out[key] = name;
    else if (f.name === 'kind') out[key] = TYPE_ENUM_VALUES[name] ? 'ENUM' : 'OBJECT';
    else if (f.name === 'fields') {
      const list = TYPE_FIELDS[name] ?? [];
      out[key] = list.map((n) => ({ name: n }));
    } else if (f.name === 'enumValues') {
      const list = TYPE_ENUM_VALUES[name] ?? [];
      out[key] = list.map((n) => ({ name: n }));
    } else {
      err(ctx, `Cannot query field "${f.name}" on type "__Type".`, [...path, key]);
      out[key] = null;
    }
  }
  return out;
}

function executeOperation(store: Store, op: Operation): { data: Record<string, unknown> | null; errors?: GqlError[] } {
  const ctx: Ctx = { store, errors: [] };
  const data: Record<string, unknown> = {};
  for (const f of op.selection) {
    if (f.fragmentType) continue;
    const key = f.alias ?? f.name;
    if (op.kind === 'query') {
      switch (f.name) {
        case 'viewer':
          data[key] = f.selection ? userValue(ctx, store as unknown as Repo, f.selection, [key]) : { login: store.viewer.login };
          break;
        case 'repository': {
          const owner = String(f.args['owner'] ?? '');
          const name = String(f.args['name'] ?? '');
          const repo = owner === store.viewer.login ? store.getRepo(owner, name) : undefined;
          data[key] = repo && f.selection ? repoValue(ctx, repo, f.selection, [key]) : repo ? { name: repo.name } : null;
          break;
        }
        case 'node': {
          const id = String(f.args['id'] ?? '');
          const decoded = decodeGlobalId(id);
          let node: Record<string, unknown> | null = null;
          if (decoded?.kind === 'Repository') {
            const repo = findRepoByGlobalId(store, id);
            if (repo) {
              node = { id };
              for (const sub of f.selection ?? []) {
                if (sub.fragmentType === 'Repository') {
                  node = { ...node, ...repoValue(ctx, repo, sub.selection ?? [], [key]) };
                } else if (sub.name === 'id') node[sub.alias ?? sub.name] = id;
              }
            }
          } else if (decoded?.kind === 'Issue') {
            const found = findIssueByGlobalId(store, id);
            if (found) {
              node = { id };
              for (const sub of f.selection ?? []) {
                if (sub.fragmentType === 'Issue') node = { ...node, ...issueValue(ctx, found.repo, found.issue, sub.selection ?? [], [key]) };
                else if (sub.name === 'id') node[sub.alias ?? sub.name] = id;
              }
            }
          }
          data[key] = node;
          break;
        }
        case '__type': {
          const name = String(f.args['name'] ?? '');
          if (!TYPE_FIELDS[name] && !TYPE_ENUM_VALUES[name]) data[key] = null;
          else data[key] = f.selection ? typeValue(ctx, name, f.selection, [key]) : { name };
          break;
        }
        default:
          err(ctx, `Cannot query field "${f.name}" on type "Query".`, [key]);
          data[key] = null;
      }
    } else {
      // Mutations.
      const input = (f.args['input'] as Record<string, Value> | undefined) ?? {};
      switch (f.name) {
        case 'createIssue': {
          const repo = findRepoByGlobalId(store, String(input['repositoryId'] ?? ''));
          if (!repo) {
            err(ctx, 'Could not resolve to a Repository with the id provided.', [key]);
            data[key] = null;
            break;
          }
          const number = repo.nextIssue++;
          const now = store.nowIso();
          const issue: Issue = {
            number,
            id: repo.id * 100000 + number,
            nodeId: globalId('Issue', `${repo.id}:${number}`),
            title: String(input['title'] ?? ''),
            body: typeof input['body'] === 'string' ? input['body'] : '',
            state: 'open',
            labels: [],
            user: store.viewer.login,
            comments: [],
            createdAt: now,
            updatedAt: now,
            seq: number,
          };
          repo.issues.set(number, issue);
          const sub = f.selection?.find((s) => s.name === 'issue');
          data[key] = { issue: sub?.selection ? issueValue(ctx, repo, issue, sub.selection, [key, 'issue']) : { number: issue.number, id: issue.nodeId } };
          break;
        }
        case 'closeIssue': {
          const found = findIssueByGlobalId(store, String(input['issueId'] ?? ''));
          if (!found) {
            err(ctx, 'Could not resolve to an Issue with the id provided.', [key]);
            data[key] = null;
            break;
          }
          found.issue.state = 'closed';
          found.issue.updatedAt = store.nowIso();
          const sub = f.selection?.find((s) => s.name === 'issue');
          data[key] = { issue: sub?.selection ? issueValue(ctx, found.repo, found.issue, sub.selection, [key, 'issue']) : { number: found.issue.number, id: found.issue.nodeId, state: 'CLOSED' } };
          break;
        }
        case 'createPullRequest': {
          const repo = findRepoByGlobalId(store, String(input['repositoryId'] ?? ''));
          const head = String(input['headRefName'] ?? '');
          const base = String(input['baseRefName'] ?? repo?.defaultBranch ?? 'main');
          if (!repo) {
            err(ctx, 'Could not resolve to a Repository with the id provided.', [key]);
            data[key] = null;
            break;
          }
          const headSha = repo.refs.get(`refs/heads/${head}`);
          const baseSha = repo.refs.get(`refs/heads/${base}`);
          if (!headSha || !baseSha) {
            err(ctx, 'Head or base ref does not exist.', [key]);
            data[key] = null;
            break;
          }
          const number = repo.nextPull++;
          const now = store.nowIso();
          const pr: PullRequest = {
            number,
            id: repo.id * 100000 + number,
            nodeId: globalId('PullRequest', `${repo.id}:${number}`),
            title: String(input['title'] ?? ''),
            body: typeof input['body'] === 'string' ? input['body'] : '',
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
          const sub = f.selection?.find((s) => s.name === 'pullRequest');
          data[key] = { pullRequest: sub?.selection ? prValue(ctx, repo, pr, sub.selection, [key, 'pullRequest']) : { number: pr.number, id: pr.nodeId, state: 'OPEN', headRefName: head, baseRefName: base } };
          break;
        }
        case 'mergePullRequest': {
          const found = findPullByGlobalId(store, String(input['pullRequestId'] ?? ''));
          if (!found) {
            err(ctx, 'Could not resolve to a PullRequest with the id provided.', [key]);
            data[key] = null;
            break;
          }
          const { repo, pr } = found;
          if (!pr.merged && pr.state === 'open') {
            const baseTip = repo.refs.get(`refs/heads/${pr.base}`) ?? pr.baseSha;
            const headTip = repo.refs.get(`refs/heads/${pr.head}`) ?? pr.headSha;
            const mb = mergeBase(repo, baseTip, headTip);
            if (mb !== null) {
              const { tree, conflicts } = threeWayMerge(repo, baseTip, headTip, mb);
              if (!conflicts.length) {
                const treeOid = buildTreeFromMap(repo, tree);
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
          data[key] = { pullRequest: sub?.selection ? prValue(ctx, repo, pr, sub.selection, [key, 'pullRequest']) : { number: pr.number, merged: pr.merged, state: prState(pr) } };
          break;
        }
        case 'addComment': {
          const found = findIssueByGlobalId(store, String(input['subjectId'] ?? ''));
          if (!found) {
            err(ctx, 'Could not resolve to an Issue with the id provided.', [key]);
            data[key] = null;
            break;
          }
          const now = store.nowIso();
          const comment = {
            id: found.repo.id * 1000000 + found.repo.nextCommentId++,
            nodeId: globalId('IssueComment', `${found.repo.id}:${found.issue.number}:${found.repo.nextCommentId}`),
            body: String(input['body'] ?? ''),
            user: store.viewer.login,
            createdAt: now,
            updatedAt: now,
          };
          found.issue.comments.push(comment);
          data[key] = { commentEdge: { node: { id: comment.nodeId, body: comment.body } } };
          break;
        }
        default:
          err(ctx, `Cannot query field "${f.name}" on type "Mutation".`, [key]);
          data[key] = null;
      }
    }
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
  const vars = (variables !== null && typeof variables === 'object' && !Array.isArray(variables) ? variables : {}) as Record<string, Value>;
  try {
    const op = new Parser(query, vars).parseOperation();
    return executeOperation(store, op);
  } catch (e) {
    return { data: null, errors: [{ message: e instanceof Error ? e.message : 'Parse error.' }] };
  }
}
