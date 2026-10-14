// Slice 6: answer the first task-list question item by voice: option N / recommended / free text, one sub-question at a time for a
// multi-question item, then ONE read-back of every answer. A strict yes sends through the card's own call (answer).
import assert from 'node:assert/strict'
import test from 'node:test'
import { createQueueRunner } from '../voice/queue-runner.js'

const COLOUR = { id: 'c', header: 'Colour', question: 'Which colour?', options: [{ label: 'Red' }, { label: 'Blue (Recommended)' }, { label: 'Green' }] }
const SIZE = { id: 's', question: 'Which size should the button have?', options: [{ label: 'Small' }, { label: 'Large (Recommended)' }] }
const question = (over = {}) => ({ id: 'q1', type: 'question', sessionId: 's2', createdAt: 101, seq: 2, title: 'Pick a colour', payload: { questions: [COLOUR] }, position: 1, ...over })
const multi = (over = {}) => question({ title: 'Design choices', payload: { questions: [COLOUR, SIZE] }, ...over })
const done = (over = {}) => ({ id: 'd1', type: 'completed', sessionId: 's1', createdAt: 100, seq: 1, title: 'Fix parser', payload: { reply: 'All done.' }, position: 1, ...over })
const perm = (over = {}) => ({ id: 'p1', type: 'permission', sessionId: 's3', createdAt: 102, seq: 3, title: 'shell: git push', position: 1, payload: { toolName: 'pwsh', detail: 'git push' }, ...over })

function setup({ open = [question()], snapshotId = 'e:1', ...over } = {}) {
  const h = { open, snapshotId, calls: [], total: undefined }
  const queue = {
    snapshot: () => ({ snapshotId: h.snapshotId, open: h.open }),
    count: () => ({ total: h.total ?? h.open.length, byType: {} }),
    answer: (id, answers) => { h.calls.push(['answer', id, answers]); h.open = h.open.filter((i) => i.id !== id); return { ok: true } },
    ...over,
  }
  h.runner = createQueueRunner({ queue: () => queue, select: () => {} })
  return h
}

const TAIL = ' Say yes to send, or say it again to start over.'

test('PQ1 option two on a one-question item: frozen item, ONE read-back with the short question and the answer', async () => {
  const h = setup({ snapshotId: 'e:9' })
  const r = await h.runner.prepareReply({ kind: 'option', n: 2 })
  assert.equal(r.ok, true)
  assert.equal(r.frozen.id, 'q1')
  assert.equal(r.frozen.type, 'question')
  assert.equal(r.frozen.snapshotId, 'e:9')
  assert.equal(r.frozen.title, 'Pick a colour')
  assert.ok(Object.isFrozen(r.frozen))
  assert.equal(r.move.kind, 'confirm')
  assert.equal(r.move.line, 'Answer to Pick a colour: Colour option two.' + TAIL)
  assert.deepEqual(h.calls, [])
})

test('PQ2 recommended picks the option marked (Recommended); a question without one asks again with a line', async () => {
  const r = await setup().runner.prepareReply({ kind: 'recommended' })
  assert.equal(r.move.line, 'Answer to Pick a colour: Colour recommended.' + TAIL)
  const none = setup({ open: [question({ payload: { questions: [{ ...COLOUR, options: [{ label: 'Red' }, { label: 'Blue' }] }] } })] })
  const n = await none.runner.prepareReply({ kind: 'recommended' })
  assert.equal(n.move.kind, 'ask')
  assert.equal(n.move.line, 'That question has no recommended option. Say an option, or your answer.')
})

test('PQ3 an option number that does not exist asks again, naming the range', async () => {
  const r = await setup().runner.prepareReply({ kind: 'option', n: 7 })
  assert.equal(r.move.kind, 'ask')
  assert.equal(r.move.line, 'There is no option 7. Say an option from one to three, or your answer.')
  const bare = setup({ open: [question({ payload: { questions: [{ id: 'c', question: 'Why?', options: [] }] } })] })
  assert.equal((await bare.runner.prepareReply({ kind: 'option', n: 1 })).move.line, 'That question has no options. Say your answer.')
})

test('PQ4 "answer <text>" is a free-text answer, sanitised like a dictated reply', async () => {
  const r = await setup().runner.prepareReply({ kind: 'answer', text: 'Use Postgres, please.' })
  assert.equal(r.move.line, 'Answer to Pick a colour: Colour Use Postgres, please.' + TAIL)
  assert.equal((await setup().runner.prepareReply({ kind: 'answer', text: 'x'.repeat(1501) })).move.kind, 'reject')
  assert.deepEqual((await setup().runner.prepareReply({ kind: 'answer', text: 'x'.repeat(1501) })).move, { kind: 'reject', error: 'too-long' })
  assert.deepEqual((await setup().runner.prepareReply({ kind: 'answer', text: 'a|b' })).move, { kind: 'reject', error: 'invalid' })
  assert.deepEqual((await setup().runner.prepareReply({ kind: 'answer', text: 'caf\u00e9 ok' })).move, { kind: 'reject', error: 'invalid' })
})

