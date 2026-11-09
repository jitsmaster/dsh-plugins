// File-based FIFO lease queue shared by several OS processes.
// State: a single <dir>/state.json = { lease, waiters }, so a crash can never leave the two halves
// disagreeing. Every read-modify-write runs under <dir>/state.lock and the file is replaced
// atomically (temp file + rename); an operation that changes nothing does not write at all.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { withLockSync, retryBusy, defaultPidAlive } from './lock.js';

const MAX_HOLDER = 200;
const MAX_QUARANTINE = 5;
const MAX_STATE_BYTES = 1024 * 1024; // a larger state.json is treated as corrupt
const MAX_FUTURE_TS_MS = 60000; // mirrors lock.js: a stamp further ahead than this is clamped to now()
const UNSAFE_CHARS = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]+/gu;
const LOCKFREE_BUSY_RETRIES = 2; // 3 attempts in total
const UNKNOWN = Symbol('unknown');

export const DEFAULT_IDLE_MS = 600000;
const DEFAULT_MAX_WAITERS = 100;
const TMP_STALE_MS = 60000;
const TMP_SWEEP_EVERY_MS = 60000;

// Temp name = pid + random suffix, created exclusively ('wx'), so a leftover or hostile file is never reused.
function writeJsonAtomic(file, text) {
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(8).toString('hex')}.tmp`;
  try {
    const fd = fs.openSync(tmp, 'wx', 0o600);
    try {
      fs.writeSync(fd, text);
    } finally {
      fs.closeSync(fd);
    }
    retryBusy(() => fs.renameSync(tmp, file)); // Windows can briefly refuse to replace a file in use
  } catch (err) {
    try { fs.rmSync(tmp, { force: true }); } catch { /* best effort: keep the original error */ }
    throw err;
  }
}

// Remove regular `<state>.*.tmp` files older than TMP_STALE_MS (left by a crash mid-write). Best effort.
function sweepStaleTmp(file) {
  const dir = path.dirname(file);
  const prefix = `${path.basename(file)}.`;
  let names;
  try {
    names = fs.readdirSync(dir);
  } catch {
    return;
  }
  for (const name of names) {
    if (!name.startsWith(prefix) || !name.endsWith('.tmp')) continue;
    try {
      const p = path.join(dir, name);
      const st = fs.statSync(p);
      if (st.isFile() && Date.now() - st.mtimeMs > TMP_STALE_MS) fs.rmSync(p, { force: true });
    } catch { /* vanished or busy: leave it */ }
  }
}

const emptyState = () => ({ lease: null, waiters: [] });
const isClaimed = (lease) => lease.claimedAt !== undefined && lease.claimedAt !== null;

const isStr = (v) => typeof v === 'string';
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const isPid = (v) => Number.isInteger(v) && v > 0;
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

const validWaiter = (w) =>
  isObj(w) && isStr(w.ticket) && isPid(w.pid) && isStr(w.holder) && isNum(w.enqueuedAt) && isNum(w.lastPolledAt);
const validLease = (l) =>
  isObj(l) && isStr(l.token) && isStr(l.ticket) && isStr(l.holder) && isPid(l.pid) && isNum(l.grantedAt) && isNum(l.lastActivityAt) &&
  (l.claimedAt === undefined || l.claimedAt === null || isNum(l.claimedAt));

// Deep shape check: any invalid entry makes the whole file untrustworthy.
// Control/format/line-separator chars (newlines, bidi overrides, zero-width) become one space; then trim and cap.
const cleanHolder = (h) => h.replace(UNSAFE_CHARS, ' ').trim().slice(0, MAX_HOLDER);

// Sanitise a validated state in place: clean holders, clamp future stamps, keep the oldest maxWaiters.
// Returns true if a future stamp was clamped (the clamp only sticks once the locked path rewrites the file).
function normalizeState(state, nowMs, maxWaiters) {
  const limit = nowMs + MAX_FUTURE_TS_MS;
  let clamped = false;
  const clamp = (v) => (v > limit ? ((clamped = true), nowMs) : v);
  if (state.lease) {
    const l = state.lease;
    l.holder = cleanHolder(l.holder);
    l.grantedAt = clamp(l.grantedAt);
    l.lastActivityAt = clamp(l.lastActivityAt);
    if (isNum(l.claimedAt)) l.claimedAt = clamp(l.claimedAt);
  }
  if (state.waiters.length > maxWaiters) state.waiters = state.waiters.slice(0, maxWaiters);
  for (const w of state.waiters) {
    w.holder = cleanHolder(w.holder);
    w.enqueuedAt = clamp(w.enqueuedAt);
    w.lastPolledAt = clamp(w.lastPolledAt);
  }
  return clamped;
}

function validState(p) {
  if (!isObj(p)) return false;
  if (p.lease !== undefined && p.lease !== null && !validLease(p.lease)) return false;
  if (p.waiters !== undefined && !(Array.isArray(p.waiters) && p.waiters.every(validWaiter))) return false;
  return true;
}

// Missing file = empty state. Unparsable/wrong-shaped file = quarantined (kept for inspection) + empty.
// Keep only the newest MAX_QUARANTINE quarantine files (by the timestamp in the name, then mtime, then name).
function pruneQuarantine(file) {
  const dir = path.dirname(file);
  const prefix = `${path.basename(file)}.corrupt-`;
  const entries = [];
  let names;
  try {
    names = fs.readdirSync(dir);
  } catch {
    return; // best effort: a missing/unreadable dir must never fail a transaction
  }
  for (const name of names) {
    if (!name.startsWith(prefix)) continue;
    let mtimeMs;
    try {
      const st = fs.statSync(path.join(dir, name));
      if (!st.isFile()) continue; // never touch directories or other odd entries
      mtimeMs = st.mtimeMs;
    } catch {
      continue; // vanished
    }
    entries.push({ name, ts: Number(/^(\d+)-/.exec(name.slice(prefix.length))?.[1] ?? 0), mtimeMs });
  }
  entries.sort((a, b) => b.ts - a.ts || b.mtimeMs - a.mtimeMs || (a.name < b.name ? 1 : -1));
  for (const e of entries.slice(MAX_QUARANTINE)) {
    try { fs.rmSync(path.join(dir, e.name), { force: true }); } catch { /* best effort: must not wedge transactions */ }
  }
}

// Read + shape-check state.json without side effects. Returns { state } (missing file = empty state)
// or { corrupt: true } for an unparsable/wrongly shaped file. Other read errors are thrown.
function readState(file, read = fs.readFileSync, busyRetries, nowMs = Date.now(), maxWaiters = DEFAULT_MAX_WAITERS) {
  let raw;
  try {
    try {
      if (fs.statSync(file).size > MAX_STATE_BYTES) return { corrupt: true };
    } catch { /* ENOENT/other: the read below reports it */ }
    raw = retryBusy(() => read(file, 'utf8'), busyRetries);
  } catch (err) {
    if (err.code === 'ENOENT') return { state: emptyState() };
    throw err;
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    parsed = undefined;
  }
  if (raw.length > MAX_STATE_BYTES || !validState(parsed)) return { corrupt: true };
  const state = { lease: parsed.lease ?? null, waiters: parsed.waiters ?? [] };
  return { state, clamped: normalizeState(state, nowMs, maxWaiters) };
}

// Locked path only: may quarantine a corrupt file. (Temp sweeping is throttled in transact.)
function loadState(file, now, randomId, maxWaiters) {
  const r = readState(file, fs.readFileSync, undefined, now(), maxWaiters);
  if (!r.corrupt) return { state: r.state, dirty: r.clamped };
  // time + random id: two corruptions in the same millisecond must not collide
  retryBusy(() => fs.renameSync(file, `${file}.corrupt-${now()}-${path.basename(String(randomId()))}`));
  pruneQuarantine(file);
  return { state: emptyState(), dirty: false };
}

function checkEnqueueInput(holder, pid) {
  if (!Number.isInteger(pid) || pid <= 0) throw new TypeError('pid must be a positive integer');
  if (typeof holder !== 'string') throw new TypeError('holder must be a non-empty string');
  const clean = cleanHolder(holder);
  if (clean.length === 0) throw new TypeError('holder must be a non-empty string');
  return clean;
}

function checkNumberOption(name, v, { min, integer = false }) {
  if (!isNum(v)) throw new TypeError(`${name} must be a finite number`);
  if (v < min || (integer && !Number.isInteger(v))) {
    throw new RangeError(`${name} must be ${integer ? 'an integer' : 'a number'} >= ${min}`);
  }
}

export function createQueue({
  dir,
  now = Date.now,
  isAlive = defaultPidAlive,
  idleMs = DEFAULT_IDLE_MS,
  waiterTtlMs = 120000,
  randomId = () => crypto.randomUUID(),
  touchThrottleMs: touchThrottleOpt = Math.floor(idleMs / 10),
  pollThrottleMs: pollThrottleOpt = Math.floor(waiterTtlMs / 10),
  maxWaiters = DEFAULT_MAX_WAITERS,
  readFile = fs.readFileSync, // @internal test seam for the lock-free read; not public API
}) {
  checkNumberOption('idleMs', idleMs, { min: 1 });
  checkNumberOption('waiterTtlMs', waiterTtlMs, { min: 1 });
  checkNumberOption('touchThrottleMs', touchThrottleOpt, { min: 0 });
  checkNumberOption('pollThrottleMs', pollThrottleOpt, { min: 0 });
  checkNumberOption('maxWaiters', maxWaiters, { min: 1, integer: true });
  const touchThrottleMs = Math.min(touchThrottleOpt, Math.floor(idleMs / 2));
  const pollThrottleMs = Math.min(pollThrottleOpt, Math.floor(waiterTtlMs / 2));
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (process.platform !== 'win32') {
    try { fs.chmodSync(dir, 0o700); } catch { /* best effort */ }
  }
  const stateFile = path.join(dir, 'state.json');
  const lockFile = path.join(dir, 'state.lock');
  let lastSweep = -Infinity;

  function maybeSweep() {
    if (Date.now() - lastSweep > TMP_SWEEP_EVERY_MS) {
      lastSweep = Date.now();
      sweepStaleTmp(stateFile); // real clock on purpose: compared with file mtimes
    }
  }

  // Run fn(state) under the lock with reclaim applied; persist the state only if it changed.
  function transact(fn) {
    return withLockSync(lockFile, () => {
      maybeSweep();
      const { state, dirty } = loadState(stateFile, now, randomId, maxWaiters);
      const before = JSON.stringify(state);
      const reclaimed = reclaimState(state);
      promote(state); // so fn (poll/snapshot) already sees a lease granted by this call
      const result = fn(state, reclaimed);
      promote(state); // release/cancel free the lease inside fn
      const after = JSON.stringify(state);
      if (dirty || after !== before) writeJsonAtomic(stateFile, after);
      return result;
    });
  }
  // Lock-free read: only 3 attempts on a busy file. Returns the lease (or null = no lease, which includes a
  // missing file: readState maps ENOENT to empty state), or UNKNOWN when the read failed (other error)
  // or the file is corrupt: callers then take the lock.
  function readLeaseLockFree() {
    try {
      const r = readState(stateFile, readFile, LOCKFREE_BUSY_RETRIES, now(), maxWaiters);
      return r.corrupt || r.clamped ? UNKNOWN : r.state.lease; // clamped stamps must be persisted by the locked path
    } catch {
      return UNKNOWN;
    }
  }
  function reclaimState(state) {
    const droppedWaiters = [];
    state.waiters = state.waiters.filter((w) => {
      if (isAlive(w.pid) && now() - w.lastPolledAt <= waiterTtlMs) return true;
      droppedWaiters.push(w.ticket);
      return false;
    });
    let droppedLease = null;
    if (state.lease && leaseExpired(state.lease)) {
      droppedLease = state.lease.ticket;
      state.lease = null;
    }
    return { droppedWaiters, droppedLease };
  }

  // Dead holder, idle past idleMs, or (a promoted lease nobody has polled/touched) abandoned after waiterTtlMs.
  function leaseExpired(l) {
    return !isAlive(l.pid) || now() - l.lastActivityAt > idleMs || (!isClaimed(l) && now() - l.grantedAt > waiterTtlMs);
  }

  function promote(state) {
    if (state.lease || state.waiters.length === 0) return;
    const w = state.waiters.shift();
    const t = now();
    state.lease = { token: randomId(), ticket: w.ticket, holder: w.holder, pid: w.pid, grantedAt: t, lastActivityAt: t, claimedAt: null };
  }

  return {
    enqueue(input) {
      const { pid } = input;
      const holder = checkEnqueueInput(input.holder, pid);
      return transact((s) => {
        if (s.lease && s.lease.holder === holder && s.lease.pid === pid) return { ticket: s.lease.ticket };
        const existing = s.waiters.find((w) => w.holder === holder && w.pid === pid);
        if (existing) {
          if (now() - existing.lastPolledAt > pollThrottleMs) existing.lastPolledAt = now();
          return { ticket: existing.ticket };
        }
        if (s.waiters.length >= maxWaiters) {
          throw Object.assign(new Error(`Queue is full (${maxWaiters} waiters)`), { code: 'EQUEUEFULL' });
        }
        const ticket = randomId();
        const t = now();
        s.waiters.push({ ticket, holder, pid, enqueuedAt: t, lastPolledAt: t });
        return { ticket };
      });
    },

    poll(ticket) {
      return transact((s) => {
        const w = s.waiters.find((x) => x.ticket === ticket);
        if (w && now() - w.lastPolledAt > pollThrottleMs) w.lastPolledAt = now();
        if (s.lease && s.lease.ticket === ticket) {
          if (!isClaimed(s.lease)) {
            s.lease.claimedAt = now();
            s.lease.lastActivityAt = now(); // idle time counts from the claim
          }
          return { status: 'granted', token: s.lease.token };
        }
        const i = s.waiters.findIndex((x) => x.ticket === ticket);
        if (i < 0) return { status: 'unknown' };
        return { status: 'waiting', position: i + 1, holderLabel: s.lease ? s.lease.holder : undefined };
      });
    },

    // Lock-free and read-only when the read succeeds: state.json is replaced by atomic rename, so a plain read
    // is consistent. The reclaim rules are applied in memory only to decide the answer. If the lock-free read
    // fails (transient EPERM/EBUSY or another read error, corrupt file; a missing file is just empty state) the answer comes from the locked path,
    // which also quarantines a corrupt file; a really missing/corrupt state is "not valid".
    validate(token) {
      const l = readLeaseLockFree();
      if (l === UNKNOWN) return transact((s) => Boolean(s.lease) && s.lease.token === token); // reclaim already applied
      return Boolean(l) && l.token === token && !leaseExpired(l);
    },

    // Only writes when the activity stamp is older than touchThrottleMs (or the lease is still unclaimed),
    // so a busy proxy does not rewrite state.json on every call. Keep touchThrottleMs well below idleMs.
    touch(token) {
      const f = readLeaseLockFree();
      if (f !== UNKNOWN && f && f.token === token && isClaimed(f) && !leaseExpired(f) && now() - f.lastActivityAt <= touchThrottleMs) return true;
      return transact((s) => {
        const l = s.lease;
        if (!l || l.token !== token) return false;
        const unclaimed = !isClaimed(l);
        const t = now();
        if (unclaimed || t - l.lastActivityAt > touchThrottleMs) {
          l.lastActivityAt = t;
          if (unclaimed) l.claimedAt = t;
        }
        return true;
      });
    },

    release(token) {
      return transact((s) => {
        if (!s.lease || s.lease.token !== token) return false;
        s.lease = null;
        return true;
      });
    },

    cancel(ticket) {
      return transact((s) => {
        const i = s.waiters.findIndex((w) => w.ticket === ticket);
        if (i >= 0) {
          s.waiters.splice(i, 1);
          return true;
        }
        if (s.lease && s.lease.ticket === ticket) {
          s.lease = null;
          return true;
        }
        return false;
      });
    },

    // Reclaim already ran at the start of the transaction; surface its result.
    reclaim() {
      return transact((_s, reclaimed) => reclaimed);
    },

    snapshot() {
      return transact((s) => ({
        lease: s.lease ? { holder: s.lease.holder, since: s.lease.grantedAt, idleForMs: now() - s.lease.lastActivityAt } : null,
        waiters: s.waiters.map((w, i) => ({ holder: w.holder, position: i + 1 })),
      }));
    },
  };
}
