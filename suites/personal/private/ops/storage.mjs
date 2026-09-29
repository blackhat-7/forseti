/**
 * Cloud Storage, as `gsutil` and the `gcloud storage` group, plus the two neighbours a bucket move
 * touches: Cloud CDN backend buckets (`gcloud compute backend-buckets`, `url-maps`) and Pub/Sub
 * topics (`gcloud pubsub`).
 *
 * A production bucket holds millions of objects, so contents are kept compact. Objects that
 * existed before the session come from a shared catalog of day partitions: a bucket holds a
 * "block" per day it has, recording only which of that day's objects it lacks. Objects created
 * during the session (uploads, single-object copies) are tracked one by one. Every object carries a
 * content identity, so a copy is recognisably the same file and rsync skips it, and listings are
 * generated lazily in name order.
 *
 * State lives in ctx.state.storage = { buckets, taken, catalog }, ctx.state.compute.backendBuckets
 * and ctx.state.pubsub.topics. Every change is recorded with ctx.event(...).
 */
import { lines } from './shell.mjs';
import { table } from './world.mjs';
import { yaml } from './gcloud.mjs';

// ---------------------------------------------------------------------------------------------
// The catalog of objects that predate the session.

function mix(a, b) {
  let h = (Math.imul(a ^ 0x9e3779b9, 0x85ebca6b) ^ Math.imul(b + 0x632be5ab, 0xc2b2ae35)) >>> 0;
  h ^= h >>> 16; h = Math.imul(h, 0x7feb352d) >>> 0; h ^= h >>> 15; h = Math.imul(h, 0x846ca68b) >>> 0; h ^= h >>> 16;
  return h >>> 0;
}
const hex8 = (n) => n.toString(16).padStart(8, '0');
const EXT = ['jpg', 'jpg', 'jpg', 'jpg', 'jpg', 'jpg', 'jpg', 'jpg', 'jpg', 'jpg', 'jpg', 'jpg', 'jpg', 'jpg', 'png', 'png', 'png', 'heic', 'heic', 'webp'];
const TYPES = { jpg: 'image/jpeg', png: 'image/png', heic: 'image/heic', webp: 'image/webp' };

/**
 * Day partitions from `from` to `to`, with counts that grow over time and sum to `total`. The
 * last day is partial: it holds only what was uploaded before `cutoff` (seconds into that day).
 */
export function makeCatalog({ from, to, total, cutoff, seed = 7 }) {
  const start = Date.parse(`${from}T00:00:00Z`), end = Date.parse(`${to}T00:00:00Z`);
  const n = Math.round((end - start) / 86400000) + 1;
  const weights = [];
  for (let d = 0; d < n; d++) {
    const date = new Date(start + d * 86400000);
    const weekend = [0, 6].includes(date.getUTCDay()) ? 1.18 : 1;
    const jitter = 0.9 + (mix(seed, d) % 2000) / 10000;
    let w = (0.3 + 0.7 * Math.pow((d + 1) / n, 1.4)) * weekend * jitter;
    if (d === n - 1) w *= cutoff / 86400;
    weights.push(w);
  }
  const sum = weights.reduce((a, b) => a + b, 0);
  const counts = weights.map(w => Math.floor((w / sum) * total));
  let short = total - counts.reduce((a, b) => a + b, 0);
  for (let d = n - 2; short > 0; d = d > 0 ? d - 1 : n - 2) { counts[d]++; short--; }
  const days = counts.map((count, d) => {
    const date = new Date(start + d * 86400000);
    const key = `${date.getUTCFullYear()}/${String(date.getUTCMonth() + 1).padStart(2, '0')}/${String(date.getUTCDate()).padStart(2, '0')}`;
    return { d, key, count, epoch: (start + d * 86400000) / 1000, span: d === n - 1 ? cutoff : 86400 };
  });
  return { days, total, seed, index: new Map(days.map(x => [x.key, x])), reverse: new Map() };
}
/** The i-th object of day `day`: name relative to its block, size, creation instant, identity. */
export function baseObject(catalog, day, i) {
  const h1 = mix(catalog.seed * 7919 + day.d, i), h2 = mix(h1, day.d + 17);
  const ext = EXT[h2 % EXT.length];
  return {
    rest: `${hex8(h1)}${hex8(h2)}.${ext}`,
    size: 40_000 + (mix(h2, 3) % 2_666_000),
    created: day.epoch + Math.floor((i / Math.max(1, day.count)) * day.span) + (h1 % 40),
    id: `b:${day.d}:${i}`,
    type: TYPES[ext],
  };
}
function dayNames(catalog, day) {
  const out = [];
  for (let i = 0; i < day.count; i++) out.push([baseObject(catalog, day, i).rest, i]);
  return out.sort((a, b) => (a[0] < b[0] ? -1 : 1));
}
/** Which index of a day a name belongs to, for looking a single object up by name. */
function indexOf(catalog, day, rest) {
  let map = catalog.reverse.get(day.d);
  if (!map) { map = new Map(dayNames(catalog, day)); catalog.reverse.set(day.d, map); }
  return map.get(rest);
}

// ---------------------------------------------------------------------------------------------
// Buckets and their contents.

/**
 * A bucket. `blocks` maps a key to { day, prefix, cut, removed }: the block holds the names
 * prefix + dayPath.slice(cut) + rest for every index of `day` not in `removed`, where dayPath is
 * `u/YYYY/MM/DD/`. `objects` maps a name to { size, created, id, type, generation }.
 */
export function makeBucket(ctx, spec) {
  const now = ctx.at ? Math.floor(ctx.at().getTime() / 1000) : 0;
  return {
    name: spec.name, project: spec.project, location: (spec.location ?? 'US').toUpperCase(),
    locationType: spec.locationType ?? locationType(spec.location ?? 'US'), storageClass: spec.storageClass ?? 'STANDARD',
    created: spec.created ?? now, updated: spec.updated ?? spec.created ?? now, metageneration: spec.metageneration ?? 1,
    ubla: spec.ubla ?? true, pap: spec.pap ?? 'enforced', versioning: spec.versioning ?? false,
    softDelete: 604800, labels: spec.labels ?? {}, lifecycle: spec.lifecycle ?? [],
    iam: spec.iam ?? defaultPolicy(spec.projectNumber ?? ctx.state.storage.projectNumber, spec.project),
    iamVersion: 1, notifications: spec.notifications ?? [],
    blocks: new Map(), objects: new Map(),
    deleted: { live: 0, bytes: 0, names: [] },
  };
}
const locationType = (l) => (['US', 'EU', 'ASIA'].includes(String(l).toUpperCase()) ? 'multi-region' : ['NAM4', 'EUR4', 'ASIA1', 'EUR5'].includes(String(l).toUpperCase()) ? 'dual-region' : 'region');
function defaultPolicy(number, project) {
  void number;
  return [
    { role: 'roles/storage.legacyBucketOwner', members: [`projectEditor:${project}`, `projectOwner:${project}`] },
    { role: 'roles/storage.legacyBucketReader', members: [`projectViewer:${project}`] },
    { role: 'roles/storage.legacyObjectOwner', members: [`projectEditor:${project}`, `projectOwner:${project}`] },
    { role: 'roles/storage.legacyObjectReader', members: [`projectViewer:${project}`] },
  ];
}
const blockKey = (prefix, cut, d) => `${prefix}\u0000${cut}\u0000${d}`;
const dayPath = (day) => `u/${day.key}/`;
const blockStart = (b) => b.prefix + dayPath(b.day).slice(b.cut);
/**
 * One way to write each set of names: "u/2026/" + "09/29/" and "" + "u/2026/09/29/" are the same
 * block, and must be one key, or a second sync of a sub-folder would copy it all again.
 */
function canon(day, prefix, cut) {
  const path = dayPath(day);
  while (cut > 0 && prefix.endsWith(path[cut - 1])) { prefix = prefix.slice(0, -1); cut--; }
  return { prefix, cut };
}
/** Whole virtual seconds, at least one: a call to the API is never free. */
const pause = (ctx, seconds) => ctx.wait(Math.max(1, Math.round(seconds)));
/** Puts a whole day into a bucket, under `prefix`, lacking the indices in `removed`. */
export function addBlock(bucket, day, prefix = '', cut = 0, removed = new Set()) {
  ({ prefix, cut } = canon(day, prefix, cut));
  const key = blockKey(prefix, cut, day.d);
  const existing = bucket.blocks.get(key);
  if (existing) { for (const i of [...existing.removed]) if (!removed.has(i)) existing.removed.delete(i); return; }
  bucket.blocks.set(key, { day, prefix, cut, removed: new Set(removed) });
}
export const blockCount = (b) => b.day.count - b.removed.size;
export function countObjects(bucket) {
  let n = bucket.objects.size;
  for (const b of bucket.blocks.values()) n += blockCount(b);
  return n;
}
/** Bytes are summed once per block and kept, because a day's sizes never change. */
function blockBytes(catalog, b) {
  if (b.bytes === undefined || b.bytesRemoved !== b.removed.size) {
    let total = 0;
    for (let i = 0; i < b.day.count; i++) if (!b.removed.has(i)) total += baseObject(catalog, b.day, i).size;
    b.bytes = total; b.bytesRemoved = b.removed.size;
  }
  return b.bytes;
}
export function bucketBytes(catalog, bucket, prefix = '') {
  let total = 0;
  for (const b of bucket.blocks.values()) {
    const start = blockStart(b);
    if (start.startsWith(prefix)) total += blockBytes(catalog, b);
    else if (prefix.startsWith(start)) for (const o of blockObjects(catalog, b)) if (o.name.startsWith(prefix)) total += o.size;
  }
  for (const [name, o] of bucket.objects) if (name.startsWith(prefix)) total += o.size;
  return total;
}
function* blockObjects(catalog, b) {
  const start = blockStart(b);
  for (const [rest, i] of dayNames(catalog, b.day)) {
    if (b.removed.has(i)) continue;
    const o = baseObject(catalog, b.day, i);
    yield { name: start + rest, size: o.size, created: o.created, id: o.id, type: o.type, generation: generation(o.created, i), index: i, block: b };
  }
}
const generation = (seconds, salt) => String(seconds * 1_000_000 + (mix(seconds, salt) % 1_000_000));
/** Every object whose name starts with `prefix`, in name order, generated as it is read. */
export function* listObjects(catalog, bucket, prefix = '') {
  const blocks = [...bucket.blocks.values()].filter(b => { const s = blockStart(b); return s.startsWith(prefix) || prefix.startsWith(s); }).sort((a, b) => (blockStart(a) < blockStart(b) ? -1 : 1));
  const singles = [...bucket.objects.keys()].filter(n => n.startsWith(prefix)).sort();
  let p = 0;
  const single = (name) => ({ name, ...bucket.objects.get(name) });
  for (const b of blocks) {
    const start = blockStart(b);
    while (p < singles.length && singles[p] < start) yield single(singles[p++]);
    const inside = [];
    while (p < singles.length && singles[p].startsWith(start)) inside.push(single(singles[p++]));
    let k = 0;
    for (const o of blockObjects(catalog, b)) {
      if (!o.name.startsWith(prefix)) continue;
      while (k < inside.length && inside[k].name < o.name) yield inside[k++];
      yield o;
    }
    while (k < inside.length) yield inside[k++];
  }
  while (p < singles.length) yield single(singles[p++]);
}
/** How many objects sit under `prefix`, without listing them. */
export function countPrefix(catalog, bucket, prefix) {
  let n = 0;
  for (const b of bucket.blocks.values()) {
    const start = blockStart(b);
    if (start.startsWith(prefix)) n += blockCount(b);
    else if (prefix.startsWith(start)) for (const o of blockObjects(catalog, b)) if (o.name.startsWith(prefix)) n++;
  }
  for (const name of bucket.objects.keys()) if (name.startsWith(prefix)) n++;
  return n;
}
/** The object called `name`, or undefined. */
export function lookup(catalog, bucket, name) {
  const single = bucket.objects.get(name);
  if (single) return { name, ...single };
  for (const b of bucket.blocks.values()) {
    const start = blockStart(b);
    if (!name.startsWith(start)) continue;
    const i = indexOf(catalog, b.day, name.slice(start.length));
    if (i === undefined || b.removed.has(i)) continue;
    const o = baseObject(catalog, b.day, i);
    return { name, size: o.size, created: o.created, id: o.id, type: o.type, generation: generation(o.created, i), index: i, block: b };
  }
  return undefined;
}
/** Deletes one object found by lookup. Returns its size. */
function removeObject(bucket, o) {
  if (o.block) o.block.removed.add(o.index);
  else bucket.objects.delete(o.name);
  bucket.deleted.live++;
  bucket.deleted.bytes += o.size;
  if (bucket.deleted.names.length < 50) bucket.deleted.names.push(o.name);
  return o.size;
}
/** Deletes every object under `prefix`. Returns { count, bytes, sample }. */
function removePrefix(catalog, bucket, prefix) {
  let count = 0, bytes = 0;
  const sample = [];
  for (const [key, b] of [...bucket.blocks]) {
    const start = blockStart(b);
    if (start.startsWith(prefix)) {
      const n = blockCount(b);
      count += n; bytes += blockBytes(catalog, b);
      for (const o of take(blockObjects(catalog, b), 3)) if (sample.length < 400) sample.push(o);
      bucket.blocks.delete(key);
      bucket.deleted.live += n;
    } else if (prefix.startsWith(start)) {
      for (const o of [...blockObjects(catalog, b)]) if (o.name.startsWith(prefix)) { count++; bytes += o.size; b.removed.add(o.index); bucket.deleted.live++; if (sample.length < 400) sample.push(o); }
    }
  }
  for (const [name, o] of [...bucket.objects]) if (name.startsWith(prefix)) { count++; bytes += o.size; bucket.objects.delete(name); bucket.deleted.live++; if (sample.length < 400) sample.push({ name, ...o }); }
  bucket.deleted.bytes += bytes;
  for (const o of sample) if (bucket.deleted.names.length < 50) bucket.deleted.names.push(o.name);
  return { count, bytes, sample };
}
function* take(it, n) { let k = 0; for (const x of it) { if (k++ >= n) return; yield x; } }

