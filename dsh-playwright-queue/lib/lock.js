// Cross-process mutex built on exclusive file creation (fs.openSync 'wx').
//
// Who may delete the lock file: ONLY a process holding the short-lived guard file `<lock>.break`
// (also created with 'wx'). That covers both stale-breaking and release(). Under the guard a remover
//     re-reads the lock,
//     checks it still carries exactly the owner it meant to remove (owner id / the stale content),
//     unlinks it.
// Acquirers use plain open 'wx' and never need the guard. Why this is safe: an acquirer can only
// create the lock path while it is absent, and the file can only become absent through a guarded
// remover. So while we hold the guard and have just read the expected content, the file is still
// there and no new lock can have been created; unlink therefore removes exactly what we verified.
// (The earlier rename-aside + link() restore had a window in which a competitor could take the
// emptied path, and the restore then silently lost the live owner's lock.)
//
// Honest limits: (1) a guard older than GUARD_STALE_MS or owned by a dead pid is itself broken, with
// a read-compare-unlink that has a microsecond gap, so a guard-break race needs a crashed or >5 s
// stalled guard holder plus two simultaneous breakers; (2) a process that deletes the lock without
// the guard (old code, manual deletion) is outside the protocol; (3) a live owner is only broken
// after hardStaleMs (no heartbeat), so fn must finish well within it.
import fs from 'node:fs';
import crypto from 'node:crypto';

const ALWAYS_BUSY = new Set(['EEXIST', 'EBUSY']);
// Windows reports these while another process has the file open or is deleting it.
const WIN_BUSY = new Set(['EPERM', 'EACCES']);
const MAX_WIN_BUSY = 100; // consecutive occurrences before the real error is thrown
const BUSY_RETRIES = 100;
const GUARD_STALE_MS = 5000;
const MAX_FUTURE_TS_MS = 60000; // a ts further ahead than this is clock garbage: use the file mtime instead
const SLEEP_CELL = new Int32Array(new SharedArrayBuffer(4));
const DEFAULTS = { timeoutMs: 5000, retryMs: 5, staleMs: 10000, hardStaleMs: 60000, guardTimeoutMs: 2000 };

/** True if err means "busy, try again" on this platform (EPERM/EACCES only count on Windows). */
export function isBusyError(err) {
  return ALWAYS_BUSY.has(err.code) || (process.platform === 'win32' && WIN_BUSY.has(err.code));
}

/** True if a process with this pid exists (EPERM means it exists but is not ours). */
export function defaultPidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
}

/** Block the thread for ms without spinning. */
export function sleepSync(ms) {
  Atomics.wait(SLEEP_CELL, 0, 0, ms);
}

/** Run a synchronous fs op, retrying (2 ms apart) while it reports a busy error; other errors throw. */
export function retryBusy(op, attempts = BUSY_RETRIES) {
  for (let i = 0; ; i++) {
    try {
      return op();
    } catch (err) {
      if (!isBusyError(err) || i >= attempts) throw err;
      sleepSync(2);
    }
  }
}

function readRaw(p) {
  try {
    return fs.readFileSync(p, 'utf8');
  } catch {
    return null;
  }
}

