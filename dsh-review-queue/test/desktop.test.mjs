import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createDesktop } from '../desktop.js'

function fakeSpawn(codes = []) {
  const runs = []
  const spawn = (exe, args, opts) => {
    const child = new EventEmitter()
    child.unref = () => { child.unrefd = true }
    runs.push({ exe, args, opts, child })
    const code = codes.length ? codes.shift() : 0
    setImmediate(() => child.emit('exit', code))
    return child
  }
  return { spawn, runs }
}
const timers = () => { const pending = []; return { pending, setTimer: (fn, ms) => { const t = { fn, ms, unref() {} }; pending.push(t); return t } } }
const make = (over = {}) => {
  const f = fakeSpawn(over.codes)
  const t = timers()
  const desktop = createDesktop({ spawn: f.spawn, script: 'C:/rq/desktop-quit.ps1', powershell: 'ps.exe', pid: 4242, platform: 'win32', exists: () => true, setTimer: t.setTimer, ...over.deps })
  return { ...f, t, desktop }
}

test('canQuit asks the script in find mode for this process pid: exit 0 is yes, exit 3 is no', async () => {
  const yes = make({ codes: [0] })
  assert.equal(await yes.desktop.canQuit(), true)
  assert.deepEqual(yes.runs[0].args.slice(-4), ['-StartPid', '4242', '-Mode', 'find'])
  assert.equal(await make({ codes: [3] }).desktop.canQuit(), false)
})

test('canQuit is false off Windows, without the script, and when the script cannot start', async () => {
  const off = make({ deps: { platform: 'linux' } })
  assert.equal(await off.desktop.canQuit(), false)
  assert.equal(off.runs.length, 0)
  assert.equal(await make({ deps: { exists: () => false } }).desktop.canQuit(), false)
  assert.equal(await make({ deps: { spawn: () => { throw new Error('EPERM') } } }).desktop.canQuit(), false)
})

test('quitSoon starts the kill script detached after the delay, once', () => {
  const { desktop, runs, t } = make({ deps: { delayMs: 800 } })
  assert.equal(desktop.quitSoon(), true)
  assert.equal(runs.length, 0, 'not yet: the HTTP answer goes out first')
  assert.equal(t.pending[0].ms, 800)
  t.pending[0].fn()
  assert.equal(runs.length, 1)
  assert.deepEqual(runs[0].args.slice(-4), ['-StartPid', '4242', '-Mode', 'kill'])
  assert.equal(runs[0].opts.detached, true)
  assert.equal(runs[0].opts.stdio, 'ignore')
  assert.equal(runs[0].child.unrefd, true)
  assert.equal(desktop.quitSoon(), false, 'a second request does not start a second kill')
})

test('quitSoon does nothing where the script cannot work', () => {
  const off = make({ deps: { platform: 'darwin' } })
  assert.equal(off.desktop.quitSoon(), false)
  assert.equal(off.t.pending.length, 0)
})

test('the script is pure ASCII (PowerShell 5.1 misreads BOM-less UTF-8) and has the three modes', () => {
  const ps = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'desktop-quit.ps1'), 'utf8')
  assert.ok(!/[^\x00-\x7f]/.test(ps), 'ASCII only')
  assert.match(ps, /'find', 'plan', 'kill'/)
  assert.match(ps, /--type=/)
})