/**
 * Copies everything under `srcPrefix` in `src` to `dst`, renaming srcPrefix to dstPrefix. With
 * `sync`, objects the destination already holds with the same content are skipped, as rsync does;
 * with `prune`, destination objects under dstPrefix that the source lacks are deleted (rsync -d).
 * Returns what moved, without spending any time: the caller charges the clock.
 */
export function transfer(ctx, src, srcPrefix, dst, dstPrefix, { sync = false, prune = false, dryRun = false, asOf = Infinity } = {}) {
  const catalog = ctx.state.storage.catalog;
  const result = { copied: 0, bytes: 0, skipped: 0, deleted: 0, deletedBytes: 0, listedSrc: 0, listedDst: 0, copySample: [], deleteSample: [] };
  const rename = (name) => dstPrefix + name.slice(srcPrefix.length);
  const plan = [];
  for (const b of src.blocks.values()) {
    const start = blockStart(b);
    if (start.startsWith(srcPrefix)) {
      const full = b.prefix.length >= srcPrefix.length;
      const { prefix, cut } = canon(b.day, full ? dstPrefix + b.prefix.slice(srcPrefix.length) : dstPrefix, full ? b.cut : b.cut + (srcPrefix.length - b.prefix.length));
      plan.push({ b, prefix, cut });
      result.listedSrc += blockCount(b);
    } else if (srcPrefix.startsWith(start)) {
      for (const o of blockObjects(catalog, b)) if (o.name.startsWith(srcPrefix)) { plan.push({ single: o }); result.listedSrc++; }
    }
  }
  // Objects written after the listing was taken (`asOf`) are not part of this transfer.
  for (const [name, o] of src.objects) if (name.startsWith(srcPrefix) && o.created <= asOf) { plan.push({ single: { name, ...o } }); result.listedSrc++; }
  result.listedDst = sync ? countPrefix(catalog, dst, dstPrefix) : 0;
  // The tail of a long transfer is what a terminal keeps, so the last names are the ones kept.
  const note = (list, o) => { list.push(o); if (list.length > 400) list.shift(); };
  const srcNames = prune ? new Set() : null;
  for (const step of plan) {
    if (step.b) {
      const key = blockKey(step.prefix, step.cut, step.b.day.d);
      const existing = dst.blocks.get(key);
      let missing = 0, bytes = 0;
      const sample = [];
      for (let i = 0; i < step.b.day.count; i++) {
        if (step.b.removed.has(i)) continue;
        if (sync && existing && !existing.removed.has(i)) { result.skipped++; continue; }
        const o = baseObject(catalog, step.b.day, i);
        missing++; bytes += o.size;
        if (sample.length < 3) sample.push(step.prefix + dayPath(step.b.day).slice(step.cut) + o.rest);
      }
      // Anything tracked one by one under the same names is superseded by the block copy.
      result.copied += missing; result.bytes += bytes;
      for (const s of sample) note(result.copySample, s);
      if (prune) srcNames.add(key);
      if (!dryRun) {
        if (existing) for (const i of [...existing.removed]) { if (!step.b.removed.has(i)) existing.removed.delete(i); }
        else {
          addBlock(dst, step.b.day, step.prefix, step.cut, step.b.removed);
          const start = step.prefix + dayPath(step.b.day).slice(step.cut);
          for (const name of [...dst.objects.keys()]) if (name.startsWith(start) && dst.objects.get(name).id?.startsWith(`b:${step.b.day.d}:`)) dst.objects.delete(name);
        }
      }
    } else {
      const o = step.single, name = rename(o.name);
      if (prune) srcNames.add(name);
      const have = lookup(catalog, dst, name);
      if (sync && have && have.id === o.id) { result.skipped++; continue; }
      result.copied++; result.bytes += o.size;
      note(result.copySample, name);
      if (!dryRun) dst.objects.set(name, { size: o.size, created: Math.floor(ctx.at().getTime() / 1000), id: o.id, type: o.type ?? 'image/jpeg', generation: generation(Math.floor(ctx.at().getTime() / 1000), result.copied) });
    }
  }
  if (prune) {
    const covered = new Set([...srcNames].filter(k => k.includes('\u0000')));
    for (const [key, b] of [...dst.blocks]) {
      const start = blockStart(b);
      if (!start.startsWith(dstPrefix)) continue;
      if (covered.has(key)) {
        const source = plan.find(s => s.b && blockKey(s.prefix, s.cut, s.b.day.d) === key).b;
        for (const i of source.removed) if (!b.removed.has(i)) {
          const o = baseObject(catalog, b.day, i);
          result.deleted++; result.deletedBytes += o.size; note(result.deleteSample, start + o.rest);
          if (!dryRun) { b.removed.add(i); dst.deleted.live++; dst.deleted.bytes += o.size; }
        }
        continue;
      }
      const n = blockCount(b);
      result.deleted += n; result.deletedBytes += blockBytes(catalog, b);
      for (const o of take(blockObjects(catalog, b), 2)) note(result.deleteSample, o.name);
      if (!dryRun) { dst.blocks.delete(key); dst.deleted.live += n; dst.deleted.bytes += b.bytes ?? 0; if (dst.deleted.names.length < 50) dst.deleted.names.push(start); }
    }
    for (const [name, o] of [...dst.objects]) {
      if (!name.startsWith(dstPrefix) || srcNames.has(name) || o.created > asOf) continue;
      result.deleted++; result.deletedBytes += o.size; note(result.deleteSample, name);
      if (!dryRun) removeObject(dst, { name, ...o });
    }
  }
  return result;
}

// ---------------------------------------------------------------------------------------------
// Shared formatting.

