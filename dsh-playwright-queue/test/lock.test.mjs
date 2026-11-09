import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { withLockSync, defaultPidAlive } from '../lib/lock.js';

const worker = fileURLToPath(new URL('../fixtures/lock-worker.mjs', import.meta.url));

function tmp(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pwq-lock-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function run(args) {
  const child = spawn(process.execPath, [worker, ...args], { stdio: 'inherit' });
  const done = new Promise((resolve, reject) => {
    child.on('error', reject);
    child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`worker ${args[0]} exit ${code}`))));
  });
  return { child, done };
}

// A pid that was just reaped. Verified dead immediately; callers must use it right away (pid reuse).
function reapedPid() {
  for (let i = 0; i < 10; i++) {
    const pid = spawnSync(process.execPath, ['-e', '']).pid;
    if (!defaultPidAlive(pid)) return pid;
  }
  throw new Error('could not obtain a dead pid');
}

test('returns the result of fn', (t) => {
  const lock = path.join(tmp(t), 'x.lock');
  assert.equal(withLockSync(lock, () => 7), 7);
});

test('releases the lock file after fn finishes', (t) => {
  const lock = path.join(tmp(t), 'x.lock');
  withLockSync(lock, () => 1);
  assert.equal(fs.existsSync(lock), false);
});

test('releases the lock when fn throws', (t) => {
  const lock = path.join(tmp(t), 'x.lock');
  assert.throws(() => withLockSync(lock, () => { throw new Error('boom'); }), /boom/);
  assert.equal(fs.existsSync(lock), false);
  assert.equal(withLockSync(lock, () => 'again'), 'again');
});

test('lock file stores owner pid, timestamp and id', (t) => {
  const lock = path.join(tmp(t), 'x.lock');
  let content;
  withLockSync(lock, () => { content = JSON.parse(fs.readFileSync(lock, 'utf8')); });
  assert.equal(content.pid, process.pid);
  assert.equal(typeof content.ts, 'number');
  assert.equal(typeof content.id, 'string');
});

test('breaks a lock whose owner pid is dead', (t) => {
  const lock = path.join(tmp(t), 'x.lock');
  fs.writeFileSync(lock, JSON.stringify({ pid: 999999, ts: Date.now(), id: 'old' }));
  assert.equal(withLockSync(lock, () => 'taken', { isAlive: () => false, timeoutMs: 2000 }), 'taken');
});

test('a lock older than staleMs but held by a live owner is NOT broken before hardStaleMs', (t) => {
  const lock = path.join(tmp(t), 'x.lock');
  fs.writeFileSync(lock, JSON.stringify({ pid: 1, ts: 0, id: 'old' }));
  assert.throws(() => withLockSync(lock, () => 1, { isAlive: () => true, staleMs: 10000, now: () => 20000, timeoutMs: 50, retryMs: 5 }), /timeout/i);
  assert.equal(JSON.parse(fs.readFileSync(lock, 'utf8')).id, 'old');
});

test('a live owner older than the default hardStaleMs (60 s) is broken', (t) => {
  const lock = path.join(tmp(t), 'x.lock');
  fs.writeFileSync(lock, JSON.stringify({ pid: 1, ts: 0, id: 'old' }));
  assert.equal(withLockSync(lock, () => 'taken', { isAlive: () => true, now: () => 60001, timeoutMs: 2000 }), 'taken');
});

test('hardStaleMs is configurable and a live owner exactly at it is not broken', (t) => {
  const lock = path.join(tmp(t), 'x.lock');
  fs.writeFileSync(lock, JSON.stringify({ pid: 1, ts: 0, id: 'old' }));
  const o = { isAlive: () => true, hardStaleMs: 30000, timeoutMs: 40, retryMs: 5 };
  assert.throws(() => withLockSync(lock, () => 1, { ...o, now: () => 30000 }), /timeout/i);
  assert.equal(withLockSync(lock, () => 'taken', { ...o, now: () => 30001, timeoutMs: 2000 }), 'taken');
});

test('a dead owner is broken immediately regardless of age', (t) => {
  const lock = path.join(tmp(t), 'x.lock');
  fs.writeFileSync(lock, JSON.stringify({ pid: 1, ts: 100, id: 'old' }));
  assert.equal(withLockSync(lock, () => 'taken', { isAlive: () => false, now: () => 101, timeoutMs: 2000 }), 'taken');
});

