// The in-memory store: every object the four surfaces serve lives here.
// Nothing touches disk and nothing reads the wall clock, so the same request
// sequence always leaves the same state behind.
//
// Who the bearer token names is re-derived from the one public scenario seed
// the suite builds its data from: the same splitmix64 / xorshift64* stream
// and the same name lists. That keeps the forge honest about the viewer
// without ever reading the suite's files at run time.

const MASK64 = 0xffffffffffffffffn;

/** FNV-1a over UTF-16 code units, 64-bit. */
function hashFNV1a(text: string): bigint {
  let h = 0xcbf29ce484222325n;
  for (let i = 0; i < text.length; i++) {
    h = ((h ^ BigInt(text.charCodeAt(i))) * 0x100000001b3n) & MASK64;
  }
  return h;
}

/** splitmix64 finalizer. */
function scramble64(value: bigint): bigint {
  let z = (value + 0x9e3779b97f4a7c15n) & MASK64;
  z = ((z ^ (z >> 30n)) * 0xbf58476d1ce4e5b9n) & MASK64;
  z = ((z ^ (z >> 27n)) * 0x94d049bb133111ebn) & MASK64;
  return (z ^ (z >> 31n)) & MASK64;
}

interface RngStream {
  nextU64(): bigint;
  nextU32(): number;
  nextInt(maxExclusive: number): number;
  pick<T>(items: readonly T[]): T;
}

/** xorshift64* stream; a zero seed is replaced with the golden constant. */
function createRng(seed: bigint): RngStream {
  let state = seed & MASK64;
  if (state === 0n) state = 0x6a09e667f3bcc909n;
  const nextU64 = (): bigint => {
    let x = state;
    x = (x ^ (x >> 12n)) & MASK64;
    x = (x ^ (x << 25n)) & MASK64;
    x = (x ^ (x >> 27n)) & MASK64;
    state = x;
    return (x * 0x2545f4914f6cdd1dn) & MASK64;
  };
  const nextU32 = (): number => Number(nextU64() >> 32n);
  const nextInt = (maxExclusive: number): number => {
    if (maxExclusive === 1) return 0;
    const range = 4_294_967_296;
    const limit = range - (range % maxExclusive);
    for (;;) {
      const value = nextU32();
      if (value < limit) return value % maxExclusive;
    }
  };
  const pick = <T>(items: readonly T[]): T => items[nextInt(items.length)]!;
  return { nextU64, nextU32, nextInt, pick };
}

const GIVEN_NAMES = [
  'ada', 'bram', 'cora', 'dmitri', 'elena', 'felix', 'greta', 'hugo', 'iris',
  'jonas', 'kira', 'lars', 'mira', 'nico', 'olga', 'pavel', 'quinn', 'rosa',
  'sven', 'tess', 'ulla', 'vito', 'wren', 'yara', 'zane',
];
const FAMILY_NAMES = [
  'anders', 'bauer', 'costa', 'dahl', 'eriksen', 'fischer', 'garcia', 'holm',
  'iversen', 'jansen', 'keller', 'lind', 'moreau', 'novak', 'olsen', 'peters',
  'quist', 'rossi', 'sato', 'turi', 'ulrich', 'vega', 'weber', 'xu', 'yilmaz',
  'zimmer',
];

const SCENARIO_SEED = 0x6a09e667f3bcc909n;

/** The token owner's login and id, derived from the public scenario seed. */
export function viewerIdentity(): { login: string; id: number; name: string; email: string } {
  const rng = createRng(scramble64(SCENARIO_SEED ^ hashFNV1a('users')));
  const taken = new Set<string>();
  let login = '';
  let name = '';
  for (let i = 0; i < 12; i++) {
    const first = rng.pick(GIVEN_NAMES);
    const last = rng.pick(FAMILY_NAMES);
    let candidate = `${first}${last}`;
    let n = 2;
    while (taken.has(candidate)) {
      candidate = `${first}${last}-${n}`;
      n += 1;
    }
    taken.add(candidate);
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
  #repoSeq = 1;
  #dbSeq = 1;
  #tick = 0;

  constructor(token: string) {
    this.token = token;
    const v = viewerIdentity();
    this.viewer = { login: v.login, id: v.id, name: v.name, email: v.email };
  }

  /** Advance the deterministic clock one second and return the new count. */
  #advance(): number {
    this.#tick += 1;
    return this.#tick;
  }

  /** A deterministic ISO timestamp; each call ticks one second forward. */
  nowIso(): string {
    const seconds = EPOCH_SEC + this.#advance();
    return new Date(seconds * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z');
  }

  /** The deterministic git timestamp (seconds since epoch) for a new commit. */
  nowSec(): number {
    return EPOCH_SEC + this.#advance();
  }

  nextRepoDbId(): number {
    const id = this.#dbSeq;
    this.#dbSeq += 1;
    return id;
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
      seq: this.#repoSeq,
    };
    this.#repoSeq += 1;
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
    const found = [...this.repos.values()].filter((repo) => repo.owner === owner);
    found.sort((a, b) => a.seq - b.seq);
    return found;
  }

  allRepos(): Repo[] {
    return [...this.repos.values()].sort((a, b) => a.seq - b.seq);
  }
}
