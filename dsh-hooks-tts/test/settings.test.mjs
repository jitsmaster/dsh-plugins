// Spec: docs/voice-two-stage-flow.md §0 D8, §2 "Changed – settings.js", §7 ST1.
// Shape chosen: 'voiceConfirm' is dropped from the validate list and the defaults, so an unknown key in an old settings.json
// is ignored (the rest of the file still applies) and get() never contains a 'voiceConfirm' key.
import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createSettings } from '../settings.js'

test('ST1 an old settings.json with voiceConfirm still loads; voiceConfirm is neither exposed nor defaulted', () => {
  const fresh = createSettings(mkdtempSync(join(tmpdir(), 'settings-')), {})
  assert.equal('voiceConfirm' in fresh.get(), false, 'no default')
  const dir = mkdtempSync(join(tmpdir(), 'settings-'))
  writeFileSync(join(dir, 'settings.json'), JSON.stringify({ voiceControl: true, voiceConfirm: false, warnPercent: 70 }))
  const s = createSettings(dir, {})
  let got
  assert.doesNotThrow(() => { got = s.get() })
  assert.equal(got.voiceControl, true, 'the rest of the old file still applies')
  assert.equal(got.warnPercent, 70)
  assert.equal('voiceConfirm' in got, false, 'not exposed')
})

test('ST2 decideChime defaults to true, a config default or a saved boolean overrides it, anything else throws', () => {
  const dir = mkdtempSync(join(tmpdir(), 'settings-'))
  assert.equal(createSettings(dir, {}).get().decideChime, true)
  assert.equal(createSettings(dir, { decideChime: false }).get().decideChime, false, 'the config default')
  const s = createSettings(dir, {})
  assert.equal(s.set({ decideChime: false }).decideChime, false)
  assert.equal(createSettings(dir, { decideChime: true }).get().decideChime, false, 'a saved value wins over the config default')
  assert.throws(() => s.set({ decideChime: 'no' }), /decideChime must be true or false/)
})
