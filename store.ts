// The forge's store: every object the four surfaces serve lives here, in memory.
// Nothing is written to disk and nothing carries a wall-clock time, so two runs of
// the same trial leave the same state.
//
// The viewer is the bearer token's owner. The token itself is opaque (shpat_<hex>),
// so the login comes from the one public, constant scenario seed the suite builds
// its data from: the same splitmix64/xorshift64* stream and the same name lists the
// suite's wire contract uses. Re-deriving it here keeps the forge honest about who
// the token names without ever reading the suite's files at run time.

const U64_MASK = 0xffffffffffffffffn;

function fnv1a64(text: string): bigint {
  let hash = 0xcbf29ce484222325n;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= BigInt(text.charCodeAt(i));
    hash = (hash * 0x100000001b3n) & U64_MASK;
  }
  return hash;
}

function mix64(value: bigint): bigint {
  let z = (value + 0x9e3779b97f4a7c15n) & U64_MASK;
  z = ((z ^ (z >> 30n)) * 0xbf58476d1ce4e5b9n) & U64_MASK;
  z = ((z ^ (z >> 27n)) * 0x94d049bb133111ebn) & U64_MASK;
  return (z ^ (z >> 31n)) & U64_MASK;
}

class Rng {
  #state: bigint;
  constructor(seed: bigint) {
    const masked = seed & U64_MASK;
    this.#state = masked === 0n ? 0x6a09e667f3bcc909n : masked;
  }
  nextU64(): bigint {
    let x = this.#state;
    x = (x ^ (x >> 12n)) & U64_MASK;
    x = (x ^ (x << 25n)) & U64_MASK;
    x = (x ^ (x >> 27n)) & U64_MASK;
    this.#state = x;
    return (x * 0x2545f4914f6cdd1dn) & U64_MASK;
  }
  nextU32(): number {
    return Number(this.nextU64() >> 32n);
  }
  nextInt(maxExclusive: number): number {
    if (maxExclusive === 1) return 0;
    const range = 4_294_967_296;
    const limit = range - (range % maxExclusive);
    for (;;) {
      const value = this.nextU32();
      if (value < limit) return value % maxExclusive;
    }
  }
  pick<T>(items: readonly T[]): T {
    return items[this.nextInt(items.length)];
  }
}

const FIRST_NAMES = [
  'ada', 'bram', 'cora', 'dmitri', 'elena', 'felix', 'greta', 'hugo', 'iris', 'jonas', 'kira', 'lars',
  'mira', 'nico', 'olga', 'pavel', 'quinn', 'rosa', 'sven', 'tess', 'ulla', 'vito', 'wren', 'yara', 'zane',
];
const LAST_NAMES = [
  'anders', 'bauer', 'costa', 'dahl', 'eriksen', 'fischer', 'garcia', 'holm', 'iversen', 'jansen', 'keller',
  'lind', 'moreau', 'novak', 'olsen', 'peters', 'quist', 'rossi', 'sato', 'turi', 'ulrich', 'vega', 'weber',
  'xu', 'yilmaz', 'zimmer',
];

const SCENARIO_SEED = 0x6a09e667f3bcc909n;

/** The token owner's login and id, derived from the public scenario seed. */
export function viewerIdentity(): { login: string; id: number; name: string; email: string } {
  const rng = new Rng(mix64(SCENARIO_SEED ^ fnv1a64('users')));
  const used = new Set<string>();
  let login = '';
  let name = '';
  for (let i = 0; i < 12; i += 1) {
    const first = rng.pick(FIRST_NAMES);
    const last = rng.pick(LAST_NAMES);
    let candidate = `${first}${last}`;
    let suffix = 2;
    while (used.has(candidate)) candidate = `${first}${last}-${suffix++}`;
    used.add(candidate);
    if (i === 0) {
      login = candidate;
      name = `${first} ${last}`;
    }
  }
  return { login, id: 1000, name, email: `${login}@example.invalid` };
}

/** Deterministic timestamps: the scenario epoch plus a counter, never the wall clock. */
export const EPOCH_SEC = 1_735_689_600;