test('an unparsable lock falls back to mtime and staleMs', (t) => {
  const lock = path.join(tmp(t), 'x.lock');
  fs.writeFileSync(lock, '');
  const m = fs.statSync(lock).mtimeMs;
  assert.throws(() => withLockSync(lock, () => 1, { isAlive: () => true, now: () => m + 5000, timeoutMs: 40, retryMs: 5 }), /timeout/i);
  assert.equal(withLockSync(lock, () => 'taken', { isAlive: () => true, now: () => m + 10001, timeoutMs: 2000 }), 'taken');
});

test('removal runs under a guard file and a competing lock created at the critical moment survives', (t) => {
  const lock = path.join(tmp(t), 'x.lock');
  const competitor = { pid: process.pid, ts: Date.now(), id: 'competitor' };
  let guardHeld = false;
  withLockSync(lock, () => {}, {
    onBeforeRemove: () => {
      guardHeld = fs.existsSync(lock + '.break');
      // the owner's lock vanishes and a competitor takes the path right here
      fs.writeFileSync(lock, JSON.stringify(competitor));
    },
  });
  assert.equal(guardHeld, true);
  assert.equal(JSON.parse(fs.readFileSync(lock, 'utf8')).id, 'competitor');
  assert.equal(fs.existsSync(lock + '.break'), false);
});

test('while removal holds the guard, a competing acquirer cannot create the lock', (t) => {
  const lock = path.join(tmp(t), 'x.lock');
  let code;
  withLockSync(lock, () => {}, {
    onBeforeRemove: () => {
      try { fs.closeSync(fs.openSync(lock, 'wx')); } catch (e) { code = e.code; }
    },
  });
  assert.equal(code, 'EEXIST');
});

test('a guard left by a dead process is broken', (t) => {
  const dir = tmp(t);
  const lock = path.join(dir, 'x.lock');
  fs.writeFileSync(lock + '.break', JSON.stringify({ pid: 999999, ts: Date.now() }));
  assert.equal(withLockSync(lock, () => 'ok', { isAlive: (p) => p !== 999999, timeoutMs: 2000 }), 'ok');
  assert.deepEqual(fs.readdirSync(dir), []);
});

test('a guard held by a live process makes release fail loudly after a bounded wait, not silently', (t) => {
  const dir = tmp(t);
  const lock = path.join(dir, 'x.lock');
  assert.throws(() => withLockSync(lock, () => {
    fs.writeFileSync(lock + '.break', JSON.stringify({ pid: process.pid, ts: Date.now() }));
  }, { releaseGuardTimeoutMs: 60, retryMs: 5 }), /guard/i);
});

test('an error thrown while removing propagates and the guard is cleaned up', (t) => {
  const lock = path.join(tmp(t), 'x.lock');
  assert.throws(() => withLockSync(lock, () => {}, { onBeforeRemove: () => { throw new Error('hook-boom'); } }), /hook-boom/);
  assert.equal(fs.existsSync(lock + '.break'), false);
});

test('leaves no stale-break leftovers in the directory', (t) => {
  const dir = tmp(t);
  const lock = path.join(dir, 'x.lock');
  fs.writeFileSync(lock, JSON.stringify({ pid: 999999, ts: 0, id: 'old' }));
  withLockSync(lock, () => 1, { isAlive: () => false, timeoutMs: 2000 });
  assert.deepEqual(fs.readdirSync(dir), []);
});

test('times out on a fresh lock held by a live owner and leaves it intact', (t) => {
  const lock = path.join(tmp(t), 'x.lock');
  fs.writeFileSync(lock, JSON.stringify({ pid: 1, ts: Date.now(), id: 'live' }));
  assert.throws(() => withLockSync(lock, () => 1, { isAlive: () => true, timeoutMs: 40, retryMs: 5 }), /timeout/i);
  assert.equal(JSON.parse(fs.readFileSync(lock, 'utf8')).id, 'live');
});

