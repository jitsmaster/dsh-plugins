import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createQueue } from '../lib/queue.js';
import { withLockSync } from '../lib/lock.js';

function setup(t, extra = {}) {
  const dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'pwq-queue-')), 'q');
  t.after(() => fs.rmSync(path.dirname(dir), { recursive: true, force: true }));
  const clock = { t: 1000 };
  const dead = new Set();
  let n = 0;
  const opts = {
    dir,
    now: () => clock.t,
    isAlive: (pid) => !dead.has(pid),
    randomId: () => `id${++n}`,
    idleMs: 1000,
    ...extra,
  };
  return { dir, file: path.join(dir, 'state.json'), clock, dead, q: createQueue(opts), opts };
}

test('creates the dir if missing', (t) => {
  const { dir } = setup(t);
  assert.equal(fs.existsSync(dir), true);
});

test('first enqueue is granted on first poll', (t) => {
  const { q } = setup(t);
  const { ticket } = q.enqueue({ holder: 'a', pid: 1 });
  const r = q.poll(ticket);
  assert.equal(r.status, 'granted');
  assert.equal(typeof r.token, 'string');
  assert.equal(q.validate(r.token), true);
});

test('granted ticket polled again returns the same token', (t) => {
  const { q } = setup(t);
  const { ticket } = q.enqueue({ holder: 'a', pid: 1 });
  const a = q.poll(ticket);
  assert.equal(q.poll(ticket).token, a.token);
});

test('three waiters are served in FIFO order with positions', (t) => {
  const { q } = setup(t);
  const a = q.enqueue({ holder: 'a', pid: 1 }).ticket;
  const b = q.enqueue({ holder: 'b', pid: 2 }).ticket;
  const c = q.enqueue({ holder: 'c', pid: 3 }).ticket;
  const ga = q.poll(a);
  assert.equal(ga.status, 'granted');
  assert.deepEqual(q.poll(b), { status: 'waiting', position: 1, holderLabel: 'a' });
  assert.deepEqual(q.poll(c), { status: 'waiting', position: 2, holderLabel: 'a' });
  q.release(ga.token);
  assert.equal(q.poll(c).status, 'waiting');
  const gb = q.poll(b);
  assert.equal(gb.status, 'granted');
  assert.deepEqual(q.poll(c), { status: 'waiting', position: 1, holderLabel: 'b' });
  q.release(gb.token);
  assert.equal(q.poll(c).status, 'granted');
});

test('polling a later waiter first never jumps the queue', (t) => {
  const { q } = setup(t);
  const a = q.enqueue({ holder: 'a', pid: 1 }).ticket;
  const b = q.enqueue({ holder: 'b', pid: 2 }).ticket;
  assert.equal(q.poll(b).status, 'waiting');
  assert.equal(q.poll(a).status, 'granted');
});

test('release promotes the next waiter immediately', (t) => {
  const { q } = setup(t);
  const a = q.enqueue({ holder: 'a', pid: 1 }).ticket;
  q.enqueue({ holder: 'b', pid: 2 });
  const ga = q.poll(a);
  q.release(ga.token);
  assert.equal(q.snapshot().lease.holder, 'b');
});

test('release is idempotent and rejects stale tokens', (t) => {
  const { q } = setup(t);
  const a = q.enqueue({ holder: 'a', pid: 1 }).ticket;
  const ga = q.poll(a);
  assert.equal(q.release('nope'), false);
  assert.equal(q.release(ga.token), true);
  assert.equal(q.release(ga.token), false);
  assert.equal(q.validate(ga.token), false);
  assert.equal(q.poll(a).status, 'unknown');
});

test('validate is false after idle expiry and the next waiter is promoted', (t) => {
  const { q, clock } = setup(t);
  const a = q.enqueue({ holder: 'a', pid: 1 }).ticket;
  const b = q.enqueue({ holder: 'b', pid: 2 }).ticket;
  const ga = q.poll(a);
  clock.t += 1001;
  assert.equal(q.validate(ga.token), false);
  assert.equal(q.poll(b).status, 'granted');
});

test('lease is not expired exactly at idleMs', (t) => {
  const { q, clock } = setup(t);
  const ga = q.poll(q.enqueue({ holder: 'a', pid: 1 }).ticket);
  clock.t += 1000;
  assert.equal(q.validate(ga.token), true);
});

test('touch extends the lease', (t) => {
  const { q, clock } = setup(t);
  const ga = q.poll(q.enqueue({ holder: 'a', pid: 1 }).ticket);
  clock.t += 800;
  assert.equal(q.touch(ga.token), true);
  clock.t += 800;
  assert.equal(q.validate(ga.token), true);
  clock.t += 300;
  assert.equal(q.validate(ga.token), false);
  assert.equal(q.touch(ga.token), false);
});

test('validate does not extend the lease', (t) => {
  const { q, clock } = setup(t);
  const ga = q.poll(q.enqueue({ holder: 'a', pid: 1 }).ticket);
  clock.t += 800;
  q.validate(ga.token);
  clock.t += 800;
  assert.equal(q.validate(ga.token), false);
});

test('dead-pid waiter is skipped', (t) => {
  const { q, dead } = setup(t);
  const a = q.enqueue({ holder: 'a', pid: 1 }).ticket;
  const b = q.enqueue({ holder: 'b', pid: 2 }).ticket;
  dead.add(1);
  assert.equal(q.poll(b).status, 'granted');
  assert.equal(q.poll(a).status, 'unknown');
});

test('dead-pid lease is reclaimed', (t) => {
  const { q, dead } = setup(t);
  const a = q.enqueue({ holder: 'a', pid: 1 }).ticket;
  const b = q.enqueue({ holder: 'b', pid: 2 }).ticket;
  const ga = q.poll(a);
  dead.add(1);
  assert.equal(q.poll(b).status, 'granted');
  assert.equal(q.validate(ga.token), false);
});

test('reclaim reports what it dropped', (t) => {
  const { q, dead } = setup(t);
  const a = q.enqueue({ holder: 'a', pid: 1 }).ticket;
  const b = q.enqueue({ holder: 'b', pid: 2 }).ticket;
  q.poll(a);
  dead.add(1);
  dead.add(2);
  const r = q.reclaim();
  assert.equal(r.droppedLease, a);
  assert.deepEqual(r.droppedWaiters, [b]);
  assert.deepEqual(q.reclaim(), { droppedWaiters: [], droppedLease: null });
});

test('cancel removes a waiting ticket', (t) => {
  const { q } = setup(t);
  q.poll(q.enqueue({ holder: 'a', pid: 1 }).ticket);
  const b = q.enqueue({ holder: 'b', pid: 2 }).ticket;
  const c = q.enqueue({ holder: 'c', pid: 3 }).ticket;
  assert.equal(q.cancel(b), true);
  assert.equal(q.cancel(b), false);
  assert.equal(q.poll(b).status, 'unknown');
  assert.equal(q.poll(c).position, 1);
});

