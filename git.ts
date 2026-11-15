// Git from first principles on node:crypto and node:zlib — object store,
// packfiles (plain objects when writing, OFS/REF deltas when reading),
// pkt-lines, upload-pack v2/v0 and receive-pack v0. No git binary, no
// third-party code: every byte of the protocol is built here.
//
// Speed notes (measured on this box, 1 KiB blobs):
//   * A pack entry's zlib stream is located in one inflate: inflateSync
//     stops at the first stream's end and, with { info: true }, its engine
//     reports exactly how many input bytes it consumed, so the stream's end
//     needs no trailer scan and no second, confirming inflate. The Adler-32
//     trailer is still checked, and a disagreement falls back to the scan,
//     so the answer stays right on any Node. A receive-pack is dominated by
//     pack reading, so this is the single biggest win in the forge.
//   * SHA-1 is the one-shot crypto.hash, not a Hash object per object.
//   * A commit's parents are memoised per repo (objects never change under
//     an oid), so ancestry walks parse each commit at most once.

import { hash as cryptoHash } from 'node:crypto';
import { inflateSync as zlibInflate, deflateSync as zlibDeflate } from 'node:zlib';
import type { Repo } from './store.ts';

export const ZERO_OID = '0000000000000000000000000000000000000000';

/** One-shot SHA-1 hex: no Hash object is allocated per object. */
export function sha1Hex(data: Buffer): string {
  return cryptoHash('sha1', data, 'hex');
}

/** An object's id: sha1("<type> <length>\0" + body). */
export function objectId(type: string, data: Buffer): string {
  const prefix = Buffer.from(`${type} ${data.length}\0`, 'utf8');
  return sha1Hex(Buffer.concat([prefix, data]));
}

export interface GitObject {
  type: string;
  data: Buffer;
}

export function storeObject(repo: Repo, type: string, data: Buffer): string {
  const oid = objectId(type, data);
  if (!repo.objects.has(oid)) repo.objects.set(oid, { type, data });
  return oid;
}

export function getObject(repo: Repo, oid: string): GitObject | undefined {
  return repo.objects.get(oid);
}

// ---------------------------------------------------------------- commits

export interface Commit {
  tree: string;
  parents: string[];
  author: string;
  committer: string;
  message: string;
}

/** Parse a commit's header lines and message out of its raw bytes. */
export function parseCommit(data: Buffer): Commit {
  const text = data.toString('utf8');
  const blank = text.indexOf('\n\n');
  const head = blank < 0 ? text : text.slice(0, blank);
  const message = blank < 0 ? '' : text.slice(blank + 2);
  const out: Commit = { tree: '', parents: [], author: '', committer: '', message };
  let at = 0;
  while (at <= head.length) {
    const eol = head.indexOf('\n', at);
    const line = eol < 0 ? head.slice(at) : head.slice(at, eol);
    if (line.startsWith('tree ')) out.tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) out.parents.push(line.slice(7).trim());
    else if (line.startsWith('author ')) out.author = line.slice(7);
    else if (line.startsWith('committer ')) out.committer = line.slice(10);
    if (eol < 0) break;
    at = eol + 1;
  }
  return out;
}

/** Serialise a commit the way parseCommit reads it back. */
export function buildCommit(c: Commit): Buffer {
  const lines: string[] = [`tree ${c.tree}`];
  for (const p of c.parents) lines.push(`parent ${p}`);
  lines.push(`author ${c.author}`);
  lines.push(`committer ${c.committer}`);
  return Buffer.from(`${lines.join('\n')}\n\n${c.message}`, 'utf8');
}

/** "Name <email> 1735689600 +0000" */
export function ident(name: string, email: string, epochSec: number): string {
  return `${name} <${email}> ${epochSec} +0000`;
}

// ---------------------------------------------------------------- trees

export interface TreeEntry {
  mode: string;
  name: string;
  oid: string;
}

/** Decode a tree's binary entries: "<mode> <name>\0" + 20-byte oid, repeated. */
export function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let off = 0;
  while (off < data.length) {
    const sp = data.indexOf(0x20, off);
    const mode = data.subarray(off, sp).toString('utf8');
    const nul = data.indexOf(0, sp + 1);
    const name = data.subarray(sp + 1, nul).toString('utf8');
    const oid = data.subarray(nul + 1, nul + 21).toString('hex');
    entries.push({ mode, name, oid });
    off = nul + 21;
  }
  return entries;
}

/** Encode entries, ordered the way git orders them (directories sort as name + "/"). */
export function buildTree(entries: TreeEntry[]): Buffer {
  const ordered = [...entries].sort((a, b) => {
    const an = a.mode === '40000' ? `${a.name}/` : a.name;
    const bn = b.mode === '40000' ? `${b.name}/` : b.name;
    if (an < bn) return -1;
    if (an > bn) return 1;
    return 0;
  });
  const chunks: Buffer[] = [];
  for (const e of ordered) {
    chunks.push(Buffer.from(`${e.mode} ${e.name}\0`, 'utf8'));
    chunks.push(Buffer.from(e.oid, 'hex'));
  }
  return Buffer.concat(chunks);
}

