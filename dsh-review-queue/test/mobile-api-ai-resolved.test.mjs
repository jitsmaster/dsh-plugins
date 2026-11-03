// Slice 2: the phone restores a saved resolvedBy filter only when it is one of all / me / ai (lib/mobile/api.js load()).
import { test } from 'node:test'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'
import assert from 'node:assert/strict'

globalThis.location = { pathname: '/review-queue/m/', hash: '' }
const store = new Map()
globalThis.localStorage = { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => { store.set(k, String(v)) }, removeItem: (k) => { store.delete(k) } }
// init() loads the overlay core through a script element: here the element "loads" the real lib/client.js and fires onload. fetch never answers, so the poll loop just waits.
const overlay = readFileSync(fileURLToPath(new URL('../lib/client.js', import.meta.url)), 'utf8')
globalThis.window = { addEventListener() {}, localStorage: globalThis.localStorage }
globalThis.document = {
  hidden: false,
  addEventListener() {},
  createElement: (tag) => ({ tag }),
  head: { append(script) { setTimeout(() => { vm.runInNewContext(overlay, { window: globalThis.window, console, setTimeout, clearTimeout, setInterval, clearInterval, fetch: () => new Promise(() => {}) }); script.onload() }, 0) } },
}
globalThis.fetch = () => new Promise(() => {})

let n = 0
/** A fresh api.js module that loads whatever is saved in 'rq-m.filter' right now. */
async function restored(saved) {
  store.clear()
  if (saved !== undefined) store.set('rq-m.filter', typeof saved === 'string' ? saved : JSON.stringify(saved))
  const api = await import('../lib/mobile/api.js?restore=' + ++n)
  await api.init()
  api.stopThreadPolling()
  return api.state.filter
}

test('a saved valid resolvedBy is restored with the type and query', async () => {
  for (const resolvedBy of ['all', 'me', 'ai']) assert.deepEqual({ ...(await restored({ type: 'todo', query: 'x', resolvedBy })) }, { type: 'todo', query: 'x', resolvedBy })
})

test('a saved resolvedBy that is not all / me / ai becomes all', async () => {
  for (const resolvedBy of ['bogus', 'AI', '', 7, null, {}, ['ai'], true]) assert.equal((await restored({ type: 'all', query: '', resolvedBy })).resolvedBy, 'all', JSON.stringify(resolvedBy))
})

test('a filter saved before resolvedBy existed restores with resolvedBy all', async () => {
  assert.deepEqual({ ...(await restored({ type: 'question', query: 'q' })) }, { type: 'question', query: 'q', resolvedBy: 'all' })
})

test('nothing saved, or garbled storage, leaves the default filter with resolvedBy all', async () => {
  assert.deepEqual({ ...(await restored(undefined)) }, { type: 'all', query: '', resolvedBy: 'all' })
  assert.deepEqual({ ...(await restored('{not json')) }, { type: 'all', query: '', resolvedBy: 'all' })
})