test('stale-break never deletes a live lock that replaced the stale one mid-check', (t) => {
  const lock = path.join(tmp(t), 'x.lock');
  const live = { pid: process.pid, ts: Date.now(), id: 'fresh-owner' };
  fs.writeFileSync(lock, JSON.stringify({ pid: 999999, ts: Date.now(), id: 'stale-owner' }));
  let swapped = false;
  // The liveness probe runs between "read owner" and "remove": another process breaks the stale
  // lock and takes a fresh one exactly there.
  const isAlive = (pid) => {
    if (!swapped) {
      swapped = true;
      fs.writeFileSync(lock, JSON.stringify(live));
    }
    return pid === process.pid;
  };
  // First attempt sees stale-owner dead; afterwards only the live lock is there.
  assert.throws(() => withLockSync(lock, () => 1, { isAlive, timeoutMs: 80, retryMs: 5 }), /timeout/i);
  assert.equal(JSON.parse(fs.readFileSync(lock, 'utf8')).id, 'fresh-owner');
});

test('release does not delete a lock now owned by someone else', (t) => {
  const lock = path.join(tmp(t), 'x.lock');
  const other = { pid: process.pid, ts: Date.now(), id: 'someone-else' };
  withLockSync(lock, () => fs.writeFileSync(lock, JSON.stringify(other)));
  assert.equal(JSON.parse(fs.readFileSync(lock, 'utf8')).id, 'someone-else');
});

test('a non-busy error from the filesystem is thrown, not turned into a timeout', (t) => {
  const lock = path.join(tmp(t), 'missing-dir', 'x.lock');
  assert.throws(() => withLockSync(lock, () => 1, { timeoutMs: 200 }), (e) => e.code === 'ENOENT');
});

test('a directory at the lock path throws and is never deleted', { timeout: 20000 }, (t) => {
  const dir = tmp(t);
  const lock = path.join(dir, 'x.lock');
  // A directory at the lock path: open 'wx' gives EEXIST and it cannot be read as a lock file.
  fs.mkdirSync(lock);
  fs.writeFileSync(path.join(lock, 'f'), 'x');
  // Only assert the contract: it throws (timeout or fs error, platform dependent) and the directory survives.
  assert.throws(() => withLockSync(lock, () => 1, { isAlive: () => false, timeoutMs: 300, retryMs: 5, staleMs: 0 }));
  assert.equal(fs.existsSync(path.join(lock, 'f')), true);
});

test('defaultPidAlive is true for this process', () => {
  assert.equal(defaultPidAlive(process.pid), true);
});

test('defaultPidAlive is false for a reaped child pid', () => {
  const pid = reapedPid();
  assert.equal(defaultPidAlive(pid), false); // asserted right after the reap (pid reuse)
});

test('defaultPidAlive is false for non-positive or non-integer pids', () => {
  for (const bad of [0, -1, 1.5, NaN, '123', null, undefined]) assert.equal(defaultPidAlive(bad), false, String(bad));
});

test('multi-process contention: no lost updates across many short transactions', async (t) => {
  const dir = tmp(t);
  const lock = path.join(dir, 'c.lock');
  const counter = path.join(dir, 'counter');
  fs.writeFileSync(counter, '0');
  const N = 4;
  const ITER = 40;
  await Promise.all(Array.from({ length: N }, () => run(['counter', lock, counter, String(ITER)]).done));
  assert.equal(Number(fs.readFileSync(counter, 'utf8')), N * ITER);
  assert.equal(fs.existsSync(lock), false);
});

test('a holder killed mid-hold is recovered from by other processes', async (t) => {
  const dir = tmp(t);
  const lock = path.join(dir, 'c.lock');
  const ready = path.join(dir, 'ready');
  const counter = path.join(dir, 'counter');
  fs.writeFileSync(counter, '0');
  const holder = run(['hold', lock, ready, '0']);
  holder.done.catch(() => {});
  const until = Date.now() + 15000;
  while (!fs.existsSync(ready) && Date.now() < until) await new Promise((r) => setTimeout(r, 10));
  assert.equal(fs.existsSync(ready), true, 'holder never took the lock');
  assert.equal(fs.existsSync(lock), true);
  process.kill(holder.child.pid);
  await new Promise((r) => holder.child.on('exit', r));
  const N = 3;
  await Promise.all(Array.from({ length: N }, () => run(['counter', lock, counter, '5']).done));
  assert.equal(Number(fs.readFileSync(counter, 'utf8')), N * 5);
});

