import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createStore } from '../store.js'
import { createReviewQueue } from '../service.js'
import { chunkForSpeech, fullTextFor } from '../speech.js'

function setup() {
  let t = 1000
  let n = 0
  const store = createStore({ now: () => ++t, uuid: () => 'i' + ++n })
  const calls = []
  const capture = {
    answerQuestion: (id, answers) => { calls.push(['answer', id, answers]); return { ok: true } },
    decidePermission: (id, decision) => { calls.push(['decide', id, decision]); return { ok: true } },
    lateAnswerQuestion: async (id, answers) => { calls.push(['late', id, answers]); return { ok: true, sent: true } },
  }
  // Like the real Remote method: refuses a call without a caller signal.
  const controller = { prompt: async (req, signal) => { if (!(signal instanceof AbortSignal)) throw new TypeError("Cannot read properties of undefined (reading 'throwIfAborted')"); calls.push(['prompt', req]); return {} } }
  const queue = createReviewQueue({ store, capture, controllerOf: () => controller, now: () => 5000 })
  return { store, queue, calls }
}
const completed = (over = {}) => ({ type: 'completed', sessionId: 's1', sessionTitle: 'One', summary: 'Did X. Then Y.', payload: { reply: 'r' }, ...over })

test('snapshot adds positions, spoken text and the server clock', () => {
  const { store, queue } = setup()
  store.add(completed({ sessionTitle: 'Old' }))
  store.add({ type: 'question', sessionId: 's2', sessionTitle: 'Two', payload: { questions: [{ id: 'q', question: 'Pick?', options: [{ label: 'A' }, { label: 'B' }] }] } })
  const snap = queue.snapshot()
  assert.equal(snap.serverNow, 5000)
  assert.deepEqual(snap.open.map((i) => i.position), [1, 2])
  assert.match(snap.open[0].spoken.headline, /^Item 1\. Done in Old/)
  assert.match(snap.open[1].spoken.headline, /^Item 2\. Question from Two: Pick\?/)
  assert.ok(snap.snapshotId)
})

test('onChange passes through and can be removed', () => {
  const { store, queue } = setup()
  let n = 0
  const off = queue.onChange(() => { n++ })
  store.add(completed())
  off()
  store.add(completed())
  assert.equal(n, 1)
})

test('answer, approve and deny delegate to capture and report its outcome', () => {
  const { store, queue, calls } = setup()
  const q = store.add({ type: 'question', sessionId: 's', payload: { questions: [] } })
  assert.deepEqual(queue.answer(q.id, [{ id: 'q', selected: ['A'] }]), { ok: true })
  const p = store.add({ type: 'permission', sessionId: 's', payload: {} })
  assert.deepEqual(queue.approve(p.id), { ok: true })
  assert.deepEqual(queue.deny(p.id), { ok: true })
  assert.deepEqual(calls.map((c) => c[0] + ':' + (c[2] === undefined ? '' : JSON.stringify(c[2]))), ['answer:[{"id":"q","selected":["A"]}]', 'decide:"approve"', 'decide:"deny"'])
})

test('markReviewed resolves a completed item, and only a completed item', () => {
  const { store, queue } = setup()
  const c = store.add(completed())
  const q = store.add({ type: 'question', sessionId: 's', payload: { questions: [] } })
  assert.deepEqual(queue.markReviewed(q.id), { ok: false, error: 'not-completed' })
  assert.deepEqual(queue.markReviewed(c.id), { ok: true })
  assert.equal(store.get(c.id).resolution.kind, 'reviewed')
  assert.deepEqual(queue.markReviewed(c.id), { ok: false, error: 'not-open' })
  assert.deepEqual(queue.markReviewed('nope'), { ok: false, error: 'not-open' })
})

test('reply sends a queued prompt to the item session and resolves the item as replied', async () => {
  const { store, queue, calls } = setup()
  const c = store.add(completed({ sessionId: 'sess-9' }))
  assert.deepEqual(await queue.reply(c.id, '  please add tests  '), { ok: true })
  const [, req] = calls.find((x) => x[0] === 'prompt')
  assert.equal(req.sessionId, 'sess-9')
  assert.equal(req.mode, 'queue')
  assert.deepEqual(req.content, [{ type: 'text', text: 'please add tests' }])
  assert.match(req.requestId, /^review-/)
  assert.equal(store.get(c.id).resolution.kind, 'replied')
})

