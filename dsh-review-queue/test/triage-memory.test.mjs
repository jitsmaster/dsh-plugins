// Learning from reversals: a case bank (Memento-style) and a lesson bank (ReasoningBank-style), recalled by code. A reversed AI proposal must not
// be proposed again, and the card must say it is based on a past correction.
import test from 'node:test'
import assert from 'node:assert/strict'
import { createStore } from '../store.js'
import { createTriageMemory, tokensOf, jaccard, signatureOf, VETO_SIMILARITY, LESSON_ACTIVE_MS } from '../triage-memory.js'
import { createTriageRunner, lessonFeedbackOf, userDidWhatAiWould } from '../triage-runner.js'
import { createTriageJudge } from '../triage-judge.js'
import { loadClient } from './client-todo-helpers.mjs'

const GOOD = {
  needs_decision: false, answer_basis: 'none', answer: null, evidence_quote: null, evidence_source: null,
  matched_rule: 'ro-permission', attention: 10, reversible: true, touches_outside_workspace: false, read_only: true,
}
const perm = (detail = 'git status') => ({ type: 'permission', sessionId: 's1', workspace: 'D:/w', payload: { toolName: 'shell', detail, summary: detail } })
const triage = (over = {}) => ({ verdict: 'handle', ruleId: 'ro-permission', ruleVersion: 'abcd1234', would: 'approve this read-only command', score: 10, ...over })
const resolved = (item, kind) => ({ ...item, status: 'resolved', resolution: { kind }, triage: triage() })
const memIo = () => { const box = { text: undefined }; return { box, io: { read: () => box.text, write: (t) => { box.text = t } } } }

test('tokensOf drops stop words and short words; jaccard measures overlap', () => {
  assert.deepEqual(tokensOf('The git log of the repo'), ['git', 'log', 'repo'])
  assert.equal(jaccard(['a1', 'b1'], ['a1', 'b1']), 1)
  assert.equal(jaccard(['a1'], ['b1']), 0)
  assert.equal(jaccard([], ['b1']), 0)
})

test('signatureOf: tool + command, git with its subcommand', () => {
  assert.equal(signatureOf(perm('git log -n 5')), 'shell:git log')
  assert.equal(signatureOf(perm('cat README.md')), 'shell:cat')
})

test('an overrule makes a case AND one lesson; a second overrule of the same thing counts up the same lesson', () => {
  const m = createTriageMemory()
  const r1 = m.record({ item: resolved(perm('git log'), 'denied'), review: 'overruled' })
  assert.ok(r1.lesson.id)
  const r2 = m.record({ item: resolved(perm('git log -n 3'), 'denied'), review: 'overruled' })
  assert.equal(r2.lesson.id, r1.lesson.id)
  assert.equal(m.lessons().length, 1)
  assert.equal(m.lessons()[0].count, 2)
  assert.equal(m.cases().length, 2)
  assert.match(m.lessons()[0].title, /Keep the command "git log" for the user/)
})

test('an agreement is a case only (no lesson), and counts for a matching lesson', () => {
  const m = createTriageMemory()
  assert.equal(m.record({ item: resolved(perm('ls'), 'approved'), review: 'matched-user' }).lesson, undefined)
  assert.equal(m.lessons().length, 0)
  assert.equal(m.cases().length, 1)
  m.record({ item: resolved(perm('git log'), 'denied'), review: 'overruled' })
  m.record({ item: resolved(perm('git log'), 'approved'), review: 'matched-user' })
  assert.equal(m.lessons()[0].agreed, 1)
})

test('recall: the same signature is a code veto; unrelated items and other classes are not', () => {
  const m = createTriageMemory()
  m.record({ item: resolved(perm('git log'), 'denied'), review: 'overruled' })
  const hit = m.recall(perm('git log --oneline'), ['ro-permission'])
  assert.ok(hit.veto)
  assert.equal(hit.veto.similarity, 1)
  assert.equal(m.recall(perm('ls'), ['ro-permission']).veto, undefined)
  assert.equal(m.recall({ type: 'completed', payload: { reply: 'git log' } }, ['ro-permission']).veto, undefined)
  assert.equal(m.recall(perm('git log'), ['another-rule']).veto, undefined)
})

test('recall: a weaker token match is context for the judge, not a veto', () => {
  const m = createTriageMemory()
  m.record({ item: { ...resolved({ type: 'completed', sessionId: 's', payload: { request: 'migrate billing tables', reply: 'migrated the billing tables, all green' } }, 'replied'), triage: triage({ ruleId: 'green-done' }) }, review: 'overruled' })
  const probe = { type: 'completed', payload: { request: 'update billing tables', reply: 'migrate cleanup' } }
  const r = m.recall(probe, ['green-done'])
  assert.ok(VETO_SIMILARITY > 0.3)
  assert.equal(r.veto, undefined)
  assert.equal(r.context.length, 1)
  assert.ok(r.context[0].similarity >= 0.3 && r.context[0].similarity < VETO_SIMILARITY)
})