/** path -> { oid, mode } for every blob under a tree, recursing into subtrees. */
export function flattenTree(repo: Repo, treeOid: string, prefix = '', out = new Map<string, { oid: string; mode: string }>()): Map<string, { oid: string; mode: string }> {
  const obj = repo.objects.get(treeOid);
  if (!obj || obj.type !== 'tree') return out;
  for (const e of parseTree(obj.data)) {
    const path = prefix === '' ? e.name : `${prefix}/${e.name}`;
    if (e.mode === '40000') flattenTree(repo, e.oid, path, out);
    else out.set(path, { oid: e.oid, mode: e.mode });
  }
  return out;
}

/** Build (and store) the tree for a flat path map; returns the root tree oid. */
export function buildTreeFromMap(repo: Repo, files: Map<string, { oid: string; mode: string }>): string {
  const build = (prefix: string): string => {
    const entries: TreeEntry[] = [];
    const subdirs = new Map<string, Map<string, { oid: string; mode: string }>>();
    for (const [path, f] of files) {
      if (!path.startsWith(prefix)) continue;
      const rest = path.slice(prefix.length);
      const slash = rest.indexOf('/');
      if (slash < 0) {
        entries.push({ mode: f.mode, name: rest, oid: f.oid });
      } else {
        const dir = rest.slice(0, slash);
        let bucket = subdirs.get(dir);
        if (bucket === undefined) {
          bucket = new Map();
          subdirs.set(dir, bucket);
        }
        bucket.set(path, f);
      }
    }
    for (const [dir, bucket] of subdirs) {
      const childPrefix = prefix === '' ? `${dir}/` : `${prefix}${dir}/`;
      entries.push({ mode: '40000', name: dir, oid: build(childPrefix) });
    }
    return storeObject(repo, 'tree', buildTree(entries));
  };
  return build('');
}

// ---------------------------------------------------------------- ancestry

// A commit's parents, memoised per repo. An oid names its bytes forever, so
// a cached parent list can never go stale; without this every ancestry walk
// re-parses every commit it visits, and a fetch checks ancestry once per
// (have, want) pair.
const parentMemo = new WeakMap<Repo, Map<string, string[]>>();

function commitParents(repo: Repo, oid: string): string[] {
  let perRepo = parentMemo.get(repo);
  if (perRepo === undefined) {
    perRepo = new Map<string, string[]>();
    parentMemo.set(repo, perRepo);
  }
  const hit = perRepo.get(oid);
  if (hit !== undefined) return hit;
  const obj = repo.objects.get(oid);
  const parents = obj !== undefined && obj.type === 'commit' ? parseCommit(obj.data).parents : [];
  perRepo.set(oid, parents);
  return parents;
}

/** Is `ancestor` reachable from `descendant` by following parents? */
export function isAncestor(repo: Repo, ancestor: string, descendant: string): boolean {
  if (ancestor === descendant) return true;
  const visited = new Set<string>();
  const stack = [descendant];
  while (stack.length > 0) {
    const oid = stack.pop()!;
    if (visited.has(oid)) continue;
    visited.add(oid);
    for (const p of commitParents(repo, oid)) {
      if (p === ancestor) return true;
      stack.push(p);
    }
  }
  return false;
}

/** The merge-base of two commits: the common ancestor closest to both. */
export function mergeBase(repo: Repo, a: string, b: string): string | null {
  if (a === b) return a;
  // BFS out from a, recording each commit's distance. A queue with a head
  // index, not shift(): shift() is O(n) per step and makes a long history
  // walk quadratic.
  const distA = new Map<string, number>();
  const queueA: Array<[string, number]> = [[a, 0]];
  for (let head = 0; head < queueA.length; head += 1) {
    const [oid, d] = queueA[head]!;
    if (distA.has(oid)) continue;
    distA.set(oid, d);
    for (const p of commitParents(repo, oid)) queueA.push([p, d + 1]);
  }
  let best: string | null = null;
  let bestSum = Infinity;
  const seenB = new Set<string>();
  const queueB: Array<[string, number]> = [[b, 0]];
  for (let head = 0; head < queueB.length; head += 1) {
    const [oid, d] = queueB[head]!;
    if (seenB.has(oid)) continue;
    seenB.add(oid);
    const da = distA.get(oid);
    if (da !== undefined && da + d < bestSum) {
      bestSum = da + d;
      best = oid;
    }
    for (const p of commitParents(repo, oid)) queueB.push([p, d + 1]);
  }
  return best;
}

/** Walk commits from `tips`; returns oid -> depth (0 at a tip). */
export function walkCommits(repo: Repo, tips: string[]): Map<string, number> {
  const depth = new Map<string, number>();
  const queue: Array<[string, number]> = tips.map((t) => [t, 0] as [string, number]);
  let head = 0;
  while (head < queue.length) {
    const [oid, d] = queue[head++]!;
    const prev = depth.get(oid);
    if (prev !== undefined && prev <= d) continue;
    depth.set(oid, d);
    for (const p of commitParents(repo, oid)) queue.push([p, d + 1]);
  }
  return depth;
}

// ---------------------------------------------------------------- deltas

