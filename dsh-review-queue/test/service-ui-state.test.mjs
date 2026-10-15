import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createReviewQueue } from '../service.js'
import { createStore } from '../store.js'

// Two apps in one process (the hub tests) must not share their show/hide commands; one app keeps its sequence across a plugin reload.
const make = (extra = {}) => createReviewQueue({ store: createStore(), capture: {}, controllerOf: () => ({}), ...extra })

test('a service given its own ui state keeps show/hide commands to itself', () => {
  const a = make({ ui: { seq: 0 } })
  const b = make({ ui: { seq: 0 } })
  assert.deepEqual(a.uiCommand('show'), { ok: true, seq: 1 })
  assert.deepEqual(a.snapshot().ui, { seq: 1, cmd: 'show' })
  assert.deepEqual(b.snapshot().ui, { seq: 0, cmd: undefined }, 'the other app sees nothing')
  assert.deepEqual(b.uiCommand('hide'), { ok: true, seq: 1 })
  assert.equal(a.snapshot().ui.cmd, 'show')
})

test('uiState exposes the holder, so a second view of the same app (the hub mirror) can share it', () => {
  const ui = { seq: 4, cmd: 'hide' }
  const a = make({ ui })
  assert.equal(a.uiState(), ui)
  const view = make({ ui: a.uiState() })
  a.uiCommand('show')
  assert.deepEqual(view.snapshot().ui, { seq: 5, cmd: 'show' })
})
