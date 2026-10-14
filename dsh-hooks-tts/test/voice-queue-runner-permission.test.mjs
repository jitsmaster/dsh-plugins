// Slice 6: approve / deny the first task-list item by voice. The runner freezes the item, words ONE read-back (the request summary
// first, with the existing approval rules: a summary that was cut, hidden or of an unknown tool cannot be approved by ear), and a strict
// yes goes through the card's own service calls (approve / deny) after the same stale check as a reply.
import assert from 'node:assert/strict'
import test from 'node:test'
import { createQueueRunner } from '../voice/queue-runner.js'

const perm = (over = {}) => ({
  id: 'p1', type: 'permission', sessionId: 's3', sessionTitle: 'dsh plugins', createdAt: 102, seq: 3, title: 'shell: git push', position: 1, risks: [],
  payload: { toolName: 'pwsh', summary: 'pwsh: git push origin main', detail: 'git push origin main' }, ...over,
})
const done = (over = {}) => ({ id: 'd1', type: 'completed', sessionId: 's1', createdAt: 100, seq: 1, title: 'Fix parser', payload: { reply: 'All done.' }, position: 1, ...over })
const question = (over = {}) => ({ id: 'q1', type: 'question', sessionId: 's2', createdAt: 101, seq: 2, title: 'Pick a colour', payload: { questions: [] }, position: 1, ...over })

function setup({ open = [perm()], snapshotId = 'e:1', ...over } = {}) {
  const h = { open, snapshotId, calls: [], total: undefined }
  const queue = {
    snapshot: () => ({ snapshotId: h.snapshotId, open: h.open }),
    count: () => ({ total: h.total ?? h.open.length, byType: {} }),
    approve: (id) => { h.calls.push(['approve', id]); h.open = h.open.filter((i) => i.id !== id); return { ok: true } },
    deny: (id) => { h.calls.push(['deny', id]); h.open = h.open.filter((i) => i.id !== id); return { ok: true } },
    ...over,
  }
  h.runner = createQueueRunner({ queue: () => queue, select: () => {} })
  return h
}

const NOT_APPROVABLE = 'That request is too long or unclear to approve by voice. Answer it on screen.'
const approve = { kind: 'approve' }
const deny = { kind: 'deny' }

test('PP1 approve freezes the item and reads the request summary back once: tool phrase, operand, session', async () => {
  const h = setup({ snapshotId: 'e:9' })
  const r = await h.runner.prepareReply(approve)
  assert.equal(r.ok, true)
  assert.equal(r.frozen.id, 'p1')
  assert.equal(r.frozen.type, 'permission')
  assert.equal(r.frozen.snapshotId, 'e:9')
  assert.equal(r.frozen.title, 'shell: git push')
  assert.ok(Object.isFrozen(r.frozen))
  assert.deepEqual(r.move, { kind: 'confirm', state: { decision: 'approve' }, line: 'I will approve run command git push origin main in dsh plugins. Shall I do it?' })
  assert.deepEqual(h.calls, [], 'nothing is decided before the yes')
})

test('PP2 deny reads the same summary back with "deny"', async () => {
  const r = await setup().runner.prepareReply(deny)
  assert.deepEqual(r.move, { kind: 'confirm', state: { decision: 'deny' }, line: 'I will deny run command git push origin main in dsh plugins. Shall I do it?' })
})

test('PP3 the session name is left out when there is none; symbols in the operand are spelled like the existing approval flow', async () => {
  const bare = await setup({ open: [perm({ sessionTitle: '' })] }).runner.prepareReply(approve)
  assert.equal(bare.move.line, 'I will approve run command git push origin main. Shall I do it?')
  const piped = await setup({ open: [perm({ sessionTitle: undefined, payload: { toolName: 'bash', summary: 'x', detail: 'ls | wc -l' } })] }).runner.prepareReply(approve)
  assert.equal(piped.move.line, 'I will approve run command ls pipe wc -l. Shall I do it?')
})

test('PP4 an operand longer than the spoken limit cannot be approved by voice (exact line); it can still be denied, with "and more"', async () => {
  const long = 'git push origin main --tags ' + 'x'.repeat(120)
  const h = setup({ open: [perm({ payload: { toolName: 'pwsh', summary: 's', detail: long } })] })
  assert.deepEqual(await h.runner.prepareReply(approve), { ok: false, outcome: 'not-approvable', line: NOT_APPROVABLE })
  const d = await h.runner.prepareReply(deny)
  assert.equal(d.ok, true)
  assert.match(d.move.line, /^I will deny run command git push origin main --tags x+ and more in dsh plugins\. Shall I do it\?$/)
})