function readVarint(buf: Buffer, off: number): [number, number] {
  let value = 0;
  let shift = 0;
  let i = off;
  for (;;) {
    const byte = buf[i++];
    value |= (byte & 0x7f) << shift;
    shift += 7;
    if ((byte & 0x80) === 0) break;
  }
  return [value, i];
}

export function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let off = 0;
  const [sourceSize, afterSource] = readVarint(delta, off);
  off = afterSource;
  const [targetSize, afterTarget] = readVarint(delta, off);
  off = afterTarget;
  if (sourceSize !== base.length) throw new Error(`delta base size ${sourceSize} != ${base.length}`);
  const out = Buffer.alloc(targetSize);
  let written = 0;
  while (off < delta.length) {
    const op = delta[off++];
    if ((op & 0x80) !== 0) {
      let copyOffset = 0;
      let copySize = 0;
      for (let i = 0; i < 4; i += 1) if ((op & (1 << i)) !== 0) copyOffset |= delta[off++] << (8 * i);
      for (let i = 0; i < 3; i += 1) if ((op & (0x10 << i)) !== 0) copySize |= delta[off++] << (8 * i);
      if (copySize === 0) copySize = 0x10000;
      base.copy(out, written, copyOffset, copyOffset + copySize);
      written += copySize;
    } else if (op !== 0) {
      delta.copy(out, written, off, off + op);
      off += op;
      written += op;
    } else {
      throw new Error('delta opcode 0');
    }
  }
  if (written !== targetSize) throw new Error('delta size mismatch');
  return out;
}

// ---------------------------------------------------------------- packfiles

const OBJ_TYPE_NAMES = ['', 'commit', 'tree', 'blob', 'tag', '', 'ofs-delta', 'ref-delta'];

interface PackEntry {
  offset: number;
  typeNum: number;
  type: string;
  size: number;
  data: Buffer;
  baseOffset?: number;
  baseOid?: string;
}

/**
 * Adler-32, the checksum a zlib stream ends with. Computed in 5552-byte
 * blocks so the modulo only runs once per block (the classic zlib trick):
 * a and b stay below 65521 * 5552 inside a block, so deferring the mod is
 * exact.
 */
function adler32(data: Buffer): number {
  const MOD = 65521;
  let a = 1;
  let b = 0;
  let i = 0;
  while (i < data.length) {
    const end = Math.min(i + 5552, data.length);
    while (i < end) {
      a += data[i++];
      b += a;
    }
    a %= MOD;
    b %= MOD;
  }
  return ((b << 16) | a) >>> 0;
}

/**
 * Inflate the one zlib stream starting at `start` and return its bytes plus
 * the offset just past its Adler-32 trailer, in a single inflate.
 *
 * inflateSync stops at the end of the first stream and ignores trailing
 * bytes, so inflating the remainder of the pack gives exactly this entry's
 * bytes; with `{ info: true }` its engine reports how many input bytes it
 * consumed, which is the stream's own length — no scan for the trailer and
 * no second, confirming inflate. The four bytes before that end must be
 * this stream's Adler-32 trailer; when they are not (an engine that reports
 * consumption differently), the trailer scan below is the fallback, so the
 * answer stays right on any Node instead of trusting one runtime's counter.
 */
function inflateEntry(
  buf: Buffer,
  start: number,
  packEnd: number,
): { data: Buffer; end: number } {
  const { buffer: data, engine } = zlibInflate(buf.subarray(start, packEnd), { info: true }) as {
    buffer: Buffer;
    engine: { bytesWritten: number };
  };
  const end = start + engine.bytesWritten;
  if (end > start + 2 && end <= packEnd) {
    const trailer = Buffer.alloc(4);
    trailer.writeUInt32BE(adler32(data), 0);
    if (buf.subarray(end - 4, end).equals(trailer)) return { data, end };
  }
  return inflateEntrySlow(buf, start, packEnd, data);
}

/**
 * The fallback inflateEntry uses when the engine's consumed-byte count does
 * not land on the stream's Adler-32 trailer: scan the pack for the trailer
 * bytes and confirm the first candidate whose bounded inflate reproduces
 * the entry's bytes (an earlier accidental match is truncated and throws,
 * so the scan simply moves on). Slower, and only ever reached when the fast
 * path's counter disagrees with the bytes.
 */
function inflateEntrySlow(
  buf: Buffer,
  start: number,
  packEnd: number,
  data: Buffer,
): { data: Buffer; end: number } {
  const trailer = Buffer.alloc(4);
  trailer.writeUInt32BE(adler32(data), 0);
  let searchFrom = start + 2; // a zlib header is 2 bytes, so no trailer starts earlier
  for (;;) {
    const pos = buf.indexOf(trailer, searchFrom);
    if (pos < 0 || pos + 4 > packEnd) throw new Error('zlib stream runs past pack end');
    const end = pos + 4;
    try {
      const check = zlibInflate(buf.subarray(start, end));
      if (check.length === data.length && check.equals(data)) return { data, end };
    } catch {
      // A truncated stream: this match was a coincidence inside the data.
    }
    searchFrom = pos + 1;
  }
}