test('reply refuses empty or oversized text, non-completed items and a missing controller', async () => {
  const { store, queue } = setup()
  const c = store.add(completed())
  assert.deepEqual(await queue.reply(c.id, '   '), { ok: false, error: 'empty' })
  assert.deepEqual(await queue.reply(c.id, 'x'.repeat(5000)), { ok: false, error: 'too-long' })
  const q = store.add({ type: 'question', sessionId: 's', payload: { questions: [] } })
  assert.deepEqual(await queue.reply(q.id, 'hi'), { ok: false, error: 'not-completed' })
  const bare = createReviewQueue({ store, capture: {}, controllerOf: () => undefined })
  assert.deepEqual(await bare.reply(c.id, 'hi'), { ok: false, error: 'no-controller' })
  assert.equal(store.get(c.id).status, 'open')
})

test('a failing prompt leaves the item open and reports the fixed code post-failed, never the text of the error', async () => {
  const { store } = setup()
  const queue = createReviewQueue({ store, capture: {}, controllerOf: () => ({ prompt: async () => { throw new Error('session closed: C:\\secret\\path') } }) })
  const c = store.add(completed())
  assert.deepEqual(await queue.reply(c.id, 'hi'), { ok: false, error: 'post-failed' })
  assert.equal(store.get(c.id).status, 'open')
})

test('focus is shared state that voice and the screen both follow', () => {
  const { store, queue } = setup()
  const a = store.add(completed())
  let n = 0
  queue.onChange(() => { n++ })
  assert.equal(queue.getFocus(), undefined)
  queue.setFocus(a.id)
  assert.equal(queue.getFocus(), a.id)
  assert.equal(queue.snapshot().focusId, a.id)
  assert.equal(n, 1)
  store.resolve(a.id, { kind: 'reviewed' })
  assert.equal(queue.getFocus(), undefined)
})

test('lateAnswer delegates to capture for an expired question', async () => {
  const { queue, calls } = setup()
  assert.deepEqual(await queue.lateAnswer('i1', [{ id: 'q', selected: ['B'] }]), { ok: true, sent: true })
  assert.deepEqual(calls.at(-1), ['late', 'i1', [{ id: 'q', selected: ['B'] }]])
})

function setupSpeak() {
  const spoken = []
  let stopped = 0
  let end
  const speaker = {
    speak: (chunks, opts) => { spoken.push(chunks); end = opts.onEnd; return speaker.result ?? { ok: true } },
    stop: () => { stopped++; end?.() },
    result: undefined,
  }
  let n = 0
  let t = 1000
  const store = createStore({ now: () => ++t, uuid: () => 'r' + ++n })
  const queue = createReviewQueue({ store, capture: {}, controllerOf: () => undefined, now: () => 5000, speaker })
  return { store, queue, spoken, speaker, finish: () => end?.(), stopped: () => stopped }
}

test('snapshot gives every item a title and reports what is being read', () => {
  const { store, queue } = setupSpeak()
  const a = store.add(completed({ title: 'Move auth', payload: { reply: 'Full reply text.' } }))
  assert.equal(queue.snapshot().open[0].title, 'Move auth')
  assert.equal(queue.snapshot().reading, undefined)
  assert.deepEqual(queue.read(a.id), { ok: true })
  assert.equal(queue.snapshot().reading, a.id)
})

test('read speaks the full reply in chunks, not the summary, and the state clears when speech ends', () => {
  const { store, queue, spoken, finish } = setupSpeak()
  const a = store.add(completed({ summary: 'SHORT', payload: { reply: 'Part one is here.\n\nPart two is here.' } }))
  let changes = 0
  queue.onChange(() => { changes++ })
  assert.deepEqual(queue.read(a.id), { ok: true })
  const text = spoken[0].join(' ')
  assert.match(text, /Part one is here\./)
  assert.match(text, /Part two is here\./)
  assert.doesNotMatch(text, /SHORT/)
  assert.ok(changes >= 1)
  finish()
  assert.equal(queue.snapshot().reading, undefined)
})

