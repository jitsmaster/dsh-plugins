// Slice 5: the queue-runner half of "reply by voice". prepareReply freezes the first item, replyReadBack words the confirm line,
// sendReply re-checks the item and goes through the card's own service call (reply), then says how many are still waiting.
import assert from 'node:assert/strict'
import test from 'node:test'
import { createQueueRunner } from '../voice/queue-runner.js'

const done = (over = {}) => ({ id: 'd1', type: 'completed', sessionId: 's1', createdAt: 100, seq: 1, title: 'Fix parser', payload: { reply: 'All done.' }, position: 1, ...over })
const question = (over = {}) => ({ id: 'q1', type: 'question', sessionId: 's2', createdAt: 101, seq: 2, title: 'Pick a colour', payload: {}, position: 1, ...over })
const permission = (over = {}) => ({ id: 'p1', type: 'permission', sessionId: 's3', createdAt: 102, seq: 3, title: 'Run a command', payload: {}, position: 1, ...over })

/** A fake reviewQueue service whose snapshot is mutable through h.open / h.snapshotId. */
function setup({ open = [done()], snapshotId = 'e:1', ...over } = {}) {
  const h = { open, snapshotId, replies: [], total: undefined }
  const queue = {
    snapshot: () => ({ snapshotId: h.snapshotId, open: h.open }),
    count: () => ({ total: h.total ?? h.open.length, byType: {} }),
    // Like the real service: a sent reply resolves the item, so it leaves the open list.
    reply: async (id, text) => { h.replies.push([id, text]); h.open = h.open.filter((i) => i.id !== id); return { ok: true } },
    ...over,
  }
  h.runner = createQueueRunner({ queue: () => queue, select: () => {} })
  return h
}

test('P1 prepareReply freezes the first item: id, type, snapshotId and its spoken title', async () => {
  const h = setup({ open: [done(), question({ position: 2 })], snapshotId: 'e:9' })
  const r = await h.runner.prepareReply({ kind: 'reply', n: 1 })
  assert.equal(r.ok, true)
  assert.equal(r.frozen.id, 'd1')
  assert.equal(r.frozen.type, 'completed')
  assert.equal(r.frozen.snapshotId, 'e:9')
  assert.equal(r.frozen.title, 'Fix parser')
  assert.ok(Object.isFrozen(r.frozen))
})

test('P2 an empty queue says "Nothing waiting."', async () => {
  const r = await setup({ open: [] }).runner.prepareReply({ kind: 'reply', n: 1 })
  assert.deepEqual(r, { ok: false, outcome: 'empty', line: 'Nothing waiting.' })
})

test('P3 a permission first item has no dictation (slice 6: approve or deny), and a question the voice cannot walk is for the screen: one line each', async () => {
  assert.deepEqual(await setup({ open: [question()] }).runner.prepareReply({ kind: 'reply', n: 1 }), { ok: false, outcome: 'unsupported', line: 'That question cannot be answered by voice. Answer it on screen.' })
  assert.deepEqual(await setup({ open: [permission()] }).runner.prepareReply({ kind: 'reply', n: 1 }), { ok: false, outcome: 'wrong-type', line: 'The first item is a permission request. Say approve or deny.' })
})

test('P3b only the FIRST item counts: a done item at position 2 does not make the reply possible', async () => {
  const r = await setup({ open: [question(), done({ position: 2 })] }).runner.prepareReply({ kind: 'reply', n: 1 })
  assert.equal(r.ok, false)
  assert.equal(r.outcome, 'unsupported')
})

test('P4 a missing service or a service without snapshot() is a failure the flow speaks', async () => {
  const absent = createQueueRunner({ queue: () => undefined, select: () => {} })
  await assert.rejects(() => absent.prepareReply({ kind: 'reply', n: 1 }), /not available/)
  const partial = createQueueRunner({ queue: () => ({}), select: () => {} })
  await assert.rejects(() => partial.prepareReply({ kind: 'reply', n: 1 }), /snapshot is not available/)
  await assert.rejects(() => absent.sendReply({ id: 'x', type: 'completed', title: 'T' }, 'hi'), /not available/)
})