/**
 * Read one packfile; resolve deltas against the pack itself and `resolveBase`.
 * Each resolved object is also handed to `sink` as it is finalised, so a
 * caller that is about to store the objects anyway (receive-pack) pays no
 * second pass over the map.
 */
export function readPack(
  buf: Buffer,
  resolveBase?: (oid: string) => GitObject | undefined,
  sink?: Map<string, GitObject>,
): Map<string, GitObject> {
  if (buf.length < 12 || buf.toString('ascii', 0, 4) !== 'PACK') throw new Error('not a packfile');
  const version = buf.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error(`pack version ${version}`);
  const count = buf.readUInt32BE(8);
  const packEnd = buf.length - 20; // the pack's 20-byte SHA-1 trailer
  const entries: PackEntry[] = [];
  let off = 12;
  for (let n = 0; n < count; n += 1) {
    const start = off;
    let i = off;
    let byte = buf[i++];
    const typeNum = (byte >> 4) & 0x7;
    let size = byte & 0x0f;
    let shift = 4;
    while ((byte & 0x80) !== 0) {
      byte = buf[i++];
      size |= (byte & 0x7f) << shift;
      shift += 7;
    }
    let baseOffset: number | undefined;
    let baseOid: string | undefined;
    if (typeNum === 6) {
      let b = buf[i++];
      let base = b & 0x7f;
      while ((b & 0x80) !== 0) {
        b = buf[i++];
        base = ((base + 1) << 7) | (b & 0x7f);
      }
      baseOffset = start - base;
    } else if (typeNum === 7) {
      baseOid = buf.subarray(i, i + 20).toString('hex');
      i += 20;
    }
    const { data, end } = inflateEntry(buf, i, packEnd);
    if (data.length !== size) throw new Error('pack entry size mismatch');
    entries.push({ offset: start, typeNum, type: OBJ_TYPE_NAMES[typeNum] ?? '', size, data, baseOffset, baseOid });
    off = end;
  }
  // Resolve deltas. Bases are found by offset (OFS) or by oid (REF): the
  // oid map is filled as objects resolve, so a REF base never needs a scan
  // that re-hashes every resolved object for every delta.
  const byOffset = new Map<number, PackEntry>();
  for (const e of entries) byOffset.set(e.offset, e);
  const resolved = new Map<string, GitObject>();
  const byOid = new Map<string, GitObject>();
  const resolve = (entry: PackEntry, seen: Set<number>): GitObject => {
    if (entry.typeNum === 6 || entry.typeNum === 7) {
      if (seen.has(entry.offset)) throw new Error('delta cycle');
      seen.add(entry.offset);
      let base: GitObject;
      if (entry.typeNum === 6) {
        const baseEntry = byOffset.get(entry.baseOffset!);
        if (baseEntry === undefined) throw new Error('ofs-delta base missing');
        base = resolve(baseEntry, seen);
      } else {
        const inPack = byOid.get(entry.baseOid!);
        if (inPack !== undefined) {
          base = inPack;
        } else {
          const ext = resolveBase?.(entry.baseOid!);
          if (ext === undefined) throw new Error(`ref-delta base ${entry.baseOid} missing`);
          base = ext;
        }
      }
      const data = applyDelta(base.data, entry.data);
      return { type: base.type, data };
    }
    return { type: entry.type, data: entry.data };
  };
  for (const entry of entries) {
    const obj = resolve(entry, new Set());
    const oid = objectId(obj.type, obj.data);
    resolved.set(oid, obj);
    byOid.set(oid, obj);
    sink?.set(oid, obj);
  }
  return resolved;
}

/** Write a packfile of plain (undelted) objects. */
export function writePack(objects: GitObject[]): Buffer {
  const parts: Buffer[] = [];
  const head = Buffer.alloc(12);
  head.write('PACK', 0, 'ascii');
  head.writeUInt32BE(2, 4);
  head.writeUInt32BE(objects.length, 8);
  parts.push(head);
  for (const obj of objects) {
    let typeNum: number;
    if (obj.type === 'commit') typeNum = 1;
    else if (obj.type === 'tree') typeNum = 2;
    else if (obj.type === 'blob') typeNum = 3;
    else if (obj.type === 'tag') typeNum = 4;
    else throw new Error(`cannot pack type ${obj.type}`);
    // Level 1: pack bytes are checksummed, never size-checked, and a fetch's
    // cost is dominated by deflate time over hundreds of small objects.
    const deflated = zlibDeflate(obj.data, { level: 1 });
    // Varint header: the size's low 4 bits, the type in the next 3, then
    // 7-bit size groups with continuation bits.
    const header: number[] = [];
    let size = obj.data.length;
    let first = (typeNum << 4) | (size & 0x0f);
    size >>= 4;
    if (size > 0) first |= 0x80;
    header.push(first);
    while (size > 0) {
      let b = size & 0x7f;
      size >>= 7;
      if (size > 0) b |= 0x80;
      header.push(b);
    }
    parts.push(Buffer.from(header));
    parts.push(deflated);
  }
  const body = Buffer.concat(parts);
  const trailer = Buffer.from(sha1Hex(body), 'hex');
  return Buffer.concat([body, trailer]);
}