// Strict read used under the guard: absent = null, any other failure is loud (after busy retries).
function readStrict(p) {
  try {
    return retryBusy(() => fs.readFileSync(p, 'utf8'));
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
}

function parseOwner(raw) {
  try {
    const v = JSON.parse(raw);
    return v && typeof v === 'object' ? v : null;
  } catch {
    return null;
  }
}

function mtime(p) {
  try {
    return fs.statSync(p).mtimeMs;
  } catch {
    return null;
  }
}

// Decide staleness from a snapshot of the lock content (null = unreadable: never stale).
// Dead owner pid: stale at once. Live owner pid: only after hardStaleMs (no heartbeat exists, so
// this is a last-resort cap for a wedged owner). No usable pid: fall back to staleMs on ts/mtime.
function isStale(lockPath, raw, o) {
  if (raw === null) return false;
  const owner = parseOwner(raw);
  const ts = tsOf(lockPath, owner, o);
  if (ts === null) return false;
  const age = Math.max(0, o.now() - ts);
  if (owner && Number.isInteger(owner.pid)) {
    return !o.isAlive(owner.pid) || age > o.hardStaleMs;
  }
  return age > o.staleMs;
}

// Timestamp of a lock/guard file: the owner's ts unless missing or implausibly far in the future, else mtime.
function tsOf(p, owner, o) {
  if (owner && typeof owner.ts === 'number' && owner.ts <= o.now() + MAX_FUTURE_TS_MS) return owner.ts;
  return mtime(p);
}

function removeFile(p) {
  retryBusy(() => fs.rmSync(p, { force: true }));
}

// A guard is held for microseconds, so one from a dead pid or older than GUARD_STALE_MS is abandoned.
function breakStaleGuard(guard, o) {
  const raw = readRaw(guard);
  if (raw === null) return;
  const owner = parseOwner(raw);
  const ts = tsOf(guard, owner, o);
  const dead = owner && Number.isInteger(owner.pid) && !o.isAlive(owner.pid);
  if (!dead && (ts === null || Math.max(0, o.now() - ts) <= GUARD_STALE_MS)) return;
  let again;
  try { again = retryBusy(() => fs.readFileSync(guard, 'utf8'), 10); } catch { return; }
  if (again === raw) removeFile(guard); // narrow read-compare-unlink gap, see header
}

function acquireGuard(guard, o) {
  const deadline = Date.now() + o.guardTimeoutMs;
  for (;;) {
    let fd;
    try {
      fd = fs.openSync(guard, 'wx', 0o600);
    } catch (err) {
      if (!isBusyError(err)) throw err;
      breakStaleGuard(guard, o);
      if (Date.now() >= deadline) {
        const e = new Error(`Could not take lock break guard within ${o.guardTimeoutMs} ms: ${guard}`);
        e.code = 'EGUARDBUSY';
        throw e;
      }
      sleepSync(o.retryMs);
      continue;
    }
    const content = JSON.stringify({ pid: process.pid, ts: o.now(), id: crypto.randomUUID() });
    try {
      fs.writeSync(fd, content);
    } catch (err) {
      fs.closeSync(fd);
      try { fs.rmSync(guard, { force: true }); } catch { /* best effort: keep the original error */ }
      throw err;
    }
    fs.closeSync(fd);
    return content;
  }
}

/**
 * Remove the lock at lockPath iff its content (read under the guard) satisfies matches(raw).
 * Returns true if removed, false if absent or not a match. Unexpected fs errors are thrown.
 */
function removeIfMatches(lockPath, matches, o) {
  const guard = `${lockPath}.break`;
  const mine = acquireGuard(guard, o);
  try {
    if (o.onBeforeRemove) o.onBeforeRemove(lockPath); // test seam: runs under the guard
    const raw = readStrict(lockPath);
    if (raw === null || !matches(raw)) return false;
    removeFile(lockPath);
    return true;
  } finally {
    // Only unlink the guard if it is still ours (it may have been broken as stale and retaken).
    if (guardIsOursOrUnreadable(guard, mine)) removeFile(guard);
  }
}

// Skip unlinking only when the guard is absent or readable with different content. A read that keeps
// failing after busy retries is not evidence of a foreign guard (ours has a unique id): unlink it.
function guardIsOursOrUnreadable(guard, mine) {
  try {
    return retryBusy(() => fs.readFileSync(guard, 'utf8'), 10) === mine;
  } catch (err) {
    return err.code !== 'ENOENT';
  }
}

/** One acquisition attempt. Returns the owner id on success, null if busy. */
function tryAcquire(lockPath, o, st) {
  const id = crypto.randomUUID();
  let fd;
  try {
    fd = fs.openSync(lockPath, 'wx', 0o600);
  } catch (err) {
    if (ALWAYS_BUSY.has(err.code)) {
      st.winBusy = 0;
    } else if (isBusyError(err)) {
      if (++st.winBusy > MAX_WIN_BUSY) throw err;
      return null;
    } else {
      throw err;
    }
    if (err.code === 'EEXIST') {
      try {
        const raw = readRaw(lockPath);
        if (isStale(lockPath, raw, o)) {
          // never wait on the guard past the caller's overall deadline
          const left = Math.max(0, st.deadline - Date.now());
          removeIfMatches(lockPath, (r) => r === raw, { ...o, guardTimeoutMs: Math.min(o.guardTimeoutMs, left) });
        }
      } catch (err) {
        // Only 'busy' conditions (guard held, Windows sharing violation) are retried on the next loop.
        if (!isBusyError(err) && err.code !== 'EGUARDBUSY') throw err;
      }
    }
    return null;
  }
  st.winBusy = 0;
  try {
    fs.writeSync(fd, JSON.stringify({ pid: process.pid, ts: o.now(), id }));
  } catch (err) {
    fs.closeSync(fd);
    removeIfMatches(lockPath, (r) => r === '' || parseOwner(r)?.id === id, o);
    throw err;
  }
  fs.closeSync(fd);
  return id;
}

// Only remove the lock if it still carries our owner id (it may have been broken and retaken).
// The guard wait is at least GUARD_STALE_MS plus margin, so a guard abandoned by a crashed process
// is broken (and the release succeeds) instead of failing after fn already ran.
function release(lockPath, id, o) {
  removeIfMatches(lockPath, (raw) => parseOwner(raw)?.id === id, { ...o, guardTimeoutMs: o.releaseGuardTimeoutMs });
}

/** Blocking mutex for a synchronous fn (waits with Atomics.wait). */
export function withLockSync(lockPath, fn, opts = {}) {
  // undefined values must not override defaults (timeoutMs: undefined would give a NaN deadline)
  const given = Object.fromEntries(Object.entries(opts).filter(([, v]) => v !== undefined));
  const o = { ...DEFAULTS, isAlive: defaultPidAlive, now: Date.now, ...given };
  o.releaseGuardTimeoutMs ??= Math.max(o.guardTimeoutMs, GUARD_STALE_MS + 1000);
  const deadline = Date.now() + o.timeoutMs;
  const st = { winBusy: 0, deadline };
  let id = tryAcquire(lockPath, o, st);
  while (id === null) {
    if (Date.now() >= deadline) {
      const e = new Error(`Lock timeout after ${o.timeoutMs} ms: ${lockPath}`);
      e.code = 'ELOCKTIMEOUT';
      throw e;
    }
    sleepSync(o.retryMs);
    id = tryAcquire(lockPath, o, st);
  }
  let result;
  try {
    result = fn();
  } catch (err) {
    // fn's exception wins; a release failure is attached to it rather than masking it.
    try {
      release(lockPath, id, o);
    } catch (releaseError) {
      if (err !== null && typeof err === 'object') err.releaseError = releaseError;
    }
    throw err;
  }
  release(lockPath, id, o);
  // Sync only: the lock is already released, so an async fn would run unprotected.
  if (result !== null && (typeof result === 'object' || typeof result === 'function') && typeof result.then === 'function') {
    try { result.then(undefined, () => {}); } catch { /* hostile thenable: still reject below */ } // no unhandled rejection
    throw new TypeError('withLockSync: fn must be synchronous (it returned a thenable)');
  }
  return result;
}