test('reading another item switches; stop clears; unknown ids and speaker failures are reported', () => {
  const { store, queue, speaker, stopped } = setupSpeak()
  const a = store.add(completed({ payload: { reply: 'A reply.' } }))
  const b = store.add(completed({ payload: { reply: 'B reply.' } }))
  queue.read(a.id)
  queue.read(b.id)
  assert.equal(queue.snapshot().reading, b.id)
  assert.deepEqual(queue.stop(), { ok: true })
  assert.equal(queue.snapshot().reading, undefined)
  assert.ok(stopped() >= 1)
  assert.deepEqual(queue.read('nope'), { ok: false, error: 'not-found' })
  speaker.result = { ok: false, error: 'muted' }
  assert.deepEqual(queue.read(a.id), { ok: false, error: 'muted' })
  assert.equal(queue.snapshot().reading, undefined)
})

test('without a speaker, read says so', () => {
  const { store, queue } = setup()
  const a = store.add(completed())
  assert.deepEqual(queue.read(a.id), { ok: false, error: 'no-speaker' })
  assert.deepEqual(queue.stop(), { ok: true })
})

test('an item that left the queue can still be read (a resolved card)', () => {
  const { store, queue } = setupSpeak()
  const a = store.add(completed({ payload: { reply: 'Old reply.' } }))
  store.resolve(a.id, { kind: 'reviewed' })
  assert.deepEqual(queue.read(a.id), { ok: true })
})

test('reopen works for reviewed and superseded done items only', () => {
  const { store, queue } = setup()
  const a = store.add(completed())
  const b = store.add(completed())
  const q = store.add({ type: 'question', sessionId: 's', payload: { questions: [] } })
  store.resolve(a.id, { kind: 'reviewed', by: 'card' })
  store.resolve(b.id, { kind: 'replied', by: 'card' })
  store.resolve(q.id, { kind: 'answered' })
  assert.deepEqual(queue.reopen(a.id), { ok: true })
  assert.equal(store.get(a.id).status, 'open')
  assert.deepEqual(queue.reopen(b.id), { ok: false, error: 'not-reopenable' })
  assert.deepEqual(queue.reopen(q.id), { ok: false, error: 'not-reopenable' })
  assert.deepEqual(queue.reopen(a.id), { ok: false, error: 'not-reopenable' })
  assert.deepEqual(queue.reopen('nope'), { ok: false, error: 'not-found' })
  const c = store.add(completed())
  store.resolve(c.id, { kind: 'superseded', by: 'newer' })
  assert.deepEqual(queue.reopen(c.id), { ok: true })
})

test('permission items carry their risks in the snapshot', () => {
  const { store, queue } = setup()
  store.add({ type: 'permission', sessionId: 's', workspace: 'D:/proj', payload: { toolName: 'shell', summary: 'shell: rm -rf x', detail: 'rm -rf x' } })
  store.add({ type: 'permission', sessionId: 's', workspace: 'D:/proj', payload: { toolName: 'shell', summary: 'shell: ls', detail: 'ls' } })
  const snap = queue.snapshot()
  assert.deepEqual(snap.open[0].risks.map((r) => r.code), ['recursive-delete'])
  assert.deepEqual(snap.open[1].risks, [])
})

test('approveSimilar approves every identical open request of that session, but never a risky one', () => {
  const { store, queue, calls } = setup()
  const perm = (over = {}, detail = 'npm test') => store.add({ type: 'permission', sessionId: 's1', workspace: 'D:/p', payload: { toolName: 'shell', summary: 'shell: ' + detail, detail, ...over } })
  const a = perm(); const b = perm(); perm({}, 'npm run build'); store.add({ type: 'permission', sessionId: 's2', workspace: 'D:/p', payload: { toolName: 'shell', summary: 'shell: npm test', detail: 'npm test' } })
  assert.deepEqual(queue.approveSimilar(a.id), { ok: true, count: 2 })
  assert.deepEqual(calls.filter((c) => c[0] === 'decide').map((c) => c[1]).sort(), [a.id, b.id].sort())
  const risky = perm({}, 'rm -rf build')
  assert.deepEqual(queue.approveSimilar(risky.id), { ok: false, error: 'risky' })
  const done = store.add(completed())
  assert.deepEqual(queue.approveSimilar(done.id), { ok: false, error: 'not-permission' })
  assert.deepEqual(queue.approveSimilar('nope'), { ok: false, error: 'not-open' })
})

