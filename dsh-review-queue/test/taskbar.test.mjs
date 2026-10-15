import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { createTaskbarBadge } from '../taskbar.js'

function fakeSpawn(codes = []) {
  const runs = []
  const spawn = (exe, args, opts) => {
    const child = new EventEmitter()
    child.stderr = new EventEmitter()
    runs.push({ exe, args, opts })
    const code = codes.length ? codes.shift() : 0
    setImmediate(() => child.emit('exit', code))
    return child
  }
  return { spawn, runs }
}
function fakeQueue(total = 0) {
  const listeners = new Set()
  return {
    total,
    count() { return { total: this.total } },
    onChange(l) { listeners.add(l); return () => listeners.delete(l) },
    set(n) { this.total = n; for (const l of [...listeners]) l() },
    listeners,
  }
}
/** Timers that fire only when told to. */
function fakeTimers() {
  const pending = []
  return { setTimer: (fn, ms) => { const t = { fn, ms }; pending.push(t); return t }, clearTimer: (t) => { const i = pending.indexOf(t); if (i >= 0) pending.splice(i, 1) }, pending,
    async fire() { const t = pending.shift(); t?.fn(); await new Promise((r) => setImmediate(r)); await new Promise((r) => setImmediate(r)) } }
}
const make = (over = {}) => {
  const f = fakeSpawn(over.codes)
  const q = over.queue ?? fakeQueue(over.total ?? 0)
  const t = fakeTimers()
  const badge = createTaskbarBadge({ queue: q, spawn: f.spawn, script: 'C:/rq/taskbar-badge.ps1', powershell: 'ps.exe', pid: 4242, platform: 'win32', exists: () => true, setTimer: t.setTimer, clearTimer: t.clearTimer, ...over.deps })
  return { ...f, q, t, badge }
}
const countOf = (run) => Number(run.args[run.args.indexOf('-Count') + 1])

test('sets the badge to the current count at start, naming the pid the window is looked up from', async () => {
  const { runs, t } = make({ total: 3 })
  await t.fire()
  assert.equal(runs.length, 1)
  assert.equal(runs[0].exe, 'ps.exe')
  assert.ok(runs[0].args.includes('-File') && runs[0].args.includes('C:/rq/taskbar-badge.ps1'))
  assert.equal(runs[0].args[runs[0].args.indexOf('-StartPid') + 1], '4242')
  assert.equal(countOf(runs[0]), 3)
  assert.equal(runs[0].opts.windowsHide, true)
})

test('a burst of changes is one run with the last count; an unchanged count is not sent again', async () => {
  const { runs, t, q } = make({ total: 0 })
  await t.fire() // start: 0 is applied
  q.set(1); q.set(2); q.set(5)
  assert.equal(t.pending.length, 1, 'debounced to one timer')
  await t.fire()
  assert.deepEqual(runs.map(countOf), [0, 5])
  q.set(5)
  await t.fire()
  assert.equal(runs.length, 2, 'same count: nothing sent')
  q.set(0)
  await t.fire()
  assert.deepEqual(runs.map(countOf), [0, 5, 0])
})

test('only a changed count while a run is in flight is applied after it', async () => {
  const f = fakeSpawn()
  const q = fakeQueue(1)
  const t = fakeTimers()
  const badge = createTaskbarBadge({ queue: q, spawn: f.spawn, script: 's.ps1', powershell: 'ps.exe', platform: 'win32', exists: () => true, setTimer: t.setTimer, clearTimer: t.clearTimer })
  const first = t.fire()
  q.set(4); // arrives while the first run is still going
  await first
  await t.fire()
  assert.deepEqual(f.runs.map(countOf), [1, 4])
  await badge.dispose()
})

test('no window above the process: retried a limited number of times, then quiet until the next change', async () => {
  const logs = []
  const { runs, t, q } = make({ total: 2, codes: [3, 3, 3, 3, 3, 3, 3, 3], deps: { maxRetries: 2, log: (l) => logs.push(l) } })
  await t.fire(); await t.fire(); await t.fire()
  assert.equal(runs.length, 3, 'start + 2 retries')
  assert.equal(t.pending.length, 0, 'no further retry')
  assert.equal(logs.filter((l) => /no app window/.test(l)).length, 1, 'logged once')
  q.set(3)
  await t.fire()
  assert.equal(runs.length, 4, 'a change tries again')
})

test('a failing PowerShell is logged and retried, never thrown', async () => {
  const logs = []
  const f = fakeSpawn([4])
  const spawn = (...a) => { const c = f.spawn(...a); setImmediate(() => c.stderr.emit('data', 'SetOverlayIcon failed')); return c }
  const t = fakeTimers()
  createTaskbarBadge({ queue: fakeQueue(1), spawn, script: 's.ps1', powershell: 'ps.exe', platform: 'win32', exists: () => true, setTimer: t.setTimer, clearTimer: t.clearTimer, log: (l) => logs.push(l) })
  await t.fire()
  assert.equal(t.pending.length, 1)
})

test('a spawn that throws is contained', async () => {
  const t = fakeTimers()
  createTaskbarBadge({ queue: fakeQueue(1), spawn: () => { throw new Error('boom') }, script: 's.ps1', powershell: 'ps.exe', platform: 'win32', exists: () => true, setTimer: t.setTimer, clearTimer: t.clearTimer })
  await t.fire()
})

test('dispose removes the badge, unsubscribes and cancels the timer', async () => {
  const { runs, t, q, badge } = make({ total: 2 })
  await t.fire()
  q.set(7)
  await badge.dispose()
  assert.equal(q.listeners.size, 0)
  assert.equal(t.pending.length, 0)
  assert.equal(countOf(runs.at(-1)), 0)
  await badge.dispose() // twice is fine
})

test('dispose leaves a never-applied taskbar alone', async () => {
  const { runs, badge } = make({ total: 2 })
  await badge.dispose()
  assert.equal(runs.length, 0)
})

test('not Windows, or no script: disabled and silent', () => {
  const f = fakeSpawn()
  const q = fakeQueue(1)
  const linux = createTaskbarBadge({ queue: q, spawn: f.spawn, script: 's', powershell: 'p', platform: 'linux' })
  assert.equal(linux.enabled, false)
  const logs = []
  const missing = createTaskbarBadge({ queue: q, spawn: f.spawn, script: 's', powershell: 'p', platform: 'win32', exists: () => false, log: (l) => logs.push(l) })
  assert.equal(missing.enabled, false)
  assert.equal(q.listeners.size, 0)
  assert.equal(f.runs.length, 0)
})

test('refresh re-sends the same count', async () => {
  const { runs, t, badge } = make({ total: 2 })
  await t.fire()
  badge.refresh()
  await t.fire()
  assert.deepEqual(runs.map(countOf), [2, 2])
})

test('a throwing queue.count is treated as nothing waiting', async () => {
  const q = fakeQueue(1); q.count = () => { throw new Error('x') }
  const { runs, t } = make({ queue: q })
  await t.fire()
  assert.deepEqual(runs.map(countOf), [0])
})