const GMT = (seconds) => new Date(seconds * 1000).toUTCString();
const ISOZ = (seconds) => new Date(seconds * 1000).toISOString().replace(/\.\d+Z$/, 'Z');
const ISO_OFF = (seconds) => new Date(seconds * 1000).toISOString().replace(/\.\d+Z$/, '+0000');
export function human(bytes, gsutilStyle = true) {
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB', 'PiB'];
  let v = bytes, u = 0;
  while (v >= 1024 && u < units.length - 1) { v /= 1024; u++; }
  const text = u === 0 ? `${v} B` : `${v < 10 ? v.toFixed(2) : v < 100 ? v.toFixed(1) : Math.round(v)} ${units[u]}`;
  return gsutilStyle ? text : text.replace(' ', '');
}
const typeOf = (name) => TYPES[String(name).split('.').pop()] ?? 'application/octet-stream';
const shortCount = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}k` : String(n));
function crc(id) { return Buffer.from(hex8(mix(id.length, [...id].reduce((a, c) => a + c.charCodeAt(0), 0))), 'hex').toString('base64'); }
function md5(id) { const h = mix(id.length * 31, [...id].reduce((a, c) => (a * 33 + c.charCodeAt(0)) >>> 0, 5381)); return Buffer.from(hex8(h) + hex8(mix(h, 1)) + hex8(mix(h, 2)) + hex8(mix(h, 3)), 'hex').toString('base64'); }

/** `gs://bucket/path` -> { bucket, path, wildcard }. */
export function parseUrl(url) {
  const m = /^gs:\/\/([^/]*)\/?(.*)$/.exec(url);
  if (!m) return null;
  const wildcard = /[*?[]/.test(m[2]);
  return { bucket: m[1], path: m[2], wildcard };
}
const VALID_NAME = /^[a-z0-9][a-z0-9._-]{1,61}[a-z0-9]$/;

/**
 * Operations both front ends share. Each returns { out, err, code } in the words of whichever
 * tool asked, chosen by `tool` ('gsutil' or 'gcloud').
 */
function storage(ctx) {
  const st = ctx.state.storage;
  const bucket = (name) => st.buckets[name];
  const time = (seconds) => pause(ctx, seconds);
  /** Paging through a listing: 1,000 objects a page, about a tenth of a second each. */
  const listTime = (n) => Math.ceil(n / 1000) * 0.12;
  return { st, bucket, time, listTime };
}

// ---------------------------------------------------------------------------------------------
// Permission model, used by the scenario too.

const WRITE_ROLES = ['roles/storage.objectAdmin', 'roles/storage.objectCreator', 'roles/storage.objectUser', 'roles/storage.admin', 'roles/storage.legacyBucketWriter', 'roles/storage.legacyBucketOwner'];
const READ_ROLES = ['roles/storage.objectAdmin', 'roles/storage.objectViewer', 'roles/storage.objectUser', 'roles/storage.admin', 'roles/storage.legacyObjectReader', 'roles/storage.legacyObjectOwner'];
export const canWrite = (b, member) => Boolean(b) && b.iam.some(x => WRITE_ROLES.includes(x.role) && x.members.includes(member));
export const canRead = (b, member) => Boolean(b) && b.iam.some(x => READ_ROLES.includes(x.role) && x.members.includes(member));

// ---------------------------------------------------------------------------------------------
// gsutil

const GSUTIL_NOTE_M = ['==> NOTE: You are performing a sequence of gsutil operations that may', 'run significantly faster if you instead use gsutil -m cp ... Please', 'see the -m section under "gsutil help options" for further information', 'about when gsutil -m can be advantageous.', ''];

export function makeGsutil(ctx) {
  const { st, bucket, time, listTime } = storage(ctx);
  const catalog = () => st.catalog;
  const project = () => ctx.state.gcloud.project;
  const missingBucket = (name) => ({ err: [`BucketNotFoundException: 404 gs://${name} bucket does not exist.`], code: 1 });
  const commands = {
    ls(args, io, parallel) {
      void parallel;
      const flags = new Set(), urls = [];
      for (let k = 0; k < args.length; k++) { const a = args[k]; if (a === '-p') { k++; continue; } if (a.startsWith('-')) for (const f of a.slice(1)) flags.add(f); else urls.push(a); }
      if (!urls.length) {
        time(0.4);
        return { out: Object.values(st.buckets).filter(b => b.project === project()).sort((a, b) => (a.name < b.name ? -1 : 1)).map(b => `gs://${b.name}/`) };
      }
      // Listings may be millions of lines long, so they are chained lazily rather than copied.
      const parts = [], err = [];
      let code = 0;
      for (const url of urls) {
        const u = parseUrl(url);
        if (!u) { err.push(`CommandException: "ls" command does not support "file://" URLs. Did you mean to use a gs:// URL?`); code = 1; continue; }
        const b = bucket(u.bucket);
        if (!b) { err.push(`BucketNotFoundException: 404 gs://${u.bucket} bucket does not exist.`); code = 1; continue; }
        if (flags.has('b')) {
          time(0.3);
          if (flags.has('L')) parts.push(bucketLong(b));
          else parts.push([`gs://${b.name}/`]);
          continue;
        }
        const r = listing(b, u, flags);
        if (r.err) { err.push(...r.err); code = 1; continue; }
        parts.push(r.out);
      }
      return { out: (function* () { for (const p of parts) yield* p; })(), err, code };
    },
    du(args) {
      const flags = new Set(), urls = [];
      for (const a of args) { if (a.startsWith('-')) for (const f of a.slice(1)) flags.add(f); else urls.push(a); }
      const out = [];
      for (const url of urls) {
        const u = parseUrl(url);
        const b = u && bucket(u.bucket);
        if (!b) return missingBucket(u?.bucket ?? url);
        const prefixes = u.wildcard && !/\*\*/.test(u.path) ? expand(b, u.path) : [u.path.replace(/\*+$/, '')];
        if (!prefixes.length) return { out, err: [`CommandException: No URLs matched: ${url}`], code: 1 };
        let total = 0;
        for (const prefix of prefixes) {
          const n = [...take(countUnder(b, prefix), 1)][0];
          time(listTime(n));
          const bytes = bucketBytes(catalog(), b, prefix);
          total += bytes;
          const size = flags.has('h') ? human(bytes) : String(bytes);
          out.push(`${size.padEnd(flags.has('h') ? 12 : 14)} gs://${b.name}${prefix ? `/${prefix}` : flags.has('s') ? '' : '/'}`);
        }
        if (flags.has('c')) out.push(`${(flags.has('h') ? human(total) : String(total)).padEnd(14)} total`);
      }
      return { out };
    },
    mb(args) {
      let location = 'US', cls = 'STANDARD', ubla = false, proj = project(), pap = 'inherited';
      const urls = [];
      for (let k = 0; k < args.length; k++) {
        const a = args[k];
        if (a === '-l') location = args[++k] ?? '';
        else if (a === '-c' || a === '-s') cls = (args[++k] ?? '').toUpperCase();
        else if (a === '-b') ubla = (args[++k] ?? '').toLowerCase() === 'on';
        else if (a === '-p') proj = args[++k];
        else if (a === '--pap') pap = args[++k] === 'enforced' ? 'enforced' : 'inherited';
        else if (a === '--autoclass' || a === '--placement' || a === '--retention' || a === '--rpo') k++;
        else if (!a.startsWith('-')) urls.push(a);
      }
      const out = [], err = [];
      for (const url of urls) {
        const u = parseUrl(url);
        err.push(`Creating gs://${u?.bucket ?? url}/...`);
        const made = createBucket(u?.bucket, { location, cls, ubla, project: proj, pap }, 'gsutil');
        if (made.error) return { err: [...err, made.error], code: 1 };
      }
      return { out, err };
    },
    rb(args) {
      const force = args.includes('-f');
      const err = [];
      for (const url of args.filter(a => !a.startsWith('-'))) {
        const u = parseUrl(url);
        const b = u && bucket(u.bucket);
        if (!b) { err.push(`NotFoundException: 404 gs://${u?.bucket ?? url} bucket does not exist.`); if (!force) return { err, code: 1 }; continue; }
        err.push(`Removing gs://${b.name}/...`);
        if (countObjects(b) > 0) { err.push(`NotEmptyException: 409 BucketNotEmpty (${b.name}): The bucket you tried to delete is not empty.`); return { err, code: 1 }; }
        deleteBucket(b);
      }
      return { err };
    },
    rm(args, _io, parallel) {
      let recursive = false, all = false;
      const urls = [];
      for (const a of args) { if (a === '-r' || a === '-R' || a === '--recursive') recursive = true; else if (a === '-a') all = true; else if (a === '-f') continue; else if (a.startsWith('-')) { if (a.includes('r') || a.includes('R')) recursive = true; if (a.includes('a')) all = true; } else urls.push(a); }
      void all;
      const err = [];
      let total = 0, code = 0;
      for (const url of urls) {
        const u = parseUrl(url);
        const b = u && bucket(u.bucket);
        if (!b) { err.push(`BucketNotFoundException: 404 gs://${u?.bucket ?? url} bucket does not exist.`); code = 1; continue; }
        let prefix = u.path, removeBucket = false;
        if (u.wildcard) {
          if (!/^[^*?[]*\*\*?$/.test(u.path)) { err.push(`CommandException: No URLs matched: ${url}`); code = 1; continue; }
          prefix = u.path.replace(/\*+$/, '');
          if (u.path.endsWith('/*') || (u.path === '*')) {
            // One level only: objects directly under prefix, which here never exist.
            const direct = [...listObjects(catalog(), b, prefix)].filter(o => !o.name.slice(prefix.length).includes('/'));
            if (!direct.length) { err.push(`CommandException: No URLs matched: ${url}`); code = 1; continue; }
            for (const o of direct) { err.push(`Removing gs://${b.name}/${o.name}...`); removeObject(b, o); total++; }
            ctx.event('storage.objects.delete', { bucket: b.name, count: direct.length, prefix });
            continue;
          }
        } else if (!prefix) {
          if (!recursive) { err.push(`CommandException: "rm" command will not remove buckets. To delete this/these bucket(s) do:`, `	gsutil rm -r ${url}`); code = 1; continue; }
          removeBucket = true;
        } else if (!recursive) {
          const o = lookup(catalog(), b, prefix);
          if (!o) { err.push(`CommandException: No URLs matched: ${url}`); code = 1; continue; }
          time(0.15);
          err.push(`Removing gs://${b.name}/${o.name}#${o.generation}...`);
          removeObject(b, o);
          total++;
          ctx.event('storage.objects.delete', { bucket: b.name, count: 1, prefix: o.name });
          continue;
        } else if (!prefix.endsWith('/')) prefix += '/';
        const before = countObjects(b);
        const r = removePrefix(catalog(), b, prefix);
        if (!r.count && !removeBucket) { err.push(`CommandException: No URLs matched: ${url}`); code = 1; continue; }
        time(r.count / (parallel ? 900 : 45));
        if (r.count > 400) err.push(...(parallel ? [] : GSUTIL_NOTE_M));
        for (const o of r.sample.slice(-300)) err.push(`Removing gs://${b.name}/${o.name}#${o.generation ?? generation(o.created, 1)}...`);
        err.push(`/ [${shortCount(r.count)}/${shortCount(r.count)} objects] 100% Done`, `Operation completed over ${shortCount(r.count)} objects.`);
        total += r.count;
        ctx.event('storage.objects.delete', { bucket: b.name, count: r.count, bytes: r.bytes, prefix, before });
        if (removeBucket) { err.push(`Removing gs://${b.name}/...`); deleteBucket(b); }
      }
      void total;
      return { err, code };
    },
    cp(args, io, parallel) {
      let recursive = false;
      const urls = [];
      for (const a of args) { if (/^-[a-zA-Z]*[rR]/.test(a)) recursive = true; if (a.startsWith('-')) continue; urls.push(a); }
      if (urls.length < 2) return { err: ['CommandException: Wrong number of arguments for "cp" command.'], code: 1 };
      const dest = urls.pop();
      return copy(urls, dest, { recursive, parallel, tool: 'gsutil', io });
    },
    rsync(args, _io, parallel) {
      let recursive = false, prune = false, dryRun = false;
      const urls = [];
      for (let k = 0; k < args.length; k++) {
        const a = args[k];
        if (a === '-x' || a === '-j' || a === '-J' || a === '-y') { k++; continue; }
        if (a.startsWith('-')) { for (const f of a.slice(1)) { if (f === 'r' || f === 'R') recursive = true; if (f === 'd') prune = true; if (f === 'n') dryRun = true; } continue; }
        urls.push(a);
      }
      if (urls.length !== 2) return { err: ['CommandException: Wrong number of arguments for "rsync" command.'], code: 1 };
      return sync(urls[0], urls[1], { recursive, prune, dryRun, parallel, tool: 'gsutil' });
    },
    iam(args, io) {
      const [verb, ...rest] = args;
      if (verb === 'get') {
        const u = parseUrl(rest[0] ?? '');
        const b = u && bucket(u.bucket);
        if (!b) return missingBucket(u?.bucket ?? rest[0]);
        time(0.3);
        return { out: JSON.stringify(policyJson(b), null, 2).split('\n') };
      }
      if (verb === 'ch') {
        const drop = rest[0] === '-d';
        const specs = rest.filter(a => !a.startsWith('gs://') && a !== '-d');
        const targets = rest.filter(a => a.startsWith('gs://'));
        for (const url of targets) {
          const b = bucket(parseUrl(url).bucket);
          if (!b) return missingBucket(parseUrl(url).bucket);
          for (const spec of specs) {
            const m = /^(user|serviceAccount|group|domain|allUsers|allAuthenticatedUsers|projectViewer|projectEditor|projectOwner|principal|principalSet)(?::(.+?))?(?::([A-Za-z.]+))?$/.exec(spec);
            if (!m) return { err: [`CommandException: Incorrect member type for binding ${spec}`], code: 1 };
            const member = m[2] ? `${m[1]}:${m[2]}` : m[1];
            const roleName = m[3] ?? (drop ? null : 'objectViewer');
            if (!drop && !m[3]) return { err: [`CommandException: Must specify a role to grant.`], code: 1 };
            const role = roleName ? (roleName.startsWith('roles/') ? roleName : `roles/storage.${roleAlias(roleName)}`) : null;
            if (drop) unbind(b, member, role); else bind(b, member, role);
          }
        }
        time(0.8);
        return {};
      }
      if (verb === 'set') {
        const [file, url] = rest.filter(a => !a.startsWith('-'));
        const text = io.sh.readFile(file ?? '');
        if (text === null) return { err: [`ArgumentException: Specified IAM policy file "${file}" does not exist.`], code: 1 };
        const b = url && bucket(parseUrl(url)?.bucket);
        if (!b) return missingBucket(parseUrl(url ?? '')?.bucket ?? url);
        let policy;
        try { policy = JSON.parse(text); } catch { return { err: ['ArgumentException: Invalid IAM policy file "' + file + '" or etag "None".'], code: 1 }; }
        return setPolicy(b, policy, 'gsutil');
      }
      return { err: [`CommandException: Invalid subcommand "${verb}" for the "iam" command.`], code: 1 };
    },
    notification(args) {
      const [verb, ...rest] = args;
      if (verb === 'list') {
        const out = [];
        for (const url of rest.filter(a => a.startsWith('gs://'))) {
          const b = bucket(parseUrl(url).bucket);
          if (!b) return missingBucket(parseUrl(url).bucket);
          for (const n of b.notifications) out.push(`projects/_/buckets/${b.name}/notificationConfigs/${n.id}`, `	Cloud Pub/Sub topic: ${n.topic}`, ...(n.eventTypes?.length ? ['	Filters:', `		Event Types: ${n.eventTypes.join(', ')}`] : []), '');
        }
        time(0.3);
        return { out };
      }
      if (verb === 'create') {
        let topic, format = 'none', events = [];
        const urls = [];
        for (let k = 0; k < rest.length; k++) {
          const a = rest[k];
          if (a === '-t') topic = rest[++k];
          else if (a === '-f') format = rest[++k];
          else if (a === '-e') events.push(rest[++k]);
          else if (a === '-p' || a === '-m' || a === '-K') k++;
          else if (a === '-s') continue;
          else urls.push(a);
        }
        if (format !== 'json' && format !== 'none') return { err: [`CommandException: Invalid payload format "${format}"`], code: 1 };
        const b = urls[0] && bucket(parseUrl(urls[0])?.bucket);
        if (!b) return missingBucket(parseUrl(urls[0] ?? '')?.bucket ?? urls[0]);
        const r = addNotification(b, topic ?? b.name, events, format === 'json' ? 'JSON_API_V1' : 'NONE');
        if (r.error) return { err: [r.error], code: 1 };
        time(1.2);
        return { out: [`Created notification config projects/_/buckets/${b.name}/notificationConfigs/${r.id}`] };
      }
      if (verb === 'delete') {
        for (const target of rest) {
          const m = /^projects\/_\/buckets\/([^/]+)\/notificationConfigs\/(\d+)$/.exec(target);
          const b = m ? bucket(m[1]) : target.startsWith('gs://') ? bucket(parseUrl(target).bucket) : null;
          if (!b) return { err: [`NotFoundException: 404 ${target}`], code: 1 };
          const removed = m ? b.notifications.filter(n => n.id === m[2]) : b.notifications;
          b.notifications = b.notifications.filter(n => !removed.includes(n));
          for (const n of removed) ctx.event('storage.notification.delete', { bucket: b.name, topic: n.topic });
        }
        return {};
      }
      return { err: [`CommandException: Invalid subcommand "${verb}" for the "notification" command.`], code: 1 };
    },
    versioning(args) {
      const [verb, ...rest] = args;
      if (verb === 'get') {
        const out = [];
        for (const url of rest) { const b = bucket(parseUrl(url)?.bucket); if (!b) return missingBucket(parseUrl(url)?.bucket ?? url); out.push(`gs://${b.name}: ${b.versioning ? 'Enabled' : 'Suspended'}`); }
        return { out };
      }
      if (verb === 'set') {
        const [state, ...urls] = rest;
        const err = [];
        for (const url of urls) {
          const b = bucket(parseUrl(url)?.bucket);
          if (!b) return missingBucket(parseUrl(url)?.bucket ?? url);
          const on = state === 'on';
          err.push(`${on ? 'Enabling' : 'Suspending'} versioning for gs://${b.name}/...`);
          if (b.versioning !== on) { b.versioning = on; b.metageneration++; ctx.event('storage.bucket.update', { bucket: b.name, versioning: on }); }
        }
        return { err };
      }
      return { err: [`CommandException: Invalid subcommand "${verb}" for the "versioning" command.`], code: 1 };
    },
    retention(args) {
      const [verb, ...rest] = args;
      if (verb === 'get') { const b = bucket(parseUrl(rest[0] ?? '')?.bucket); if (!b) return missingBucket(rest[0]); return { out: [`gs://${b.name}/ has no Retention Policy.`] }; }
      return { err: [`CommandException: Invalid subcommand "${verb}" for the "retention" command.`], code: 1 };
    },
    lifecycle(args) {
      const [verb, ...rest] = args;
      const b = bucket(parseUrl(rest.at(-1) ?? '')?.bucket);
      if (!b) return missingBucket(parseUrl(rest.at(-1) ?? '')?.bucket ?? rest.at(-1));
      if (verb === 'get') return b.lifecycle.length ? { out: [JSON.stringify({ rule: b.lifecycle })] } : { out: [`gs://${b.name}/ has no lifecycle configuration.`] };
      return { err: [`CommandException: Invalid subcommand "${verb}" for the "lifecycle" command.`], code: 1 };
    },
    label(args) {
      const [verb, ...rest] = args;
      const b = bucket(parseUrl(rest.at(-1) ?? '')?.bucket);
      if (!b) return missingBucket(parseUrl(rest.at(-1) ?? '')?.bucket ?? rest.at(-1));
      if (verb === 'get') return Object.keys(b.labels).length ? { out: JSON.stringify(b.labels, null, 2).split('\n') } : { out: [`gs://${b.name}/ has no label configuration.`] };
      if (verb === 'ch') {
        for (let k = 0; k < rest.length - 1; k++) { if (rest[k] === '-l') { const [key, v] = String(rest[++k]).split(':'); b.labels[key] = v; } else if (rest[k] === '-d') delete b.labels[rest[++k]]; }
        b.metageneration++;
        return { err: [`Setting label configuration on gs://${b.name}/...`] };
      }
      return { err: [`CommandException: Invalid subcommand "${verb}" for the "label" command.`], code: 1 };
    },
    defstorageclass(args) {
      const [verb, ...rest] = args;
      if (verb === 'get') { const out = []; for (const url of rest) { const b = bucket(parseUrl(url)?.bucket); if (!b) return missingBucket(url); out.push(`gs://${b.name}: ${b.storageClass}`); } return { out }; }
      return { err: [`CommandException: Invalid subcommand "${verb}" for the "defstorageclass" command.`], code: 1 };
    },
    ubla(args) {
      const [verb, ...rest] = args;
      if (verb === 'get') { const out = []; for (const url of rest) { const b = bucket(parseUrl(url)?.bucket); if (!b) return missingBucket(url); out.push(`Uniform bucket-level access setting for gs://${b.name}:`, `  Enabled: ${b.ubla ? 'True' : 'False'}`, `  LockedTime: ${b.ubla ? GMT(b.created + 86400 * 90) : 'None'}`, ''); } return { out }; }
      if (verb === 'set') { const [state, ...urls] = rest; for (const url of urls) { const b = bucket(parseUrl(url)?.bucket); if (!b) return missingBucket(url); b.ubla = state === 'on'; b.metageneration++; ctx.event('storage.bucket.update', { bucket: b.name, ubla: b.ubla }); } return { err: rest.slice(1).map(u => `${rest[0] === 'on' ? 'Enabling' : 'Disabling'} Uniform bucket-level access for ${u}...`) }; }
      return { err: [`CommandException: Invalid subcommand "${verb}" for the "ubla" command.`], code: 1 };
    },
    stat(args) {
      const out = [];
      for (const url of args.filter(a => !a.startsWith('-'))) {
        const u = parseUrl(url);
        const b = u && bucket(u.bucket);
        if (!b) return missingBucket(u?.bucket ?? url);
        const o = lookup(catalog(), b, u.path);
        if (!o) return { out, err: [`No URLs matched ${url}`], code: 1 };
        time(0.2);
        out.push(`${url}:`, `    Creation time:          ${GMT(o.created)}`, `    Update time:            ${GMT(o.created)}`, `    Storage class:          ${b.storageClass}`, `    Content-Length:         ${o.size}`, `    Content-Type:           ${o.type ?? 'image/jpeg'}`, `    Hash (crc32c):          ${crc(o.id)}`, `    Hash (md5):             ${md5(o.id)}`, `    ETag:                   ${Buffer.from(o.generation).toString('base64').slice(0, 14)}EAE=`, `    Generation:             ${o.generation}`, `    Metageneration:         1`);
      }
      return { out };
    },
    cat(args) {
      const u = parseUrl(args.filter(a => !a.startsWith('-')).at(-1) ?? '');
      const b = u && bucket(u.bucket);
      if (!b) return missingBucket(u?.bucket ?? args[0]);
      const o = lookup(catalog(), b, u.path);
      if (!o) return { err: [`CommandException: No URLs matched: gs://${u.bucket}/${u.path}`], code: 1 };
      return { out: [o.type === 'image/png' ? '�PNG' : '����\u0010JFIF'] };
    },
    version(args) { return { out: args.includes('-l') ? ['gsutil version: 5.30', 'checksum: 5d0ab1b9dd52cf9c2a1c3e0f2fe7ddf0 (OK)', 'boto version: 2.49.0', 'python version: 3.11.2', 'OS: Linux 6.1.0-25-cloud-amd64', 'multiprocessing available: True', 'using cloud sdk: True', 'pass cloud sdk credentials to gsutil: True'] : ['gsutil version: 5.30'] }; },
    help() { return { out: ['Usage: gsutil [-D] [-DD] [-h header]... [-i service_account] [-m] [-o section:flag=value]... [-q] [-u user_project] [command [opts...] args...]', 'Available commands:', '  acl             Get, set, or change bucket and/or object ACLs', '  cat             Concatenate object content to stdout', '  cp              Copy files and objects', '  du              Display object size usage', '  iam             Get, set, or change bucket and/or object IAM permissions.', '  ls              List providers, buckets, or objects', '  mb              Make buckets', '  mv              Move/rename objects', '  notification    Configure object change notification', '  rb              Remove buckets', '  rm              Remove objects', '  rsync           Synchronize content of two buckets/directories', '  stat            Display object status', '  versioning      Enable or suspend versioning for one or more buckets'] }; },
  };
  commands.mv = (args, io, parallel) => {
    const r = commands.cp(args, io, parallel);
    if (r.code) return r;
    const err = [...(r.err ?? [])];
    for (const url of args.filter(a => !a.startsWith('-')).slice(0, -1)) {
      const u = parseUrl(url), b = u && bucket(u.bucket);
      const o = b && !u.wildcard && lookup(st.catalog, b, u.path);
      if (o) { removeObject(b, o); err.push(`Removing ${url}...`); ctx.event('storage.objects.delete', { bucket: b.name, count: 1, prefix: o.name, via: 'mv' }); }
      else err.push(...(commands.rm(['-r', url], io, parallel).err ?? []));
    }
    return { ...r, err };
  };

  /** Names matching a wildcard path, one directory level at a time, as in u/(star)/ or u/2026/0?/(star). */
  function expand(b, path) {
    const segs = path.split('/');
    let current = [''];
    for (let k = 0; k < segs.length; k++) {
      const seg = segs[k], last = k === segs.length - 1;
      if (seg === '') { if (last) break; continue; }
      if (!/[*?[]/.test(seg)) { current = current.map(p => p + seg + (last ? '' : '/')); continue; }
      const re = new RegExp(`^${seg.replace(/[.+^${}()|\\]/g, '\\$&').replace(/\*+/g, '[^/]*').replace(/\?/g, '[^/]')}$`);
      const next = [];
      for (const p of current) for (const child of childNames(b, p)) {
        if (!re.test(child.slice(p.length).replace(/\/$/, ''))) continue;
        if (last || child.endsWith('/')) next.push(child);
      }
      current = next;
    }
    return current;
  }
  const trailingOnly = (path) => /^[^*?[]*(\*\*?)?$/.test(path);
  function listing(b, u, flags) {
    if (u.wildcard && !/\*\*/.test(u.path) && !(flags.has('d') && trailingOnly(u.path))) {
      const matches = expand(b, u.path);
      time(0.3);
      if (!matches.length) return { err: [`CommandException: One or more URLs matched no objects.`] };
      if (flags.has('d')) return { out: matches.map(m => `gs://${b.name}/${m}`) };
      const out = [], objects = [];
      for (const m of matches) if (!m.endsWith('/')) objects.push(lookup(st.catalog, b, m));
      if (objects.length) out.push(...(flags.has('l') || flags.has('L') ? objectLines(objects, b, flags) : objects.map(o => `gs://${b.name}/${o.name}`)));
      for (const m of matches.filter(x => x.endsWith('/'))) {
        const inner = listing(b, { bucket: b.name, path: m, wildcard: false }, flags);
        out.push(...(out.length ? [''] : []), `gs://${b.name}/${m}:`, ...(inner.out ?? []));
      }
      return { out };
    }
    const long = flags.has('l') || flags.has('L');
    const recursive = flags.has('r') || flags.has('R') || /\*\*/.test(u.path);
    let prefix = u.path.replace(/\*+$/, '');
    if (!u.wildcard && prefix && !prefix.endsWith('/')) {
      const exact = lookup(st.catalog, b, prefix);
      if (exact) { time(0.15); return { out: long ? [...objectLines([exact], b, flags)] : [`gs://${b.name}/${prefix}`] }; }
      prefix += '/';
    }
    const all = listObjects(st.catalog, b, prefix);
    if (recursive) {
      const n = countUnder(b, prefix).next().value;
      time(listTime(n));
      if (!n) return { err: [`CommandException: One or more URLs matched no objects.`] };
      const versions = flags.has('a');
      const out = long ? objectLines(all, b, flags, true) : (function* () { for (const o of all) yield `gs://${b.name}/${o.name}${versions ? `#${o.generation}` : ''}`; })();
      return { out };
    }
    time(0.3);
    const seen = new Set(), entries = [];
    for (const name of childNames(b, prefix)) {
      if (seen.has(name)) continue;
      seen.add(name);
      entries.push(name);
    }
    if (!entries.length) return { err: [`CommandException: One or more URLs matched no objects.`] };
    const out = [], objects = [];
    for (const e of entries) {
      if (e.endsWith('/')) out.push(long ? `                                 gs://${b.name}/${e}` : `gs://${b.name}/${e}`);
      else if (long) objects.push(lookup(st.catalog, b, e));
      else out.push(`gs://${b.name}/${e}${flags.has('a') ? `#${lookup(st.catalog, b, e).generation}` : ''}`);
    }
    if (long) out.push(...objectLines(objects, b, flags));
    return { out };
  }
  function* objectLines(objects, b, flags, withTotal = true) {
    let n = 0, bytes = 0;
    for (const o of objects) {
      n++; bytes += o.size;
      if (flags.has('L')) {
        yield `gs://${b.name}/${o.name}:`;
        yield `    Creation time:          ${GMT(o.created)}`;
        yield `    Storage class:          ${b.storageClass}`;
        yield `    Content-Length:         ${o.size}`;
        yield `    Content-Type:           ${o.type ?? 'image/jpeg'}`;
        yield `    Generation:             ${o.generation}`;
        continue;
      }
      yield `${String(flags.has('h') ? human(o.size) : o.size).padStart(10)}  ${ISOZ(o.created)}  gs://${b.name}/${o.name}`;
    }
    if (withTotal && !flags.has('L')) yield `TOTAL: ${n} objects, ${bytes} bytes (${human(bytes)})`;
  }
  /** The next level of names under `prefix`: objects, and "directories" ending in "/". */
  function* childNames(b, prefix) {
    const levels = new Set();
    for (const bl of b.blocks.values()) {
      const start = blockStart(bl);
      if (start.startsWith(prefix) && start !== prefix) { const rest = start.slice(prefix.length); levels.add(rest.slice(0, rest.indexOf('/') + 1)); }
      else if (prefix.startsWith(start)) for (const o of blockObjects(st.catalog, bl)) if (o.name.startsWith(prefix)) { const rest = o.name.slice(prefix.length); levels.add(rest.includes('/') ? rest.slice(0, rest.indexOf('/') + 1) : rest); }
    }
    for (const name of b.objects.keys()) if (name.startsWith(prefix)) { const rest = name.slice(prefix.length); levels.add(rest.includes('/') ? rest.slice(0, rest.indexOf('/') + 1) : rest); }
    for (const l of [...levels].filter(Boolean).sort()) yield prefix + l;
  }
  function* countUnder(b, prefix) { yield countPrefix(st.catalog, b, prefix); }
  function bucketLong(b) {
    return [
      `gs://${b.name}/ :`,
      `	Storage class:			${b.storageClass}`,
      `	Location type:			${b.locationType}`,
      `	Location constraint:		${b.location}`,
      `	Versioning enabled:		${b.versioning ? 'True' : 'None'}`,
      '	Logging configuration:		None',
      '	Website configuration:		None',
      '	CORS configuration: 		None',
      `	Lifecycle configuration:	${b.lifecycle.length ? 'Present' : 'None'}`,
      '	Requester Pays enabled:		None',
      ...(Object.keys(b.labels).length ? ['	Labels:', ...JSON.stringify(b.labels, null, 2).split('\n').map(l => `		${l}`)] : ['	Labels:				None']),
      '	Default KMS key:		None',
      `	Time created:			${GMT(b.created)}`,
      `	Time updated:			${GMT(b.updated)}`,
      `	Metageneration:			${b.metageneration}`,
      `	Bucket Policy Only enabled:	${b.ubla ? 'True' : 'False'}`,
      `	Public access prevention:	${b.pap}`,
      '	RPO:				DEFAULT',
      ...(b.ubla ? [] : ['	ACL:', '	  [', '	    {', `	      "entity": "project-owners-${ctx.state.storage.projectNumber}",`, '	      "role": "OWNER"', '	    }', '	  ]']),
      '	Default ACL:			[]',
    ];
  }
  function copy(sources, dest, { recursive, parallel, tool, io }) {
    const out = [], err = [];
    const d = parseUrl(dest);
    if (!d) return download(sources, dest, tool, io);
    const dst = bucket(d.bucket);
    if (!dst) return tool === 'gsutil' ? { err: [`NotFoundException: 404 The destination bucket gs://${d.bucket} does not exist or the write to the destination must be restarted`], code: 1 } : { err: [`ERROR: (gcloud.storage.cp) gs://${d.bucket} not found: 404.`], code: 1 };
    let copied = 0, bytes = 0, code = 0;
    const sample = [];
    for (const src of sources) {
      const s = parseUrl(src);
      if (!s) {
        // A file from the checkout.
        const text = io?.sh.readFile(src.replace(/^file:\/\//, '')) ?? null;
        if (text === null) { err.push(tool === 'gsutil' ? `CommandException: No URLs matched: ${src}` : `ERROR: (gcloud.storage.cp) The following URLs matched no objects or files:\n-${src}`); code = 1; continue; }
        const base = src.split('/').pop();
        const name = d.path === '' || d.path.endsWith('/') ? `${d.path}${base}` : d.path;
        const size = Buffer.byteLength(text);
        const now = Math.floor(ctx.at().getTime() / 1000);
        dst.objects.set(name, { size, created: now, id: `f:${dst.name}:${name}:${size}`, type: /\.json$/.test(base) ? 'application/json' : /\.ya?ml$/.test(base) ? 'application/octet-stream' : 'text/plain', generation: generation(now, size) });
        err.push(tool === 'gsutil' ? `Copying file://${src.replace(/^file:\/\//, '')} [Content-Type=${/\.json$/.test(base) ? 'application/json' : 'application/octet-stream'}]...` : `Copying file://${src.replace(/^file:\/\//, '')} to gs://${dst.name}/${name}`);
        copied++; bytes += size;
        ctx.event('storage.copy', { src: 'local', dst: dst.name, count: 1, bytes: size, srcPrefix: src, dstPrefix: name });
        continue;
      }
      const sb = bucket(s.bucket);
      if (!sb) { err.push(tool === 'gsutil' ? `BucketNotFoundException: 404 gs://${s.bucket} bucket does not exist.` : `ERROR: (gcloud.storage.cp) gs://${s.bucket} not found: 404.`); code = 1; continue; }
      let srcPrefix, dstPrefix;
      const dstDir = d.path && !d.path.endsWith('/') ? `${d.path}/` : d.path;
      if (s.wildcard) {
        const base = s.path.replace(/\*+$/, '');
        if (s.path.endsWith('**')) { srcPrefix = base; dstPrefix = dstDir; }
        else {
          if (!recursive) {
            const dirs = [...childNames(sb, base)].filter(n => n.endsWith('/'));
            const files = [...childNames(sb, base)].filter(n => !n.endsWith('/'));
            for (const dir of dirs) err.push(`Omitting prefix "gs://${sb.name}/${dir}". (Did you mean to do cp -r?)`);
            for (const f of files) { const o = lookup(st.catalog, sb, f); const name = dstDir + f.slice(base.length); dst.objects.set(name, { ...o, created: Math.floor(ctx.at().getTime() / 1000) }); copied++; bytes += o.size; }
            if (!files.length) { err.push(tool === 'gsutil' ? `CommandException: ${dirs.length} file/object could not be transferred.` : `ERROR: (gcloud.storage.cp) The following URLs matched no objects or files:\n-${src}`); code = 1; }
            continue;
          }
          srcPrefix = base; dstPrefix = dstDir;
        }
      } else {
        const exact = s.path && !s.path.endsWith('/') ? lookup(st.catalog, sb, s.path) : undefined;
        if (exact) {
          const name = d.path === '' || d.path.endsWith('/') ? dstDir + s.path.split('/').pop() : d.path;
          time(0.4);
          dst.objects.set(name, { size: exact.size, created: Math.floor(ctx.at().getTime() / 1000), id: exact.id, type: exact.type, generation: generation(Math.floor(ctx.at().getTime() / 1000), 5) });
          err.push(tool === 'gsutil' ? `Copying ${src} [Content-Type=${exact.type}]...` : `Copying ${src} to gs://${dst.name}/${name}`);
          copied++; bytes += exact.size;
          ctx.event('storage.copy', { src: sb.name, dst: dst.name, count: 1, bytes: exact.size, srcPrefix: s.path, dstPrefix: name });
          continue;
        }
        if (!recursive) { err.push(tool === 'gsutil' ? `Omitting prefix "gs://${sb.name}/${s.path}". (Did you mean to do cp -r?)` : `ERROR: (gcloud.storage.cp) Source URL gs://${sb.name}/${s.path} is a bucket or directory. Use --recursive.`); code = 1; continue; }
        // cp -r of a bucket or a "directory" nests it under its own last name, like cp -r dir dest.
        const trimmed = s.path.replace(/\/$/, '');
        srcPrefix = trimmed ? `${trimmed}/` : '';
        const leaf = trimmed ? trimmed.split('/').pop() : sb.name;
        dstPrefix = `${dstDir}${leaf}/`;
      }
      // The listing is taken when the command starts; the copies land when it finishes.
      const asOf = Math.floor(ctx.at().getTime() / 1000);
      const planned = transfer(ctx, sb, srcPrefix, dst, dstPrefix, { dryRun: true, asOf });
      if (!planned.listedSrc) { err.push(tool === 'gsutil' ? `CommandException: No URLs matched: ${src}` : `ERROR: (gcloud.storage.cp) The following URLs matched no objects or files:\n-${src}`); code = 1; continue; }
      time(listTime(planned.listedSrc) + copyTime(planned.copied, planned.bytes, parallel));
      const r = transfer(ctx, sb, srcPrefix, dst, dstPrefix, { asOf });
      copied += r.copied; bytes += r.bytes;
      for (const name of r.copySample) sample.push([sb.name, name.slice(dstPrefix.length), name]);
      ctx.event('storage.copy', { src: sb.name, dst: dst.name, count: r.copied, bytes: r.bytes, srcPrefix, dstPrefix });
    }
    if (copied) {
      if (tool === 'gsutil') {
        if (!parallel && copied > 400) err.push(...GSUTIL_NOTE_M);
        for (const [from, rel, to] of sample.slice(-300)) err.push(`Copying gs://${from}/${srcPrefixName(rel, to)} [Content-Type=${typeOf(to)}]...`);
        err.push(`/ [${shortCount(copied)}/${shortCount(copied)} files][${human(bytes).padStart(9)}/${human(bytes).padStart(9)}] 100% Done ${parallel ? ' 1.4 GiB/s' : ' 61.2 MiB/s'} ETA 00:00:00`, `Operation completed over ${shortCount(copied)} objects/${human(bytes)}.`);
      } else {
        for (const [from, , to] of sample.slice(-300)) err.push(`Copying gs://${from}/${to.split('/').slice(-5).join('/')} to gs://${dst.name}/${to}`);
        err.push(`  Completed files ${copied}/${copied} | ${human(bytes, false)}/${human(bytes, false)} | 1.5GiB/s`, '', `Average throughput: 1.5GiB/s`);
      }
    }
    return { out, err, code };
  }
  const srcPrefixName = (rel, to) => to.slice(to.length - rel.length);
  /** Objects copied into the checkout. Images arrive as the bytes they are; nothing else here is text. */
  function download(sources, dest, tool, io) {
    const err = [];
    if (sources.length > 1 && !io?.sh.isDir(io.sh.relative(dest) ?? '\u0000')) return { err: [tool === 'gsutil' ? 'CommandException: Destination URL must name a directory, bucket, or bucket subdirectory for the multiple source form of the cp command.' : `ERROR: (gcloud.storage.cp) Destination URL ${dest} must be a directory when copying multiple sources.`], code: 1 };
    for (const src of sources) {
      const u = parseUrl(src);
      const b = u && bucket(u.bucket);
      const o = b && lookup(st.catalog, b, u.path);
      if (!o) return { err: [...err, tool === 'gsutil' ? `CommandException: No URLs matched: ${src}` : `ERROR: (gcloud.storage.cp) The following URLs matched no objects or files:\n-${src}`], code: 1 };
      const rel = io.sh.relative(dest);
      const target = rel !== null && io.sh.isDir(rel) ? `${dest.replace(/\/$/, '')}/${o.name.split('/').pop()}` : dest;
      time(0.5 + o.size / 1.2e8);
      err.push(tool === 'gsutil' ? `Copying ${src}...` : `Copying ${src} to file://${target}`);
      const body = o.type === 'application/json' ? `{\n  "version": 4,\n  "terraform_version": "1.7.5",\n  "serial": 412,\n  "lineage": "5b0e2a7c-1f3d-4e8a-9c6b-7d2f0e4a1b93",\n  "outputs": {},\n  "resources": [],\n  "check_results": null\n}\n` : '\uFFFD\uFFFD\uFFFD\uFFFD\u0010JFIF\u0000\u0001\u0001\u0000\u0000H\u0000H\u0000\u0000\uFFFD\uFFFD\n';
      const problem = io.sh.writeFile(target, body);
      if (problem) return { err: [...err, tool === 'gsutil' ? `OSError: [Errno 13] ${problem}: '${target}'` : `ERROR: [Errno 13] ${problem}: '${target}'`], code: 1 };
      if (tool === 'gsutil') err.push(`/ [1 files][${human(o.size).padStart(9)}/${human(o.size).padStart(9)}]`, `Operation completed over 1 objects/${human(o.size)}.`);
      else err.push(`  Completed files 1/1 | ${human(o.size, false)}/${human(o.size, false)}`);
    }
    return { err };
  }
  function sync(from, to, { recursive, prune, dryRun, parallel, tool }) {
    const s = parseUrl(from), d = parseUrl(to);
    const err = [];
    if (!s || !d) return tool === 'gsutil' ? { err: [`CommandException: arg (${!s ? from : to}) does not name a directory, bucket, or bucket subdir.`], code: 1 } : { err: [`ERROR: (gcloud.storage.rsync) Expected destination to be a container.`], code: 1 };
    const sb = bucket(s.bucket), db = bucket(d.bucket);
    if (!sb) return tool === 'gsutil' ? { err: [`CommandException: arg (${from}) does not name a directory, bucket, or bucket subdir.`, 'If there is an object with the same path, please add a trailing', 'slash to specify the directory.'], code: 1 } : { err: [`ERROR: (gcloud.storage.rsync) gs://${s.bucket} not found: 404.`], code: 1 };
    if (!db) return tool === 'gsutil' ? { err: [`CommandException: arg (${to}) does not name a directory, bucket, or bucket subdir.`, 'If there is an object with the same path, please add a trailing', 'slash to specify the directory.'], code: 1 } : { err: [`ERROR: (gcloud.storage.rsync) gs://${d.bucket} not found: 404.`], code: 1 };
    const srcPrefix = s.path && !s.path.endsWith('/') ? `${s.path}/` : s.path;
    const dstPrefix = d.path && !d.path.endsWith('/') ? `${d.path}/` : d.path;
    if (tool === 'gsutil') err.push('Building synchronization state...');
    if (!recursive) {
      // Only objects directly under the prefix; subdirectories are skipped without -r.
      const direct = [...childNames(sb, srcPrefix)].filter(n => !n.endsWith('/'));
      time(1.5);
      if (tool === 'gsutil') err.push('Starting synchronization...');
      for (const name of direct) { const o = lookup(st.catalog, sb, name); if (!dryRun) db.objects.set(dstPrefix + name.slice(srcPrefix.length), { ...o, created: Math.floor(ctx.at().getTime() / 1000) }); }
      if (tool !== 'gsutil' && !direct.length) err.push('At source listing 0...', 'At destination listing 0...');
      ctx.event('storage.rsync', { src: sb.name, dst: db.name, srcPrefix, dstPrefix, count: dryRun ? 0 : direct.length, bytes: 0, recursive: false, prune, dryRun });
      return { err };
    }
    // Both listings are taken when the command starts; copies and deletions land when it finishes.
    const asOf = Math.floor(ctx.at().getTime() / 1000);
    const planned = transfer(ctx, sb, srcPrefix, db, dstPrefix, { sync: true, prune, dryRun: true, asOf });
    time(listTime(planned.listedSrc) + listTime(planned.listedDst) + (dryRun ? 0 : copyTime(planned.copied, planned.bytes, parallel) + planned.deleted / (parallel ? 900 : 45)));
    const r = dryRun ? planned : transfer(ctx, sb, srcPrefix, db, dstPrefix, { sync: true, prune, asOf });
    if (tool === 'gsutil') {
      if (r.listedSrc > 1000) err.push(`At source listing ${Math.floor(r.listedSrc / 10000) * 10000}...`);
      if (r.listedDst > 1000) err.push(`At destination listing ${Math.floor(r.listedDst / 10000) * 10000}...`);
      err.push('Starting synchronization...');
      if (!parallel && r.copied > 400 && !dryRun) err.push(...GSUTIL_NOTE_M);
      for (const name of r.copySample.slice(-300)) err.push(dryRun ? `Would copy gs://${sb.name}/${srcPrefix}${name.slice(dstPrefix.length)} to gs://${db.name}/${name}` : `Copying gs://${sb.name}/${srcPrefix}${name.slice(dstPrefix.length)} [Content-Type=${typeOf(name)}]...`);
      for (const name of r.deleteSample.slice(-200)) err.push(dryRun ? `Would remove gs://${db.name}/${name}` : `Removing gs://${db.name}/${name}`);
      if (!dryRun && (r.copied || r.deleted)) err.push(`/ [${shortCount(r.copied)}/${shortCount(r.copied)} files][${human(r.bytes).padStart(9)}/${human(r.bytes).padStart(9)}] 100% Done ${parallel ? ' 1.4 GiB/s' : ' 61.2 MiB/s'} ETA 00:00:00`, `Operation completed over ${shortCount(r.copied)} objects/${human(r.bytes)}.`);
    } else {
      err.push(`At source listing ${r.listedSrc}...`, `At destination listing ${r.listedDst}...`);
      for (const name of r.copySample.slice(-300)) err.push(dryRun ? `Would copy gs://${sb.name}/${srcPrefix}${name.slice(dstPrefix.length)} to gs://${db.name}/${name}` : `Copying gs://${sb.name}/${srcPrefix}${name.slice(dstPrefix.length)} to gs://${db.name}/${name}`);
      for (const name of r.deleteSample.slice(-200)) err.push(dryRun ? `Would remove gs://${db.name}/${name}` : `Removing gs://${db.name}/${name}`);
      if (!dryRun && (r.copied || r.deleted)) err.push(`  Completed files ${r.copied + r.deleted}/${r.copied + r.deleted} | ${human(r.bytes, false)}/${human(r.bytes, false)} | 1.5GiB/s`, '', 'Average throughput: 1.5GiB/s');
    }
    ctx.event('storage.rsync', { src: sb.name, dst: db.name, srcPrefix, dstPrefix, count: dryRun ? 0 : r.copied, bytes: dryRun ? 0 : r.bytes, deleted: dryRun ? 0 : r.deleted, recursive: true, prune, dryRun });
    if (r.deleted && !dryRun) ctx.event('storage.objects.delete', { bucket: db.name, count: r.deleted, bytes: r.deletedBytes, prefix: dstPrefix, via: 'rsync' });
    return { err };
  }
  /** Server-side rewrites: about 1,200 objects a second in parallel, one at a time about 12. */
  const copyTime = (n, bytes, parallel) => (parallel ? Math.max(n / 1200, bytes / 1.6e9) : Math.max(n / 12, bytes / 6.4e7));

  function createBucket(name, { location, cls, ubla, project: proj, pap }, tool) {
    const fail = (message) => ({ error: tool === 'gsutil' ? message.gsutil : message.gcloud });
    if (!name || !VALID_NAME.test(name) || name.includes('..') || name.startsWith('goog')) return fail({ gsutil: `BadRequestException: 400 Invalid bucket name: '${name}'`, gcloud: `ERROR: (gcloud.storage.buckets.create) HTTPError 400: Invalid bucket name: '${name}'` });
    if (st.buckets[name] || st.taken.has(name)) return fail({ gsutil: `ServiceException: 409 A Cloud Storage bucket named '${name}' already exists. Try another name. Bucket names must be globally unique across all Google Cloud projects, including those outside of your organization.`, gcloud: `ERROR: (gcloud.storage.buckets.create) HTTPError 409: The requested bucket name is not available. The bucket namespace is shared by all users of the system. Please select a different name and try again.` });
    const loc = String(location || 'US').toUpperCase();
    if (!LOCATIONS.has(loc)) return fail({ gsutil: `BadRequestException: 400 Invalid Value`, gcloud: `ERROR: (gcloud.storage.buckets.create) HTTPError 400: Invalid Value` });
    // The organization enforces uniform bucket-level access and public access prevention.
    if (!ubla) return fail({ gsutil: `PreconditionException: 412 Request violates constraint 'constraints/storage.uniformBucketLevelAccess'`, gcloud: `ERROR: (gcloud.storage.buckets.create) HTTPError 412: Request violates constraint 'constraints/storage.uniformBucketLevelAccess'` });
    if (proj !== ctx.state.gcloud.project && !ctx.state.gcloud.projects.some(p => p.id === proj)) return fail({ gsutil: `AccessDeniedException: 403 ${ctx.state.gcloud.account} does not have storage.buckets.create access to the Google Cloud project. Permission 'storage.buckets.create' denied on resource (or it may not exist).`, gcloud: `ERROR: (gcloud.storage.buckets.create) HTTPError 403: ${ctx.state.gcloud.account} does not have storage.buckets.create access to the Google Cloud project. Permission 'storage.buckets.create' denied on resource (or it may not exist).` });
    const b = makeBucket(ctx, { name, project: proj, location: loc, storageClass: cls || 'STANDARD', ubla: true, pap: pap === 'enforced' ? 'enforced' : 'enforced' });
    st.buckets[name] = b;
    ctx.event('storage.bucket.create', { bucket: name, location: loc, project: proj });
    time(1.5);
    return { bucket: b };
  }
  function deleteBucket(b) {
    delete st.buckets[b.name];
    st.taken.add(b.name);
    ctx.event('storage.bucket.delete', { bucket: b.name });
  }
  function bind(b, member, role) {
    let binding = b.iam.find(x => x.role === role && !x.condition);
    if (!binding) { binding = { role, members: [] }; b.iam.push(binding); }
    if (!binding.members.includes(member)) { binding.members.push(member); binding.members.sort(); b.iamVersion++; ctx.event('storage.iam.bind', { bucket: b.name, member, role }); }
  }
  function unbind(b, member, role) {
    for (const x of b.iam) if (!role || x.role === role) {
      const before = x.members.length;
      x.members = x.members.filter(m => m !== member);
      if (x.members.length !== before) { b.iamVersion++; ctx.event('storage.iam.unbind', { bucket: b.name, member, role: x.role }); }
    }
    b.iam = b.iam.filter(x => x.members.length);
  }
  function policyJson(b) {
    return { bindings: [...b.iam].sort((x, y) => (x.role < y.role ? -1 : 1)).map(x => ({ members: [...x.members], role: x.role })), etag: Buffer.from([8, b.iamVersion % 128]).toString('base64') };
  }
  function setPolicy(b, policy, tool) {
    if (!Array.isArray(policy.bindings)) return { err: [tool === 'gsutil' ? 'ArgumentException: Invalid IAM policy file.' : 'ERROR: (gcloud.storage.buckets.set-iam-policy) Invalid policy file.'], code: 1 };
    const before = JSON.stringify(b.iam);
    b.iam = policy.bindings.filter(x => x && typeof x.role === 'string' && Array.isArray(x.members)).map(x => ({ role: x.role, members: [...x.members].sort() }));
    b.iamVersion++;
    ctx.event('storage.iam.set', { bucket: b.name, before: JSON.parse(before), after: b.iam });
    time(0.8);
    return tool === 'gsutil' ? { out: JSON.stringify(policyJson(b), null, 2).split('\n') } : { out: yaml(policyJson(b)) };
  }
  function addNotification(b, topicSpec, events, payload) {
    const topicName = topicSpec.includes('/') ? topicSpec.split('/').pop() : topicSpec;
    const topicProject = topicSpec.includes('/') ? topicSpec.split('/')[1] : ctx.state.gcloud.project;
    const topic = ctx.state.pubsub.topics[topicName];
    if (!topic || topicProject !== ctx.state.gcloud.project) {
      // gsutil creates a missing topic on the fly, as the real one does.
      ctx.state.pubsub.topics[topicName] = { name: topicName, created: ctx.t, subscriptions: [] };
      ctx.event('pubsub.topic.create', { topic: topicName });
    }
    const id = String(b.notifications.reduce((m, n) => Math.max(m, Number(n.id)), 0) + 1);
    const n = { id, topic: `//pubsub.googleapis.com/projects/${topicProject}/topics/${topicName}`, topicName, eventTypes: events.map(e => e.toUpperCase()), payloadFormat: payload };
    b.notifications.push(n);
    ctx.event('storage.notification.create', { bucket: b.name, topic: topicName, eventTypes: n.eventTypes, payloadFormat: payload });
    return { id };
  }
  function roleAlias(short) {
    const map = { objectviewer: 'objectViewer', objectadmin: 'objectAdmin', objectcreator: 'objectCreator', objectuser: 'objectUser', admin: 'admin', r: 'objectViewer', w: 'objectCreator', o: 'objectAdmin', legacybucketreader: 'legacyBucketReader', legacybucketwriter: 'legacyBucketWriter', legacybucketowner: 'legacyBucketOwner', legacyobjectreader: 'legacyObjectReader', legacyobjectowner: 'legacyObjectOwner' };
    return map[short.toLowerCase()] ?? short;
  }

  const gsutil = (argv, io) => {
    let parallel = false, k = 0;
    for (; k < argv.length; k++) {
      const a = argv[k];
      if (a === '-m') parallel = true;
      else if (a === '-o' || a === '-h' || a === '-u' || a === '-i') k++;
      else if (a === '-q' || a === '-D' || a === '-DD') continue;
      else break;
    }
    const [name, ...args] = argv.slice(k);
    if (!name) return commands.help();
    const cmd = commands[name];
    if (!cmd) return { err: [`CommandException: Invalid command "${name}".`], code: 1 };
    time(0.8);
    try { return cmd(args, io, parallel); }
    catch (e) {
      // A gap in this model must not end the session; the service's own transient error is what an operator would see.
      ctx.event('storage.internal', { command: name, error: String(e?.message ?? e) });
      return { err: ['ServiceException: 503 We encountered an internal error. Please try again.'], code: 1 };
    }
  };
  return { gsutil, commands, internals: { createBucket, deleteBucket, bind, unbind, policyJson, setPolicy, addNotification, copy, sync, listing, childNames, countUnder, bucketLong, roleAlias } };
}
/** The rest of the project's Compute Engine inventory, for the `list` commands an operator looks around with. */
const ZONES = ['us-central1-a', 'us-central1-b', 'us-central1-c', 'us-central1-f', 'us-east1-b', 'us-east1-c', 'us-east1-d', 'us-west1-a', 'us-west1-b', 'europe-west1-b', 'europe-west1-c', 'europe-west1-d', 'europe-west2-a', 'europe-west3-a', 'europe-west4-a', 'asia-east1-a'];
const LISTS = {
  instances: () => [['NAME', 'ZONE', 'MACHINE_TYPE', 'PREEMPTIBLE', 'INTERNAL_IP', 'EXTERNAL_IP', 'STATUS'], [
    ['gke-prod-usc1-general-7f3c2a1e-4kqz', 'us-central1-a', 'e2-standard-8', '', '10.128.0.14', '', 'RUNNING'],
    ['gke-prod-usc1-general-7f3c2a1e-9wtm', 'us-central1-a', 'e2-standard-8', '', '10.128.0.15', '', 'RUNNING'],
    ['gke-prod-usc1-general-7f3c2a1e-h2xp', 'us-central1-a', 'e2-standard-8', '', '10.128.0.19', '', 'RUNNING'],
    ['gke-prod-usc1-general-b81d04c9-5nrd', 'us-central1-b', 'e2-standard-8', '', '10.128.0.22', '', 'RUNNING'],
    ['gke-prod-usc1-general-b81d04c9-q7vl', 'us-central1-b', 'e2-standard-8', '', '10.128.0.23', '', 'RUNNING'],
    ['gke-prod-usc1-general-b81d04c9-zm8c', 'us-central1-b', 'e2-standard-8', '', '10.128.0.27', '', 'RUNNING'],
  ]],
  networks: () => [['NAME', 'SUBNET_MODE', 'BGP_ROUTING_MODE', 'IPV4_RANGE', 'GATEWAY_IPV4'], [['prod-vpc', 'CUSTOM', 'GLOBAL', '', '']]],
  addresses: () => [['NAME', 'ADDRESS/RANGE', 'TYPE', 'PURPOSE', 'NETWORK', 'REGION', 'SUBNET', 'STATUS'], [['uploads-cdn-ip', '34.117.84.203', 'EXTERNAL', '', '', '', '', 'IN_USE']]],
  'forwarding-rules': () => [['NAME', 'REGION', 'IP_ADDRESS', 'IP_PROTOCOL', 'TARGET'], [['uploads-cdn-https', '', '34.117.84.203', 'TCP', 'uploads-cdn-https-proxy']]],
  'target-https-proxies': () => [['NAME', 'SSL_CERTIFICATES', 'URL_MAP', 'REGION', 'CERTIFICATE_MAP'], [['uploads-cdn-https-proxy', 'cdn-quillmart-com', 'uploads-cdn-map', '', '']]],
  'ssl-certificates': (now) => [['NAME', 'TYPE', 'CREATION_TIMESTAMP', 'EXPIRE_TIME', 'REGION', 'MANAGED_STATUS'], [['cdn-quillmart-com', 'MANAGED', new Date((now - 41 * 86400 - 5233) * 1000).toISOString().replace('Z', '-00:00'), new Date((now + 49 * 86400 - 5232) * 1000).toISOString().replace(/\.\d+Z$/, '.000-00:00'), '', 'ACTIVE']]],
  'backend-services': () => [['NAME', 'BACKENDS', 'PROTOCOL'], []],
  regions: () => [['NAME', 'CPUS', 'DISKS_GB', 'ADDRESSES', 'RESERVED_ADDRESSES', 'STATUS', 'TURNDOWN_DATE'], [...new Set(ZONES.map(z => z.slice(0, z.lastIndexOf('-'))))].sort().map(r => [r, r === 'us-central1' ? '48/600' : '0/600', r === 'us-central1' ? '600/40960' : '0/40960', r === 'us-central1' ? '1/200' : '0/200', '0/100', 'UP', ''])],
  zones: () => [['NAME', 'REGION', 'STATUS', 'NEXT_MAINTENANCE', 'TURNDOWN_DATE'], [...ZONES].sort().map(z => [z, z.slice(0, z.lastIndexOf('-')), 'UP', '', ''])],
};
const LOCATIONS = new Set(['US', 'EU', 'ASIA', 'NAM4', 'EUR4', 'EUR5', 'EUR7', 'EUR8', 'ASIA1', 'US-CENTRAL1', 'US-EAST1', 'US-EAST4', 'US-WEST1', 'US-WEST2', 'EUROPE-WEST1', 'EUROPE-WEST2', 'EUROPE-WEST3', 'EUROPE-WEST4', 'EUROPE-WEST6', 'EUROPE-WEST8', 'EUROPE-WEST9', 'EUROPE-NORTH1', 'EUROPE-CENTRAL2', 'EUROPE-SOUTHWEST1', 'ASIA-EAST1', 'ASIA-NORTHEAST1', 'ASIA-SOUTHEAST1', 'AUSTRALIA-SOUTHEAST1', 'NORTHAMERICA-NORTHEAST1', 'SOUTHAMERICA-EAST1']);

// ---------------------------------------------------------------------------------------------
// gcloud storage, gcloud compute backend-buckets / url-maps, gcloud pubsub

export function makeStorageGroups(ctx) {
  const { gsutil, commands, internals } = makeGsutil(ctx);
  const st = ctx.state.storage;
  const bucketOf = (url) => st.buckets[parseUrl(url ?? '')?.bucket ?? ''];
  const describe = (b) => ({
    creation_time: ISO_OFF(b.created), default_storage_class: b.storageClass, location: b.location, location_type: b.locationType,
    metageneration: b.metageneration, name: b.name, public_access_prevention: b.pap,
    soft_delete_policy: { effectiveTime: ISOZ(b.created), retentionDurationSeconds: String(b.softDelete) },
    storage_url: `gs://${b.name}/`, uniform_bucket_level_access: b.ubla, update_time: ISO_OFF(b.updated),
    ...(Object.keys(b.labels).length ? { labels: b.labels } : {}),
    ...(b.lifecycle.length ? { lifecycle_config: { rule: b.lifecycle } } : {}),
    ...(b.versioning ? { versioning_enabled: true } : {}),
  });
  const docs = (items) => items.flatMap((x, k) => [...(k ? ['---'] : []), ...yaml(x)]);
  const storageGroup = (args, io, g) => {
    const [sub, ...rest] = args;
    const pos = g.positional.slice(1);
    if (sub === 'buckets') {
      const [verb] = rest;
      const target = pos.slice(1).find(a => a.startsWith('gs://')) ?? (pos[1] && !pos[1].startsWith('-') ? `gs://${pos[1]}` : undefined);
      if (verb === 'list') {
        pause(ctx, 0.6);
        const keep = filterOf(g.flag('filter'));
        if (keep.error) return g.error(keep.error);
        const list = Object.values(st.buckets).filter(b => b.project === g.project && keep(describe(b))).sort((a, b) => (a.name < b.name ? -1 : 1));
        if (g.flag('format')) return g.print(list.map(describe));
        return { out: docs(list.map(describe)) };
      }
      if (verb === 'describe') {
        const b = bucketOf(target);
        if (!b) return g.error(`gs://${parseUrl(target ?? '')?.bucket ?? ''} not found: 404.`);
        return g.print(describe(b));
      }
      if (verb === 'create') {
        const name = parseUrl(target ?? '')?.bucket;
        const r = internals.createBucket(name, { location: g.flag('location') ?? g.flag('l') ?? 'US', cls: String(g.flag('default-storage-class') ?? 'STANDARD').toUpperCase(), ubla: g.has('uniform-bucket-level-access') || g.has('b'), project: g.project, pap: g.flag('public-access-prevention') }, 'gcloud');
        if (r.error) return { err: [`Creating gs://${name}/...`, r.error], code: 1 };
        return { err: [`Creating gs://${name}/...`] };
      }
      if (verb === 'delete') {
        const b = bucketOf(target);
        if (!b) return g.error(`gs://${parseUrl(target ?? '')?.bucket ?? ''} not found: 404.`);
        if (countObjects(b) > 0) return { err: [`Removing gs://${b.name}/...`, `ERROR: (gcloud.storage.buckets.delete) HTTPError 409: The bucket you tried to delete is not empty.`], code: 1 };
        internals.deleteBucket(b);
        return { err: [`Removing gs://${b.name}/...`, '  Completed 1'] };
      }
      if (verb === 'update') {
        const b = bucketOf(target);
        if (!b) return g.error(`gs://${parseUrl(target ?? '')?.bucket ?? ''} not found: 404.`);
        if (g.has('versioning')) b.versioning = true;
        if (g.has('no-versioning')) b.versioning = false;
        if (g.has('uniform-bucket-level-access')) b.ubla = true;
        if (typeof g.flag('update-labels') === 'string') for (const pair of g.flag('update-labels').split(',')) { const [k, v] = pair.split('='); b.labels[k] = v; }
        if (g.has('location')) return g.error('unrecognized arguments: --location');
        b.metageneration++;
        ctx.event('storage.bucket.update', { bucket: b.name, flags: Object.keys(g.flags) });
        return { err: [`Updating gs://${b.name}/...`, '  Completed 1'] };
      }
      if (verb === 'add-iam-policy-binding' || verb === 'remove-iam-policy-binding') {
        const b = bucketOf(target);
        if (!b) return g.error(`gs://${parseUrl(target ?? '')?.bucket ?? ''} not found: 404.`);
        const member = g.flag('member'), role = g.flag('role');
        if (typeof member !== 'string' || typeof role !== 'string') return g.error('argument --member --role: Must be specified.', 2);
        if (!role.startsWith('roles/')) return g.error(`HTTPError 400: Role (${role}) does not exist in the resource's hierarchy.`);
        if (verb === 'add-iam-policy-binding') internals.bind(b, member, role); else internals.unbind(b, member, role);
        return g.print(internals.policyJson(b));
      }
      if (verb === 'get-iam-policy') {
        const b = bucketOf(target);
        if (!b) return g.error(`gs://${parseUrl(target ?? '')?.bucket ?? ''} not found: 404.`);
        return g.print(internals.policyJson(b));
      }
      if (verb === 'set-iam-policy') {
        const b = bucketOf(target);
        if (!b) return g.error(`gs://${parseUrl(target ?? '')?.bucket ?? ''} not found: 404.`);
        const file = pos.slice(1).find(a => !a.startsWith('gs://') && a !== 'set-iam-policy');
        const text = io.sh.readFile(file ?? '');
        if (text === null) return g.error(`Unable to read file [${file}]: [Errno 2] No such file or directory: '${file}'`);
        let policy;
        try { policy = JSON.parse(text); } catch { try { policy = parseSimpleYaml(text); } catch { return g.error(`Failed to parse JSON or YAML from file [${file}].`); } }
        return internals.setPolicy(b, policy, 'gcloud');
      }
      if (verb === 'notifications') {
        const action = rest[1];
        const url = pos.slice(2).find(a => a.startsWith('gs://'));
        const b = bucketOf(url);
        if (action === 'list') {
          if (!b) return g.error(`gs://${parseUrl(url ?? '')?.bucket ?? ''} not found: 404.`);
          return { out: docs(b.notifications.map(n => ({ bucket: b.name, notification_configuration: { event_types: n.eventTypes.length ? n.eventTypes : undefined, id: n.id, kind: 'storage#notification', payload_format: n.payloadFormat, selfLink: `https://www.googleapis.com/storage/v1/b/${b.name}/notificationConfigs/${n.id}`, topic: n.topic } }))) };
        }
        if (action === 'create') {
          if (!b) return g.error(`gs://${parseUrl(url ?? '')?.bucket ?? ''} not found: 404.`);
          const topic = g.flag('topic');
          if (typeof topic !== 'string') return g.error('argument --topic: Must be specified.', 2);
          const events = typeof g.flag('event-types') === 'string' ? g.flag('event-types').split(',') : [];
          const r = internals.addNotification(b, topic, events, g.flag('payload-format') === 'none' ? 'NONE' : 'JSON_API_V1');
          return g.print({ etag: r.id, event_types: events.length ? events.map(e => e.toUpperCase()) : undefined, id: r.id, kind: 'storage#notification', payload_format: g.flag('payload-format') === 'none' ? 'NONE' : 'JSON_API_V1', selfLink: `https://www.googleapis.com/storage/v1/b/${b.name}/notificationConfigs/${r.id}`, topic: `//pubsub.googleapis.com/projects/${g.project}/topics/${topic.split('/').pop()}` });
        }
        if (action === 'delete') {
          const target2 = pos.slice(2)[0] ?? '';
          const r = commands.notification(['delete', target2]);
          return r.code ? { err: [`ERROR: (gcloud.storage.buckets.notifications.delete) HTTPError 404: ${target2} not found.`], code: 1 } : {};
        }
      }
      return g.error(`Invalid choice: '${verb ?? ''}'.`, 2);
    }
    if (sub === 'ls') {
      const urls = pos.filter(a => a.startsWith('gs://'));
      const flags = new Set();
      // gcloud's parser leaves short flags among the operands.
      for (const a of pos) if (/^-[a-zA-Z]+$/.test(a)) for (const f of a.slice(1)) flags.add(f === 'R' ? 'r' : f);
      if (g.has('recursive') || g.has('r') || g.has('R')) flags.add('r');
      if (g.has('long') || g.has('l')) flags.add('l');
      if (g.has('full') || g.has('L')) flags.add('L');
      if (g.has('readable-sizes')) flags.add('h');
      if (!urls.length) {
        pause(ctx, 0.4);
        return { out: Object.values(st.buckets).filter(b => b.project === g.project).sort((a, b) => (a.name < b.name ? -1 : 1)).map(b => `gs://${b.name}/`) };
      }
      const out = [];
      for (const url of urls) {
        const u = parseUrl(url);
        const b = st.buckets[u.bucket];
        if (!b) return g.error(`gs://${u.bucket} not found: 404.`);
        if (flags.has('L') && !u.path) { out.push(docs([describe(b)])); continue; }
        const r = internals.listing(b, u, flags);
        if (r.err) return g.error(`One or more URLs matched no objects.`);
        out.push(r.out);
      }
      return { out: (function* () { for (const part of out) yield* part; })() };
    }
    if (sub === 'du') {
      const urls = pos.filter(a => a.startsWith('gs://'));
      const flags = [];
      const short = pos.filter(a => /^-[a-zA-Z]+$/.test(a)).join('');
      if (g.has('summarize') || short.includes('s')) flags.push('-s');
      if (g.has('readable-sizes') || short.includes('r')) flags.push('-h');
      if (g.has('total') || short.includes('c')) flags.push('-c');
      const r = commands.du([...flags, ...urls]);
      return r.code ? { err: [`ERROR: (gcloud.storage.du) gs://${parseUrl(urls[0] ?? '')?.bucket ?? ''} not found: 404.`], code: 1 } : { out: (r.out ?? []).map(l => l.replace(/^(\d+(?:\.\d+)?) (\w?i?B)\s+/, '$1$2  ').replace(/ {2,}(?=gs:)/, '  ')) };
    }
    if (sub === 'cp' || sub === 'mv') {
      const urls = pos.filter(a => !a.startsWith('-'));
      if (urls.length < 2) return g.error('the following arguments are required: destination', 2);
      const dest = urls.pop();
      const r = internals.copy(urls, dest, { recursive: g.has('recursive') || pos.some(a => /^-[a-zA-Z]*[rR]/.test(a)), parallel: true, tool: 'gcloud', io });
      if (sub === 'mv' && !r.code) commands.rm(['-r', ...urls]);
      return r;
    }
    if (sub === 'rsync') {
      const urls = pos.filter(a => !a.startsWith('-'));
      if (urls.length !== 2) return g.error('the following arguments are required: destination', 2);
      return internals.sync(urls[0], urls[1], { recursive: g.has('recursive') || pos.some(a => /^-[a-zA-Z]*[rR]/.test(a)), prune: g.has('delete-unmatched-destination-objects'), dryRun: g.has('dry-run'), parallel: true, tool: 'gcloud' });
    }
    if (sub === 'rm') {
      const urls = pos.filter(a => a.startsWith('gs://'));
      const recursive = g.has('recursive') || pos.some(a => /^-[a-zA-Z]*[rR]/.test(a));
      const r = commands.rm([...(recursive ? ['-r'] : []), ...urls], io, true);
      const err = (r.err ?? []).map(l => l.replace(/^CommandException: No URLs matched: (.*)$/, 'ERROR: (gcloud.storage.rm) The following URLs matched no objects or files:\n-$1').replace(/^CommandException: "rm" command will not remove buckets.*$/, `ERROR: (gcloud.storage.rm) ${urls[0]} matched no objects or files. To delete a bucket, include --recursive.`).replace(/^\t?gsutil rm -r .*$/, '').replace(/#\d+\.\.\.$/, '...'));
      return { err: err.filter(Boolean), code: r.code };
    }
    if (sub === 'objects') {
      const [verb] = rest;
      const url = pos.slice(1).find(a => a.startsWith('gs://'));
      const u = parseUrl(url ?? '');
      const b = u && st.buckets[u.bucket];
      if (!b) return g.error(`gs://${u?.bucket ?? ''} not found: 404.`);
      const toDoc = (o) => ({ bucket: b.name, content_type: o.type ?? 'image/jpeg', crc32c_hash: crc(o.id), creation_time: ISO_OFF(o.created), generation: o.generation, md5_hash: md5(o.id), metageneration: 1, name: o.name, size: o.size, storage_class: b.storageClass, storage_url: `gs://${b.name}/${o.name}#${o.generation}`, update_time: ISO_OFF(o.created) });
      if (verb === 'describe') {
        const o = lookup(st.catalog, b, u.path);
        if (!o) return g.error(`gs://${b.name}/${u.path} not found: 404.`);
        return g.print(toDoc(o));
      }
      if (verb === 'list') {
        const prefix = u.path.replace(/\*+$/, '');
        const n = internals.countUnder(b, prefix).next().value;
        pause(ctx, Math.ceil(n / 1000) * 0.12);
        const limit = Number(g.flag('limit') ?? Infinity);
        const selected = take(listObjects(st.catalog, b, prefix), limit);
        if (g.flag('format')) return g.print([...selected].map(toDoc));
        return { out: (function* () { let k = 0; for (const o of selected) { if (k++) yield '---'; yield* yaml(toDoc(o)); } })() };
      }
      return g.error(`Invalid choice: '${verb ?? ''}'.`, 2);
    }
    return g.error(`Invalid choice: '${sub ?? ''}'.`, 2);
  };

  const computeGroup = (args, _io, g) => {
    const [kind, verb] = args;
    const pos = g.positional.slice(2);
    const backends = ctx.state.compute.backendBuckets;
    const link = (name, what = 'backendBuckets') => `https://www.googleapis.com/compute/v1/projects/${g.project}/global/${what}/${name}`;
    if (kind === 'backend-buckets') {
      if (verb === 'list') return g.print(Object.values(backends).map(b => ({ name: b.name, bucketName: b.bucket, enableCdn: b.enableCdn })), [['NAME', 'GCS_BUCKET_NAME', 'ENABLE_CDN'], b => [b.name, b.bucketName, b.enableCdn ? 'True' : 'False']]);
      const name = pos.find(a => !a.startsWith('-'));
      const b = backends[name];
      if (!b) return g.error(`Could not fetch resource:\n - The resource '${link(name ?? '')}' was not found\n`);
      if (verb === 'describe') return g.print({ bucketName: b.bucket, cdnPolicy: { cacheKeyPolicy: {}, cacheMode: 'CACHE_ALL_STATIC', clientTtl: 3600, defaultTtl: 3600, maxTtl: 86400, negativeCaching: false, requestCoalescing: true, serveWhileStale: 0, signedUrlCacheMaxAgeSec: '0' }, creationTimestamp: '2023-01-10T03:12:44.918-08:00', description: b.description, enableCdn: b.enableCdn, id: b.id, kind: 'compute#backendBucket', name: b.name, selfLink: link(b.name) });
      if (verb === 'update') {
        const target = g.flag('gcs-bucket-name');
        if (typeof target === 'string') {
          if (!st.buckets[target]) return g.error(`Could not fetch resource:\n - The resource 'projects/${g.project}/buckets/${target}' was not found`, 1);
          const before = b.bucket;
          b.bucket = target;
          pause(ctx, 4);
          ctx.event('cdn.backend.update', { backend: b.name, before, bucket: target });
        }
        if (g.has('enable-cdn')) b.enableCdn = true;
        if (g.has('no-enable-cdn')) { b.enableCdn = false; ctx.event('cdn.backend.update', { backend: b.name, enableCdn: false }); }
        return { err: [`Updated [${link(b.name)}].`] };
      }
      if (verb === 'delete') return g.error(`The backend bucket resource '${link(b.name)}' is already being used by '${link('uploads-cdn-map', 'urlMaps')}'`);
      if (verb === 'create') return g.error(`Could not fetch resource:\n - The resource '${link(name)}' already exists`);
    }
    if (kind === 'url-maps') {
      const maps = ctx.state.compute.urlMaps;
      if (verb === 'list') return g.print(Object.values(maps).map(m => ({ name: m.name, defaultService: link(m.defaultBackend) })), [['NAME', 'DEFAULT_SERVICE'], m => [m.name, `backendBuckets/${m.defaultService.split('/').pop()}`]]);
      const name = pos.find(a => !a.startsWith('-'));
      const m = maps[name];
      if (!m) return g.error(`Could not fetch resource:\n - The resource '${link(name ?? '', 'urlMaps')}' was not found\n`);
      if (verb === 'describe') return g.print({ creationTimestamp: '2023-01-10T03:14:02.113-08:00', defaultService: link(m.defaultBackend), fingerprint: 'q2cR3GpT4wU=', hostRules: [{ hosts: m.hosts, pathMatcher: 'uploads' }], id: m.id, kind: 'compute#urlMap', name: m.name, pathMatchers: [{ defaultService: link(m.defaultBackend), name: 'uploads' }], selfLink: link(m.name, 'urlMaps') });
      if (verb === 'invalidate-cdn-cache') {
        ctx.event('cdn.invalidate', { urlMap: m.name, path: g.flag('path') });
        if (!g.has('async')) pause(ctx, 45);
        const op = `operation-${ctx.at().getTime()}-${(ctx.t * 7919).toString(16).padStart(13, '0')}-2f6a1c3e-8d4b9a07`;
        return { err: g.has('async') ? [`Invalidation pending for [${link(m.name, 'urlMaps')}]`, `Monitor its progress at [https://www.googleapis.com/compute/v1/projects/${g.project}/global/operations/${op}]`] : [`Waiting for operation [projects/${g.project}/global/operations/${op}] to complete...done.`] };
      }
    }
    if (verb === 'list' && LISTS[kind]) {
      const [headers, rows] = LISTS[kind](Math.floor(ctx.at().getTime() / 1000));
      if (!rows.length) return { err: ['Listed 0 items.'] };
      return g.flag('format') ? g.print(rows.map(r => Object.fromEntries(headers.map((h, k) => [h.toLowerCase(), r[k]])))) : { out: table(headers, rows, 2) };
    }
    return g.error(`Invalid choice: '${verb ?? kind ?? ''}'.`, 2);
  };

  const pubsubGroup = (args, _io, g) => {
    const [kind, verb] = args;
    const topics = ctx.state.pubsub.topics;
    if (kind === 'topics' && verb === 'list') return g.flag('format') ? g.print(Object.values(topics).map(t => ({ name: `projects/${g.project}/topics/${t.name}` }))) : { out: docs(Object.values(topics).map(t => ({ name: `projects/${g.project}/topics/${t.name}` }))) };
    if (kind === 'topics' && verb === 'describe') { const t = topics[String(g.positional[2] ?? '').split('/').pop()]; return t ? g.print({ name: `projects/${g.project}/topics/${t.name}` }) : g.error(`NOT_FOUND: Resource not found (resource=${g.positional[2]}).`); }
    if (kind === 'subscriptions' && verb === 'list') return { out: docs(Object.values(topics).flatMap(t => t.subscriptions.map(s => ({ ackDeadlineSeconds: 60, expirationPolicy: {}, messageRetentionDuration: '604800s', name: `projects/${g.project}/subscriptions/${s}`, pushConfig: {}, state: 'ACTIVE', topic: `projects/${g.project}/topics/${t.name}` })))) };
    if (kind === 'topics' && verb === 'create') { const name = String(g.positional[2] ?? ''); if (topics[name]) return g.error(`Failed to create topic [projects/${g.project}/topics/${name}]: Resource already exists in the project (resource=${name}).`); topics[name] = { name, subscriptions: [] }; ctx.event('pubsub.topic.create', { topic: name }); return { err: [`Created topic [projects/${g.project}/topics/${name}].`] }; }
    return g.error(`Invalid choice: '${verb ?? kind ?? ''}'.`, 2);
  };
  /** A gap in this model must not end the session; the API's own transient error is what an operator would see. */
  const guard = (group) => (args, io, g) => {
    try { return group(args, io, g); }
    catch (e) { ctx.event('storage.internal', { command: args.join(' '), error: String(e?.message ?? e) }); return g.error('HTTPError 503: We encountered an internal error. Please try again.'); }
  };
  return { gsutil, storage: guard(storageGroup), compute: guard(computeGroup), pubsub: guard(pubsubGroup) };
}
/**
 * gcloud's --filter for the terms people type: `name:qm`, `location=EU`, `name~^qm-`, joined
 * with AND. Anything else is refused the way gcloud refuses an expression it cannot parse.
 */
function filterOf(expr) {
  if (typeof expr !== 'string' || !expr.trim()) return () => true;
  const groups = expr.split(/\s+OR\s+/i).map(g => g.split(/\s+AND\s+/i).map(t => /^\s*(-?)([\w.]+)\s*(:|=|!=|~)\s*["']?([^"'\s]*)["']?\s*$/.exec(t)));
  if (groups.flat().some(t => !t)) return { error: `Parse error [${expr}]: Unexpected token.` };
  return (item) => groups.some(terms => terms.every(([, neg, key, op, value]) => {
    const got = String(key.split('.').reduce((v, k) => v?.[k], item) ?? '');
    const hit = op === ':' ? got.toLowerCase().includes(value.toLowerCase()) : op === '~' ? new RegExp(value).test(got) : op === '=' ? got === value : got !== value;
    return neg ? !hit : hit;
  }));
}
/** Enough YAML to read back what `get-iam-policy` printed. */
function parseSimpleYaml(text) {
  const bindings = [];
  let current = null, inMembers = false;
  let etag;
  for (const raw of lines(text)) {
    const line = raw.replace(/\s+$/, '');
    if (/^bindings:/.test(line)) continue;
    let m;
    if ((m = /^- members:/.exec(line))) { current = { members: [] }; bindings.push(current); inMembers = true; continue; }
    if ((m = /^\s*- (.+)$/.exec(line)) && inMembers && current) { current.members.push(m[1].replace(/^['"]|['"]$/g, '')); continue; }
    if ((m = /^\s*role: (.+)$/.exec(line)) && current) { current.role = m[1].replace(/^['"]|['"]$/g, ''); inMembers = false; continue; }
    if ((m = /^etag: (.+)$/.exec(line))) etag = m[1];
  }
  if (!bindings.length) throw new Error('no bindings');
  return { bindings, etag };
}
export { table };
