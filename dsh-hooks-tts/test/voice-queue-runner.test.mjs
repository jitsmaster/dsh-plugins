// The adapter between the flow's fast path and dsh-review-queue's reviewQueue service: intents in, outcome lines out.
import assert from 'node:assert/strict'
import test from 'node:test'
import { countLine, createQueueRunner } from '../voice/queue-runner.js'

function setup(over = {}) {
  const calls = []
  const selected = []
  const queue = {
    uiCommand: (cmd) => { calls.push(['uiCommand', cmd]); return { ok: true, seq: 1 } },
    count: () => { calls.push(['count']); return { total: 0, byType: { question: 0, permission: 0, completed: 0 } } },
    readPosition: (n) => { calls.push(['readPosition', n]); return { ok: true, id: 'i1' } },
    next: () => { calls.push(['next']); return { ok: true, id: 'i2' } },
    again: () => { calls.push(['again']); return { ok: true, id: 'i1' } },
    stop: () => { calls.push(['stop']); return { ok: true } },
    openTarget: () => { calls.push(['openTarget']); return { sessionId: 'sess-1', title: 'Fix the parser' } },
    ...over,
  }
  const runner = createQueueRunner({ queue: () => queue, select: (id) => selected.push(id) })
  return { runner, calls, selected, queue }
}

test('match: a matcher result when the queue exists, nothing when it is absent', () => {
  assert.deepEqual(setup().runner.match('show the task list'), { kind: 'show' })
  assert.equal(setup().runner.match('fix the parser'), undefined)
  const absent = createQueueRunner({ queue: () => undefined, select: () => {} })
  assert.equal(absent.match('show the task list'), undefined)
  const throwing = createQueueRunner({ queue: () => { throw new Error('no service') }, select: () => {} })
  assert.equal(throwing.match('show the task list'), undefined)
  assert.doesNotThrow(() => throwing.stop())
  assert.equal(createQueueRunner({ select: () => {} }).match('show the task list'), undefined)
})

test('show and hide broadcast the ui command and say so', async () => {
  const { runner, calls } = setup()
  assert.deepEqual(await runner.run({ kind: 'show' }), { outcome: 'show', line: 'Coding Boss Review Queue showing.' })
  assert.deepEqual(await runner.run({ kind: 'hide' }), { outcome: 'hide', line: 'Coding Boss Review Queue hidden.' })
  assert.deepEqual(calls, [['uiCommand', 'show'], ['uiCommand', 'hide']])
})

test('a refused ui command is a failure with its reason', async () => {
  const { runner } = setup({ uiCommand: () => ({ ok: false, error: 'bad-command' }) })
  await assert.rejects(() => runner.run({ kind: 'show' }), /bad-command/)
})

test('count: the exact wording table', () => {
  const t = (total, q = 0, p = 0, c = 0) => countLine({ total, byType: { question: q, permission: p, completed: c } })
  assert.equal(t(0), 'Nothing waiting.')
  assert.equal(t(3, 1, 1, 1), 'Three waiting: one question, one permission, one done.')
  assert.equal(t(1, 0, 0, 1), 'One waiting: one done.')
  assert.equal(t(1, 1), 'One waiting: one question.')
  assert.equal(t(2, 2), 'Two waiting: two questions.')
  assert.equal(t(2, 0, 2), 'Two waiting: two permissions.')
  assert.equal(t(2, 0, 0, 2), 'Two waiting: two done.')
  assert.equal(t(5, 0, 2, 3), 'Five waiting: two permissions, three done.')
  assert.equal(t(6, 3, 0, 3), 'Six waiting: three questions, three done.')
  assert.equal(t(7, 2, 2, 3), 'Seven waiting: two questions, two permissions, three done.')
  assert.equal(t(20, 20), 'Twenty waiting: twenty questions.')
  assert.equal(t(21, 20, 1), '21 waiting: twenty questions, one permission.')
  assert.equal(t(25, 0, 0, 25), '25 waiting: 25 done.')
  assert.equal(t(120, 100, 10, 10), '120 waiting: 100 questions, ten permissions, ten done.')
  assert.equal(countLine({ total: 2, byType: { question: 1 } }), 'Two waiting: one question.', 'a missing type counts as none')
  assert.equal(countLine({ total: 2, byType: { question: 1, 'pr-merged': 1 } }), 'Two waiting: one question, one merged pull request.')
  assert.equal(countLine({ total: 2, byType: { 'pr-merged': 2 } }), 'Two waiting: two merged pull requests.')
  assert.equal(countLine({ total: 0 }), 'Nothing waiting.')
  assert.equal(countLine(undefined), 'Nothing waiting.')
})

test('count runs through the queue', async () => {
  const { runner } = setup({ count: () => ({ total: 3, byType: { question: 1, permission: 1, completed: 1 } }) })
  assert.deepEqual(await runner.run({ kind: 'count' }), { outcome: 'count', line: 'Three waiting: one question, one permission, one done.' })
  assert.deepEqual(await setup().runner.run({ kind: 'count' }), { outcome: 'count', line: 'Nothing waiting.' })
})