test('PQ5 "reply to the first item" on a question listens for the answer: no line first (the STT beep is the cue)', async () => {
  const r = await setup().runner.prepareReply({ kind: 'reply', n: 1 })
  assert.equal(r.ok, true)
  assert.deepEqual(r.move, { kind: 'ask', state: { answers: [] } })
})

test('PQ6 the short question is the header, else the first words of the question without its question mark', async () => {
  const r = await setup({ open: [multi()] }).runner.prepareReply({ kind: 'option', n: 1 })
  const s = await setup({ open: [multi()] }).runner.replyStep(r.frozen, r.move.state, { step: 'ask', kind: 'text', text: 'Large' })
  assert.equal(s.line, 'Answer to Design choices: Colour option one, Which size should the button Large.' + TAIL)
})

test('PQ7 multi-question: the first answer moves on to the next question, which is read in full, options included', async () => {
  const h = setup({ open: [multi()] })
  const r = await h.runner.prepareReply({ kind: 'option', n: 2 })
  assert.equal(r.move.kind, 'ask')
  assert.equal(r.move.line, 'Question 2 of 2: Which size should the button have? Option 1: Small. Option 2: Large, recommended. Say an option, recommended, or your answer.')
  assert.deepEqual(r.move.state, { answers: [{ kind: 'option', n: 2 }] })
  const second = await h.runner.replyStep(r.frozen, r.move.state, { step: 'ask', kind: 'text', text: 'recommended' })
  assert.deepEqual(second, { kind: 'confirm', state: { answers: [{ kind: 'option', n: 2 }, { kind: 'recommended', n: 2 }] }, line: 'Answer to Design choices: Colour option two, Which size should the button recommended.' + TAIL })
})

test('PQ8 in an ask step "option two" / "the second one" / "recommended" are choices, anything else is free text', async () => {
  const h = setup()
  const { frozen, move } = await h.runner.prepareReply({ kind: 'reply', n: 1 })
  const step = (text) => h.runner.replyStep(frozen, move.state, { step: 'ask', kind: 'text', text })
  assert.equal((await step('option three')).line, 'Answer to Pick a colour: Colour option three.' + TAIL)
  assert.equal((await step('the first one')).line, 'Answer to Pick a colour: Colour option one.' + TAIL)
  assert.equal((await step('recommended')).line, 'Answer to Pick a colour: Colour recommended.' + TAIL)
  assert.equal((await step('make it purple')).line, 'Answer to Pick a colour: Colour make it purple.' + TAIL)
  assert.equal((await step('yes')).line, 'Answer to Pick a colour: Colour yes.' + TAIL, '"yes" is text here, as in a dictation')
  assert.equal((await step('option nine')).kind, 'ask')
  assert.deepEqual(await step('a|b'), { kind: 'reject', error: 'invalid' })
})

test('PQ9 at the read-back: a bare no asks again, any other speech starts over with that speech as the first answer', async () => {
  const h = setup({ open: [multi()] })
  const { frozen, move } = await h.runner.prepareReply({ kind: 'option', n: 2 })
  const toConfirm = await h.runner.replyStep(frozen, move.state, { step: 'ask', kind: 'text', text: 'recommended' })
  assert.equal(toConfirm.kind, 'confirm')
  assert.deepEqual(await h.runner.replyStep(frozen, toConfirm.state, { step: 'confirm', kind: 'no', text: 'no' }), { kind: 'again' })
  const over = await h.runner.replyStep(frozen, toConfirm.state, { step: 'confirm', kind: 'text', text: 'option one' })
  assert.equal(over.kind, 'ask')
  assert.deepEqual(over.state, { answers: [{ kind: 'option', n: 1 }] })
  assert.match(over.line, /^Question 2 of 2: /)
})

test('PQ10 a one-question item restarted at the read-back is simply replaced', async () => {
  const h = setup()
  const { frozen, move } = await h.runner.prepareReply({ kind: 'option', n: 2 })
  const over = await h.runner.replyStep(frozen, move.state, { step: 'confirm', kind: 'text', text: 'Purple' })
  assert.equal(over.kind, 'confirm')
  assert.equal(over.line, 'Answer to Pick a colour: Colour Purple.' + TAIL)
})

test('PQ11 sendReply answers through the card call with one entry per question: label for an option, custom for free text', async () => {
  const h = setup({ open: [multi(), done({ id: 'd2', position: 2 })] })
  const { frozen, move } = await h.runner.prepareReply({ kind: 'option', n: 3 })
  const last = await h.runner.replyStep(frozen, move.state, { step: 'ask', kind: 'text', text: 'Extra large please' })
  assert.deepEqual(await h.runner.sendReply(frozen, undefined, last.state), { outcome: 'sent', line: 'Task Design choices, answered. One waiting.' })
  assert.deepEqual(h.calls, [['answer', 'q1', [{ id: 'c', selected: ['Green'] }, { id: 's', selected: [], custom: 'Extra large please' }]]])
})

test('PQ12 recommended sends the labelled option', async () => {
  const h = setup()
  const { frozen, move } = await h.runner.prepareReply({ kind: 'recommended' })
  await h.runner.sendReply(frozen, undefined, move.state)
  assert.deepEqual(h.calls[0][2], [{ id: 'c', selected: ['Blue (Recommended)'] }])
})