test('cancel of a granted ticket releases the lease and promotes next', (t) => {
  const { q } = setup(t);
  const a = q.enqueue({ holder: 'a', pid: 1 }).ticket;
  const b = q.enqueue({ holder: 'b', pid: 2 }).ticket;
  const ga = q.poll(a);
  assert.equal(q.cancel(a), true);
  assert.equal(q.validate(ga.token), false);
  assert.equal(q.poll(b).status, 'granted');
});

test('enqueue is idempotent for the same holder and pid while waiting', (t) => {
  const { q } = setup(t);
  q.poll(q.enqueue({ holder: 'a', pid: 1 }).ticket);
  const b1 = q.enqueue({ holder: 'b', pid: 2 }).ticket;
  const b2 = q.enqueue({ holder: 'b', pid: 2 }).ticket;
  const b3 = q.enqueue({ holder: 'b', pid: 3 }).ticket;
  assert.equal(b1, b2);
  assert.notEqual(b1, b3);
  assert.equal(q.snapshot().waiters.length, 2);
});

test('corrupt state.json is quarantined and treated as empty', (t) => {
  const { dir, q } = setup(t);
  fs.writeFileSync(path.join(dir, 'state.json'), '{not json');
  const a = q.enqueue({ holder: 'a', pid: 1 }).ticket;
  assert.equal(q.poll(a).status, 'granted');
  const quarantined = fs.readdirSync(dir).filter((f) => f.startsWith('state.json.corrupt-'));
  assert.equal(quarantined.length, 1);
  assert.equal(fs.readFileSync(path.join(dir, quarantined[0]), 'utf8'), '{not json');
  JSON.parse(fs.readFileSync(path.join(dir, 'state.json'), 'utf8'));
  assert.deepEqual(fs.readdirSync(dir).filter((f) => f.includes('.tmp')), []);
});

const goodWaiter = { ticket: 't', pid: 5, holder: 'h', enqueuedAt: 1, lastPolledAt: 1 };
const goodLease = { token: 'k', ticket: 'l', holder: 'h', pid: 5, grantedAt: 1, lastActivityAt: 1 };
const badShapes = {
  'null waiter': { waiters: [null] },
  'waiter without ticket': { waiters: [{ ...goodWaiter, ticket: 5 }] },
  'waiter pid 0': { waiters: [{ ...goodWaiter, pid: 0 }] },
  'waiter pid string': { waiters: [{ ...goodWaiter, pid: '5' }] },
  'waiter holder number': { waiters: [{ ...goodWaiter, holder: 1 }] },
  'waiter enqueuedAt missing': { waiters: [{ ...goodWaiter, enqueuedAt: undefined }] },
  'waiter lastPolledAt string': { waiters: [{ ...goodWaiter, lastPolledAt: 'x' }] },
  'lease token number': { lease: { ...goodLease, token: 1 } },
  'lease ticket missing': { lease: { ...goodLease, ticket: undefined } },
  'lease holder missing': { lease: { ...goodLease, holder: undefined } },
  'lease pid float': { lease: { ...goodLease, pid: 1.5 } },
  'lease grantedAt string': { lease: { ...goodLease, grantedAt: 'x' } },
  'lease lastActivityAt missing': { lease: { ...goodLease, lastActivityAt: undefined } },
  'lease is a string': { lease: 'x' },
  'waiters not an array': { waiters: {} },
};
for (const [name, shape] of Object.entries(badShapes)) {
  test(`state.json with an invalid shape (${name}) is quarantined and treated as empty`, (t) => {
    const { dir, q } = setup(t);
    fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify(shape));
    assert.deepEqual(q.snapshot(), { lease: null, waiters: [] });
    assert.equal(fs.readdirSync(dir).filter((f) => f.startsWith('state.json.corrupt-')).length, 1);
  });
}

test('a well-formed state.json is loaded, not quarantined', (t) => {
  const { dir, q } = setup(t, { idleMs: 1e9, waiterTtlMs: 1e9 });
  fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify({ lease: goodLease, waiters: [{ ...goodWaiter, holder: 'w' }] }));
  assert.deepEqual(q.snapshot().waiters, [{ holder: 'w', position: 1 }]);
  assert.deepEqual(fs.readdirSync(dir).filter((f) => f.includes('corrupt')), []);
});

test('two corruptions in the same millisecond get distinct quarantine files', (t) => {
  const { dir, q } = setup(t);
  const file = path.join(dir, 'state.json');
  fs.writeFileSync(file, '{bad1');
  q.snapshot();
  fs.writeFileSync(file, '{bad2');
  q.snapshot();
  assert.equal(fs.readdirSync(dir).filter((f) => f.startsWith('state.json.corrupt-')).length, 2);
});

test('a missing state.json is empty state and is not quarantined', (t) => {
  const { dir, q } = setup(t);
  assert.deepEqual(q.snapshot(), { lease: null, waiters: [] });
  assert.deepEqual(fs.readdirSync(dir).filter((f) => f.includes('corrupt')), []);
});

test('state lives in a single state.json holding lease and waiters', (t) => {
  const { dir, q } = setup(t);
  q.poll(q.enqueue({ holder: 'a', pid: 1 }).ticket);
  q.enqueue({ holder: 'b', pid: 2 });
  const s = JSON.parse(fs.readFileSync(path.join(dir, 'state.json'), 'utf8'));
  assert.equal(s.lease.holder, 'a');
  assert.equal(s.waiters.length, 1);
  assert.equal(fs.existsSync(path.join(dir, 'queue.json')), false);
  assert.equal(fs.existsSync(path.join(dir, 'lease.json')), false);
});

test('operations on unchanged state do not rewrite state.json', (t) => {
  const { dir, q, clock } = setup(t);
  const a = q.enqueue({ holder: 'a', pid: 1 }).ticket;
  const ga = q.poll(a);
  q.enqueue({ holder: 'b', pid: 2 });
  const file = path.join(dir, 'state.json');
  const old = new Date(2000, 0, 1);
  fs.utimesSync(file, old, old);
  clock.t += 50; // a time change alone must not cause a write for a claimed lease
  q.validate(ga.token);
  q.validate('nope');
  q.snapshot();
  q.poll(a);
  q.release('nope');
  q.cancel('nope');
  q.reclaim();
  assert.equal(fs.statSync(file).mtimeMs, old.getTime());
});