test('PP5 a tool voice does not know cannot be approved; deny says what it can', async () => {
  const h = setup({ open: [perm({ payload: { toolName: 'my_tool', summary: 'x', detail: 'do stuff' } })] })
  assert.deepEqual(await h.runner.prepareReply(approve), { ok: false, outcome: 'not-approvable', line: NOT_APPROVABLE })
  assert.equal((await h.runner.prepareReply(deny)).move.line, 'I will deny my tool do stuff in dsh plugins. Shall I do it?')
})

test('PP6 no operand known (the queue carried no detail): not approvable, and "details not available" when denying', async () => {
  const h = setup({ open: [perm({ payload: { toolName: 'pwsh', summary: 'pwsh' } })] })
  assert.deepEqual(await h.runner.prepareReply(approve), { ok: false, outcome: 'not-approvable', line: NOT_APPROVABLE })
  assert.equal((await h.runner.prepareReply(deny)).move.line, 'I will deny run command details not available in dsh plugins. Shall I do it?')
})

test('PP7 hidden or non-ASCII characters in the operand make it not approvable', async () => {
  for (const detail of ['git push\u200b origin', 'echo caf\u00e9', 'rm \u202e txt.exe']) {
    const h = setup({ open: [perm({ payload: { toolName: 'pwsh', summary: 'x', detail } })] })
    assert.equal((await h.runner.prepareReply(approve)).outcome, 'not-approvable', JSON.stringify(detail))
  }
})

test('PP8 the request reason is read too; a reason that does not fit makes it not approvable', async () => {
  const ok = setup({ open: [perm({ payload: { toolName: 'pwsh', summary: 'x', detail: 'git push', reason: 'needs network' } })] })
  assert.equal((await ok.runner.prepareReply(approve)).move.line, 'I will approve run command git push, reason: needs network in dsh plugins. Shall I do it?')
  const long = setup({ open: [perm({ payload: { toolName: 'pwsh', summary: 'x', detail: 'git push', reason: 'because '.repeat(40) } })] })
  assert.equal((await long.runner.prepareReply(approve)).outcome, 'not-approvable')
})

test('PP9 the queue\'s risk warnings are read after the summary', async () => {
  const h = setup({ open: [perm({ payload: { toolName: 'pwsh', summary: 'x', detail: 'rm -rf build' }, risks: [{ code: 'recursive-delete', label: 'Deletes files recursively' }, { code: 'outside-workspace', label: 'Writes outside this session\u2019s workspace' }] })] })
  assert.equal((await h.runner.prepareReply(approve)).move.line, 'I will approve run command rm -rf build in dsh plugins. Warning: Deletes files recursively. Warning: Writes outside this session s workspace. Shall I do it?')
})

test('PP10 a permission command while the first item is another type gets a short correction, nothing frozen', async () => {
  const q = await setup({ open: [question()] }).runner.prepareReply(approve)
  assert.deepEqual(q, { ok: false, outcome: 'wrong-type', line: 'The first item is a question. Say an option, or reply.' })
  const d = await setup({ open: [done()] }).runner.prepareReply(deny)
  assert.deepEqual(d, { ok: false, outcome: 'wrong-type', line: 'The first item is a done item. Say reply.' })
  const first = await setup({ open: [question(), perm({ position: 2 })] }).runner.prepareReply(approve)
  assert.equal(first.outcome, 'wrong-type', 'only the FIRST item counts')
})

test('PP11 "reply to the first item" on a permission item says what to say instead', async () => {
  assert.deepEqual(await setup().runner.prepareReply({ kind: 'reply', n: 1 }), { ok: false, outcome: 'wrong-type', line: 'The first item is a permission request. Say approve or deny.' })
})

test('PP12 an empty queue says "Nothing waiting."', async () => {
  assert.deepEqual(await setup({ open: [] }).runner.prepareReply(approve), { ok: false, outcome: 'empty', line: 'Nothing waiting.' })
})

test('PP13 at the read-back anything but a yes cancels: no, other words, silence-words', async () => {
  const h = setup()
  const { frozen, move } = await h.runner.prepareReply(approve)
  for (const input of [{ step: 'confirm', kind: 'no', text: 'no' }, { step: 'confirm', kind: 'text', text: 'wait what' }, { step: 'confirm', kind: 'text', text: 'approve it' }]) {
    assert.deepEqual(await h.runner.replyStep(frozen, move.state, input), { kind: 'cancel' }, JSON.stringify(input))
  }
  assert.deepEqual(h.calls, [])
})

test('PP14 the yes approves through the card service call (approve) once and says how many are waiting', async () => {
  const h = setup({ open: [perm(), done({ id: 'd2', position: 2 })] })
  const { frozen, move } = await h.runner.prepareReply(approve)
  assert.deepEqual(await h.runner.sendReply(frozen, undefined, move.state), { outcome: 'sent', line: 'Task shell: git push, approved. One waiting.' })
  assert.deepEqual(h.calls, [['approve', 'p1']])
})