// ---------------------------------------------------------------- pkt-lines

export function pktLine(data: Buffer | string): Buffer {
  const body = typeof data === 'string' ? Buffer.from(data, 'utf8') : data;
  const len = body.length + 4;
  return Buffer.concat([Buffer.from(len.toString(16).padStart(4, '0'), 'ascii'), body]);
}

export const PKT_FLUSH = Buffer.from('0000', 'ascii');
export const PKT_DELIM = Buffer.from('0001', 'ascii');

export function pktLines(items: Array<string | Buffer | 'flush' | 'delim'>): Buffer {
  const parts: Buffer[] = [];
  for (const item of items) {
    if (item === 'flush') parts.push(PKT_FLUSH);
    else if (item === 'delim') parts.push(PKT_DELIM);
    else parts.push(pktLine(item));
  }
  return Buffer.concat(parts);
}

/** Parse a buffer of pkt-lines into payloads; 'flush'/'delim' as markers. */
export function parsePktLines(buf: Buffer): Array<Buffer | 'flush' | 'delim'> {
  const out: Array<Buffer | 'flush' | 'delim'> = [];
  let off = 0;
  while (off + 4 <= buf.length) {
    const len = parseInt(buf.toString('ascii', off, off + 4), 16);
    if (Number.isNaN(len)) throw new Error('bad pkt-line length');
    if (len === 0) {
      out.push('flush');
      off += 4;
    } else if (len === 1) {
      out.push('delim');
      off += 4;
    } else {
      if (off + len > buf.length) throw new Error('pkt-line truncated');
      out.push(buf.subarray(off + 4, off + len));
      off += len;
    }
  }
  if (off !== buf.length) throw new Error('trailing bytes after pkt-lines');
  return out;
}

/** Split a receive-pack/upload-pack body into its pkt-line section and the pack bytes. */
export function splitPktSection(body: Buffer): { lines: Array<Buffer | 'flush' | 'delim'>; rest: Buffer } {
  const lines: Array<Buffer | 'flush' | 'delim'> = [];
  let off = 0;
  while (off + 4 <= body.length) {
    const len = parseInt(body.toString('ascii', off, off + 4), 16);
    if (Number.isNaN(len)) break;
    if (len === 0) {
      lines.push('flush');
      off += 4;
      break;
    }
    if (len === 1) {
      lines.push('delim');
      off += 4;
      continue;
    }
    if (off + len > body.length) break;
    lines.push(body.subarray(off + 4, off + len));
    off += len;
  }
  return { lines, rest: body.subarray(off) };
}

// ---------------------------------------------------------------- fetch packing

export interface PackOptions {
  depth?: number;
  filter?: string;
  /** Shallow boundaries the client already has (deepen of a shallow clone). */
  clientShallow?: string[];
}

export interface CollectedPack {
  objects: GitObject[];
  shallow: string[];
  unshallow: string[];
}