test('reading stops by itself when the item being read leaves the queue; reading a resolved item is left alone', () => {
  const { store, queue, speaker, stopped } = setupSpeak()
  const a = store.add(completed({ payload: { reply: 'A reply.' } }))
  queue.read(a.id)
  store.resolve(a.id, { kind: 'reviewed' })
  assert.equal(queue.snapshot().reading, undefined)
  assert.ok(stopped() >= 1)
  const b = store.add(completed({ payload: { reply: 'B.' } }))
  store.resolve(b.id, { kind: 'reviewed' })
  const before = stopped()
  queue.read(b.id)
  store.add(completed())
  assert.equal(queue.snapshot().reading, b.id)
  assert.equal(stopped(), before)
  void speaker
})

// --- voice seams: count, first, readPosition, again, uiCommand ---

const questionItem = () => ({ type: 'question', sessionId: 'sq', sessionTitle: 'Q', payload: { questions: [{ id: 'q', question: 'Pick?', options: [{ label: 'A' }, { label: 'B' }] }] } })
const permissionItem = () => ({ type: 'permission', sessionId: 'sp', sessionTitle: 'P', payload: { toolName: 'shell', summary: 'shell: ls' } })

test('count tallies the open items by type and ignores resolved ones', () => {
  const { store, queue } = setup()
  assert.deepEqual(queue.count(), { total: 0, byType: { question: 0, permission: 0, completed: 0, 'pr-merged': 0, todo: 0, paused: 0 } })
  const a = store.add(completed())
  store.add(completed({ sessionId: 's2' }))
  store.add(questionItem())
  store.add(permissionItem())
  assert.deepEqual(queue.count(), { total: 4, byType: { question: 1, permission: 1, completed: 2, 'pr-merged': 0, todo: 0, paused: 0 } })
  store.resolve(a.id, { kind: 'reviewed' })
  assert.deepEqual(queue.count(), { total: 3, byType: { question: 1, permission: 1, completed: 1, 'pr-merged': 0, todo: 0, paused: 0 } })
})

test('first is the oldest open item, or undefined for an empty queue', () => {
  const { store, queue } = setup()
  assert.equal(queue.first(), undefined)
  const a = store.add(completed({ sessionTitle: 'Oldest' }))
  store.add(completed({ sessionId: 's2' }))
  assert.equal(queue.first().id, a.id)
  assert.equal(queue.first().position, 1)
  store.resolve(a.id, { kind: 'reviewed' })
  assert.notEqual(queue.first().id, a.id)
  assert.equal(queue.first().position, 1)
})

test('readPosition reads exactly what the play button reads for that position, and focuses the item', () => {
  const { store, queue, spoken } = setupSpeak()
  store.add(completed({ payload: { reply: 'One reply.' } }))
  const b = store.add(questionItem())
  store.add(permissionItem())
  assert.deepEqual(queue.readPosition(2), { ok: true, id: b.id })
  assert.deepEqual(spoken.at(-1), chunkForSpeech(fullTextFor(store.get(b.id), 2)))
  assert.equal(spoken.at(-1)[0], 'Item 2.')
  assert.equal(queue.getFocus(), b.id)
  assert.equal(queue.snapshot().focusId, b.id)
  assert.equal(queue.snapshot().reading, b.id)
})

test('readPosition: an empty queue is "empty", a position out of range is "no-item"', () => {
  const { store, queue, spoken } = setupSpeak()
  assert.deepEqual(queue.readPosition(1), { ok: false, error: 'empty' })
  store.add(completed())
  for (const n of [0, 2, -1, 1.5, NaN, undefined, '1']) assert.deepEqual(queue.readPosition(n), { ok: false, error: 'no-item' }, String(n))
  assert.equal(spoken.length, 0)
  assert.equal(queue.getFocus(), undefined)
})

test('readPosition passes a speaker failure on and works without a speaker', () => {
  const { store, queue, speaker } = setupSpeak()
  const a = store.add(completed())
  speaker.result = { ok: false, error: 'muted' }
  assert.deepEqual(queue.readPosition(1), { ok: false, error: 'muted' })
  const bare = setup()
  bare.store.add(completed())
  assert.deepEqual(bare.queue.readPosition(1), { ok: false, error: 'no-speaker' })
  void a
})