test('PP15 the yes denies through deny; nothing left says "Nothing waiting."', async () => {
  const h = setup()
  const { frozen, move } = await h.runner.prepareReply(deny)
  assert.deepEqual(await h.runner.sendReply(frozen, undefined, move.state), { outcome: 'sent', line: 'Task shell: git push, denied. Nothing waiting.' })
  assert.deepEqual(h.calls, [['deny', 'p1']])
})

test('PP16 stale: the item left, changed, or became another type -> "That item changed. Nothing done." and nothing is decided', async () => {
  const gone = setup()
  const a = await gone.runner.prepareReply(approve)
  gone.open = [question({ id: 'q9' })]; gone.snapshotId = 'e:2'
  assert.deepEqual(await gone.runner.sendReply(a.frozen, undefined, a.move.state), { outcome: 'changed', line: 'That item changed. Nothing done.' })
  const swapped = setup()
  const b = await swapped.runner.prepareReply(approve)
  swapped.open = [perm({ seq: 9 })]; swapped.snapshotId = 'e:2'
  assert.equal((await swapped.runner.sendReply(b.frozen, undefined, b.move.state)).outcome, 'changed')
  const other = setup()
  const c = await other.runner.prepareReply(approve)
  other.open = [question({ id: 'p1' })]; other.snapshotId = 'e:2'
  assert.equal((await other.runner.sendReply(c.frozen, undefined, c.move.state)).outcome, 'changed')
  assert.deepEqual([gone.calls, swapped.calls, other.calls], [[], [], []])
})

test('PP17 an unrelated change elsewhere in the queue does not block the yes', async () => {
  const h = setup()
  const { frozen, move } = await h.runner.prepareReply(approve)
  h.open = [perm({ title: 'a new title' }), done({ id: 'd7', position: 2 })]; h.snapshotId = 'e:2'
  assert.equal((await h.runner.sendReply(frozen, undefined, move.state)).outcome, 'sent')
})

test('PP18 the service answering not-pending (decided on screen meanwhile) is "changed"; another refusal is a failure with its reason', async () => {
  const late = setup({ approve: () => ({ ok: false, error: 'not-pending' }) })
  const a = await late.runner.prepareReply(approve)
  assert.deepEqual(await late.runner.sendReply(a.frozen, undefined, a.move.state), { outcome: 'changed', line: 'That item changed. Nothing done.' })
  const bad = setup({ approve: () => ({ ok: false, error: 'bad-decision' }) })
  const b = await bad.runner.prepareReply(approve)
  await assert.rejects(() => bad.runner.sendReply(b.frozen, undefined, b.move.state), /bad-decision/)
  const odd = setup({ approve: () => undefined })
  const c = await odd.runner.prepareReply(approve)
  await assert.rejects(() => odd.runner.sendReply(c.frozen, undefined, c.move.state), /could not send/)
  const boom = setup({ approve: () => { throw new Error('capture broke') } })
  const d = await boom.runner.prepareReply(approve)
  await assert.rejects(() => boom.runner.sendReply(d.frozen, undefined, d.move.state), /capture broke/)
})

test('PP19 a service without approve / deny, or a state without a decision, is a failure rather than a crash', async () => {
  const h = setup({ approve: undefined })
  const { frozen, move } = await h.runner.prepareReply(approve)
  await assert.rejects(() => h.runner.sendReply(frozen, undefined, move.state), /approve is not available/)
  const g = setup()
  const p = await g.runner.prepareReply(approve)
  await assert.rejects(() => g.runner.sendReply(p.frozen, undefined, undefined), /no decision/)
  await assert.rejects(() => g.runner.sendReply(p.frozen, undefined, { decision: 'maybe' }), /no decision/)
  assert.deepEqual(g.calls, [])
})

test('PP20 the count failing after the decision does not turn it into a failure', async () => {
  const h = setup({ count: () => { throw new Error('busy') } })
  const { frozen, move } = await h.runner.prepareReply(approve)
  assert.deepEqual(await h.runner.sendReply(frozen, undefined, move.state), { outcome: 'sent', line: 'Task shell: git push, approved.' })
})

test('PP21 match: approve / deny are commands only while the list has something in it (else the old LLM flow keeps them)', () => {
  assert.deepEqual(setup().runner.match('approve it'), { kind: 'approve' })
  assert.deepEqual(setup().runner.match('Deny.'), { kind: 'deny' })
  assert.equal(setup({ open: [] }).runner.match('approve'), undefined)
  assert.equal(setup({ snapshot: () => { throw new Error('x') } }).runner.match('approve'), undefined)
  assert.equal(setup({ snapshot: undefined }).runner.match('approve'), undefined)
  assert.equal(createQueueRunner({ queue: () => undefined, select: () => {} }).match('approve'), undefined)
})