test('a changing operation does rewrite state.json', (t) => {
  const { dir, q } = setup(t);
  const ga = q.poll(q.enqueue({ holder: 'a', pid: 1 }).ticket);
  const file = path.join(dir, 'state.json');
  const old = new Date(2000, 0, 1);
  fs.utimesSync(file, old, old);
  q.release(ga.token);
  assert.notEqual(fs.statSync(file).mtimeMs, old.getTime());
});

test('enqueue by the holder of the current lease returns its existing ticket', (t) => {
  const { q } = setup(t);
  const a1 = q.enqueue({ holder: 'a', pid: 1 }).ticket;
  q.poll(a1);
  const a2 = q.enqueue({ holder: 'a', pid: 1 }).ticket;
  assert.equal(a2, a1);
  assert.deepEqual(q.snapshot().waiters, []);
});

test('a waiter that stops polling is dropped after waiterTtlMs even if its pid is alive', (t) => {
  const { q, clock } = setup(t, { waiterTtlMs: 5000, idleMs: 1e9 });
  q.poll(q.enqueue({ holder: 'a', pid: 1 }).ticket);
  const b = q.enqueue({ holder: 'b', pid: 2 }).ticket;
  const c = q.enqueue({ holder: 'c', pid: 3 }).ticket;
  clock.t += 3000;
  q.poll(c); // c keeps polling
  clock.t += 3000; // b last seen 6000 ms ago, c 3000 ms ago
  const r = q.reclaim();
  assert.deepEqual(r.droppedWaiters, [b]);
  assert.equal(q.poll(b).status, 'unknown');
  assert.equal(q.poll(c).status, 'waiting');
});

test('a waiter is not dropped exactly at waiterTtlMs', (t) => {
  const { q, clock } = setup(t, { waiterTtlMs: 5000, idleMs: 1e9 });
  q.poll(q.enqueue({ holder: 'a', pid: 1 }).ticket);
  const b = q.enqueue({ holder: 'b', pid: 2 }).ticket;
  clock.t += 5000;
  assert.equal(q.poll(b).status, 'waiting');
});

test('waiterTtlMs defaults to 120000', (t) => {
  const { q, clock } = setup(t, { idleMs: 1e9 });
  q.poll(q.enqueue({ holder: 'a', pid: 1 }).ticket);
  const b = q.enqueue({ holder: 'b', pid: 2 }).ticket;
  clock.t += 120000;
  assert.equal(q.poll(b).status, 'waiting');
  clock.t += 120001;
  assert.equal(q.poll(b).status, 'unknown');
});

test('enqueue rejects invalid pid and holder with TypeError', (t) => {
  const { q } = setup(t);
  for (const pid of [0, -1, 1.5, NaN, '1', undefined, null]) {
    assert.throws(() => q.enqueue({ holder: 'a', pid }), TypeError, `pid ${String(pid)}`);
  }
  for (const holder of ['', 5, undefined, null, {}]) {
    assert.throws(() => q.enqueue({ holder, pid: 1 }), TypeError, `holder ${String(holder)}`);
  }
  assert.deepEqual(q.snapshot(), { lease: null, waiters: [] });
});

test('enqueue truncates a holder longer than 200 characters', (t) => {
  const { q } = setup(t);
  q.poll(q.enqueue({ holder: 'a', pid: 1 }).ticket);
  q.enqueue({ holder: 'x'.repeat(500), pid: 2 });
  assert.equal(q.snapshot().waiters[0].holder.length, 200);
});

test('snapshot reports lease and waiters without tokens', (t) => {
  const { q, clock } = setup(t);
  assert.deepEqual(q.snapshot(), { lease: null, waiters: [] });
  const ga = q.poll(q.enqueue({ holder: 'a', pid: 1 }).ticket);
  q.enqueue({ holder: 'b', pid: 2 });
  clock.t += 250;
  const s = q.snapshot();
  assert.deepEqual(s, { lease: { holder: 'a', since: 1000, idleForMs: 250 }, waiters: [{ holder: 'b', position: 1 }] });
  assert.equal(JSON.stringify(s).includes(ga.token), false);
});

test('two queue instances on the same dir see one consistent FIFO', (t) => {
  const { q, opts } = setup(t);
  const q2 = createQueue(opts);
  const a = q.enqueue({ holder: 'a', pid: 1 }).ticket;
  const b = q2.enqueue({ holder: 'b', pid: 2 }).ticket;
  const c = q.enqueue({ holder: 'c', pid: 3 }).ticket;
  const ga = q2.poll(a);
  assert.equal(ga.status, 'granted');
  assert.equal(q.validate(ga.token), true);
  assert.equal(q.poll(b).position, 1);
  assert.equal(q2.poll(c).position, 2);
  q.release(ga.token);
  assert.equal(q2.poll(b).status, 'granted');
  assert.equal(q.poll(c).status, 'waiting');
});

test('three real processes never overlap and are granted in enqueue order', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pwq-mp-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const log = path.join(dir, 'log.txt');
  const helper = fileURLToPath(new URL('../fixtures/queue-worker.mjs', import.meta.url));
  const names = ['w1', 'w2', 'w3'];
  const runs = [];
  for (const name of names) {
    runs.push(new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [helper, path.join(dir, 'q'), log, name], { stdio: 'inherit' });
      child.on('error', reject);
      child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`${name} exit ${code}`))));
    }));
    // stagger: the next worker starts only once this one is in the queue, so enqueue order is known
    const until = Date.now() + 15000;
    while (!fs.existsSync(`${log}.${name}.enq`) && Date.now() < until) await new Promise((r) => setTimeout(r, 5));
    assert.equal(fs.existsSync(`${log}.${name}.enq`), true, `${name} never enqueued`);
  }
  await Promise.all(runs);
  const rows = fs.readFileSync(log, 'utf8').trim().split('\n').map((l) => l.split(' '));
  assert.equal(rows.length, 3);
  const iv = rows.map(([name, s, e]) => ({ name, s: Number(s), e: Number(e) })).sort((x, y) => x.s - y.s);
  assert.deepEqual(iv.map((x) => x.name), names, `grant order != enqueue order: ${JSON.stringify(iv)}`);
  for (let i = 1; i < iv.length; i++) assert.ok(iv[i].s >= iv[i - 1].e, `overlap: ${JSON.stringify(iv)}`);
});
// ---- lease reclaim: abandoned promotions, dead holders, idle expiry ----
const leaseOf = (dir) => JSON.parse(fs.readFileSync(path.join(dir, 'state.json'), 'utf8')).lease;