/** The objects a fetch must send for `wants`, minus what `haves` already cover. */
export function collectPack(repo: Repo, wants: string[], haves: string[], opts: PackOptions = {}): CollectedPack {
  // What the client already holds. A have's ancestry counts as held — except
  // past a shallow boundary: a shallow tip is held, its parents are not
  // (that is exactly what a deepen fetch asks to extend).
  const shallowSet = new Set(opts.clientShallow ?? []);
  const heldCommits = new Set<string>();
  {
    const stack = [...haves];
    while (stack.length > 0) {
      const oid = stack.pop()!;
      if (heldCommits.has(oid)) continue;
      heldCommits.add(oid);
      if (shallowSet.has(oid)) continue;
      for (const p of commitParents(repo, oid)) stack.push(p);
    }
  }
  // Every tree and blob reachable from a held commit is held too: re-sending
  // one is a protocol error the client counts, even when the commit is new.
  const heldObjects = new Set<string>();
  for (const oid of heldCommits) {
    const obj = repo.objects.get(oid);
    if (!obj || obj.type !== 'commit') continue;
    const stack = [parseCommit(obj.data).tree];
    while (stack.length > 0) {
      const treeOid = stack.pop()!;
      if (heldObjects.has(treeOid)) continue;
      heldObjects.add(treeOid);
      const treeObj = repo.objects.get(treeOid);
      if (!treeObj || treeObj.type !== 'tree') continue;
      for (const e of parseTree(treeObj.data)) {
        if (e.mode === '40000') stack.push(e.oid);
        else heldObjects.add(e.oid);
      }
    }
  }
  const depths = walkCommits(repo, wants);
  const included = new Map<string, number>();
  for (const [oid, d] of depths) {
    if (heldCommits.has(oid)) continue;
    if (opts.depth !== undefined && d >= opts.depth) continue;
    included.set(oid, d);
  }
  // Shallow boundaries only come from depth limiting: a commit whose parent
  // the client already holds is not shallow, it is simply up to date.
  const shallow: string[] = [];
  for (const [oid, d] of included) {
    if (opts.depth === undefined || d !== opts.depth - 1) continue;
    const parents = commitParents(repo, oid);
    if (parents.length > 0) shallow.push(oid);
  }
  // A former shallow tip stops being shallow once this fetch delivers (or the
  // client already holds) every one of its parents.
  const unshallow: string[] = [];
  for (const s of opts.clientShallow ?? []) {
    const parents = commitParents(repo, s);
    if (parents.length === 0) continue;
    const allCovered = parents.every((p) => included.has(p) || heldCommits.has(p));
    const someNew = parents.some((p) => included.has(p));
    if (allCovered && someNew) unshallow.push(s);
  }
  const filter = opts.filter ?? '';
  const skipBlobs = filter === 'blob:none';
  const skipTrees = filter === 'tree:0';
  let blobLimit = -1;
  const limitMatch = /^blob:limit=(\d+)$/.exec(filter);
  if (limitMatch) blobLimit = Number(limitMatch[1]);
  const objects = new Map<string, GitObject>();
  const addObj = (oid: string): void => {
    if (heldObjects.has(oid) || heldCommits.has(oid)) return;
    const obj = repo.objects.get(oid);
    if (obj !== undefined) objects.set(oid, obj);
  };
  const addTree = (treeOid: string): void => {
    if (skipTrees) return;
    if (heldObjects.has(treeOid)) return;
    const obj = repo.objects.get(treeOid);
    if (!obj || obj.type !== 'tree') return;
    objects.set(treeOid, obj);
    for (const e of parseTree(obj.data)) {
      if (e.mode === '40000') {
        addTree(e.oid);
      } else {
        if (skipBlobs) continue;
        if (heldObjects.has(e.oid)) continue;
        const blob = repo.objects.get(e.oid);
        if (blob === undefined) continue;
        if (blobLimit >= 0 && blob.data.length > blobLimit) continue;
        objects.set(e.oid, blob);
      }
    }
  };
  for (const oid of included.keys()) {
    const obj = repo.objects.get(oid);
    if (obj === undefined) continue;
    objects.set(oid, obj);
    if (obj.type === 'commit') {
      addTree(parseCommit(obj.data).tree);
    } else if (obj.type === 'tag') {
      const text = obj.data.toString('utf8');
      const m = /^object ([0-9a-f]{40})$/m.exec(text);
      if (m === null) continue;
      const target = m[1]!;
      if (heldCommits.has(target) || heldObjects.has(target)) continue;
      const tObj = repo.objects.get(target);
      if (tObj === undefined) continue;
      objects.set(target, tObj);
      if (tObj.type === 'commit') addTree(parseCommit(tObj.data).tree);
    }
  }
  return { objects: [...objects.values()], shallow, unshallow };
}

// ---------------------------------------------------------------- three-way merge

export interface MergeResult {
  tree: Map<string, { oid: string; mode: string }>;
  conflicts: string[];
}

/** Merge head's tree onto base's tree, both descended from `mergeBaseOid`'s tree. */
export function threeWayMerge(repo: Repo, baseTip: string, headTip: string, mergeBaseOid: string | null): MergeResult {
  const baseTree = mergeBaseOid === null
    ? new Map<string, { oid: string; mode: string }>()
    : flattenTree(repo, parseCommit(repo.objects.get(mergeBaseOid)!.data).tree);
  const headTree = flattenTree(repo, parseCommit(repo.objects.get(headTip)!.data).tree);
  const curTree = flattenTree(repo, parseCommit(repo.objects.get(baseTip)!.data).tree);
  const out = new Map<string, { oid: string; mode: string }>(curTree);
  const conflicts: string[] = [];
  const same = (x?: { oid: string; mode: string }, y?: { oid: string; mode: string }): boolean =>
    x?.oid === y?.oid && x?.mode === y?.mode;
  const paths = new Set([...baseTree.keys(), ...headTree.keys(), ...curTree.keys()]);
  for (const path of paths) {
    const b = baseTree.get(path);
    const h = headTree.get(path);
    const t = curTree.get(path);
    if (same(h, b)) continue; // head did not change it: keep base's version
    if (same(t, b)) {
      // base did not change it: take head's version (or its deletion)
      if (h !== undefined) out.set(path, h);
      else out.delete(path);
      continue;
    }
    if (same(h, t)) continue; // both changed it the same way
    conflicts.push(path);
  }
  return { tree: out, conflicts };
}

// ---------------------------------------------------------------- advertisements

const AGENT = 'forge/1.0';

/** HEAD plus every ref, sorted by name; annotated tags carry their peeled target. */
function refLines(repo: Repo): Array<{ oid: string; name: string; peeled?: string }> {
  const out: Array<{ oid: string; name: string; peeled?: string }> = [];
  const tip = repo.refs.get(`refs/heads/${repo.defaultBranch}`) ?? [...repo.refs.values()][0];
  out.push({ oid: tip ?? ZERO_OID, name: 'HEAD' });
  const names = [...repo.refs.keys()].sort();
  for (const name of names) {
    const oid = repo.refs.get(name)!;
    const obj = repo.objects.get(oid);
    if (obj !== undefined && obj.type === 'tag') {
      const m = /^object ([0-9a-f]{40})$/m.exec(obj.data.toString('utf8'));
      out.push({ oid, name, peeled: m?.[1] });
    } else {
      out.push({ oid, name });
    }
  }
  return out;
}