test('PQ13 an incomplete walk is never sent', async () => {
  const h = setup({ open: [multi()] })
  const { frozen, move } = await h.runner.prepareReply({ kind: 'option', n: 2 })
  await assert.rejects(() => h.runner.sendReply(frozen, undefined, move.state), /incomplete/)
  await assert.rejects(() => h.runner.sendReply(frozen, undefined, undefined), /incomplete/)
  assert.deepEqual(h.calls, [])
})

test('PQ14 stale: left / changed / other type -> "That item changed. Nothing done."; not-pending from the service is the same', async () => {
  const gone = setup()
  const a = await gone.runner.prepareReply({ kind: 'option', n: 1 })
  gone.open = [perm()]; gone.snapshotId = 'e:2'
  assert.deepEqual(await gone.runner.sendReply(a.frozen, undefined, a.move.state), { outcome: 'changed', line: 'That item changed. Nothing done.' })
  const late = setup({ answer: () => ({ ok: false, error: 'not-pending' }) })
  const b = await late.runner.prepareReply({ kind: 'option', n: 1 })
  assert.equal((await late.runner.sendReply(b.frozen, undefined, b.move.state)).outcome, 'changed')
  const same = setup()
  const c = await same.runner.prepareReply({ kind: 'option', n: 1 })
  same.open = [question({ seq: 99 })]; same.snapshotId = 'e:2'
  assert.equal((await same.runner.sendReply(c.frozen, undefined, c.move.state)).outcome, 'changed')
  assert.deepEqual([gone.calls, same.calls], [[], []])
})

test('PQ15 other refusals are failures with the reason; a missing answer() is a failure, not a crash', async () => {
  const bad = setup({ answer: () => ({ ok: false, error: 'bad-answer' }) })
  const a = await bad.runner.prepareReply({ kind: 'option', n: 1 })
  await assert.rejects(() => bad.runner.sendReply(a.frozen, undefined, a.move.state), /bad-answer/)
  const none = setup({ answer: undefined })
  const b = await none.runner.prepareReply({ kind: 'option', n: 1 })
  await assert.rejects(() => none.runner.sendReply(b.frozen, undefined, b.move.state), /answer is not available/)
})

test('PQ16 a question command while the first item is another type gets a short correction', async () => {
  for (const intent of [{ kind: 'option', n: 2 }, { kind: 'recommended' }, { kind: 'answer', text: 'yes' }]) {
    assert.deepEqual(await setup({ open: [perm()] }).runner.prepareReply(intent), { ok: false, outcome: 'wrong-type', line: 'The first item is a permission request. Say approve or deny.' })
    assert.deepEqual(await setup({ open: [done()] }).runner.prepareReply(intent), { ok: false, outcome: 'wrong-type', line: 'The first item is a done item. Say reply.' })
  }
  assert.equal((await setup({ open: [] }).runner.prepareReply({ kind: 'option', n: 1 })).line, 'Nothing waiting.')
})

test('PQ17 a question item the voice cannot walk (no questions, no ids) is answered on screen', async () => {
  const line = 'That question cannot be answered by voice. Answer it on screen.'
  for (const payload of [{ questions: [] }, {}, { questions: [{ question: 'No id?', options: [] }] }, { questions: [{ id: 'a', question: '', options: [] }] }, { questions: 'nope' }]) {
    assert.deepEqual(await setup({ open: [question({ payload })] }).runner.prepareReply({ kind: 'option', n: 1 }), { ok: false, outcome: 'unsupported', line }, JSON.stringify(payload))
  }
})

test('PQ18 match: question phrases are commands only while the list has something in it', () => {
  assert.deepEqual(setup().runner.match('option two'), { kind: 'option', n: 2 })
  assert.deepEqual(setup().runner.match('recommended'), { kind: 'recommended' })
  assert.deepEqual(setup().runner.match('Answer use Postgres'), { kind: 'answer', text: 'use Postgres' })
  assert.equal(setup({ open: [] }).runner.match('option two'), undefined)
  assert.equal(setup({ open: [] }).runner.match('answer yes'), undefined)
  assert.deepEqual(setup({ open: [] }).runner.match('reply to the first item'), { kind: 'reply', n: 1 }, 'reply keeps its own "Nothing waiting."')
})

test('PQ19 the title is cleaned for speech; a multi-select question takes one option per answer', async () => {
  const dirty = await setup({ open: [question({ title: 'Pick [a] colour_now' })] }).runner.prepareReply({ kind: 'option', n: 1 })
  assert.equal(dirty.frozen.title, 'Pick a colour now')
  const multiSelect = setup({ open: [question({ payload: { questions: [{ ...COLOUR, multiSelect: true }] } })] })
  const { frozen, move } = await multiSelect.runner.prepareReply({ kind: 'option', n: 3 })
  await multiSelect.runner.sendReply(frozen, undefined, move.state)
  assert.deepEqual(multiSelect.calls[0][2], [{ id: 'c', selected: ['Green'] }])
})