test('a promoted lease that is never polled is reclaimed after waiterTtlMs and the next waiter is promoted', (t) => {
  const { q, clock } = setup(t, { waiterTtlMs: 5000, idleMs: 1e9 });
  const a = q.enqueue({ holder: 'a', pid: 1 }).ticket;
  const b = q.enqueue({ holder: 'b', pid: 2 }).ticket;
  const c = q.enqueue({ holder: 'c', pid: 3 }).ticket;
  const gb = q.poll(a); // a granted and claimed
  clock.t += 100;
  q.release(gb.token); // promotes b, who never polls
  clock.t += 4000;
  q.poll(c); // keep c alive
  clock.t += 1001; // b's lease is 5101 ms old and unclaimed; c polled 1001 ms ago
  assert.equal(q.poll(c).status, 'granted');
  assert.equal(q.poll(b).status, 'unknown');
});

test('a promoted lease is not dropped exactly at waiterTtlMs', (t) => {
  const { q, clock, dir } = setup(t, { waiterTtlMs: 5000, idleMs: 1e9 });
  const a = q.enqueue({ holder: 'a', pid: 1 }).ticket;
  q.enqueue({ holder: 'b', pid: 2 });
  q.release(q.poll(a).token);
  clock.t += 5000;
  assert.equal(q.validate(leaseOf(dir).token), true);
});

test('a lease claimed by poll is not dropped by the unclaimed rule', (t) => {
  const { q, clock } = setup(t, { waiterTtlMs: 5000, idleMs: 1e9 });
  const a = q.enqueue({ holder: 'a', pid: 1 }).ticket;
  const b = q.enqueue({ holder: 'b', pid: 2 }).ticket;
  q.release(q.poll(a).token);
  clock.t += 100;
  const gb = q.poll(b);
  assert.equal(gb.status, 'granted');
  clock.t += 60000;
  assert.equal(q.validate(gb.token), true);
});

test('a lease claimed by touch is not dropped by the unclaimed rule', (t) => {
  const { q, clock, dir } = setup(t, { waiterTtlMs: 5000, idleMs: 1e9 });
  const a = q.enqueue({ holder: 'a', pid: 1 }).ticket;
  q.enqueue({ holder: 'b', pid: 2 });
  q.release(q.poll(a).token);
  const token = leaseOf(dir).token;
  clock.t += 100;
  assert.equal(q.touch(token), true);
  clock.t += 60000;
  assert.equal(q.validate(token), true);
});

test('validate of an unclaimed token is true before the TTL and does not claim it', (t) => {
  const { q, clock, dir } = setup(t, { waiterTtlMs: 5000, idleMs: 1e9 });
  const a = q.enqueue({ holder: 'a', pid: 1 }).ticket;
  q.enqueue({ holder: 'b', pid: 2 });
  q.release(q.poll(a).token);
  const token = leaseOf(dir).token;
  clock.t += 4000;
  assert.equal(q.validate(token), true);
  clock.t += 2000;
  assert.equal(q.validate(token), false);
});

test('state.json with a lease claimedAt of null, a number or absent is accepted; a string is quarantined', (t) => {
  for (const ok of [null, 5, undefined]) {
    const { dir, q } = setup(t, { idleMs: 1e9, waiterTtlMs: 1e9 });
    fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify({ lease: { ...goodLease, claimedAt: ok }, waiters: [] }));
    assert.equal(q.snapshot().lease.holder, 'h');
    assert.deepEqual(fs.readdirSync(dir).filter((f) => f.includes('corrupt')), []);
  }
  const { dir, q } = setup(t);
  fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify({ lease: { ...goodLease, claimedAt: 'x' }, waiters: [] }));
  assert.deepEqual(q.snapshot(), { lease: null, waiters: [] });
  assert.equal(fs.readdirSync(dir).filter((f) => f.startsWith('state.json.corrupt-')).length, 1);
});

test('only the newest 5 quarantine files are kept', (t) => {
  const { dir, q, clock } = setup(t);
  const file = path.join(dir, 'state.json');
  for (let i = 1; i <= 8; i++) {
    clock.t = 10000 + i * 10; // 10 reaches double digits on purpose: ordering must be numeric
    fs.writeFileSync(file, `{bad${i}`);
    q.snapshot();
  }
  const kept = fs.readdirSync(dir).filter((f) => f.startsWith('state.json.corrupt-'));
  assert.equal(kept.length, 5);
  const contents = kept.map((f) => fs.readFileSync(path.join(dir, f), 'utf8')).sort();
  assert.deepEqual(contents, ['{bad4', '{bad5', '{bad6', '{bad7', '{bad8']);
});

// ---- perf/robustness round ----
const mtimeOf = (dir) => fs.statSync(path.join(dir, 'state.json')).mtimeMs;
const backdate = (dir) => {
  const old = new Date(2000, 0, 1);
  fs.utimesSync(path.join(dir, 'state.json'), old, old);
  return old.getTime();
};

test('a waiting poll refreshes lastPolledAt and rewrites state.json once the poll throttle window has passed', (t) => {
  const { dir, q, clock } = setup(t, { idleMs: 100000 }); // poll throttle default = 12000
  q.poll(q.enqueue({ holder: 'a', pid: 1 }).ticket);
  const b = q.enqueue({ holder: 'b', pid: 2 }).ticket;
  const old = backdate(dir);
  clock.t += 12050;
  q.poll(b);
  assert.notEqual(mtimeOf(dir), old);
});

test('touch inside the throttle window does not rewrite state.json, after it does', (t) => {
  const { dir, q, clock } = setup(t); // idleMs 1000 -> default throttle 100
  const ga = q.poll(q.enqueue({ holder: 'a', pid: 1 }).ticket);
  const old = backdate(dir);
  clock.t += 50;
  assert.equal(q.touch(ga.token), true);
  assert.equal(mtimeOf(dir), old);
  assert.equal(leaseOf(dir).lastActivityAt, 1000);
  clock.t += 51;
  assert.equal(q.touch(ga.token), true);
  assert.notEqual(mtimeOf(dir), old);
  assert.equal(leaseOf(dir).lastActivityAt, clock.t);
});

test('touchThrottleMs is configurable', (t) => {
  const { dir, q, clock } = setup(t, { touchThrottleMs: 500 });
  const ga = q.poll(q.enqueue({ holder: 'a', pid: 1 }).ticket);
  const old = backdate(dir);
  clock.t += 400;
  q.touch(ga.token);
  assert.equal(mtimeOf(dir), old);
  clock.t += 101;
  q.touch(ga.token);
  assert.notEqual(mtimeOf(dir), old);
});

test('touch claims an unclaimed lease immediately even inside the throttle window', (t) => {
  const { dir, q } = setup(t);
  const a = q.enqueue({ holder: 'a', pid: 1 }).ticket;
  q.enqueue({ holder: 'b', pid: 2 });
  q.release(q.poll(a).token);
  const token = leaseOf(dir).token;
  assert.equal(leaseOf(dir).claimedAt, null);
  assert.equal(q.touch(token), true);
  assert.equal(typeof leaseOf(dir).claimedAt, 'number');
});

