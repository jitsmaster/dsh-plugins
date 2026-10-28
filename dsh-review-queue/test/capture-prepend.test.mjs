import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createStore } from '../store.js'
import { installCapture } from '../capture.js'

// A plugin reload registers its hooks after the host's own answerer (the web client). A waterfall listener that answers never calls
// next(), so a capture registered later never sees the question. The capture hooks that wait on an answerer must be outermost (prepend).
function setup() {
  const registered = []
  const ctx = {
    on: (name, fn, options) => { registered.push({ name, fn, options }) },
    get: () => undefined,
    logger: { warn() {}, info() {} },
  }
  const store = createStore({})
  installCapture(ctx, { store, summarizer: { summarize: async () => ({ text: 'x', source: 'llm' }) } })
  return registered
}

for (const name of ['user-questions/request', 'approval/request']) {
  test(name + ' is registered as the outermost listener so a reload cannot put it behind an answerer', () => {
    const entry = setup().find((r) => r.name === name)
    assert.ok(entry, 'hook registered')
    assert.equal(entry.options?.prepend, true)
  })
}