test('P5 the title is cleaned for speech; an empty one falls back to "the first item"', async () => {
  const dirty = await setup({ open: [done({ title: 'Fix [the] parser_v2!!' })] }).runner.prepareReply({ kind: 'reply', n: 1 })
  assert.equal(dirty.frozen.title, 'Fix the parser v2')
  const blank = await setup({ open: [done({ title: '   ' })] }).runner.prepareReply({ kind: 'reply', n: 1 })
  assert.equal(blank.frozen.title, 'the first item')
  const missing = await setup({ open: [done({ title: undefined })] }).runner.prepareReply({ kind: 'reply', n: 1 })
  assert.equal(missing.frozen.title, 'the first item')
})

test('P6 replyReadBack: the exact confirm wording', () => {
  const { runner } = setup()
  const frozen = { id: 'd1', type: 'completed', title: 'Fix parser' }
  assert.equal(runner.replyReadBack(frozen, 'add tests'), 'Send to Fix parser: add tests. Say yes to send, or say the prompt again to replace it.')
})

test('P6b a text that already ends with punctuation gets no second full stop', () => {
  const { runner } = setup()
  const frozen = { title: 'Fix parser' }
  assert.equal(runner.replyReadBack(frozen, 'is it done?'), 'Send to Fix parser: is it done? Say yes to send, or say the prompt again to replace it.')
  assert.equal(runner.replyReadBack(frozen, 'thanks!'), 'Send to Fix parser: thanks! Say yes to send, or say the prompt again to replace it.')
  assert.equal(runner.replyReadBack(frozen, 'ok.'), 'Send to Fix parser: ok. Say yes to send, or say the prompt again to replace it.')
})

test('P7 sendReply sends through the card service call (reply) once, with the frozen id and the text, and counts what is left', async () => {
  const h = setup({ open: [done(), done({ id: 'd2', position: 2 })] })
  const { frozen } = await h.runner.prepareReply({ kind: 'reply', n: 1 })
  const result = await h.runner.sendReply(frozen, 'add tests')
  assert.deepEqual(h.replies, [['d1', 'add tests']])
  assert.deepEqual(result, { outcome: 'sent', line: 'Task Fix parser, reply sent. One waiting.' })
})

test('P7b nothing left after the send: "Nothing waiting."', async () => {
  const h = setup({})
  const { frozen } = await h.runner.prepareReply({ kind: 'reply', n: 1 })
  assert.deepEqual(await h.runner.sendReply(frozen, 'thanks'), { outcome: 'sent', line: 'Task Fix parser, reply sent. Nothing waiting.' })
})

test('P7c the waiting count is said in words like the count line, digits above twenty', async () => {
  const h = setup({})
  h.total = 3
  const { frozen } = await h.runner.prepareReply({ kind: 'reply', n: 1 })
  assert.equal((await h.runner.sendReply(frozen, 'x')).line, 'Task Fix parser, reply sent. Three waiting.')
  const big = setup({})
  big.total = 25
  const prep = await big.runner.prepareReply({ kind: 'reply', n: 1 })
  assert.equal((await big.runner.sendReply(prep.frozen, 'x')).line, 'Task Fix parser, reply sent. 25 waiting.')
})

test('P8 an item that left the queue is "That item changed. Nothing done." and nothing is sent', async () => {
  const h = setup({})
  const { frozen } = await h.runner.prepareReply({ kind: 'reply', n: 1 })
  h.open = [question({ id: 'q9' })]
  h.snapshotId = 'e:2'
  assert.deepEqual(await h.runner.sendReply(frozen, 'add tests'), { outcome: 'changed', line: 'That item changed. Nothing done.' })
  assert.deepEqual(h.replies, [])
})

test('P8b an item whose message changed (same id) is refused when the snapshot moved on', async () => {
  const h = setup({})
  const { frozen } = await h.runner.prepareReply({ kind: 'reply', n: 1 })
  h.open = [done({ payload: { reply: 'A different message.' } })]
  h.snapshotId = 'e:2'
  assert.equal((await h.runner.sendReply(frozen, 'add tests')).outcome, 'changed')
  assert.deepEqual(h.replies, [])
})