test('processes racing to break one stale lock never overlap in the critical section', async (t) => {
  const dir = tmp(t);
  const lock = path.join(dir, 'c.lock');
  const violations = path.join(dir, 'violations');
  fs.writeFileSync(lock, JSON.stringify({ pid: reapedPid(), ts: 0, id: 'dead' }));
  await Promise.all(Array.from({ length: 5 }, () => run(['marker', lock, violations, '30']).done));
  assert.equal(fs.existsSync(violations) ? fs.readFileSync(violations, 'utf8') : '', '');
});

test('package index re-exports createQueue and withLockSync', async () => {
  const m = await import('../lib/index.js');
  assert.equal(typeof m.createQueue, 'function');
  assert.equal(typeof m.withLockSync, 'function');
});

// ---- withLockSync option handling, release robustness and exceptions ----
test('an undefined timeoutMs falls back to the default instead of waiting forever', (t) => {
  const lock = path.join(tmp(t), 'x.lock');
  let polls = 0;
  const isAlive = () => {
    // Held by a live owner: every attempt consults isAlive. Bail out loudly if the deadline is never reached.
    if (++polls > 1500) throw new Error('never timed out (NaN deadline)');
    return true;
  };
  withLockSync(lock, () => {
    assert.throws(
      () => withLockSync(lock, () => 'inner', { timeoutMs: undefined, isAlive }),
      /Lock timeout after 5000 ms/,
    );
  });
});

test('an async fn is rejected with a TypeError and the lock is released', (t) => {
  const lock = path.join(tmp(t), 'x.lock');
  assert.throws(() => withLockSync(lock, () => Promise.resolve(1)), TypeError);
  assert.equal(fs.existsSync(lock), false);
  assert.equal(withLockSync(lock, () => 'ok'), 'ok');
});

test('release waits past a stale guard instead of throwing after fn succeeded', (t) => {
  const lock = path.join(tmp(t), 'x.lock');
  const result = withLockSync(lock, () => {
    // a live guard holder whose guard turns stale (5 s) in ~200 ms
    fs.writeFileSync(lock + '.break', JSON.stringify({ pid: process.pid, ts: Date.now() - 4800 }));
    return 'fn-result';
  }, { guardTimeoutMs: 50, retryMs: 5 });
  assert.equal(result, 'fn-result');
  assert.equal(fs.existsSync(lock), false);
  assert.equal(fs.existsSync(lock + '.break'), false);
});

test('a release failure does not mask the exception fn threw', (t) => {
  const lock = path.join(tmp(t), 'x.lock');
  let caught;
  try {
    withLockSync(lock, () => {
      fs.writeFileSync(lock + '.break', JSON.stringify({ pid: process.pid, ts: Date.now() }));
      throw new Error('fn-boom');
    }, { releaseGuardTimeoutMs: 60, retryMs: 5 });
  } catch (e) { caught = e; }
  assert.match(caught.message, /fn-boom/);
  assert.equal(caught.releaseError.code, 'EGUARDBUSY');
});

test('the guard is not unlinked when another owner replaced it during the critical section', (t) => {
  const lock = path.join(tmp(t), 'x.lock');
  const other = { pid: process.pid, ts: Date.now(), id: 'other-guard-owner' };
  withLockSync(lock, () => {}, {
    onBeforeRemove: () => fs.writeFileSync(lock + '.break', JSON.stringify(other)),
  });
  assert.equal(JSON.parse(fs.readFileSync(lock + '.break', 'utf8')).id, 'other-guard-owner');
});

test('a transient EBUSY reading our own guard does not leave the guard behind', (t) => {
  const lock = path.join(tmp(t), 'x.lock');
  const orig = fs.readFileSync;
  let thrown = 0;
  t.mock.method(fs, 'readFileSync', (p, ...rest) => {
    if (String(p).endsWith('.break') && thrown === 0) {
      thrown++;
      throw Object.assign(new Error('busy'), { code: 'EBUSY' });
    }
    return orig(p, ...rest);
  });
  withLockSync(lock, () => {});
  assert.equal(thrown, 1);
  assert.equal(fs.existsSync(lock + '.break'), false);
});

