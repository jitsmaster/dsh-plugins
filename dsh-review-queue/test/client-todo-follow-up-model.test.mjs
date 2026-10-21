import { test } from 'node:test'
import assert from 'node:assert/strict'
import { loadClient, el, findAll, textOf, okJson } from './client-todo-helpers.mjs'

// Prompt-injection hardening of the Follow-up card (desktop): the model reads session titles and snippets, which are untrusted text, so what it says is labelled
// "Model says: <reason>", and a model suggestion for a RUNNING session is never preselected (the user picks it; the suggestion stays first in the list and is named in
// the line). A suggestion from the deterministic ticket / PR number match is trusted and stays preselected. The phone uses the same helpers (mobile-todo-follow-up-model.test.mjs).
const REF = 'ticket or PR number in the words'
const CANDS = [
  { sessionId: 's1', title: 'PR 6563 review', workspaceTitle: 'CTnP-Final', running: true },
  { sessionId: 's2', title: 'Visitor mix', workspaceTitle: 'CTnP-Final' },
  { sessionId: 's3', title: 'Loose session' },
]
const MODEL = { sessionId: 's1', title: 'PR 6563 review', workspaceTitle: 'CTnP-Final', reason: 'closest title', running: true }
const fu = (over = {}) => ({ id: 'f1', type: 'todo', kind: 'followup', text: 'Reply to the reviewer', query: 'the review', sparc: false, state: 'awaiting-confirm', status: 'open', candidates: CANDS, suggested: MODEL, ...over })
const plain = (v) => JSON.parse(JSON.stringify(v))
const PLACE = 'PR 6563 review (CTnP-Final)'

test('a model suggestion for a running session is not preselected: no target, Send is off, the dropdown starts on the placeholder with the suggestion still first', () => {
  const { T } = loadClient()
  assert.equal(T.todoTarget(fu(), ''), undefined)
  assert.equal(T.canConfirm(fu(), ''), false)
  const sel = plain(T.todoSelect(fu(), '', []))
  assert.equal(sel.value, '')
  assert.equal(sel.placeholder, 'Pick a session…')
  assert.deepEqual(sel.options.map((o) => o.id), ['s1', 's2', 's3'], 'the suggestion is still listed first')
})

test('the line names it as the model\'s suggestion and labels the reason; picking it (or another one) makes it an ordinary choice', () => {
  const { T } = loadClient()
  assert.equal(T.todoLine(fu(), '', []), 'Model suggests: ' + PLACE + ' — Model says: closest title')
  assert.equal(T.todoTarget(fu(), 's1'), 's1')
  assert.equal(T.canConfirm(fu(), 's1'), true, 'one pick of the very session the model named enables Send')
  assert.equal(T.todoLine(fu(), 's1', []), 'Session: ' + PLACE + ' — Model says: closest title')
  assert.equal(T.todoLine(fu(), 's2', []), 'Send to Visitor mix (CTnP-Final)')
})

test('running is read from the candidate too (an older item whose suggestion carries no flag)', () => {
  const { T } = loadClient()
  const { running, ...bare } = MODEL
  assert.equal(T.todoTarget(fu({ suggested: bare }), ''), undefined)
  assert.equal(T.todoTarget(fu({ suggested: bare, candidates: CANDS.map((c) => ({ ...c, running: undefined })) }), ''), 's1', 'running nowhere: preselected')
})

test('a model suggestion for a session that is not running keeps the preselect, with the reason labelled', () => {
  const { T } = loadClient()
  const idle = fu({ suggested: { ...MODEL, running: undefined }, candidates: CANDS.map((c) => ({ ...c, running: undefined })) })
  assert.equal(T.todoTarget(idle, ''), 's1')
  assert.equal(T.canConfirm(idle, ''), true)
  assert.equal(T.todoSelect(idle, '', []).value, 's1')
  assert.equal(T.todoLine(idle, '', []), 'Session: ' + PLACE + ' — Model says: closest title')
})

test('the deterministic ticket / PR number match stays preselected even for a running session, and its reason is not labelled as the model\'s', () => {
  const { T } = loadClient()
  const byRef = fu({ suggested: { ...MODEL, reason: REF } })
  assert.equal(T.todoTarget(byRef, ''), 's1')
  assert.equal(T.canConfirm(byRef, ''), true)
  assert.equal(T.todoLine(byRef, '', []), 'Session: ' + PLACE + ' — ' + REF)
})

test('Retry of a failed follow-up keeps the session that was tried, whoever suggested it', () => {
  const { T } = loadClient()
  const failed = fu({ state: 'failed', error: 'x', targetSessionId: 's1' })
  assert.equal(T.todoTarget(failed, ''), 's1')
  assert.equal(T.canConfirm(failed, ''), true)
})

test('the card: Send disabled, the select on the placeholder, the suggestion line; one pick enables Send and it posts that session', async () => {
  const calls = []
  const { T } = loadClient({ react: { createElement: el, useEffect() {}, useState: () => [0, () => {}] }, fetchImpl: async (url, opts) => { calls.push([url, JSON.parse(opts.body)]); return okJson({ ok: true }) } })
  let tree = T.FollowUpBody({ item: fu(), full: true })
  const sel = findAll(tree, (n) => n.type === 'select')[0]
  const send = findAll(tree, (n) => n.type === 'button').find((b) => textOf(b) === 'Send')
  assert.equal(sel.props.value, '')
  assert.equal(send.props.disabled, true)
  assert.deepEqual(findAll(sel, (n) => n.type === 'option').map((o) => [o.props.value, textOf(o)]).slice(0, 2), [['', 'Pick a session…'], ['s1', 'PR 6563 review · CTnP-Final']])
  assert.ok(findAll(tree, (n) => n.props?.className === 'rq-sub').some((n) => textOf(n) === 'Model suggests: ' + PLACE + ' — Model says: closest title'))
  sel.props.onChange({ target: { value: 's1' } })
  tree = T.FollowUpBody({ item: fu(), full: true })
  const send2 = findAll(tree, (n) => n.type === 'button').find((b) => textOf(b) === 'Send')
  assert.equal(send2.props.disabled, false)
  await send2.props.onClick()
  assert.deepEqual(calls, [['/review-queue/v1/todo-confirm', { id: 'f1', sessionId: 's1' }]])
})