test('a lease touched repeatedly inside the throttle window still idles out after idleMs', (t) => {
  const { q, clock } = setup(t);
  const ga = q.poll(q.enqueue({ holder: 'a', pid: 1 }).ticket);
  for (let i = 0; i < 10; i++) {
    clock.t += 50;
    assert.equal(q.touch(ga.token), true);
  }
  clock.t += 1001;
  assert.equal(q.validate(ga.token), false);
  assert.equal(q.touch(ga.token), false);
});

test('validate is true/false correctly without taking the lock or writing', (t) => {
  const { dir, q, clock, dead } = setup(t);
  const a = q.enqueue({ holder: 'a', pid: 1 }).ticket;
  const ga = q.poll(a);
  const old = backdate(dir);
  assert.equal(q.validate(ga.token), true);
  assert.equal(q.validate('nope'), false);
  dead.add(1);
  assert.equal(q.validate(ga.token), false);
  dead.clear();
  clock.t += 1001;
  assert.equal(q.validate(ga.token), false);
  assert.equal(mtimeOf(dir), old);
  assert.equal(fs.existsSync(path.join(dir, 'state.lock')), false);
  assert.equal(leaseOf(dir).token, ga.token); // an expired lease is not reclaimed by validate
});

test('validate works while another party holds state.lock', (t) => {
  const { dir, q } = setup(t);
  const ga = q.poll(q.enqueue({ holder: 'a', pid: 1 }).ticket);
  const r = withLockSync(path.join(dir, 'state.lock'), () => [q.validate(ga.token), q.validate('nope')], { timeoutMs: 500 });
  assert.deepEqual(r, [true, false]);
});

// Changed from the old behaviour (validate left a corrupt file untouched): validate now falls back to the
// locked path, which quarantines the corrupt file like every other locked operation.
test('validate on a corrupt state.json is false and the locked fallback quarantines it', (t) => {
  const { dir, q } = setup(t);
  fs.writeFileSync(path.join(dir, 'state.json'), '{not json');
  assert.equal(q.validate('x'), false);
  fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify({ lease: 'x' }));
  assert.equal(q.validate('x'), false);
  assert.equal(fs.readdirSync(dir).filter((f) => f.includes('corrupt')).length, 2);
  assert.equal(fs.existsSync(path.join(dir, 'state.json')), false);
});

test('validate with no state.json is false and creates nothing', (t) => {
  const { dir, q } = setup(t);
  assert.equal(q.validate('x'), false);
  assert.deepEqual(fs.readdirSync(dir), []);
});

test('temp files get a random suffix and are created exclusively with mode 0600', (t) => {
  const { q } = setup(t);
  const calls = [];
  const orig = fs.openSync;
  fs.openSync = (p, flags, mode) => {
    if (String(p).endsWith('.tmp')) calls.push({ p: path.basename(String(p)), flags, mode });
    return orig(p, flags, mode);
  };
  try {
    q.enqueue({ holder: 'a', pid: 1 });
    q.enqueue({ holder: 'b', pid: 2 });
  } finally {
    fs.openSync = orig;
  }
  assert.equal(calls.length, 2);
  for (const c of calls) {
    assert.equal(c.flags, 'wx');
    assert.equal(c.mode, 0o600);
    assert.match(c.p, /^state\.json\.\d+\.[0-9a-f]{12,}\.tmp$/);
  }
  assert.notEqual(calls[0].p, calls[1].p);
});

test('a failed rename removes the temp file and rethrows', (t) => {
  const { dir, q } = setup(t);
  const orig = fs.renameSync;
  fs.renameSync = (a, b) => {
    if (String(a).endsWith('.tmp')) throw Object.assign(new Error('disk'), { code: 'EIO' });
    return orig(a, b);
  };
  try {
    assert.throws(() => q.enqueue({ holder: 'a', pid: 1 }), /disk/);
  } finally {
    fs.renameSync = orig;
  }
  assert.deepEqual(fs.readdirSync(dir).filter((f) => f.endsWith('.tmp')), []);
});

test('stale temp leftovers are swept by a locked operation; fresh ones and directories are kept', (t) => {
  const { dir, q } = setup(t);
  const old = new Date(2000, 0, 1);
  const stale = path.join(dir, 'state.json.99.abc.tmp');
  const fresh = path.join(dir, 'state.json.98.def.tmp');
  const odd = path.join(dir, 'state.json.97.ghi.tmp');
  fs.writeFileSync(stale, 'x');
  fs.writeFileSync(fresh, 'x');
  fs.mkdirSync(odd);
  fs.utimesSync(stale, old, old);
  fs.utimesSync(odd, old, old);
  q.snapshot();
  assert.equal(fs.existsSync(stale), false);
  assert.equal(fs.existsSync(fresh), true);
  assert.equal(fs.statSync(odd).isDirectory(), true);
});

test('quarantining a corrupt state does not bypass the sweep throttle', (t) => {
  const { dir, q } = setup(t);
  q.snapshot(); // first locked op does the periodic sweep
  const stale = path.join(dir, 'state.json.99.abc.tmp');
  fs.writeFileSync(stale, 'x');
  const old = new Date(2000, 0, 1);
  fs.utimesSync(stale, old, old);
  fs.writeFileSync(path.join(dir, 'state.json'), '{bad');
  q.snapshot();
  assert.equal(fs.existsSync(stale), true); // still inside TMP_SWEEP_EVERY_MS
});

test('a directory named like a quarantine file cannot wedge transactions', (t) => {
  const { dir, q, clock } = setup(t);
  const trap = path.join(dir, 'state.json.corrupt-1-trap');
  fs.mkdirSync(trap);
  fs.writeFileSync(path.join(trap, 'f'), 'x');
  for (let i = 1; i <= 7; i++) {
    clock.t = 10000 + i;
    fs.writeFileSync(path.join(dir, 'state.json'), `{bad${i}`);
    assert.doesNotThrow(() => q.snapshot());
  }
  assert.equal(fs.statSync(trap).isDirectory(), true);
  const files = fs.readdirSync(dir).filter((f) => f.startsWith('state.json.corrupt-') && f !== 'state.json.corrupt-1-trap');
  assert.equal(files.length, 5);
});

test('holder labels are sanitised to a single line without control characters', (t) => {
  const { q } = setup(t);
  q.poll(q.enqueue({ holder: 'a', pid: 1 }).ticket);
  q.enqueue({ holder: 'evil\r\n\u0000name\u001b[2J\u007f!', pid: 2 });
  const h = q.snapshot().waiters[0].holder;
  assert.equal(h, 'evil name [2J !');
  assert.doesNotMatch(h, /[\u0000-\u001f\u007f]/);
});