test('the body chunks of a read are the same at every position (the speech cache hits)', () => {
  const { store, queue, spoken } = setupSpeak()
  const older = store.add(completed({ payload: { reply: 'Older.' } }))
  const b = store.add(completed({ sessionId: 's2', payload: { reply: 'Part one is here.\n\nPart two is here.' } }))
  queue.read(b.id)
  const atTwo = spoken.at(-1)
  store.resolve(older.id, { kind: 'reviewed' })
  queue.read(b.id)
  const atOne = spoken.at(-1)
  assert.equal(atTwo[0], 'Item 2.')
  assert.equal(atOne[0], 'Item 1.')
  assert.ok(atOne.length > 1)
  assert.deepEqual(atOne.slice(1), atTwo.slice(1))
})

test('again re-reads the last item read, wherever the read started', () => {
  const { store, queue, spoken } = setupSpeak()
  const a = store.add(completed({ payload: { reply: 'A reply.' } }))
  const b = store.add(completed({ sessionId: 's2', payload: { reply: 'B reply.' } }))
  assert.deepEqual(queue.again(), { ok: false, error: 'nothing-read' })
  queue.read(b.id)
  assert.deepEqual(queue.again(), { ok: true, id: b.id })
  assert.deepEqual(spoken.at(-1), chunkForSpeech(fullTextFor(store.get(b.id), 2)))
  queue.readPosition(1)
  assert.deepEqual(queue.again(), { ok: true, id: a.id })
  assert.equal(spoken.length, 4)
})

test('again says "nothing-read" when the item left the queue; a failed read does not become the last read', () => {
  const { store, queue, speaker } = setupSpeak()
  const a = store.add(completed())
  const b = store.add(completed({ sessionId: 's2' }))
  queue.read(a.id)
  speaker.result = { ok: false, error: 'muted' }
  assert.deepEqual(queue.read(b.id), { ok: false, error: 'muted' })
  speaker.result = undefined
  assert.deepEqual(queue.again(), { ok: true, id: a.id })
  store.resolve(a.id, { kind: 'reviewed' })
  assert.deepEqual(queue.again(), { ok: false, error: 'nothing-read' })
})

test('uiCommand accepts show and hide only', () => {
  const { queue } = setup()
  for (const bad of [undefined, null, '', 'open', 'SHOW', 5, {}]) assert.deepEqual(queue.uiCommand(bad), { ok: false, error: 'bad-command' }, String(bad))
})

test('uiCommand bumps a sequence number the snapshot carries, and wakes listeners', () => {
  const { queue } = setup()
  let woke = 0
  queue.onChange(() => { woke++ })
  const before = queue.snapshot().ui
  assert.equal(typeof before.seq, 'number')
  const r1 = queue.uiCommand('show')
  assert.deepEqual(r1, { ok: true, seq: before.seq + 1 })
  assert.deepEqual(queue.snapshot().ui, { seq: before.seq + 1, cmd: 'show' })
  assert.equal(woke, 1)
  assert.deepEqual(queue.uiCommand('hide'), { ok: true, seq: before.seq + 2 })
  assert.deepEqual(queue.snapshot().ui, { seq: before.seq + 2, cmd: 'hide' })
  queue.uiCommand('nope')
  assert.equal(queue.snapshot().ui.seq, before.seq + 2, 'a rejected command changes nothing')
  assert.equal(woke, 2)
})

test('the ui sequence is shared by queues of the same server run (a plugin reload must not reset it)', () => {
  const one = setup().queue
  const seq = one.uiCommand('show').seq
  const two = setup().queue
  assert.equal(two.snapshot().ui.seq, seq)
  assert.equal(two.snapshot().ui.cmd, 'show')
})

test('a done item hidden as no-action can be reopened and is not counted while hidden', () => {
  const { store, queue } = setup()
  const a = store.add(completed())
  store.resolve(a.id, { kind: 'no-action', by: 'auto' })
  assert.equal(queue.count().total, 0)
  assert.deepEqual(queue.reopen(a.id), { ok: true })
  assert.equal(queue.count().total, 1)
})
