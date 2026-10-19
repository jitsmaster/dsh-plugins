/**
 * Tests for keep-awake.js: keeps the computer awake for as long as the DSH server runs (settings keepAwake / keepDisplayOn).
 * No real process is spawned: spawn, timers, clock and platform are fakes.
 *
 * Plan:
 *  KA1  win32: one hidden powershell helper with the fixed script and the numeric parent pid
 *  KA2  win32: keepDisplayOn adds -DisplayOn
 *  KA3  darwin: caffeinate -i -w <pid>
 *  KA4  linux: systemd-inhibit ... sleep infinity
 *  KA5  keepAwake off: nothing is spawned
 *  KA6  start() is idempotent
 *  KA7  setting toggle starts / stops the helper; keepDisplayOn change restarts it with the new args
 *  KA8  a helper that exits is restarted, at most 3 times, then given up (logged)
 *  KA9  a helper that lived 60 s or more resets the restart budget
 *  KA10 stop() kills the helper, clears the pending restart and ignores the old helper's exit
 *  KA11 a throwing spawn / an 'error' event (ENOENT) is swallowed and logged once, no retry
 *  KA12 unsupported platform: no spawn, logged once
 *  KA13 status() reports { active, platform, pid? }
 *  KA14 start/stop are logged (no secrets); the helper is unref'ed
 *  KA15 settings defaults: keepAwake true, keepDisplayOn false, booleans only
 *  KA16 scripts/keep-awake.ps1: SetThreadExecutionState with the right constants, 30 s re-assert, parent-exit check
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createKeepAwake } from '../keep-awake.js'
import { createSettings } from '../settings.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const SCRIPT = 'C:\\plugin\\scripts\\keep-awake.ps1'

function fakeChild(pid) {
  const c = new EventEmitter()
  c.pid = pid
  c.killed = false
  c.unrefCalled = false
  c.kill = () => { c.killed = true; return true }
  c.unref = () => { c.unrefCalled = true }
  return c
}

function harness({ platform = 'win32', defaults = {}, spawnThrows, now = 0 } = {}) {
  const spawns = []
  const children = []
  const logs = []
  const timers = []
  let clock = now
  const settings = createSettings(mkdtempSync(join(tmpdir(), 'ka-')), defaults)
  const spawn = (cmd, args, opts) => {
    if (spawnThrows) throw spawnThrows
    const child = fakeChild(9000 + children.length)
    spawns.push({ cmd, args, opts })
    children.push(child)
    return child
  }
  const setTimer = (fn, ms) => { const h = { fn, ms, cleared: false, ran: false, unref() {} }; timers.push(h); return h }
  const clearTimer = (h) => { if (h) h.cleared = true }
  const runDue = () => { for (const h of timers) if (!h.cleared && !h.ran) { h.ran = true; h.fn() } }
  const pendingTimers = () => timers.filter((h) => !h.cleared && !h.ran)
  const ka = createKeepAwake({ platform, spawn, settings, log: (line) => logs.push(line), pid: 7777, script: SCRIPT, powershell: 'powershell.exe', setTimer, clearTimer, now: () => clock })
  return { ka, spawns, children, logs, settings, runDue, pendingTimers, advance: (ms) => { clock += ms } }
}

test('KA1 win32: one hidden powershell helper with the fixed script and the numeric parent pid', () => {
  const h = harness()
  h.ka.start()
  assert.equal(h.spawns.length, 1)
  assert.equal(h.spawns[0].cmd, 'powershell.exe')
  assert.deepEqual(h.spawns[0].args, ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-ExecutionPolicy', 'Bypass', '-File', SCRIPT, '-ParentPid', '7777'])
  assert.equal(h.spawns[0].opts.windowsHide, true)
  assert.deepEqual(h.spawns[0].opts.stdio, ['ignore', 'ignore', 'ignore'])
})

test('KA2 win32: keepDisplayOn adds -DisplayOn', () => {
  const h = harness({ defaults: { keepDisplayOn: true } })
  h.ka.start()
  assert.deepEqual(h.spawns[0].args.slice(-3), ['-ParentPid', '7777', '-DisplayOn'])
})

test('KA3 darwin: caffeinate -i -w <pid>', () => {
  const h = harness({ platform: 'darwin' })
  h.ka.start()
  assert.equal(h.spawns.length, 1)
  assert.equal(h.spawns[0].cmd, 'caffeinate')
  assert.deepEqual(h.spawns[0].args, ['-i', '-w', '7777'])
})

test('KA4 linux: systemd-inhibit holding a sleep inhibitor', () => {
  const h = harness({ platform: 'linux' })
  h.ka.start()
  assert.equal(h.spawns.length, 1)
  assert.equal(h.spawns[0].cmd, 'systemd-inhibit')
  assert.deepEqual(h.spawns[0].args, ['--what=sleep', '--who=DSH', '--why=DSH is running', 'sleep', 'infinity'])
})

test('KA5 keepAwake off: nothing is spawned', () => {
  const h = harness({ defaults: { keepAwake: false } })
  h.ka.start()
  assert.equal(h.spawns.length, 0)
  assert.equal(h.ka.status().active, false)
})

test('KA6 start() twice spawns once', () => {
  const h = harness()
  h.ka.start()
  h.ka.start()
  assert.equal(h.spawns.length, 1)
})

test('KA7 the setting toggle starts and stops the helper; a keepDisplayOn change restarts it', () => {
  const h = harness()
  h.ka.start()
  assert.equal(h.spawns.length, 1)
  h.settings.set({ keepAwake: false })
  assert.equal(h.children[0].killed, true, 'switched off: the helper is killed')
  assert.equal(h.ka.status().active, false)
  h.settings.set({ keepAwake: true })
  assert.equal(h.spawns.length, 2, 'switched on: a new helper')
  assert.equal(h.ka.status().active, true)
  h.settings.set({ keepDisplayOn: true })
  assert.equal(h.children[1].killed, true, 'keepDisplayOn changed: the old helper is replaced')
  assert.equal(h.spawns.length, 3)
  assert.equal(h.spawns[2].args.at(-1), '-DisplayOn')
  h.children[1].emit('exit', 1, null) // the replaced helper's exit must not cause a restart
  h.runDue()
  assert.equal(h.spawns.length, 3)
})

test('KA7b an unrelated setting change does nothing', () => {
  const h = harness()
  h.ka.start()
  h.settings.set({ ttsEnabled: false })
  assert.equal(h.spawns.length, 1)
  assert.equal(h.children[0].killed, false)
})

test('KA8 a helper that exits is restarted, at most 3 times, then given up and logged', () => {
  const h = harness()
  h.ka.start()
  for (let i = 1; i <= 3; i++) {
    h.children[i - 1].emit('exit', 1, null)
    assert.equal(h.ka.status().active, false, 'between exit and restart: not active')
    assert.equal(h.pendingTimers().length, 1, 'a restart is scheduled (delayed, not a tight loop)')
    h.runDue()
    assert.equal(h.spawns.length, i + 1)
    assert.equal(h.ka.status().active, true)
  }
  h.children[3].emit('exit', 1, null)
  assert.equal(h.pendingTimers().length, 0, 'no fourth restart')
  assert.equal(h.spawns.length, 4)
  assert.equal(h.ka.status().active, false)
  assert.equal(h.logs.filter((l) => /giv(e|ing) up/i.test(l)).length, 1)
})

test('KA9 a helper that lived 60 s or more gets a fresh restart budget', () => {
  const h = harness()
  h.ka.start()
  for (let i = 0; i < 5; i++) {
    h.advance(60_000)
    h.children[i].emit('exit', 1, null)
    h.runDue()
  }
  assert.equal(h.spawns.length, 6, 'five long-lived helpers in a row were each restarted')
})

test('KA10 stop() kills the helper, clears a pending restart and ignores the old helper\'s exit', () => {
  const h = harness()
  h.ka.start()
  h.ka.stop()
  assert.equal(h.children[0].killed, true)
  assert.equal(h.ka.status().active, false)
  h.children[0].emit('exit', null, 'SIGTERM')
  h.runDue()
  assert.equal(h.spawns.length, 1, 'no restart after stop')
  // a restart waiting when stop() arrives is cancelled
  const g = harness()
  g.ka.start()
  g.children[0].emit('exit', 1, null)
  assert.equal(g.pendingTimers().length, 1)
  g.ka.stop()
  assert.equal(g.pendingTimers().length, 0)
  g.runDue()
  assert.equal(g.spawns.length, 1)
})

test('KA10b after stop() a setting change no longer starts the helper', () => {
  const h = harness()
  h.ka.start()
  h.ka.stop()
  h.settings.set({ keepAwake: false })
  h.settings.set({ keepAwake: true })
  assert.equal(h.spawns.length, 1)
})

test('KA11 a throwing spawn is swallowed and logged once, without retries', () => {
  const h = harness({ spawnThrows: new Error('boom') })
  assert.doesNotThrow(() => h.ka.start())
  assert.doesNotThrow(() => h.ka.start())
  assert.equal(h.ka.status().active, false)
  assert.equal(h.pendingTimers().length, 0)
  assert.equal(h.logs.filter((l) => /boom/.test(l)).length, 1)
})

test('KA11b an error event (command not found) is swallowed and logged once, without retries', () => {
  const h = harness({ platform: 'linux' })
  h.ka.start()
  const err = Object.assign(new Error('spawn systemd-inhibit ENOENT'), { code: 'ENOENT' })
  assert.doesNotThrow(() => h.children[0].emit('error', err))
  h.children[0].emit('exit', null, null) // node may emit exit as well
  assert.equal(h.pendingTimers().length, 0)
  assert.equal(h.spawns.length, 1)
  assert.equal(h.ka.status().active, false)
  assert.equal(h.logs.filter((l) => /ENOENT/.test(l)).length, 1)
})

test('KA12 an unsupported platform spawns nothing and is logged once', () => {
  const h = harness({ platform: 'freebsd' })
  h.ka.start()
  h.ka.start()
  assert.equal(h.spawns.length, 0)
  assert.equal(h.ka.status().active, false)
  assert.equal(h.logs.filter((l) => /freebsd/.test(l)).length, 1)
})

test('KA13 status() reports active, platform and the helper pid', () => {
  const h = harness()
  assert.deepEqual(h.ka.status(), { active: false, platform: 'win32' })
  h.ka.start()
  assert.deepEqual(h.ka.status(), { active: true, platform: 'win32', pid: 9000 })
  h.ka.stop()
  assert.deepEqual(h.ka.status(), { active: false, platform: 'win32' })
})

test('KA14 start and stop are logged, and the helper never keeps DSH alive (unref)', () => {
  const h = harness()
  h.ka.start()
  assert.equal(h.children[0].unrefCalled, true)
  assert.equal(h.logs.some((l) => /keep-awake: .*start/i.test(l)), true)
  h.ka.stop()
  assert.equal(h.logs.some((l) => /keep-awake: .*stop/i.test(l)), true)
})

test('KA15 settings: keepAwake defaults on, keepDisplayOn off, config defaults apply, booleans only', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ka-set-'))
  const s = createSettings(dir, {})
  assert.equal(s.get().keepAwake, true)
  assert.equal(s.get().keepDisplayOn, false)
  assert.equal(createSettings(mkdtempSync(join(tmpdir(), 'ka-set-')), { keepAwake: false, keepDisplayOn: true }).get().keepAwake, false)
  assert.equal(s.set({ keepAwake: false }).keepAwake, false)
  assert.throws(() => s.set({ keepAwake: 'no' }), /keepAwake must be true or false/)
  assert.throws(() => s.set({ keepDisplayOn: 1 }), /keepDisplayOn must be true or false/)
})

test('KA16 the Windows helper script: SetThreadExecutionState, its constants, re-assert every 30 s, exits with the parent', () => {
  const text = readFileSync(join(HERE, '..', 'scripts', 'keep-awake.ps1'), 'utf8')
  assert.match(text, /SetThreadExecutionState/)
  assert.match(text, /kernel32\.dll/)
  assert.match(text, /ES_CONTINUOUS\s*=\s*0x80000000/)
  assert.match(text, /ES_SYSTEM_REQUIRED\s*=\s*0x00000001/)
  assert.match(text, /ES_DISPLAY_REQUIRED\s*=\s*0x00000002/)
  assert.match(text, /\$ParentPid/)
  assert.match(text, /GetProcessById/, 'checks that the parent is still alive')
  assert.match(text, /Start-Sleep\s+-Seconds\s+30/)
  assert.match(text, /-DisplayOn|\$DisplayOn/)
})
