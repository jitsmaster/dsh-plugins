import { test } from 'node:test'
import assert from 'node:assert/strict'
import vm from 'node:vm'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { createStore } from '../store.js'
import { createReviewQueue } from '../service.js'

// Undo of a swipe-right review (docs/mobile.md "Swipe to review"): the Reviewed / Keep session of an archive-ask and a PR-merged card
// can be taken back like the Reviewed of a done card. The service rule and the client rule (isReopenable, which the phone shares) agree.

function setup() {
  let t = 1000
  let n = 0
  const store = createStore({ now: () => ++t, uuid: () => 'i' + ++n })
  const capture = { answerQuestion: () => ({ ok: true }), decidePermission: () => ({ ok: true }), lateAnswerQuestion: async () => ({ ok: true }) }
  const queue = createReviewQueue({ store, capture, controllerOf: () => ({ prompt: async () => ({}) }), now: () => 5000 })
  return { store, queue }
}
const input = {
  completed: { type: 'completed', sessionId: 's1', sessionTitle: 'One', summary: 'Did X.', payload: { reply: 'r' } },
  archive: { type: 'archive', sessionId: 's2', sessionTitle: 'Two', payload: { reason: 'finished' } },
  'pr-merged': { type: 'pr-merged', sessionId: 's3', sessionTitle: 'Three', payload: { prId: 7, followUps: [] } },
  question: { type: 'question', sessionId: 's4', payload: { questions: [] } },
}

const clientFile = fileURLToPath(new URL('../lib/client.js', import.meta.url))
function clientReopenable() {
  let registered
  const sandbox = { window: { __ModuleLoader__: { load: (r) => { registered = r } }, localStorage: { getItem: () => null, setItem: () => {} } }, console, setTimeout, clearTimeout, setInterval, clearInterval, fetch: () => new Promise(() => {}) }
  vm.runInNewContext(readFileSync(clientFile, 'utf8'), sandbox, { filename: clientFile })
  const stubReact = { createElement: () => null, Fragment: Symbol('Fragment'), useState() {}, useEffect() {}, useRef() {}, useSyncExternalStore() {} }
  return registered.factory(() => stubReact).__test.isReopenable
}

test('a reviewed archive-ask or PR-merged card can be reopened, and goes back to open', () => {
  for (const type of ['archive', 'pr-merged']) {
    const { store, queue } = setup()
    const a = store.add(input[type])
    assert.deepEqual(queue.markReviewed(a.id), { ok: true }, type)
    assert.equal(store.get(a.id).status, 'resolved')
    assert.deepEqual(queue.reopen(a.id), { ok: true }, type)
    assert.equal(store.get(a.id).status, 'open', type)
    assert.deepEqual(queue.reopen(a.id), { ok: false, error: 'not-reopenable' }, type + ' twice')
  }
})

test('an archive-ask or PR-merged card resolved any other way is still not reopenable', () => {
  for (const type of ['archive', 'pr-merged']) {
    for (const kind of ['archived', 'dismissed', 'replied', 'superseded', 'no-action', 'trimmed']) {
      const { store, queue } = setup()
      const a = store.add(input[type])
      store.resolve(a.id, { kind, by: 'card' })
      assert.deepEqual(queue.reopen(a.id), { ok: false, error: 'not-reopenable' }, type + '/' + kind)
    }
  }
})

test('a reviewed archive-ask or PR-merged card is not reopened while another one of the same type is open for that session (no duplicate card)', () => {
  for (const type of ['archive', 'pr-merged']) {
    const { store, queue } = setup()
    const a = store.add(input[type])
    queue.markReviewed(a.id)
    const again = store.add(input[type]) // a new offer for the same session was raised after the Reviewed
    assert.deepEqual(queue.reopen(a.id), { ok: false, error: 'not-reopenable' }, type)
    assert.equal(store.get(a.id).status, 'resolved', type)
    store.resolve(again.id, { kind: 'dismissed', by: 'card' })
    assert.deepEqual(queue.reopen(a.id), { ok: true }, type + ' once the other is gone')
  }
})

test('two open PR-merged cards of one session for different PRs do not block each other\'s reopen', () => {
  const { store, queue } = setup()
  const a = store.add(input['pr-merged']) // PR 7
  queue.markReviewed(a.id)
  const b = store.add({ ...input['pr-merged'], payload: { prId: 8, followUps: [] } })
  assert.equal(store.get(b.id).status, 'open')
  assert.deepEqual(queue.reopen(a.id), { ok: true })
  // the same PR raised again is still a duplicate
  const { store: s2, queue: q2 } = setup()
  const c = s2.add(input['pr-merged'])
  q2.markReviewed(c.id)
  s2.add(input['pr-merged'])
  assert.deepEqual(q2.reopen(c.id), { ok: false, error: 'not-reopenable' })
})

test('the PR id of the duplicate check is compared as text (a numeric 7 and the string "7" are the same PR)', () => {
  const { store, queue } = setup()
  const a = store.add(input['pr-merged']) // prId 7
  queue.markReviewed(a.id)
  store.add({ ...input['pr-merged'], payload: { prId: '7', followUps: [] } })
  assert.deepEqual(queue.reopen(a.id), { ok: false, error: 'not-reopenable' })
})

test('the client rule and the service rule agree on done, archive-ask, PR-merged and question cards for every kind', () => {
  const isReopenable = clientReopenable()
  for (const type of Object.keys(input)) {
    for (const kind of ['reviewed', 'superseded', 'no-action', 'trimmed', 'replied', 'archived']) {
      const { store, queue } = setup()
      const a = store.add(input[type])
      store.resolve(a.id, { kind, by: 'card' })
      const label = type + '/' + kind
      assert.equal(isReopenable(store.get(a.id)), queue.reopen(a.id).ok, label)
    }
  }
  assert.equal(isReopenable({ type: 'archive', resolution: { kind: 'reviewed' } }), true)
  assert.equal(isReopenable({ type: 'pr-merged', resolution: { kind: 'reviewed' } }), true)
})
