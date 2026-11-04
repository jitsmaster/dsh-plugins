// RED: ai-report-notify.js, the default chat channel: createRcNotify({ spawn, script, powershell, envFile, log, exists, timeoutMs }) -> async (text) => void.
// scripts/rc-notify.ps1 is run through spawn with an ARGUMENT ARRAY; the message travels on stdin as JSON; nothing is executed for real in these tests.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { createRcNotify } from '../ai-report-notify.js'

function fakeSpawn({ code = 0, stderr = '', never = false } = {}) {
  const runs = []
  const spawn = (exe, args, opts) => {
    const child = new EventEmitter()
    const written = []
    child.stdin = Object.assign(new EventEmitter(), { write: (s) => { written.push(String(s)); return true }, end: (s) => { if (s) written.push(String(s)) } })
    child.stdout = new EventEmitter(); child.stderr = new EventEmitter()
    child.kill = () => { child.killed = true }
    runs.push({ exe, args, opts, child, written })
    if (!never) setImmediate(() => { if (stderr) child.stderr.emit('data', Buffer.from(stderr)); child.emit('close', code, null) })
    return child
  }
  return { spawn, runs }
}
const mk = (over = {}, f = fakeSpawn(over.spawnOpts)) => {
  const logs = []
  const notify = createRcNotify({ spawn: f.spawn, script: 'C:/rq/scripts/rc-notify.ps1', powershell: 'ps.exe', envFile: 'C:/home/.claude/skills/ado-monitor/.env', exists: () => true, log: (m) => logs.push(String(m)), ...over.deps })
  return { notify, logs, f }
}

test('runs powershell with an argument array (no shell), the script and the env file path, hidden window and a timeout', async () => {
  const { notify, f } = mk()
  await notify('AI handled 2 in the last hour: 2 done cards.')
  const run = f.runs[0]
  assert.equal(run.exe, 'ps.exe')
  assert.ok(Array.isArray(run.args))
  assert.deepEqual(run.args.slice(0, 5), ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File'])
  assert.ok(run.args.includes('C:/rq/scripts/rc-notify.ps1'))
  assert.ok(run.args.includes('C:/home/.claude/skills/ado-monitor/.env'))
  assert.notEqual(run.opts.shell, true)
  assert.equal(run.opts.windowsHide, true)
  assert.equal(run.opts.timeout, 20_000)
})

test('the message goes through stdin as JSON, never into the arguments', async () => {
  const { notify, f } = mk()
  const text = 'AI handled 2 "quoted" $(calc) `x` ; é — done.'
  await notify(text)
  assert.ok(!f.runs[0].args.some((a) => String(a).includes('calc') || String(a).includes('AI handled')))
  assert.deepEqual(JSON.parse(f.runs[0].written.join('')), { text })
})

test('a missing env file skips the channel with one log line and spawns nothing', async () => {
  const { notify, logs, f } = mk({ deps: { exists: () => false } })
  await notify('hello')
  assert.equal(f.runs.length, 0)
  assert.equal(logs.length, 1)
  assert.match(logs[0], /env file|credentials|skipp/i)
})

test('a non-zero exit is logged (with the script\'s one-line message) and does not throw', async () => {
  const { notify, logs } = mk({ spawnOpts: { code: 1, stderr: 'rc-notify: token request failed (HTTP 401)' } })
  await assert.doesNotReject(() => notify('hello'))
  assert.ok(logs.some((l) => /401/.test(l)))
})

test('a secret-looking value on stderr never reaches the log', async () => {
  const { notify, logs } = mk({ spawnOpts: { code: 1, stderr: 'failed RC_JWT=eyJhbGciOiJSUzI1NiJ9abcdefghijklmnop' } })
  await notify('hello')
  assert.ok(!logs.join('\n').includes('eyJhbGciOiJSUzI1NiJ9abcdefghijklmnop'))
})

test('a spawn that throws is logged, not thrown', async () => {
  const { notify, logs } = mk({ deps: { spawn: () => { throw new Error('ENOENT') } } })
  await assert.doesNotReject(() => notify('hello'))
  assert.ok(logs.length >= 1)
})

test('a child that never exits is killed after the timeout and the call still resolves', async () => {
  const { notify, f, logs } = mk({ spawnOpts: { never: true }, deps: { timeoutMs: 20 } })
  await notify('hello')
  assert.equal(f.runs[0].child.killed, true)
  assert.ok(logs.some((l) => /timed out|timeout/i.test(l)))
})

test('the default env file is under ~/.claude/skills/ado-monitor/.env', async () => {
  const seen = []
  const f = fakeSpawn()
  const notify = createRcNotify({ spawn: f.spawn, script: 's.ps1', powershell: 'ps.exe', exists: (p) => { seen.push(String(p)); return true }, log: () => {} })
  await notify('x')
  assert.match(seen[0].replace(/\\/g, '/'), /\.claude\/skills\/ado-monitor\/\.env$/)
})


test('the failure is logged on close, after stderr was drained (an exit-only child is not enough)', async () => {
  const logs = []
  const child = new EventEmitter()
  child.stdin = Object.assign(new EventEmitter(), { end() {} }); child.stderr = new EventEmitter(); child.kill = () => {}
  const notify = createRcNotify({ spawn: () => child, script: 's.ps1', powershell: 'ps.exe', exists: () => true, log: (m) => logs.push(String(m)) })
  const p = notify('x')
  child.emit('exit', 1, null) // exit fires before stderr is drained: must not settle the call
  child.stderr.emit('data', Buffer.from('rc-notify: HTTP 403 late'))
  child.emit('close', 1, null)
  await p
  assert.equal(logs.length, 1)
  assert.match(logs[0], /403 late/)
})

test('the missing env file is logged once per process, not at every notify', async () => {
  const { notify, logs, f } = mk({ deps: { exists: () => false } })
  await notify('a'); await notify('b')
  assert.equal(f.runs.length, 0)
  assert.equal(logs.length, 1)
})