test('a lesson retires: too strict (agreed catches up) or not met for a long time', () => {
  let t = 1000
  const m = createTriageMemory({ now: () => t })
  const id = m.record({ item: resolved(perm('git log'), 'denied'), review: 'overruled' }).lesson.id
  assert.ok(m.recall(perm('git log'), ['ro-permission']).veto)
  assert.equal(m.agree(id), true) // the user approved what the lesson held back
  assert.equal(m.recall(perm('git log'), ['ro-permission']).veto, undefined)
  const id2 = m.record({ item: resolved(perm('git diff'), 'denied'), review: 'overruled' }).lesson.id
  t += LESSON_ACTIVE_MS + 1
  assert.equal(m.recall(perm('git diff'), ['ro-permission']).veto, undefined)
  assert.equal(m.lessons().find((l) => l.id === id2).active, false)
})

test('confirm keeps a lesson fresh; forget deletes it', () => {
  const m = createTriageMemory()
  const id = m.record({ item: resolved(perm('git log'), 'denied'), review: 'overruled' }).lesson.id
  assert.equal(m.confirm(id), true)
  assert.equal(m.forget(id), true)
  assert.equal(m.forget(id), false)
  assert.equal(m.recall(perm('git log'), ['ro-permission']).veto, undefined)
})

test('stored text is redacted and the banks are capped', () => {
  const m = createTriageMemory({ maxCases: 3, maxLessons: 2 })
  m.record({ item: resolved(perm('cat x password=hunter2hunter2'), 'denied'), review: 'overruled' })
  assert.ok(!JSON.stringify(m.cases()).includes('hunter2'))
  for (const c of ['ls', 'pwd', 'head', 'tail', 'wc']) m.record({ item: resolved(perm(c), 'denied'), review: 'overruled' })
  assert.equal(m.cases().length, 3)
  assert.equal(m.lessons().length, 2)
})

test('persistence: a new memory on the same file recalls the lessons; a garbled file starts empty; no io is fine', () => {
  const { box, io } = memIo()
  createTriageMemory({ io }).record({ item: resolved(perm('git log'), 'denied'), review: 'overruled' })
  assert.ok(createTriageMemory({ io }).recall(perm('git log'), ['ro-permission']).veto)
  box.text = '{not json'
  assert.equal(createTriageMemory({ io }).lessons().length, 0)
  assert.equal(createTriageMemory().record({ item: { type: 'permission' }, review: 'overruled' }), undefined)
  assert.equal(createTriageMemory({ io: { read: () => { throw new Error('x') }, write: () => { throw new Error('y') } } }).record({ item: resolved(perm('ls'), 'denied'), review: 'overruled' }).case.review, 'overruled')
})

test('userDidWhatAiWould and lessonFeedbackOf', () => {
  assert.equal(userDidWhatAiWould({ type: 'permission', resolution: { kind: 'approved' } }), true)
  assert.equal(userDidWhatAiWould({ type: 'permission', resolution: { kind: 'denied' } }), false)
  assert.equal(userDidWhatAiWould({ type: 'permission', resolution: { kind: 'cancelled' } }), undefined)
  const held = { type: 'permission', status: 'resolved', triage: { verdict: 'ask', reason: 'past-correction', lesson: { id: 'l1' } } }
  assert.equal(lessonFeedbackOf({ ...held, resolution: { kind: 'approved' } }), 'lesson-too-strict')
  assert.equal(lessonFeedbackOf({ ...held, resolution: { kind: 'denied' } }), 'lesson-confirmed')
  assert.equal(lessonFeedbackOf({ ...held, status: 'open' }), undefined)
})

function setup(memory, judgment = GOOD) {
  let n = 0
  const store = createStore({ now: () => 1000 + n, uuid: () => 'i' + ++n })
  const calls = []
  const entries = []
  const judge = { judge: async (arg) => { calls.push(arg); return { judgment, raw: '' } } }
  const runner = createTriageRunner({ store, judge, memory, triageLog: { append: (e) => entries.push(e) } })
  runner.start()
  return { store, runner, calls, entries }
}