/** The v2 capability advertisement: it never mentions a ref, so one buffer serves every repo. */
const ADVERT_V2: Buffer = pktLines([
  'version 2\n',
  'ls-refs=unborn\n',
  'fetch=shallow filter\n',
  'object-format=sha1\n',
  `agent=${AGENT}\n`,
  'flush',
]);

export function advertiseV2(): Buffer {
  return ADVERT_V2;
}

export function advertiseV0(repo: Repo, service: 'git-upload-pack' | 'git-receive-pack'): Buffer {
  const caps =
    service === 'git-upload-pack'
      ? `symref=HEAD:refs/heads/${repo.defaultBranch} side-band-64k multi_ack thin-pack ofs-delta shallow agent=${AGENT}`
      : `report-status side-band-64k delete-refs ofs-delta agent=${AGENT}`;
  const parts: Buffer[] = [pktLine(`# service=${service}\n`), PKT_FLUSH];
  const refs = refLines(repo);
  const hasCommits = refs.some((r) => r.oid !== ZERO_OID);
  if (!hasCommits) {
    parts.push(pktLine(`${ZERO_OID} capabilities^{}\0${caps}\n`));
  } else {
    refs.forEach((r, i) => {
      const line = i === 0 ? `${r.oid} ${r.name}\0${caps}\n` : `${r.oid} ${r.name}\n`;
      parts.push(pktLine(line));
    });
  }
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------- v2 ls-refs

export interface LsRefsArg {
  peel: boolean;
  symrefs: boolean;
  unborn: boolean;
  prefixes: string[];
}

export function handleLsRefs(repo: Repo, args: LsRefsArg): Buffer {
  const lines: string[] = [];
  const tip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
  const hasCommits = [...repo.refs.values()].some((oid) => oid !== ZERO_OID);
  const keep = (name: string): boolean => args.prefixes.length === 0 || args.prefixes.some((p) => name.startsWith(p));
  if (!hasCommits) {
    // An unborn repository reports only HEAD as unborn: listing the default
    // branch itself would advertise a ref that does not exist yet.
    if (args.unborn && keep('HEAD')) {
      lines.push(`unborn HEAD symref-target:refs/heads/${repo.defaultBranch}\n`);
    }
  } else {
    if (keep('HEAD') && tip !== undefined) {
      lines.push(`${tip} HEAD${args.symrefs ? ` symref-target:refs/heads/${repo.defaultBranch}` : ''}\n`);
    }
    for (const name of [...repo.refs.keys()].sort()) {
      if (!keep(name)) continue;
      const oid = repo.refs.get(name)!;
      const obj = repo.objects.get(oid);
      let line = `${oid} ${name}`;
      if (args.peel && obj !== undefined && obj.type === 'tag') {
        const m = /^object ([0-9a-f]{40})$/m.exec(obj.data.toString('utf8'));
        if (m !== null) line += ` peeled:${m[1]}`;
      }
      lines.push(`${line}\n`);
    }
  }
  return pktLines([...lines, 'flush']);
}

// ---------------------------------------------------------------- v2/v0 fetch

export interface FetchArgs {
  wants: string[];
  haves: string[];
  shallow: string[];
  depth?: number;
  deepenSince?: number;
  filter?: string;
}

function sidebandPackets(pack: Buffer): Buffer[] {
  const out: Buffer[] = [];
  // A pkt-line is at most 65520 bytes total, so a sideband payload (1 band
  // byte + data) is at most 65516 bytes: 65515 bytes of pack per packet.
  const CHUNK = 65515;
  for (let i = 0; i < pack.length; i += CHUNK) {
    const slice = pack.subarray(i, Math.min(i + CHUNK, pack.length));
    out.push(pktLine(Buffer.concat([Buffer.from([1]), slice])));
  }
  return out;
}

/**
 * Which haves the server can ACK: one walk from the wants, then a set
 * lookup per have. The naive form walks ancestry once per (have, want)
 * pair; with 200 haves that is 200 walks over the same history.
 */
function ackedHaves(repo: Repo, args: FetchArgs): { acks: string[]; nak: boolean } {
  if (args.haves.length === 0) return { acks: [], nak: true };
  const reachable = walkCommits(repo, args.wants);
  const acks: string[] = [];
  for (const h of args.haves) {
    if (!repo.objects.has(h)) continue;
    if (reachable.has(h)) acks.push(h);
  }
  return { acks, nak: acks.length === 0 };
}

export function handleFetchV2(repo: Repo, args: FetchArgs): Buffer {
  const parts: Buffer[] = [];
  const { acks, nak } = ackedHaves(repo, args);
  parts.push(pktLine('acknowledgments\n'));
  if (nak) {
    parts.push(pktLine('NAK\n'));
  } else {
    for (const a of acks) parts.push(pktLine(`ACK ${a}\n`));
    parts.push(pktLine('ready\n'));
  }
  parts.push(PKT_DELIM);
  const collected = collectPack(repo, args.wants, args.haves, {
    depth: args.depth,
    filter: args.filter,
    clientShallow: args.shallow,
  });
  if (collected.shallow.length > 0 || collected.unshallow.length > 0) {
    parts.push(pktLine('shallow-info\n'));
    for (const s of collected.shallow) parts.push(pktLine(`shallow ${s}\n`));
    for (const s of collected.unshallow) parts.push(pktLine(`unshallow ${s}\n`));
    parts.push(PKT_DELIM);
  }
  const pack = writePack(collected.objects);
  parts.push(pktLine('packfile\n'));
  parts.push(...sidebandPackets(pack));
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

export function handleFetchV0(repo: Repo, args: FetchArgs): Buffer {
  const parts: Buffer[] = [];
  const { acks, nak } = ackedHaves(repo, args);
  if (nak) {
    parts.push(pktLine('NAK\n'));
  } else {
    for (const a of acks) parts.push(pktLine(`ACK ${a}\n`));
  }
  const collected = collectPack(repo, args.wants, args.haves, {
    depth: args.depth,
    filter: args.filter,
    clientShallow: args.shallow,
  });
  for (const s of collected.shallow) parts.push(pktLine(`shallow ${s}\n`));
  for (const s of collected.unshallow) parts.push(pktLine(`unshallow ${s}\n`));
  const pack = writePack(collected.objects);
  parts.push(...sidebandPackets(pack));
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------- receive-pack

export interface PushCommand {
  oldOid: string;
  newOid: string;
  ref: string;
}

export interface PushOutcome {
  unpackOk: boolean;
  unpackDetail: string;
  refs: Array<{ ref: string; ok: boolean; reason: string }>;
}

/** Apply a receive-pack: store the pack's objects, then apply each ref command. */
export function handleReceivePack(repo: Repo, commands: PushCommand[], packBytes: Buffer | null): PushOutcome {
  if (packBytes !== null && packBytes.length > 0) {
    try {
      // Objects land in the repo's map as they resolve: no second pass.
      readPack(packBytes, (oid) => repo.objects.get(oid), repo.objects);
    } catch {
      return {
        unpackOk: false,
        unpackDetail: 'unpacker error',
        refs: commands.map((c) => ({ ref: c.ref, ok: false, reason: 'unpacker error' })),
      };
    }
  }
  const refs: PushOutcome['refs'] = [];
  for (const cmd of commands) {
    const current = repo.refs.get(cmd.ref);
    if (cmd.newOid === ZERO_OID) {
      // Delete.
      if (current === undefined) {
        refs.push({ ref: cmd.ref, ok: false, reason: 'remote ref does not exist' });
      } else if (cmd.oldOid !== ZERO_OID && cmd.oldOid !== current) {
        refs.push({ ref: cmd.ref, ok: false, reason: 'non-fast-forward' });
      } else {
        repo.refs.delete(cmd.ref);
        refs.push({ ref: cmd.ref, ok: true, reason: '' });
      }
      continue;
    }
    const newObj = repo.objects.get(cmd.newOid);
    if (newObj === undefined || (newObj.type !== 'commit' && newObj.type !== 'tag')) {
      refs.push({ ref: cmd.ref, ok: false, reason: 'object not found' });
      continue;
    }
    if (current === undefined) {
      if (cmd.oldOid !== ZERO_OID) {
        refs.push({ ref: cmd.ref, ok: false, reason: 'non-fast-forward' });
      } else {
        repo.refs.set(cmd.ref, cmd.newOid);
        refs.push({ ref: cmd.ref, ok: true, reason: '' });
      }
      continue;
    }
    if (cmd.oldOid !== current) {
      refs.push({ ref: cmd.ref, ok: false, reason: 'non-fast-forward' });
      continue;
    }
    const target = newObj.type === 'tag' ? tagTarget(repo, cmd.newOid) ?? cmd.newOid : cmd.newOid;
    if (cmd.newOid === current || isAncestor(repo, current, target)) {
      repo.refs.set(cmd.ref, cmd.newOid);
      refs.push({ ref: cmd.ref, ok: true, reason: '' });
    } else {
      refs.push({ ref: cmd.ref, ok: false, reason: 'non-fast-forward' });
    }
  }
  return { unpackOk: true, unpackDetail: 'ok', refs };
}

function tagTarget(repo: Repo, tagOid: string): string | null {
  const obj = repo.objects.get(tagOid);
  if (obj === undefined || obj.type !== 'tag') return null;
  const m = /^object ([0-9a-f]{40})$/m.exec(obj.data.toString('utf8'));
  return m === null ? null : m[1]!;
}

/** The report-status stream (inside sideband band 1, itself pkt-framed). */
export function pushReport(outcome: PushOutcome): Buffer {
  const lines: string[] = [`unpack ${outcome.unpackDetail}\n`];
  for (const r of outcome.refs) {
    lines.push(r.ok ? `ok ${r.ref}\n` : `ng ${r.ref} ${r.reason}\n`);
  }
  const inner = pktLines([...lines, 'flush']);
  return Buffer.concat([pktLine(Buffer.concat([Buffer.from([1]), inner])), PKT_FLUSH]);
}
