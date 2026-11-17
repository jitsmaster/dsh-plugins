import test from 'node:test'
import assert from 'node:assert/strict'
import { createRenamer } from '../renamer.js'

const agent = { id: 'sess-me', session: { header: {} } }

function setup({ answer = { answers: [{ id: 'rename', selected: ['Rename'] }] }, noAsk = false, noController = false, askThrows, renameThrows } = {}) {
  const asked = []
  const renamed = []
  const svc = {
    userQuestions: noAsk ? {} : { ask: async (req) => { asked.push(req); if (askThrows) throw askThrows; return answer } },
    sessionController: noController ? {} : { rename: async (r) => { if (renameThrows) throw renameThrows; renamed.push(r) } },
  }
  const renamer = createRenamer({ get: (n) => svc[n], titleOf: () => 'Old Title', log: () => {} })
  return { renamer, asked, renamed }
}
const run = (s, title = 'PR 6785') => s.renamer.rename({ agent, title, signal: undefined })

test('asks the user with old and new title, renames only after approval, and returns no completion message', async () => {
  const s = setup()
  const res = await run(s)
  assert.equal(s.asked.length, 1)
  assert.equal(s.asked[0].agent, agent)
  const q = s.asked[0].questions[0]
  assert.match(q.question, /Old Title/)
  assert.match(q.question, /PR 6785/)
  assert.deepEqual(q.options.map((o) => o.label), ['Rename', 'Keep current name'])
  assert.deepEqual(s.renamed, [{ sessionId: 'sess-me', title: 'PR 6785' }])
  assert.equal(res, undefined)
})

test('declining renames nothing', async () => {
  const s = setup({ answer: { answers: [{ id: 'rename', selected: ['Keep current name'] }] } })
  await run(s)
  assert.equal(s.renamed.length, 0)
})

test('nothing is renamed before the question is answered', async () => {
  let release
  const gate = new Promise((r) => { release = r })
  const renamed = []
  const svc = { userQuestions: { ask: async () => { await gate; return { answers: [{ id: 'rename', selected: ['Rename'] }] } } }, sessionController: { rename: async (r) => renamed.push(r) } }
  const p = createRenamer({ get: (n) => svc[n], titleOf: () => 'Old' }).rename({ agent, title: 'New' })
  await new Promise((r) => setTimeout(r, 5))
  assert.equal(renamed.length, 0)
  release(); await p
  assert.equal(renamed.length, 1)
})

test('bad input is rejected without asking', async () => {
  const s = setup()
  for (const title of ['', '   ', null, 5, '\u200b']) assert.deepEqual(await run(s, title), { status: 'rejected', reason: 'empty' })
  assert.deepEqual(await run(s, 'Old Title'), { status: 'rejected', reason: 'unchanged' })
  assert.deepEqual(await s.renamer.rename({ title: 'x' }), { status: 'rejected', reason: 'no-sender' })
  assert.equal((await s.renamer.rename({ agent: { id: 'sub', session: { header: { origin: 'subagent' } } }, title: 'x' })).reason, 'sub-agent-sender')
  assert.equal(s.asked.length, 0)
})

test('title is collapsed to one line and clipped to 120', async () => {
  const s = setup()
  await run(s, '  a\n b\u0000  ')
  assert.equal(s.renamed[0].title, 'a b')
  const t = setup()
  await run(t, 'x'.repeat(300))
  assert.equal(t.renamed[0].title.length, 120)
})

test('missing services and failures are rejected, never renaming', async () => {
  assert.equal((await run(setup({ noAsk: true }))).reason, 'no-questions')
  const nc = setup({ noController: true })
  assert.equal((await run(nc)).reason, 'no-controller')
  assert.equal(nc.asked.length, 0)
  assert.equal((await run(setup({ askThrows: new Error('cancelled') }))).reason, 'question-failed')
  assert.equal((await run(setup({ renameThrows: new Error('boom') }))).reason, 'rename-failed')
})