test('a holder that is empty after sanitising is rejected', (t) => {
  const { q } = setup(t);
  assert.throws(() => q.enqueue({ holder: '\n\t\u0000 ', pid: 1 }), TypeError);
  assert.deepEqual(q.snapshot(), { lease: null, waiters: [] });
});

test('sanitised holders still merge idempotently', (t) => {
  const { q } = setup(t);
  q.poll(q.enqueue({ holder: 'a', pid: 1 }).ticket);
  const t1 = q.enqueue({ holder: 'b\nx', pid: 2 }).ticket;
  assert.equal(q.enqueue({ holder: 'b x', pid: 2 }).ticket, t1);
});

test('enqueue beyond maxWaiters throws EQUEUEFULL; existing waiters may still re-enqueue', (t) => {
  const { q } = setup(t, { maxWaiters: 2 });
  q.poll(q.enqueue({ holder: 'a', pid: 1 }).ticket);
  const b = q.enqueue({ holder: 'b', pid: 2 }).ticket;
  q.enqueue({ holder: 'c', pid: 3 });
  assert.throws(() => q.enqueue({ holder: 'd', pid: 4 }), (e) => e instanceof Error && e.code === 'EQUEUEFULL');
  assert.equal(q.enqueue({ holder: 'b', pid: 2 }).ticket, b);
  assert.equal(q.snapshot().waiters.length, 2);
});

test('maxWaiters defaults to 100', (t) => {
  const { q } = setup(t, { idleMs: 1e9, waiterTtlMs: 1e9 });
  q.poll(q.enqueue({ holder: 'a', pid: 1 }).ticket);
  for (let i = 0; i < 100; i++) q.enqueue({ holder: `w${i}`, pid: 10 + i });
  assert.throws(() => q.enqueue({ holder: 'over', pid: 999 }), { code: 'EQUEUEFULL' });
});


// ---- perf: lock-free touch fast path, poll throttle, bounded lock-free reads, touch clamp ----
const statKey = (f) => { const s = fs.statSync(f); return `${s.mtimeMs}:${s.ino}:${s.size}`; };

function granted(t, extra = {}) {
  const ctx = setup(t, { idleMs: 10000, touchThrottleMs: 1000, ...extra });
  const { ticket } = ctx.q.enqueue({ holder: 'a', pid: 1 });
  const token = ctx.q.poll(ticket).token; // claims the lease
  return { ...ctx, token, file: path.join(ctx.dir, 'state.json'), lock: path.join(ctx.dir, 'state.lock') };
}

test('touch inside the throttle window needs no lock and does not rewrite state.json', (t) => {
  const { q, clock, token, file, dir } = granted(t);
  clock.t += 500;
  const before = fs.readFileSync(file, 'utf8');
  const sk = statKey(file);
  let held;
  withLockSync(path.join(dir, 'state.lock'), () => {
    held = q.touch(token); // would time out / block if it tried to lock
  }, { timeoutMs: 100 });
  assert.equal(held, true);
  assert.equal(fs.readFileSync(file, 'utf8'), before);
  assert.equal(statKey(file), sk);
});

test('touch fast path never creates state.lock', (t) => {
  const { q, clock, token, lock } = granted(t);
  clock.t += 100;
  assert.equal(fs.existsSync(lock), false);
  assert.equal(q.touch(token), true);
  assert.equal(fs.existsSync(lock), false);
});

test('touch past the throttle window still writes the new activity stamp', (t) => {
  const { q, clock, token, file } = granted(t);
  clock.t += 1500;
  assert.equal(q.touch(token), true);
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).lease.lastActivityAt, clock.t);
});

test('touch on an unclaimed lease claims it via the locked path', (t) => {
  const { q, clock, file } = setup(t, { idleMs: 10000, touchThrottleMs: 1000 });
  const a = q.enqueue({ holder: 'a', pid: 1 }).ticket;
  const b = q.enqueue({ holder: 'b', pid: 2 }).ticket;
  const ga = q.poll(a);
  q.release(ga.token);
  q.poll(a); // promotes b (unclaimed)
  const lease = JSON.parse(fs.readFileSync(file, 'utf8')).lease;
  assert.equal(lease.ticket, b);
  assert.equal(lease.claimedAt, null);
  clock.t += 10;
  assert.equal(q.touch(lease.token), true);
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).lease.claimedAt, clock.t);
});

test('touch with a wrong or stale token returns false', (t) => {
  const { q, clock, token } = granted(t);
  assert.equal(q.touch('nope'), false);
  clock.t += 20000; // idle past idleMs
  assert.equal(q.touch(token), false);
});

test('touch returns false for a dead holder even inside the throttle window', (t) => {
  const { q, dead, token } = granted(t);
  dead.add(1);
  assert.equal(q.touch(token), false);
});

test('waiting poll inside the poll throttle window does not rewrite state.json', (t) => {
  const { q, clock, file } = setup(t, { waiterTtlMs: 10000, pollThrottleMs: 1000, idleMs: 100000 });
  q.poll(q.enqueue({ holder: 'a', pid: 1 }).ticket);
  const b = q.enqueue({ holder: 'b', pid: 2 }).ticket;
  clock.t += 500;
  const before = fs.readFileSync(file, 'utf8');
  const sk = statKey(file);
  assert.deepEqual(q.poll(b), { status: 'waiting', position: 1, holderLabel: 'a' });
  assert.equal(fs.readFileSync(file, 'utf8'), before);
  assert.equal(statKey(file), sk);
});

test('waiting poll after the poll throttle window refreshes lastPolledAt', (t) => {
  const { q, clock, file } = setup(t, { waiterTtlMs: 10000, pollThrottleMs: 1000, idleMs: 100000 });
  q.poll(q.enqueue({ holder: 'a', pid: 1 }).ticket);
  const b = q.enqueue({ holder: 'b', pid: 2 }).ticket;
  clock.t += 1500;
  assert.equal(q.poll(b).status, 'waiting');
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).waiters[0].lastPolledAt, clock.t);
});

test('a waiter that stops polling is still dropped after waiterTtlMs with throttled polls', (t) => {
  const { q, clock } = setup(t, { waiterTtlMs: 10000, idleMs: 100000 });
  q.poll(q.enqueue({ holder: 'a', pid: 1 }).ticket);
  const b = q.enqueue({ holder: 'b', pid: 2 }).ticket;
  for (let i = 0; i < 8; i++) { clock.t += 1000; assert.equal(q.poll(b).status, 'waiting'); }
  clock.t += 10001;
  assert.equal(q.poll(b).status, 'unknown');
});

