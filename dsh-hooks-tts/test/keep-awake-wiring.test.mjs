/** The plugin lifecycle runs keep-awake: one effect that starts it when the plugin starts and stops it on dispose. */
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import assert from 'node:assert/strict'
import test from 'node:test'
import { apply } from '../index.js'

// A permissive stand-in for the cordis context (same idea as apply-resilience.test.mjs); effects are captured, not run.
function fakeCtx(effects) {
  const mk = (path) => new Proxy(function () {}, {
    get(_t, k) {
      if (typeof k === 'symbol' || k === 'then') return undefined
      if (path === 'ctx' && k === 'effect') return (setup, label) => { effects.push({ setup, label }) }
      return mk(path + '.' + String(k))
    },
    apply() { return mk(path + '()') },
  })
  return mk('ctx')
}

test('KW1 apply() registers a keep-awake effect whose setup returns a cleanup (keepAwake off: nothing is spawned)', async () => {
  const effects = []
  apply(fakeCtx(effects), { stateDir: mkdtempSync(join(tmpdir(), 'ka-wire-')), keepAwake: false })
  const effect = effects.find((e) => e.label === 'hooks-tts: keep awake')
  assert.ok(effect, 'the keep-awake effect is registered')
  const cleanup = effect.setup()
  assert.equal(typeof cleanup, 'function')
  assert.doesNotThrow(() => cleanup())
})