export interface User {
  login: string;
  id: number;
  name: string;
  email: string;
}

export interface Label {
  name: string;
  color: string;
  description: string;
}

export interface IssueComment {
  id: number;
  nodeId: string;
  body: string;
  user: string;
  createdAt: string;
  updatedAt: string;
}

export interface Issue {
  number: number;
  id: number;
  nodeId: string;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  user: string;
  comments: IssueComment[];
  createdAt: string;
  updatedAt: string;
  seq: number;
}

export interface PullRequest {
  number: number;
  id: number;
  nodeId: string;
  title: string;
  body: string;
  state: 'open' | 'closed';
  merged: boolean;
  head: string;
  base: string;
  headSha: string;
  baseSha: string;
  mergeable: 'MERGEABLE' | 'CONFLICTING' | 'UNKNOWN';
  mergeCommitSha: string;
  user: string;
  createdAt: string;
  updatedAt: string;
  seq: number;
}

export interface Repo {
  id: number;
  owner: string;
  name: string;
  description: string;
  isPrivate: boolean;
  defaultBranch: string;
  createdAt: string;
  updatedAt: string;
  /** ref name -> commit oid. */
  refs: Map<string, string>;
  /** oid -> { type, data } (data is the raw object body, no header). */
  objects: Map<string, { type: string; data: Buffer }>;
  issues: Map<number, Issue>;
  pulls: Map<number, PullRequest>;
  labels: Map<string, Label>;
  nextIssue: number;
  nextPull: number;
  nextCommentId: number;
  seq: number;
}

/** Opaque, stable global ids: base64url of a typed key, never the bare numeric id. */
export function globalId(kind: string, key: string): string {
  return Buffer.from(`${kind}:${key}`, 'utf8').toString('base64url');
}

export class Store {
  readonly viewer: User;
  readonly token: string;
  repos = new Map<string, Repo>();
  private nextRepoId = 1;
  private nextDbId = 1;
  private clock = 0;

  constructor(token: string) {
    this.token = token;
    const v = viewerIdentity();
    this.viewer = { login: v.login, id: v.id, name: v.name, email: v.email };
  }

  /** A deterministic ISO timestamp; each call ticks one second forward. */
  nowIso(): string {
    this.clock += 1;
    return new Date((EPOCH_SEC + this.clock) * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z');
  }

  /** The deterministic git timestamp (seconds since epoch) for a new commit. */
  nowSec(): number {
    this.clock += 1;
    return EPOCH_SEC + this.clock;
  }

  nextRepoDbId(): number {
    return this.nextDbId++;
  }

  createRepo(owner: string, name: string, description: string, isPrivate: boolean): Repo | null {
    const key = `${owner}/${name}`;
    if (this.repos.has(key)) return null;
    const now = this.nowIso();
    const repo: Repo = {
      id: this.nextRepoDbId(),
      owner,
      name,
      description,
      isPrivate,
      defaultBranch: 'main',
      createdAt: now,
      updatedAt: now,
      refs: new Map(),
      objects: new Map(),
      issues: new Map(),
      pulls: new Map(),
      labels: new Map(),
      nextIssue: 1,
      nextPull: 1,
      nextCommentId: 1,
      seq: this.nextRepoId++,
    };
    this.repos.set(key, repo);
    return repo;
  }

  getRepo(owner: string, name: string): Repo | undefined {
    return this.repos.get(`${owner}/${name}`);
  }

  deleteRepo(owner: string, name: string): boolean {
    return this.repos.delete(`${owner}/${name}`);
  }

  /** Repositories owned by `owner`, in creation order. */
  reposOf(owner: string): Repo[] {
    const out: Repo[] = [];
    for (const repo of this.repos.values()) if (repo.owner === owner) out.push(repo);
    out.sort((a, b) => a.seq - b.seq);
    return out;
  }

  allRepos(): Repo[] {
    return [...this.repos.values()].sort((a, b) => a.seq - b.seq);
  }
}