test('default pollThrottleMs is waiterTtlMs/10 and is clamped to waiterTtlMs/2', (t) => {
  const d = setup(t, { waiterTtlMs: 10000, idleMs: 100000 });
  d.q.poll(d.q.enqueue({ holder: 'a', pid: 1 }).ticket);
  const b = d.q.enqueue({ holder: 'b', pid: 2 }).ticket;
  const f = path.join(d.dir, 'state.json');
  d.clock.t += 900;
  const before = fs.readFileSync(f, 'utf8');
  d.q.poll(b);
  assert.equal(fs.readFileSync(f, 'utf8'), before); // inside 1000
  d.clock.t += 200; // 1100 since last stamp
  d.q.poll(b);
  assert.notEqual(fs.readFileSync(f, 'utf8'), before);

  const c = setup(t, { waiterTtlMs: 10000, pollThrottleMs: 999999, idleMs: 100000 });
  c.q.poll(c.q.enqueue({ holder: 'a', pid: 1 }).ticket);
  const w = c.q.enqueue({ holder: 'b', pid: 2 }).ticket;
  const f2 = path.join(c.dir, 'state.json');
  c.clock.t += 5100; // > ttl/2
  const b2 = fs.readFileSync(f2, 'utf8');
  c.q.poll(w);
  assert.notEqual(fs.readFileSync(f2, 'utf8'), b2);
});

test('a grant transition still writes immediately inside the throttle window', (t) => {
  const { q, clock, file } = setup(t, { waiterTtlMs: 10000, pollThrottleMs: 5000, idleMs: 100000 });
  const a = q.enqueue({ holder: 'a', pid: 1 }).ticket;
  const b = q.enqueue({ holder: 'b', pid: 2 }).ticket;
  const ga = q.poll(a);
  q.poll(b);
  q.release(ga.token);
  clock.t += 10;
  const r = q.poll(b);
  assert.equal(r.status, 'granted');
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).lease.claimedAt, clock.t);
});

// ---- validate: lock-free read failures fall back to the locked path ----
const eio = () => { throw Object.assign(new Error('io'), { code: 'EIO' }); };

// Changed from the old behaviour (a failed lock-free read made validate answer false): a valid lease is
// now confirmed through the locked path, a wrong token is still false.
test('validate answers from the locked path when the lock-free read keeps failing', (t) => {
  const { q, token } = granted(t, { readFile: eio });
  assert.equal(q.validate(token), true);
  assert.equal(q.validate('wrong'), false);
});

test('lock-free read gives up after 3 busy attempts', (t) => {
  let calls = 0;
  const busy = setup(t, {
    idleMs: 10000, touchThrottleMs: 1000,
    readFile: () => { calls++; throw Object.assign(new Error('busy'), { code: 'EBUSY' }); },
  });
  assert.equal(busy.q.validate('x'), false);
  assert.equal(calls, 3);
});

test('validate accepts a valid token on a healthy state', (t) => {
  const ctx = granted(t);
  assert.equal(ctx.q.validate(ctx.token), true);
});

test('validate on a missing state file is false and creates nothing', (t) => {
  const { q, file } = setup(t);
  assert.equal(q.validate('x'), false);
  assert.equal(fs.existsSync(file), false);
});

test('validate on a corrupt state file is false and the locked path quarantines it', (t) => {
  const { q, dir, file } = granted(t);
  fs.writeFileSync(file, '{bad');
  assert.equal(q.validate('x'), false);
  assert.equal(fs.readdirSync(dir).filter((f) => f.startsWith('state.json.corrupt-')).length, 1);
});

test('a confirmed token match or mismatch stays lock-free', (t) => {
  const { q, token, dir } = granted(t);
  const res = [];
  withLockSync(path.join(dir, 'state.lock'), () => {
    res.push(q.validate(token), q.validate('nope')); // would time out if it took the lock
  }, { timeoutMs: 100 });
  assert.deepEqual(res, [true, false]);
});

// ---- touch: lock-free read failures ----
test('touch falls through to the locked path when the lock-free read fails', (t) => {
  let fail = false;
  const ctx = setup(t, {
    idleMs: 10000, touchThrottleMs: 1000,
    readFile: (f, enc) => { if (fail) throw Object.assign(new Error('io'), { code: 'EIO' }); return fs.readFileSync(f, enc); },
  });
  const token = ctx.q.poll(ctx.q.enqueue({ holder: 'a', pid: 1 }).ticket).token;
  fail = true;
  const before = fs.readFileSync(ctx.file, 'utf8');
  ctx.clock.t += 500; // inside the throttle window
  assert.equal(ctx.q.touch(token), true); // locked path reads state itself, not via the lock-free seam
  assert.equal(fs.readFileSync(ctx.file, 'utf8'), before); // ...and still does not write inside the window
  ctx.clock.t += 1000; // now past the window
  assert.equal(ctx.q.touch(token), true);
  assert.equal(JSON.parse(fs.readFileSync(ctx.file, 'utf8')).lease.lastActivityAt, ctx.clock.t);
});

test('claiming a promoted lease by poll restarts its idle time', (t) => {
  const { q, clock, file } = setup(t, { idleMs: 10000, waiterTtlMs: 100000 });
  const a = q.enqueue({ holder: 'a', pid: 1 }).ticket;
  const b = q.enqueue({ holder: 'b', pid: 2 }).ticket;
  q.release(q.poll(a).token);
  clock.t += 3000;
  q.poll(a); // unknown ticket, promotes b at 4000
  clock.t += 2000;
  assert.equal(q.poll(b).status, 'granted');
  const l = JSON.parse(fs.readFileSync(file, 'utf8')).lease;
  assert.equal(l.claimedAt, clock.t);
  assert.equal(l.lastActivityAt, clock.t);
});

test('re-enqueue of an existing waiter inside the poll throttle window does not rewrite state.json', (t) => {
  const { q, clock, file } = setup(t, { waiterTtlMs: 10000, pollThrottleMs: 1000, idleMs: 100000 });
  q.poll(q.enqueue({ holder: 'a', pid: 1 }).ticket);
  const b = q.enqueue({ holder: 'b', pid: 2 }).ticket;
  clock.t += 500;
  const before = fs.readFileSync(file, 'utf8');
  const sk = statKey(file);
  assert.equal(q.enqueue({ holder: 'b', pid: 2 }).ticket, b);
  assert.equal(fs.readFileSync(file, 'utf8'), before);
  assert.equal(statKey(file), sk);
  clock.t += 1000; // past the window: refreshed
  q.enqueue({ holder: 'b', pid: 2 });
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).waiters[0].lastPolledAt, clock.t);
});

test('touchThrottleMs is clamped to half of idleMs', (t) => {
  const { q, clock, token, file } = granted(t, { idleMs: 1000, touchThrottleMs: 900 });
  clock.t += 600; // > idle/2 = 500 but < 900
  assert.equal(q.touch(token), true);
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).lease.lastActivityAt, clock.t);
});