test('end to end: the user denies what the AI would have approved; next time the same command is held back by code, with no model call, and says why', async () => {
  const memory = createTriageMemory()
  const a = setup(memory)
  const first = a.store.add(perm('git log'))
  await a.runner.idle()
  assert.equal(a.store.get(first.id).triage.verdict, 'handle')
  a.store.resolve(first.id, { kind: 'denied', by: 'card' }) // the user reverses the proposal
  assert.equal(a.store.get(first.id).triage.review, 'overruled')
  assert.equal(memory.lessons().length, 1)

  const second = a.store.add(perm('git log --oneline'))
  await a.runner.idle()
  const t = a.store.get(second.id).triage
  assert.equal(t.verdict, 'ask')
  assert.equal(t.reason, 'past-correction')
  assert.equal(t.lesson.count, 1)
  assert.equal(a.calls.length, 1, 'the model was not called the second time')
  assert.equal(a.entries.at(-1).stage, 'memory-veto')
  assert.equal(a.store.get(second.id).status, 'open')

  // the card says it is based on a past correction
  const { mod } = loadClient()
  const note = mod.shared.triageNote(a.store.get(second.id))
  assert.match(note, /^AI kept this for you, based on a past correction: you reversed a similar AI proposal once/)
})

test('end to end: the user approves a held-back item, so the lesson was too strict and retires', async () => {
  const memory = createTriageMemory()
  const a = setup(memory)
  const first = a.store.add(perm('git log'))
  await a.runner.idle()
  a.store.resolve(first.id, { kind: 'denied', by: 'card' })
  const second = a.store.add(perm('git log'))
  await a.runner.idle()
  a.store.resolve(second.id, { kind: 'approved', by: 'card' })
  assert.equal(a.store.get(second.id).triage.review, 'lesson-too-strict')
  assert.equal(memory.recall(perm('git log'), ['ro-permission']).veto, undefined)
  const third = a.store.add(perm('git log'))
  await a.runner.idle()
  assert.equal(a.store.get(third.id).triage.verdict, 'handle')
})

test('end to end: the user denies a held-back item, so the lesson is confirmed', async () => {
  const memory = createTriageMemory()
  const a = setup(memory)
  const first = a.store.add(perm('git log'))
  await a.runner.idle()
  a.store.resolve(first.id, { kind: 'denied', by: 'card' })
  const second = a.store.add(perm('git log'))
  await a.runner.idle()
  a.store.resolve(second.id, { kind: 'denied', by: 'card' })
  assert.equal(a.store.get(second.id).triage.review, 'lesson-confirmed')
  assert.equal(memory.lessons()[0].confirmed, 1)
  assert.ok(memory.recall(perm('git log'), ['ro-permission']).veto)
})

test('a weaker match reaches the judge as cautionary context and shows on the card when the AI still would handle it', async () => {
  const lessons = [{ id: 'l9', title: 'Keep the command "shell:git log" for the user', count: 2, lastAt: Date.UTC(2026, 10, 1) }]
  const memory = { recall: () => ({ context: lessons }), record: () => undefined, confirm: () => {}, agree: () => {} }
  const a = setup(memory)
  const item = a.store.add(perm('git status'))
  await a.runner.idle()
  assert.equal(a.calls[0].lessons.length, 1)
  const t = a.store.get(item.id).triage
  assert.equal(t.considered[0].id, 'l9')
  const { mod } = loadClient()
  assert.match(mod.shared.triageNote(a.store.get(item.id)), /It weighed a past correction: based on a past correction: you reversed a similar AI proposal 2 times \(last 2026-11-01\)/)
})

test('the judge puts past corrections in the prompt as cautionary data that can only raise attention', async () => {
  const seen = {}
  const llm = {
    listProviders: async () => [{ id: 'p1' }], listModels: async () => [{ id: 'claude-haiku-x' }],
    prepareCall: async () => ({ config: {}, stream: async function* (req) { seen.req = req; yield { type: 'text-delta', text: JSON.stringify(GOOD) } } }),
  }
  await createTriageJudge({ llm }).judge({ item: perm(), rules: [{ id: 'ro-permission', class: 'permission' }], lessons: [{ title: 'Keep git log for the user', count: 3 }] })
  const sent = seen.req.messages[0].content[0].text
  assert.match(sent, /PAST CORRECTIONS/)
  assert.match(sent, /Keep git log for the user/)
  assert.match(sent, /raise attention/)
  await createTriageJudge({ llm }).judge({ item: perm(), rules: [{ id: 'ro-permission', class: 'permission' }] })
  assert.ok(!seen.req.messages[0].content[0].text.includes('PAST CORRECTIONS'))
})

test('a throwing memory never stops triage', async () => {
  const memory = { recall: () => { throw new Error('boom') }, record: () => { throw new Error('boom') }, confirm: () => {}, agree: () => {} }
  const a = setup(memory)
  const item = a.store.add(perm('git status'))
  await a.runner.idle()
  assert.equal(a.store.get(item.id).triage.verdict, 'handle')
  a.store.resolve(item.id, { kind: 'denied', by: 'card' })
  assert.equal(a.store.get(item.id).triage.review, 'overruled')
})