test('read, next and again start reading with no line before it', async () => {
  const { runner, calls } = setup()
  assert.deepEqual(await runner.run({ kind: 'read', n: 2 }), { outcome: 'reading' })
  assert.deepEqual(await runner.run({ kind: 'next' }), { outcome: 'reading' })
  assert.deepEqual(await runner.run({ kind: 'again' }), { outcome: 'reading' })
  assert.deepEqual(calls, [['readPosition', 2], ['next'], ['again']])
})

test('reading failures: the exact lines', async () => {
  const fail = (error, extra = {}) => ({ ok: false, error, ...extra })
  const line = async (kind, result, n) => (await setup({ readPosition: () => result, next: () => result, again: () => result }).runner.run(n === undefined ? { kind } : { kind, n }))
  assert.deepEqual(await line('read', fail('empty'), 1), { outcome: 'empty', line: 'Nothing waiting.' })
  assert.deepEqual(await line('read', fail('no-item'), 7), { outcome: 'no-item', line: 'There is no item 7.' })
  assert.deepEqual(await line('next', fail('no-item', { n: 3 })), { outcome: 'no-item', line: 'There is no item 3.' })
  assert.deepEqual(await line('next', fail('no-item')), { outcome: 'no-item', line: 'There is no next item.' })
  assert.deepEqual(await line('next', fail('empty')), { outcome: 'empty', line: 'Nothing waiting.' })
  assert.deepEqual(await line('again', fail('nothing-read')), { outcome: 'nothing-read', line: 'Nothing has been read yet.' })
  assert.deepEqual(await line('read', fail('muted'), 1), { outcome: 'muted' }, 'muted: silence')
  assert.deepEqual(await line('again', fail('no-speaker')), { outcome: 'no-speaker', line: 'The speaker is not available.' })
})

test('any other reading error is a failure the flow turns into "That failed: ..."', async () => {
  const { runner } = setup({ readPosition: () => ({ ok: false, error: 'nothing-to-read' }) })
  await assert.rejects(() => runner.run({ kind: 'read', n: 1 }), /nothing-to-read/)
  const { runner: r2 } = setup({ again: () => undefined })
  await assert.rejects(() => r2.run({ kind: 'again' }))
})

test('stop stops the reader and is silent (the flow also cuts speech)', async () => {
  const { runner, calls } = setup()
  assert.deepEqual(await runner.run({ kind: 'stop' }), { outcome: 'stopped', silence: true })
  assert.deepEqual(calls, [['stop']])
})

test('stop() on the runner is the hotkey path and never throws', () => {
  const { runner, calls } = setup()
  runner.stop()
  assert.deepEqual(calls, [['stop']])
  const bad = createQueueRunner({ queue: () => ({ stop: () => { throw new Error('x') } }), select: () => {} })
  assert.throws(() => bad.stop(), /x/, 'the flow guards it, the runner stays simple')
})

test('open selects the first item session, hides the list and says Opened <title>', async () => {
  const { runner, calls, selected } = setup()
  assert.deepEqual(await runner.run({ kind: 'open' }), { outcome: 'opened', line: 'Opened Fix the parser.' })
  assert.deepEqual(selected, ['sess-1'])
  assert.deepEqual(calls, [['openTarget'], ['uiCommand', 'hide']])
})

test('open: the title is spoken the way the speaker says it, without a doubled full stop', async () => {
  const { runner } = setup({ openTarget: () => ({ sessionId: 's', title: 'Fix_the *parser*.' }) })
  const r = await runner.run({ kind: 'open' })
  assert.equal(r.line, 'Opened Fix the parser.')
  const blank = setup({ openTarget: () => ({ sessionId: 's', title: '###' }) })
  assert.equal((await blank.runner.run({ kind: 'open' })).line, 'Opened the first item.')
})

test('open with nothing waiting says so and selects nothing', async () => {
  const { runner, selected, calls } = setup({ openTarget: () => undefined })
  assert.deepEqual(await runner.run({ kind: 'open' }), { outcome: 'empty', line: 'Nothing waiting.' })
  assert.deepEqual(selected, [])
  assert.ok(!calls.some((c) => c[0] === 'uiCommand'))
})

test('open: an item with no session is a failure and selects nothing', async () => {
  const { runner, selected } = setup({ openTarget: () => ({ title: 'x' }) })
  await assert.rejects(() => runner.run({ kind: 'open' }), /no session/)
  assert.deepEqual(selected, [])
})

test('open still reports success when hiding the list fails (the session was selected)', async () => {
  const { runner, selected } = setup({ uiCommand: () => { throw new Error('ui down') } })
  const r = await runner.run({ kind: 'open' })
  assert.equal(r.line, 'Opened Fix the parser.')
  assert.deepEqual(selected, ['sess-1'])
})

test('a service without the newer methods fails cleanly instead of crashing', async () => {
  const { runner } = setup({ openTarget: undefined, next: undefined })
  await assert.rejects(() => runner.run({ kind: 'open' }), /not available/)
  await assert.rejects(() => runner.run({ kind: 'next' }), /not available/)
})

test('run with the queue gone fails with a short reason', async () => {
  const gone = createQueueRunner({ queue: () => undefined, select: () => {} })
  await assert.rejects(() => gone.run({ kind: 'count' }), /task list is not available/)
})

test('run with an unknown kind fails', async () => {
  await assert.rejects(() => setup().runner.run({ kind: 'bogus' }), /unknown/i)
})
