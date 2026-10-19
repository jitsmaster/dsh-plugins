/**
 * Tests for the settings change notification: pr.js uses it so that pollPrComments true -> false deletes every PR
 * poll task and false -> true restores them.
 *
 * Contract: settings.subscribe(listener, onError?) -> unsubscribe(). After every set() that changes a value the
 * listener is called with (next, previous) = the full settings objects after / before the change. A throwing listener is
 * reported to its own onError, else to the one given to createSettings(stateDir, defaults, onError), and never breaks set().
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createSettings } from '../settings.js'

const fresh = () => createSettings(mkdtempSync(join(tmpdir(), 'set-')), {})
const tick = () => new Promise((resolve) => setImmediate(resolve))

test('settings exposes subscribe()', () => {
  assert.equal(typeof fresh().subscribe, 'function')
})

test('a subscriber hears pollPrComments true -> false with the new and the previous settings', async () => {
  const s = fresh()
  const seen = []
  s.subscribe((next, prev) => seen.push([next.pollPrComments, prev.pollPrComments]))
  s.set({ pollPrComments: false })
  await tick()
  assert.deepEqual(seen, [[false, true]])
})

test('a subscriber hears false -> true as well', async () => {
  const s = fresh()
  s.set({ pollPrComments: false })
  const seen = []
  s.subscribe((next, prev) => seen.push([next.pollPrComments, prev.pollPrComments]))
  s.set({ pollPrComments: true })
  await tick()
  assert.deepEqual(seen, [[true, false]])
})

test('the unsubscribe function stops notifications', async () => {
  const s = fresh()
  let calls = 0
  const off = s.subscribe(() => { calls++ })
  s.set({ ttsEnabled: false })
  await tick()
  assert.equal(calls, 1)
  off()
  s.set({ ttsEnabled: true })
  await tick()
  assert.equal(calls, 1)
})

test('a throwing subscriber does not break set() or the other subscribers', async () => {
  const s = fresh()
  let heard = 0
  s.subscribe(() => { throw new Error('listener bug') })
  s.subscribe(() => { heard++ })
  const saved = s.set({ pollPrComments: false })
  await tick()
  assert.equal(saved.pollPrComments, false)
  assert.equal(heard, 1)
})

test('a throwing subscriber is reported to the onError given to createSettings', async () => {
  const errors = []
  const s = createSettings(mkdtempSync(join(tmpdir(), 'set-')), {}, (error) => errors.push(error.message))
  s.subscribe(() => { throw new Error('listener bug') })
  s.set({ pollPrComments: false })
  await tick()
  assert.deepEqual(errors, ['listener bug'])
})

test('a subscriber\'s own onError wins over the default one', async () => {
  const defaults = []
  const own = []
  const s = createSettings(mkdtempSync(join(tmpdir(), 'set-')), {}, (error) => defaults.push(error.message))
  s.subscribe(() => { throw new Error('mine') }, (error) => own.push(error.message))
  s.set({ pollPrComments: false })
  await tick()
  assert.deepEqual(own, ['mine'])
  assert.deepEqual(defaults, [])
})

test('an onError that itself throws still never breaks set() or the other subscribers', async () => {
  const s = createSettings(mkdtempSync(join(tmpdir(), 'set-')), {}, () => { throw new Error('sink bug') })
  let heard = 0
  s.subscribe(() => { throw new Error('listener bug') })
  s.subscribe(() => { heard++ })
  assert.equal(s.set({ pollPrComments: false }).pollPrComments, false)
  assert.equal(heard, 1)
})