test('P8c an unrelated change elsewhere in the queue (new snapshotId, same item) does not block the send', async () => {
  const h = setup({})
  const { frozen } = await h.runner.prepareReply({ kind: 'reply', n: 1 })
  h.open = [done({ position: 1, title: 'A better title', summary: 'late summary' }), question({ id: 'q2', position: 2 })]
  h.snapshotId = 'e:2'
  const result = await h.runner.sendReply(frozen, 'add tests')
  assert.equal(result.outcome, 'sent')
  assert.deepEqual(h.replies, [['d1', 'add tests']])
})

test('P8d the item moving to another position is still the same item', async () => {
  const h = setup({})
  const { frozen } = await h.runner.prepareReply({ kind: 'reply', n: 1 })
  h.open = [question({ id: 'q2', position: 1 }), done({ position: 2 })]
  h.snapshotId = 'e:2'
  assert.equal((await h.runner.sendReply(frozen, 'x')).outcome, 'sent')
})

test('P8e an item of another type under the same id is refused', async () => {
  const h = setup({})
  const { frozen } = await h.runner.prepareReply({ kind: 'reply', n: 1 })
  h.open = [question({ id: 'd1' })]
  h.snapshotId = 'e:2'
  assert.equal((await h.runner.sendReply(frozen, 'x')).outcome, 'changed')
})

test('P9 the service refusing the reply: not-open is "changed", any other reason is a failure with that reason', async () => {
  const gone = setup({ reply: async () => ({ ok: false, error: 'not-open' }) })
  const a = await gone.runner.prepareReply({ kind: 'reply', n: 1 })
  assert.deepEqual(await gone.runner.sendReply(a.frozen, 'x'), { outcome: 'changed', line: 'That item changed. Nothing done.' })
  const down = setup({ reply: async () => ({ ok: false, error: 'no-controller' }) })
  const b = await down.runner.prepareReply({ kind: 'reply', n: 1 })
  await assert.rejects(() => down.runner.sendReply(b.frozen, 'x'), /no-controller/)
  const odd = setup({ reply: async () => undefined })
  const c = await odd.runner.prepareReply({ kind: 'reply', n: 1 })
  await assert.rejects(() => odd.runner.sendReply(c.frozen, 'x'), /could not send/)
})

test('P9b a reply that throws is a failure with its message', async () => {
  const h = setup({ reply: async () => { throw new Error('prompt rejected') } })
  const { frozen } = await h.runner.prepareReply({ kind: 'reply', n: 1 })
  await assert.rejects(() => h.runner.sendReply(frozen, 'x'), /prompt rejected/)
})

test('P10 a count() that fails after a successful send does not turn it into a failure: the line just omits the count', async () => {
  const h = setup({ count: () => { throw new Error('store busy') } })
  const { frozen } = await h.runner.prepareReply({ kind: 'reply', n: 1 })
  assert.deepEqual(await h.runner.sendReply(frozen, 'x'), { outcome: 'sent', line: 'Task Fix parser, reply sent.' })
  assert.equal(h.replies.length, 1)
})

test('P11 a service without reply() is a failure, not a crash', async () => {
  const h = setup({ reply: undefined })
  const { frozen } = await h.runner.prepareReply({ kind: 'reply', n: 1 })
  await assert.rejects(() => h.runner.sendReply(frozen, 'x'), /reply is not available/)
})

test('P12 a frozen item type with no handler is refused (the handler table is the extension point)', async () => {
  const h = setup({})
  await assert.rejects(() => h.runner.sendReply({ id: 'q1', type: 'weird', snapshotId: 'e:1', title: 'T' }, 'x'), /no voice reply/)
  assert.deepEqual(await setup({ open: [{ ...done(), type: 'weird' }] }).runner.prepareReply({ kind: 'reply', n: 1 }), { ok: false, outcome: 'unsupported', line: 'This item cannot be answered by voice. Answer it on screen.' })
})

test('P13 the matcher still yields the reply intent that prepareReply takes', () => {
  assert.deepEqual(setup().runner.match('reply to the first item'), { kind: 'reply', n: 1 })
})