// --- option validation ---
for (const opt of ['idleMs', 'waiterTtlMs', 'touchThrottleMs', 'pollThrottleMs', 'maxWaiters']) {
  for (const bad of ['5', NaN, Infinity, null, {}]) {
    test(`createQueue rejects non-number ${opt}=${String(bad)} with TypeError`, (t) => {
      const dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'pwq-opt-')), 'q');
      t.after(() => fs.rmSync(path.dirname(dir), { recursive: true, force: true }));
      assert.throws(() => createQueue({ dir, [opt]: bad }), (e) => e instanceof TypeError && e.message.includes(opt));
    });
  }
  test(`createQueue rejects negative ${opt} with RangeError`, (t) => {
    const dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'pwq-opt-')), 'q');
    t.after(() => fs.rmSync(path.dirname(dir), { recursive: true, force: true }));
    assert.throws(() => createQueue({ dir, [opt]: -1 }), (e) => e instanceof RangeError && e.message.includes(opt));
  });
}
test('createQueue rejects zero idleMs/waiterTtlMs/maxWaiters and fractional maxWaiters', (t) => {
  const dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'pwq-opt-')), 'q');
  t.after(() => fs.rmSync(path.dirname(dir), { recursive: true, force: true }));
  for (const o of [{ idleMs: 0 }, { waiterTtlMs: 0 }, { maxWaiters: 0 }, { maxWaiters: 1.5 }]) {
    assert.throws(() => createQueue({ dir, ...o }), RangeError);
  }
});
test('createQueue accepts zero throttles and undefined options', (t) => {
  const dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'pwq-opt-')), 'q');
  t.after(() => fs.rmSync(path.dirname(dir), { recursive: true, force: true }));
  assert.doesNotThrow(() => createQueue({ dir, touchThrottleMs: 0, pollThrottleMs: 0, idleMs: undefined, maxWaiters: undefined }));
});

test('pruneQuarantine tolerates an unreadable state dir', (t) => {
  const { dir, q } = setup(t);
  fs.writeFileSync(path.join(dir, 'state.json'), '{bad');
  t.mock.method(fs, 'readdirSync', () => { throw Object.assign(new Error('nope'), { code: 'EACCES' }); });
  assert.doesNotThrow(() => q.snapshot());
  t.mock.restoreAll();
  assert.equal(fs.readdirSync(dir).filter((f) => f.startsWith('state.json.corrupt-')).length, 1);
});

test('a failing rmSync during write cleanup does not mask the original error', (t) => {
  const { q } = setup(t);
  const orig = Object.assign(new Error('rename boom'), { code: 'EIO' });
  t.mock.method(fs, 'renameSync', () => { throw orig; });
  const rm = t.mock.method(fs, 'rmSync', () => { throw Object.assign(new Error('rm boom'), { code: 'EACCES' }); });
  try {
    assert.throws(() => q.enqueue({ holder: 'a', pid: 1 }), (e) => e === orig);
    assert.ok(rm.mock.callCount() > 0);
  } finally {
    t.mock.restoreAll(); // let the test's own cleanup hook use the real rmSync
  }
});

// ---- lows-fix-4: load-time hardening ----
const writeState = (file, s) => fs.writeFileSync(file, typeof s === 'string' ? s : JSON.stringify(s));
const mkLease = (o = {}) => ({ token: 'tok', ticket: 'tk', holder: 'h', pid: 1, grantedAt: 1000, lastActivityAt: 1000, claimedAt: 1000, ...o });
const mkWaiter = (o = {}) => ({ ticket: 'w1', pid: 2, holder: 'w', enqueuedAt: 1000, lastPolledAt: 1000, ...o });

test('holder label strips C1, line/para separators, bidi and zero-width chars', (t) => {
  const { q } = setup(t);
  const a = q.enqueue({ holder: 'a\u0085b c d‮e​f', pid: 1 }).ticket;
  q.poll(a);
  const b = q.enqueue({ holder: 'b', pid: 2 }).ticket;
  assert.equal(q.poll(b).holderLabel, 'a b c d e f');
  assert.equal(q.snapshot().lease.holder, 'a b c d e f');
});

test('holders in a hand-written state.json are cleaned and capped on load', (t) => {
  const { file, q } = setup(t);
  writeState(file, { lease: mkLease({ holder: 'x\u0085y‮z\n' + 'q'.repeat(500) }), waiters: [mkWaiter({ holder: 'w v' })] });
  const s = q.snapshot();
  assert.equal(s.lease.holder.length <= 200, true);
  assert.equal(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(s.lease.holder), false);
  assert.equal(s.lease.holder.startsWith('x y z q'), true);
  assert.equal(s.waiters[0].holder, 'w v');
});

test('state.json above 1 MiB is treated as corrupt and quarantined', (t) => {
  const { dir, file, q } = setup(t);
  writeState(file, JSON.stringify({ lease: null, waiters: [], pad: 'x'.repeat(1024 * 1024 + 10) }));
  assert.equal(q.validate('whatever'), false);
  assert.equal(fs.readdirSync(dir).some((n) => n.includes('.corrupt-')), true);
  assert.equal(fs.existsSync(file), false);
});

test('state with more waiters than maxWaiters keeps the oldest maxWaiters', (t) => {
  const { file, q } = setup(t, { maxWaiters: 2 });
  writeState(file, { lease: mkLease(), waiters: [1, 2, 3, 4].map((i) => mkWaiter({ ticket: `w${i}`, pid: 10 + i, holder: `h${i}` })) });
  assert.deepEqual(q.snapshot().waiters.map((w) => w.holder), ['h1', 'h2']);
});

test('lease timestamps far in the future are clamped so the lease still idles out', (t) => {
  const { file, clock, q } = setup(t);
  writeState(file, { lease: mkLease({ lastActivityAt: 1e15, grantedAt: 1e15 }), waiters: [mkWaiter({ lastPolledAt: 1e15, enqueuedAt: 1e15 })] });
  assert.equal(q.validate('tok'), true);
  clock.t = 5000;
  assert.equal(q.validate('tok'), false);
});

test('an injected randomId with path separators cannot escape dir via the quarantine name', (t) => {
  const { dir, file } = setup(t);
  const evil = createQueue({ dir, now: () => 1000, isAlive: () => true, randomId: () => '../../evil', idleMs: 1000 });
  writeState(file, '{not json');
  evil.snapshot();
  assert.equal(fs.readdirSync(path.dirname(dir)).sort().join(), 'q');
  assert.equal(fs.readdirSync(dir).some((n) => n.includes('.corrupt-')), true);
});
