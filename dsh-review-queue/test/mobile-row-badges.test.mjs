// Slice 5: the phone row shows the same tier chip and "Merged N" note as the desktop card; both come from the shared helpers (no phone rule).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'
import { rowBadges } from '../lib/mobile/model.js'

const file = join(dirname(fileURLToPath(import.meta.url)), '..', 'lib', 'client.js')
function loadOverlay() {
  let registered
  const sandbox = { window: { __ModuleLoader__: { load: (r) => { registered = r } }, localStorage: { getItem: () => null, setItem() {} } }, console, setTimeout, clearTimeout, setInterval, clearInterval, fetch: () => new Promise(() => {}) }
  vm.runInNewContext(readFileSync(file, 'utf8'), sandbox, { filename: file })
  return registered.factory(() => ({ createElement: () => null, Fragment: Symbol('Fragment'), useState() {}, useEffect() {}, useRef() {}, useSyncExternalStore() {} }))
}
const core = loadOverlay().shared

const withTier = (over = {}) => ({ id: 'a', type: 'question', status: 'open', createdAt: 1, tier: { severity: 'high', urgency: 'blocked', tier: 0, at: 1 }, ...over })

test('the shared helpers expose mergedNote next to tierChip', () => {
  assert.equal(typeof core.tierChip, 'function')
  assert.equal(typeof core.mergedNote, 'function')
})

test('rowBadges returns the desktop tier chip and merged note of an item', () => {
  const item = withTier({ merged: { count: 3 } })
  const b = rowBadges(core, item)
  assert.deepEqual({ ...b.tier }, { ...core.tierChip(item) })
  assert.equal(b.tier.text, 'P0 High')
  assert.equal(b.merged, 'Merged 3 similar questions')
})

test('a done card says similar messages; a count of 1 or none gives no note', () => {
  assert.equal(rowBadges(core, withTier({ type: 'completed', merged: { count: 2 } })).merged, 'Merged 2 similar messages')
  assert.equal(rowBadges(core, withTier({ merged: { count: 1 } })).merged, undefined)
  assert.equal(rowBadges(core, withTier()).merged, undefined)
})

test('an item without a usable tier has no chip, and a missing item never throws', () => {
  assert.equal(rowBadges(core, { id: 'x', type: 'question' }).tier, undefined)
  assert.equal(rowBadges(core, { id: 'x', type: 'question', tier: { tier: 9, severity: 'high' } }).tier, undefined)
  assert.deepEqual({ ...rowBadges(core, undefined) }, { tier: undefined, merged: undefined })
})