test('a persistent guard read failure still unlinks our guard, readable foreign content does not', (t) => {
  const lock = path.join(tmp(t), 'x.lock');
  const orig = fs.readFileSync;
  t.mock.method(fs, 'readFileSync', (p, ...rest) => {
    if (String(p).endsWith('.break')) throw Object.assign(new Error('busy'), { code: 'EBUSY' });
    return orig(p, ...rest);
  });
  withLockSync(lock, () => {});
  assert.equal(fs.existsSync(lock + '.break'), false);
});

test('the lock timeout error has code ELOCKTIMEOUT', (t) => {
  const lock = path.join(tmp(t), 'x.lock');
  fs.writeFileSync(lock, JSON.stringify({ pid: process.pid, ts: Date.now(), id: 'live' }));
  assert.throws(
    () => withLockSync(lock, () => {}, { timeoutMs: 30, retryMs: 5 }),
    (e) => e.code === 'ELOCKTIMEOUT' && /Lock timeout/.test(e.message),
  );
});

test('the guard wait is capped by the remaining timeoutMs', (t) => {
  const lock = path.join(tmp(t), 'x.lock');
  const dead = reapedPid();
  fs.writeFileSync(lock, JSON.stringify({ pid: dead, ts: Date.now(), id: 'dead-owner' }));
  fs.writeFileSync(lock + '.break', JSON.stringify({ pid: process.pid, ts: Date.now(), id: 'live-guard' }));
  const start = Date.now();
  assert.throws(
    () => withLockSync(lock, () => {}, { timeoutMs: 100, retryMs: 5, guardTimeoutMs: 2000 }),
    (e) => e.code === 'ELOCKTIMEOUT',
  );
  assert.ok(Date.now() - start < 1000, `waited ${Date.now() - start} ms`);
});

test('a lock ts more than 60 s in the future is invalid and falls back to mtime', (t) => {
  const lock = path.join(tmp(t), 'x.lock');
  fs.writeFileSync(lock, '{"id":"old","ts":0}'); // no pid: staleMs applies
  const m = fs.statSync(lock).mtimeMs;
  fs.writeFileSync(lock, JSON.stringify({ id: 'old', ts: m + 200000 }));
  const m2 = fs.statSync(lock).mtimeMs;
  assert.equal(withLockSync(lock, () => 'taken', { isAlive: () => true, now: () => m2 + 10001, timeoutMs: 2000 }), 'taken');
});

test('a lock ts slightly in the future is trusted and never counts as stale', (t) => {
  const lock = path.join(tmp(t), 'x.lock');
  fs.writeFileSync(lock, JSON.stringify({ id: 'old', ts: 130000 })); // 30 s ahead of now
  assert.throws(() => withLockSync(lock, () => 1, { isAlive: () => true, now: () => 100000, timeoutMs: 40, retryMs: 5 }), /timeout/i);
});

test('a guard with a far-future ts is broken via mtime', (t) => {
  const lock = path.join(tmp(t), 'x.lock');
  fs.writeFileSync(lock, JSON.stringify({ pid: 1, ts: 0, id: 'old' }));
  fs.writeFileSync(lock + '.break', '{"ts":1}');
  const m = fs.statSync(lock + '.break').mtimeMs;
  fs.writeFileSync(lock + '.break', JSON.stringify({ ts: m + 500000 }));
  const m2 = fs.statSync(lock + '.break').mtimeMs;
  const o = { isAlive: (pid) => pid !== 1, now: () => m2 + 6000, timeoutMs: 3000, guardTimeoutMs: 1000 };
  assert.equal(withLockSync(lock, () => 'taken', o), 'taken');
});

test('a failing rmSync while cleaning the guard does not mask the original write error', (t) => {
  const lock = path.join(tmp(t), 'x.lock');
  const orig = Object.assign(new Error('write boom'), { code: 'EIO' });
  t.mock.method(fs, 'writeSync', () => { throw orig; });
  const rm = t.mock.method(fs, 'rmSync', () => { throw Object.assign(new Error('rm boom'), { code: 'EACCES' }); });
  try {
    assert.throws(() => withLockSync(lock, () => 1, { timeoutMs: 200 }), (e) => e === orig);
    assert.ok(rm.mock.callCount() > 0);
  } finally {
    t.mock.restoreAll(); // let the test's own cleanup hook use the real rmSync
  }
});
