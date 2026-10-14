import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import assert from 'node:assert/strict'
import test from 'node:test'
import { apply } from '../index.js'

// A permissive stand-in for the cordis context; named services can be made to throw like an un-injected service.
function fakeCtx(throwing = [], overrides = {}) {
  const mk = (path) => new Proxy(function () {}, {
    get(_t, k) {
      if (typeof k === 'symbol' || k === 'then') return undefined
      if (path === 'ctx' && k in overrides) return overrides[k]
      if (path === 'ctx' && throwing.includes(k)) throw new Error('service ' + String(k) + ' is not injected')
      return mk(path + '.' + String(k))
    },
    apply() { return mk(path + '()') },
  })
  return mk('ctx')
}

test('apply() survives a ctx.llm that throws when read (service not injected)', () => {
  assert.doesNotThrow(() => apply(fakeCtx(['llm']), {}))
})

test('shutdown awaits the voice log flush: the stop-voice effect cleanup returns a promise', async () => {
  const effects = []
  const ctx = fakeCtx([], { effect: (setup, label) => { effects.push({ setup, label }) } })
  apply(ctx, { stateDir: mkdtempSync(join(tmpdir(), 'apply-')) })
  const stop = effects.find((e) => e.label === 'hooks-tts: stop voice control')
  assert.ok(stop, 'the stop-voice effect is registered')
  const cleanup = stop.setup()
  const result = cleanup()
  assert.equal(typeof result?.then, 'function', 'the cleanup returns the flush promise so shutdown awaits it')
  await result
})
