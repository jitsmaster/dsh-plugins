import { test } from 'node:test'
import assert from 'node:assert/strict'
import { source, loadClient, el, findAll, textOf, okJson, tick, need } from './client-todo-helpers.mjs'

// Slice C of the Follow-up todo: the desktop Task list. A todo of kind 'followup' sends its text as a queued prompt to an EXISTING session
// found from words. This file covers the card (every state), the "+ New todo" form in Follow up mode, what is posted, the keys and the
// resolved line. The saved draft is in client-todo-follow-up-draft.test.mjs, the read-aloud words in todo-follow-up-speech.test.mjs.
const CANDS = [
  { sessionId: 's1', title: 'PR 6563 review', workspaceTitle: 'CTnP-Final' },
  { sessionId: 's2', title: 'Visitor mix', workspaceTitle: 'CTnP-Final' },
  { sessionId: 's3', title: 'Loose session' },
]
const SUGGESTED = { sessionId: 's1', title: 'PR 6563 review', workspaceTitle: 'CTnP-Final', reason: 'named in the words' }
const fu = (over = {}) => ({ id: 'f1', type: 'todo', kind: 'followup', text: 'Reply to the reviewer\nsecond line', query: 'the PR 6563 session', sparc: false, state: 'awaiting-confirm', status: 'open', candidates: CANDS, suggested: SUGGESTED, ...over })
const FORM = (over = {}) => ({ open: true, text: '', workspaceId: '', sparc: false, busy: false, error: undefined, ...over })
const plain = (v) => JSON.parse(JSON.stringify(v))

/** The client with a React that builds nodes and remembers the effects; every request goes to calls and is answered with answer. */
function render({ answer = () => okJson({ ok: true }) } = {}) {
  const calls = []
  const effects = []
  const c = loadClient({
    react: { createElement: el, useEffect: (fn) => { effects.push(fn) }, useState: () => [0, () => {}] },
    fetchImpl: async (url, opts) => { calls.push([url, opts?.body ? JSON.parse(opts.body) : undefined]); return answer(url) },
  })
  return { ...c, calls, effects }
}
const buttons = (tree) => findAll(tree, (n) => n.type === 'button')
const button = (tree, label) => buttons(tree).find((b) => textOf(b) === label)
const selectOf = (tree) => findAll(tree, (n) => n.type === 'select')[0]
const optionsOf = (sel) => findAll(sel, (n) => n.type === 'option').map((o) => ({ value: o.props.value, label: textOf(o) }))
const switchOf = (tree) => findAll(tree, (n) => n.props?.role === 'group' && n.props['aria-label'] === 'Kind of todo')[0]

// ---- the pure helpers ---------------------------------------------------------------------------------------

test('todoCardState: a follow-up goes through the same cards as a workspace todo', () => {
  const { T } = loadClient()
  assert.equal(T.todoCardState(fu()), 'confirm')
  assert.equal(T.todoCardState(fu({ suggested: undefined })), 'pick')
  assert.equal(T.todoCardState(fu({ suggested: undefined, suggesting: true })), 'suggesting')
  assert.equal(T.todoCardState(fu({ state: 'starting' })), 'starting')
  assert.equal(T.todoCardState(fu({ state: 'started', status: 'resolved' })), 'started')
  assert.equal(T.todoCardState(fu({ state: 'failed', error: 'x' })), 'failed')
  assert.equal(T.todoCardState(fu({ state: 'cancelled', status: 'resolved' })), 'cancelled')
})

test('todoTarget: the session Send would use is the pick, else the one tried before, else the suggestion', () => {
  const { T } = loadClient()
  assert.equal(T.todoTarget(fu(), ''), 's1')
  assert.equal(T.todoTarget(fu(), 's2'), 's2', 'a pick wins over the suggestion')
  assert.equal(T.todoTarget(fu({ suggested: undefined }), ''), undefined, 'no suggestion and no pick: nothing to send to')
  assert.equal(T.todoTarget(fu({ suggested: undefined }), 's3'), 's3')
  assert.equal(T.todoTarget(fu({ state: 'failed', targetSessionId: 's2' }), ''), 's2', 'a failed follow-up keeps the session it tried, not the suggestion')
  assert.equal(T.todoTarget(fu({ state: 'failed', targetSessionId: 's2' }), 's3'), 's3', 'but a new pick wins')
})

test('todoTarget: a pick that is no longer among the candidates is stale and ignored (the candidate list can change under an old pick)', () => {
  const { T } = loadClient()
  assert.equal(T.todoTarget(fu(), 'gone'), 's1', 'falls back to the suggestion')
  assert.equal(T.todoTarget(fu({ suggested: undefined }), 'gone'), undefined)
  assert.equal(T.todoTarget(fu({ candidates: [] }), 's2'), 's1', 'with no candidates at all no pick can stand')
  assert.equal(T.todoTarget(fu({ candidates: undefined, suggested: undefined }), 's2'), undefined)
  assert.equal(T.canConfirm(fu({ suggested: undefined }), 'gone'), false, 'a stale pick does not enable Send')
})

test('todoTarget: the workspace todo rules are unchanged (a workspace todo has no candidates)', () => {
  const { T } = loadClient()
  const ws = { id: 't1', type: 'todo', text: 'x', state: 'awaiting-confirm', suggested: { workspaceId: 'w1', title: 'Alpha' } }
  assert.equal(T.todoTarget(ws, ''), 'w1')
  assert.equal(T.todoTarget(ws, 'w2'), 'w2')
})

test('canConfirm: Send needs a session (the pick, the suggestion or the one tried before) and a state that can send', () => {
  const { T } = loadClient()
  assert.equal(T.canConfirm(fu()), true)
  assert.equal(T.canConfirm(fu({ suggested: undefined })), false)
  assert.equal(T.canConfirm(fu({ suggested: undefined }), 's2'), true)
  assert.equal(T.canConfirm(fu({ suggested: undefined, suggesting: true })), false)
  assert.equal(T.canConfirm(fu({ state: 'failed', suggested: undefined, targetSessionId: 's3' })), true, 'Retry works with the session that was tried')
  assert.equal(T.canConfirm(fu({ state: 'starting' })), false)
  assert.equal(T.canConfirm(fu({ state: 'started' })), false)
})

test('todoSelect: the candidates in the order given, the suggestion preselected, the pick wins, a placeholder only when nothing is selected', () => {
  const { T } = loadClient()
  const sel = plain(T.todoSelect(fu(), '', []))
  assert.equal(sel.value, 's1', 'the suggestion is preselected')
  assert.equal(sel.placeholder, undefined)
  assert.deepEqual(sel.options, [
    { id: 's1', title: 'PR 6563 review · CTnP-Final' },
    { id: 's2', title: 'Visitor mix · CTnP-Final' },
    { id: 's3', title: 'Loose session' },
  ], 'label = title · workspace when the workspace is known, the order is the one of the item')
  assert.equal(T.todoSelect(fu(), 's2', []).value, 's2')
  const none = plain(T.todoSelect(fu({ suggested: undefined }), '', []))
  assert.equal(none.value, '')
  assert.equal(none.placeholder, 'Pick a session…')
  assert.equal(none.options.length, 3)
  assert.equal(T.todoSelect(fu({ state: 'failed', targetSessionId: 's3' }), '', []).value, 's3')
})

test('todoSelect: a stale pick is not shown, an item without candidates has no options, a suggestion missing from the list is still an option', () => {
  const { T } = loadClient()
  assert.equal(T.todoSelect(fu(), 'gone', []).value, 's1')
  assert.deepEqual(plain(T.todoSelect(fu({ candidates: undefined, suggested: undefined, suggesting: true }), '', []).options), [])
  const odd = plain(T.todoSelect(fu({ candidates: [CANDS[1]] }), '', []))
  assert.equal(odd.value, 's1')
  assert.deepEqual(odd.options.map((o) => o.id), ['s1', 's2'], 'the suggested session is added in front so the select can show it')
  assert.equal(odd.options[0].title, 'PR 6563 review · CTnP-Final')
})

test('todoLine: the sentence under a follow-up (suggestion, looking, no suggestion with its note, a pick, sending, failed)', () => {
  const { T } = loadClient()
  assert.equal(T.todoLine(fu(), '', []), 'Session: PR 6563 review (CTnP-Final) — Model says: named in the words')
  assert.equal(T.todoLine(fu({ suggested: { sessionId: 's3', title: 'Loose session' } }), '', []), 'Session: Loose session', 'no workspace, no reason: no empty brackets or dash')
  assert.equal(T.todoLine(fu({ suggested: { ...SUGGESTED, reason: '' } }), '', []), 'Session: PR 6563 review (CTnP-Final)')
  assert.equal(T.todoLine(fu({ suggested: undefined, suggesting: true }), '', []), 'Finding the session…')
  assert.equal(T.todoLine(fu({ suggested: undefined, suggestNote: 'no session matched' }), '', []), 'Pick a session (no suggestion: no session matched)')
  assert.equal(T.todoLine(fu({ suggested: undefined, suggestNote: '' }), '', []), 'Pick a session')
  assert.equal(T.todoLine(fu({ suggested: undefined, suggesting: true, suggestNote: 'old' }), '', []), 'Finding the session…', 'never the note while still looking')
  assert.equal(T.todoLine(fu({ suggestNote: 'stale' }), '', []), 'Session: PR 6563 review (CTnP-Final) — Model says: named in the words', 'never the note next to a suggestion')
  assert.equal(T.todoLine(fu(), 's2', []), 'Send to Visitor mix (CTnP-Final)', 'a pick other than the suggestion')
  assert.equal(T.todoLine(fu(), 's1', []), 'Session: PR 6563 review (CTnP-Final) — Model says: named in the words', 'a pick equal to the suggestion keeps the reason')
  assert.equal(T.todoLine(fu({ suggested: undefined }), 's3', []), 'Send to Loose session')
  assert.equal(T.todoLine(fu({ state: 'starting', sessionTitle: 'PR 6563 review' }), '', []), 'Sending…')
  assert.equal(T.todoLine(fu({ state: 'started', sessionTitle: 'PR 6563 review' }), '', []), 'Sent to PR 6563 review')
  assert.equal(T.todoLine(fu({ state: 'started' }), '', []), 'Sent')
  assert.equal(T.todoLine(fu({ state: 'failed', error: 'boom' }), '', []), 'Could not send: boom')
  assert.equal(T.todoLine(fu({ state: 'failed' }), '', []), 'Could not send: unknown error')
})

test('todoLine: the workspace todo sentences are untouched', () => {
  const { T } = loadClient()
  const ws = [{ id: 'w1', title: 'Alpha' }]
  const todo = { id: 't1', type: 'todo', text: 'x', state: 'awaiting-confirm', suggested: { workspaceId: 'w1', title: 'Alpha', reason: 'named in the text' } }
  assert.equal(T.todoLine(todo, '', ws), 'Start in Alpha — named in the text')
  assert.equal(T.todoLine({ ...todo, state: 'failed', error: 'boom' }, '', ws), 'Could not start: boom')
})

test('cardTitle: "Follow up: <first line>" (the server titles it the same way); a title from the server is used as it is', () => {
  const { T } = loadClient()
  assert.equal(T.cardTitle(fu()), 'Follow up: Reply to the reviewer')
  assert.equal(T.cardTitle(fu({ title: 'Follow up: from the server' })), 'Follow up: from the server')
  assert.equal(T.cardTitle(fu({ text: '\n  \nsecond line only' })), 'Follow up: second line only')
  assert.equal(T.cardTitle(fu({ text: '' })), 'Follow up')
})

test('resolutionText: a sent follow-up says where it went; cancelled reads as for every todo', () => {
  const { T } = loadClient()
  assert.equal(T.resolutionText({ type: 'todo', kind: 'followup', sessionTitle: 'PR 6563 review', resolution: { kind: 'followed-up', by: 'card', sessionId: 's1' } }), 'Sent to PR 6563 review')
  assert.equal(T.resolutionText({ type: 'todo', kind: 'followup', resolution: { kind: 'followed-up', sessionId: 's1' } }), 'Sent to the session')
  assert.equal(T.resolutionText({ type: 'todo', kind: 'followup', resolution: { kind: 'cancelled', by: 'card' } }), 'Cancelled')
  assert.equal(T.resolutionText({ type: 'todo', workspaceTitle: 'Alpha', resolution: { kind: 'started', sessionId: 's' } }), 'Started in Alpha (in the background)')
})

test('errorText: the codes of a follow-up have words', () => {
  const { T } = loadClient()
  assert.match(T.errorText(400, { error: 'empty-query' }), /session/i)
  assert.match(T.errorText(400, { error: 'unknown-session' }), /session/i)
  assert.doesNotMatch(T.errorText(400, { error: 'unknown-session' }), /Could not do that/)
  assert.doesNotMatch(T.errorText(400, { error: 'empty-query' }), /Could not do that/)
})

test('errorText: too-many-follow-ups (the hub allows 10 waiting) has words, for the form and for a card', () => {
  const { T } = loadClient()
  assert.equal(T.errorText(409, { error: 'too-many-follow-ups' }), 'Too many follow-ups are waiting: confirm or cancel one first.')
})

test('waitingCount: a follow-up that is sending is not waiting on the user, one that needs a session or failed is', () => {
  const { T } = loadClient()
  assert.equal(T.waitingCount([fu(), fu({ state: 'starting' }), fu({ state: 'failed' })]), 2)
})

// ---- the card -----------------------------------------------------------------------------------------------

test('card, suggestion: the line, the dropdown with the suggestion selected, Send enabled, Cancel; no SPARC line, no workspace dropdown', () => {
  const { T } = render()
  const tree = T.FollowUpBody({ item: fu(), full: true })
  assert.ok(findAll(tree, (n) => n.props?.className?.startsWith?.('rq-text')).some((n) => textOf(n) === 'Reply to the reviewer\nsecond line'))
  assert.ok(findAll(tree, (n) => n.props?.className === 'rq-sub').some((n) => textOf(n) === 'Session: PR 6563 review (CTnP-Final) — Model says: named in the words'))
  const sel = selectOf(tree)
  assert.equal(sel.props['aria-label'], 'Change session')
  assert.equal(sel.props.value, 's1')
  assert.deepEqual(optionsOf(sel), [
    { value: 's1', label: 'PR 6563 review · CTnP-Final' }, { value: 's2', label: 'Visitor mix · CTnP-Final' }, { value: 's3', label: 'Loose session' },
  ])
  assert.equal(button(tree, 'Send').props.disabled, false)
  assert.ok(button(tree, 'Cancel'))
  assert.equal(button(tree, 'Start'), undefined, 'the workspace wording is not used')
  assert.doesNotMatch(textOf(tree), /SPARC|workspace/i)
})

test('card, no suggestion: the placeholder option, the reason in the line, Send disabled until a session is picked', () => {
  const { T } = render()
  const item = fu({ suggested: undefined, suggestNote: 'no session matched' })
  let tree = T.FollowUpBody({ item, full: true })
  assert.match(textOf(tree), /Pick a session \(no suggestion: no session matched\)/)
  assert.equal(selectOf(tree).props.value, '')
  assert.deepEqual(optionsOf(selectOf(tree))[0], { value: '', label: 'Pick a session…' })
  assert.equal(button(tree, 'Send').props.disabled, true)
  T.state.todoPick = { f1: 's2' }
  tree = T.FollowUpBody({ item, full: true })
  assert.equal(selectOf(tree).props.value, 's2')
  assert.equal(button(tree, 'Send').props.disabled, false)
  assert.match(textOf(tree), /Send to Visitor mix \(CTnP-Final\)/)
})

test('card, suggesting: "Finding the session…" with Send disabled, and Cancel still there', () => {
  const { T } = render()
  const tree = T.FollowUpBody({ item: fu({ suggested: undefined, suggesting: true, candidates: [] }), full: true })
  assert.match(textOf(tree), /Finding the session…/)
  assert.equal(button(tree, 'Send').props.disabled, true)
  assert.ok(button(tree, 'Cancel'))
})

test('card: choosing in the dropdown stores the pick for that item only', () => {
  const { T } = render()
  const tree = T.FollowUpBody({ item: fu(), full: true })
  selectOf(tree).props.onChange({ target: { value: 's3' } })
  assert.deepEqual(plain(T.state.todoPick), { f1: 's3' })
})

test('card, starting: "Sending…", no buttons, no dropdown, no Open session (the session id is not bound before it arrived)', () => {
  const { T } = render()
  const tree = T.FollowUpBody({ item: fu({ state: 'starting', targetSessionId: 's1', sessionTitle: 'PR 6563 review' }), full: true })
  assert.match(textOf(tree), /Sending…/)
  assert.equal(buttons(tree).length, 0)
  assert.equal(selectOf(tree), undefined)
})

test('card, failed: the error in the error style, Retry (enabled, with the tried session) and Cancel', () => {
  const { T } = render()
  const tree = T.FollowUpBody({ item: fu({ state: 'failed', error: 'the session is gone', targetSessionId: 's2', suggested: undefined }), full: true })
  const err = findAll(tree, (n) => n.props?.className === 'rq-err')
  assert.equal(err.length, 1)
  assert.equal(textOf(err[0]), 'Could not send: the session is gone')
  assert.equal(button(tree, 'Retry').props.disabled, false)
  assert.ok(button(tree, 'Cancel'))
  assert.equal(button(tree, 'Send'), undefined)
  assert.equal(selectOf(tree).props.value, 's2')
})

test('card: every control is disabled while a request for the item is on its way', () => {
  const { T } = render()
  T.state.busy = { f1: true }
  const tree = T.FollowUpBody({ item: fu(), full: true })
  assert.equal(button(tree, 'Send').props.disabled, true)
  assert.equal(button(tree, 'Cancel').props.disabled, true)
  assert.equal(selectOf(tree).props.disabled, true)
})

test('Send posts /v1/todo-confirm with the id and the session: the suggestion, or the pick', async () => {
  const { T, calls } = render()
  assert.equal(await T.confirmTodo(fu(), ''), true)
  assert.equal(await T.confirmTodo(fu(), 's2'), true)
  assert.deepEqual(calls, [
    ['/review-queue/v1/todo-confirm', { id: 'f1', sessionId: 's1' }],
    ['/review-queue/v1/todo-confirm', { id: 'f1', sessionId: 's2' }],
  ])
})

test('the Send button posts the session that the dropdown shows and spends the pick', async () => {
  const { T, calls } = render()
  T.state.todoPick = { f1: 's3' }
  await button(T.FollowUpBody({ item: fu(), full: true }), 'Send').props.onClick()
  assert.deepEqual(calls, [['/review-queue/v1/todo-confirm', { id: 'f1', sessionId: 's3' }]])
  assert.equal(T.state.todoPick.f1, undefined, 'the pick is spent once it was sent, like the workspace pick')
})

test('Retry confirms again with the same session; a refused confirm keeps the pick and shows the reason on the card', async () => {
  const { T, calls } = render({ answer: () => okJson({ ok: false, error: 'unknown-session' }, 400) })
  const failed = fu({ state: 'failed', error: 'boom', targetSessionId: 's2' })
  await button(T.FollowUpBody({ item: failed, full: true }), 'Retry').props.onClick()
  assert.deepEqual(calls, [['/review-queue/v1/todo-confirm', { id: 'f1', sessionId: 's2' }]])
  assert.match(T.state.errors.f1, /session/i)
  T.state.todoPick = { f1: 's3' }
  await T.confirmTodo(failed, 's3')
  assert.equal(T.state.todoPick.f1, 's3', 'a failed request does not throw the pick away')
})

test('Cancel posts /v1/todo-cancel', async () => {
  const { T, calls } = render()
  await button(T.FollowUpBody({ item: fu(), full: true }), 'Cancel').props.onClick()
  assert.deepEqual(calls, [['/review-queue/v1/todo-cancel', { id: 'f1' }]])
})

test('a card that waits for a session never asks for the workspaces: the Task list gives a follow-up its own body, a workspace todo keeps its own', async () => {
  const a = render()
  const card = (item) => a.T.Card({ item: { position: 1, createdAt: 1, ...item }, forceFull: true })
  assert.equal(findAll(card(fu()), (n) => n.type === a.T.FollowUpBody).length, 1, 'a follow-up card renders the follow-up body')
  assert.equal(findAll(card(fu()), (n) => n.type === a.T.TodoBody).length, 0)
  assert.equal(findAll(card({ id: 't1', type: 'todo', text: 'x', state: 'awaiting-confirm', status: 'open' }), (n) => n.type === a.T.TodoBody).length, 1, 'a workspace todo still renders its own')
  a.T.FollowUpBody({ item: fu(), full: true })
  a.T.FollowUpBody({ item: fu({ state: 'failed', error: 'x' }), full: true })
  for (const fn of a.effects) await fn()
  assert.deepEqual(a.calls.filter(([u]) => u.endsWith('/v1/workspaces')), [], 'no /v1/workspaces for a follow-up')
  const b = render({ answer: () => okJson({ workspaces: [] }) })
  b.T.TodoBody({ item: { id: 't1', type: 'todo', text: 'x', state: 'awaiting-confirm', status: 'open' }, full: true })
  for (const fn of b.effects) await fn()
  assert.equal(b.calls.filter(([u]) => u.endsWith('/v1/workspaces')).length, 1, 'the workspace todo card is as before')
})

test('card, long text: the follow-up text is clamped unless the card is open, like a todo', () => {
  const { T } = render()
  const clamp = (full) => findAll(T.FollowUpBody({ item: fu(), full }), (n) => n.props?.className?.startsWith?.('rq-text'))[0].props.className
  assert.match(clamp(false), /rq-clamp/)
  assert.doesNotMatch(clamp(true), /rq-clamp/)
})

// ---- the keys -----------------------------------------------------------------------------------------------

test('keys: Shift+A, Shift+D and e do nothing on a follow-up and Enter is not bound; the other cards are unchanged', () => {
  const { T } = loadClient()
  for (const action of ['approve', 'deny', 'reviewed', 'read', 'next', 'prev']) assert.equal(T.keyRoute(action, fu()), undefined, action)
  const key = (o) => ({ key: 'x', ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, isComposing: false, target: { tagName: 'DIV' }, ...o })
  assert.equal(T.keyAction(key({ key: 'Enter' })), undefined)
  assert.equal(T.keyRoute('approve', { type: 'permission' }), '/v1/approve')
  assert.equal(T.keyRoute('reviewed', { type: 'completed' }), '/v1/reviewed')
})

test('source: the overlay key handler goes through keyRoute and the todo card binds no key', () => {
  const overlay = source.slice(source.indexOf('function Overlay('))
  assert.match(overlay, /keyRoute\(action, cur\)/)
  const body = source.slice(source.indexOf('function TodoBody'), source.indexOf('function Card('))
  assert.doesNotMatch(body, /onKeyDown/, 'no key is bound on the todo card')
})

// ---- the form -----------------------------------------------------------------------------------------------

test('form, New session (the default): the switch has two options with New session selected, and the form is what it was', () => {
  const { T } = render()
  T.set({ todoForm: FORM() })
  const tree = T.TodoForm()
  const sw = switchOf(tree)
  assert.ok(sw, 'a group named Kind of todo')
  const [a, b] = buttons(sw)
  assert.deepEqual([textOf(a), textOf(b)], ['New session', 'Follow up'])
  assert.deepEqual([a.props['aria-pressed'], b.props['aria-pressed']], [true, false])
  assert.equal(findAll(tree, (n) => n.type === 'textarea')[0].props.placeholder, 'What should the new session do? (Ctrl+Enter adds it)')
  assert.equal(findAll(tree, (n) => n.type === 'select' && n.props['aria-label'] === 'Workspace').length, 1)
  assert.match(textOf(tree), /Use SPARC/)
  assert.ok(button(tree, 'Add todo'))
  assert.equal(findAll(tree, (n) => n.props?.['aria-label'] === 'Which session').length, 0)
  assert.match(textOf(tree), /Nothing starts until you confirm the workspace\./)
})

test('form, Follow up: its own placeholder, the "Which session" input, no workspace dropdown, no SPARC, the hint and the button label', () => {
  const { T } = render()
  T.set({ todoForm: FORM({ mode: 'followup', followUp: 'the PR 6563 session' }) })
  const tree = T.TodoForm()
  const [a, b] = buttons(switchOf(tree))
  assert.deepEqual([a.props['aria-pressed'], b.props['aria-pressed']], [false, true])
  assert.equal(findAll(tree, (n) => n.type === 'textarea')[0].props.placeholder, 'What should the existing session do next? (Ctrl+Enter adds it)')
  const input = findAll(tree, (n) => n.type === 'input' && n.props['aria-label'] === 'Which session')
  assert.equal(input.length, 1)
  assert.equal(input[0].props.placeholder, 'Which session? Describe it in your own words')
  assert.equal(input[0].props.maxLength, 300)
  assert.equal(input[0].props.required, true)
  assert.equal(input[0].props.value, 'the PR 6563 session')
  assert.equal(findAll(tree, (n) => n.type === 'select').length, 0, 'the workspace dropdown is hidden')
  assert.equal(findAll(tree, (n) => n.type === 'input' && n.props.type === 'checkbox').length, 0, 'Use SPARC is hidden')
  assert.doesNotMatch(textOf(tree), /SPARC|Choose for me|confirm the workspace/)
  assert.match(textOf(tree), /Nothing is sent until you confirm the session\./)
  assert.ok(button(tree, 'Add follow-up'))
  assert.equal(button(tree, 'Add todo'), undefined)
  assert.ok(button(tree, 'Tune prompt'), 'Tune stays')
})

test('form: the Add button needs a text in both modes; the description is checked by the validation message, so a click can show it', () => {
  const { T } = render()
  T.set({ todoForm: FORM({ mode: 'followup', text: '', followUp: '' }) })
  assert.equal(button(T.TodoForm(), 'Add follow-up').props.disabled, true)
  T.set({ todoForm: FORM({ mode: 'followup', text: 'Do it', followUp: '' }) })
  assert.equal(button(T.TodoForm(), 'Add follow-up').props.disabled, false)
  T.set({ todoForm: FORM({ mode: 'followup', text: 'Do it', followUp: 'x', busy: true }) })
  assert.equal(button(T.TodoForm(), 'Adding…').props.disabled, true)
})

test('form: the switch changes the mode, typing in the input stores the description and clears the error', () => {
  const { T } = render()
  T.set({ todoForm: FORM({ error: 'old' }) })
  const [, follow] = buttons(switchOf(T.TodoForm()))
  follow.props.onClick()
  assert.equal(T.state.todoForm.mode, 'followup')
  assert.equal(T.state.todoForm.error, undefined)
  const input = findAll(T.TodoForm(), (n) => n.type === 'input' && n.props['aria-label'] === 'Which session')[0]
  input.props.onChange({ target: { value: 'the visitor mix one' } })
  assert.equal(T.state.todoForm.followUp, 'the visitor mix one')
  const [again] = buttons(switchOf(T.TodoForm()))
  again.props.onClick()
  assert.equal(T.state.todoForm.mode, 'new')
  assert.equal(T.state.todoForm.followUp, 'the visitor mix one', 'the words stay while the other mode is shown')
  assert.equal(T.state.todoForm.text, '')
})

test('form: the mode cannot be switched while a request is on its way', () => {
  const { T } = render()
  T.set({ todoForm: FORM({ busy: true }) })
  assert.deepEqual(buttons(switchOf(T.TodoForm())).map((b) => b.props.disabled), [true, true])
})

test('form: Ctrl+Enter in the description input adds the follow-up, plain Enter does nothing', async () => {
  const { T, calls } = render()
  T.set({ todoForm: FORM({ mode: 'followup', text: 'Do it', followUp: 'that session' }) })
  const input = findAll(T.TodoForm(), (n) => n.type === 'input' && n.props['aria-label'] === 'Which session')[0]
  let prevented = 0
  input.props.onKeyDown({ key: 'Enter', preventDefault: () => { prevented++ } })
  await tick()
  assert.equal(calls.length, 0)
  assert.equal(prevented, 0)
  input.props.onKeyDown({ key: 'Enter', ctrlKey: true, preventDefault: () => { prevented++ } })
  await tick()
  assert.equal(prevented, 1)
  assert.deepEqual(calls, [['/review-queue/v1/todo', { text: 'Do it', followUp: 'that session' }]])
})

test('form: Ctrl+Enter in the textarea adds a follow-up too', async () => {
  const { T, calls } = render()
  T.set({ todoForm: FORM({ mode: 'followup', text: 'Do it', followUp: 'that session' }) })
  const ta = findAll(T.TodoForm(), (n) => n.type === 'textarea')[0]
  ta.props.onKeyDown({ key: 'Enter', ctrlKey: true, preventDefault() {} })
  await tick()
  assert.equal(calls.length, 1)
})

// ---- what is posted -------------------------------------------------------------------------------------------

test('submit, Follow up: POST /v1/todo with the trimmed text and followUp only (no workspaceId, no sparc), then the form closes and is empty', async () => {
  const { T, calls } = render()
  T.set({ todoForm: FORM({ mode: 'followup', text: '  Reply to it  ', followUp: '  the PR 6563 session ', workspaceId: 'w1', sparc: true }) })
  assert.equal(await T.submitTodo(), true)
  assert.deepEqual(calls, [['/review-queue/v1/todo', { text: 'Reply to it', followUp: 'the PR 6563 session' }]])
  const f = plain(T.state.todoForm)
  assert.equal(f.open, false)
  assert.equal(f.text, '')
  assert.ok(!f.followUp)
  assert.ok(f.mode !== 'followup', 'the next todo starts in New session')
  assert.equal(f.busy, false)
})

test('submit, New session: the body is what it was (a stale description in the form is not sent)', async () => {
  const { T, calls } = render()
  T.set({ todoForm: FORM({ mode: 'new', text: 'Fix it', workspaceId: 'w1', sparc: true, followUp: 'left over words' }) })
  assert.equal(await T.submitTodo(), true)
  assert.deepEqual(calls, [['/review-queue/v1/todo', { text: 'Fix it', workspaceId: 'w1', sparc: true }]])
})

test('submit, Follow up: an empty or blank description is refused before any request, with its own message', async () => {
  const { T, calls } = render()
  for (const followUp of ['', '   ', '\n ', undefined]) {
    T.set({ todoForm: FORM({ mode: 'followup', text: 'Do it', followUp }) })
    assert.equal(await T.submitTodo(), false, JSON.stringify(followUp))
    assert.equal(T.state.todoForm.error, 'Say which session this is for.')
    assert.equal(T.state.todoForm.busy, false)
    assert.equal(T.state.todoForm.open, true)
  }
  assert.equal(calls.length, 0)
})

test('submit, Follow up: a description over 300 characters is refused, 300 is fine; an empty text says so first', async () => {
  const { T, calls } = render()
  T.set({ todoForm: FORM({ mode: 'followup', text: 'Do it', followUp: 'x'.repeat(301) }) })
  assert.equal(await T.submitTodo(), false)
  assert.equal(T.state.todoForm.error, 'Describe the session in 300 characters or fewer.')
  assert.equal(calls.length, 0)
  T.set({ todoForm: FORM({ mode: 'followup', text: 'Do it', followUp: 'x'.repeat(300) }) })
  assert.equal(await T.submitTodo(), true)
  T.set({ todoForm: FORM({ mode: 'followup', text: '  ', followUp: '' }) })
  await T.submitTodo()
  assert.equal(T.state.todoForm.error, 'Type the task first.')
})

test('todoFormProblem: the second argument is the description of a follow-up; none means a todo for a new session', () => {
  const { T } = loadClient()
  assert.equal(T.todoFormProblem('Do it'), undefined, 'a new-session todo needs no description')
  assert.equal(T.todoFormProblem('Do it', 'that one'), undefined)
  assert.equal(T.todoFormProblem('Do it', ''), 'Say which session this is for.')
  assert.equal(T.todoFormProblem('', 'that one'), 'Type the task first.')
  assert.equal(T.todoFormProblem('x'.repeat(4001), 'that one'), 'That is too long.')
  assert.equal(T.todoFormProblem('Do it', 'x'.repeat(301)), 'Describe the session in 300 characters or fewer.')
})

test('submit, Follow up: a refusal of the server keeps the form and shows the reason in words', async () => {
  const { T } = render({ answer: () => okJson({ ok: false, error: 'empty-query' }, 400) })
  T.set({ todoForm: FORM({ mode: 'followup', text: 'Do it', followUp: 'that one' }) })
  assert.equal(await T.submitTodo(), false)
  assert.equal(T.state.todoForm.open, true)
  assert.equal(T.state.todoForm.followUp, 'that one')
  assert.match(T.state.todoForm.error, /session/i)
  assert.doesNotMatch(T.state.todoForm.error, /Could not do that/)
})

test('submit does nothing while busy, in Follow up mode too', async () => {
  const { T, calls } = render()
  T.set({ todoForm: FORM({ mode: 'followup', text: 'Do it', followUp: 'x', busy: true }) })
  assert.equal(await T.submitTodo(), false)
  assert.equal(calls.length, 0)
})

test('Tune prompt keeps working in Follow up mode: it tunes the text and leaves the description alone', async () => {
  const { T, calls } = render({ answer: (url) => okJson(url.endsWith('/v1/todo-tune') ? { ok: true, text: 'Tuned message' } : { ok: true }) })
  T.set({ todoForm: FORM({ mode: 'followup', text: 'rough idea', followUp: 'that one' }) })
  assert.equal(button(T.TodoForm(), 'Tune prompt').props.disabled, false)
  assert.equal(await T.tuneTodo(), true)
  assert.deepEqual(calls, [['/review-queue/v1/todo-tune', { text: 'rough idea' }]])
  assert.equal(T.state.todoForm.text, 'Tuned message')
  assert.equal(T.state.todoForm.original, 'rough idea')
  assert.equal(T.state.todoForm.followUp, 'that one')
  assert.equal(T.state.todoForm.mode, 'followup')
})

// ---- no workspaces for a follow-up --------------------------------------------------------------------------

test('opening the form in Follow up mode, or switching to it, does not load the workspaces; switching back does', async () => {
  const { T, calls } = render({ answer: () => okJson({ workspaces: [{ id: 'w1', title: 'Alpha' }] }) })
  need(T, 'setTodoMode')
  const loads = () => calls.filter(([u]) => u.endsWith('/v1/workspaces')).length
  T.set({ todoForm: FORM({ open: false, mode: 'followup' }) })
  T.openTodoForm()
  await tick()
  assert.equal(loads(), 0, 'opened in Follow up mode')
  T.setTodoMode('new')
  await tick()
  assert.equal(loads(), 1, 'back to New session: the dropdown needs its list')
  T.setTodoMode('followup')
  await tick()
  assert.equal(loads(), 1)
  assert.equal(T.state.todoForm.mode, 'followup')
  T.set({ todoForm: FORM({ open: false, mode: 'new' }) })
  T.openTodoForm()
  await tick()
  assert.equal(loads(), 2, 'a New session form still loads them')
})

test('a draft restored open in Follow up mode does not load the workspaces at start; one in New session mode does', async () => {
  const KEY = 'dsh-review-queue.todoDraft'
  const start = async (draft) => {
    const calls = []
    const { mod } = loadClient({ stored: { [KEY]: JSON.stringify(draft) }, fetchImpl: async (url) => { calls.push(url); return okJson({ workspaces: [] }) } })
    mod.apply({ effect() {}, slots: {}, uiWorkspace: undefined })
    await tick()
    return calls.filter((u) => u.endsWith('/v1/workspaces')).length
  }
  assert.equal(await start({ text: 'x', open: true, mode: 'followup', followUp: 'y' }), 0)
  assert.equal(await start({ text: 'x', open: true }), 1)
})

// ---- the resolved list ----------------------------------------------------------------------------------------

const sent = (over = {}) => ({ id: 'f1', type: 'todo', kind: 'followup', status: 'resolved', state: 'started', text: 'Reply to the reviewer', title: 'Follow up: Reply to the reviewer', sessionId: 's1', sessionTitle: 'PR 6563 review', createdAt: 1, resolvedAt: 2, resolution: { kind: 'followed-up', by: 'card', sessionId: 's1' }, ...over })

test('resolved: a sent follow-up reads "Sent to <session>" and has the Open session button for the session it went to', () => {
  const opened = []
  const { T, mod } = render()
  mod.apply({ effect() {}, slots: {}, uiWorkspace: { openSession: (id) => { opened.push(id) } } })
  T.state.snap = { snapshotId: 'e:1', open: [], resolved: [sent()] }
  const tree = T.ResolvedCard({ it: sent() })
  assert.ok(findAll(tree, (n) => n.props?.className === 'rq-sub').some((n) => textOf(n) === 'Sent to PR 6563 review'))
  assert.ok(textOf(tree).includes('Follow up: Reply to the reviewer'), 'the title')
  const open = button(tree, 'Open session')
  assert.ok(open, 'a BUTTON, as for a started todo')
  assert.match(open.props.className, /pri/)
  open.props.onClick()
  assert.deepEqual(opened, ['s1'])
})

test('resolved: a sent follow-up can be read aloud (the server reads any item by id)', async () => {
  const { T, calls } = render()
  T.state.snap = { snapshotId: 'e:1', open: [], resolved: [sent()] }
  const play = findAll(T.ResolvedCard({ it: sent() }), (n) => n.type === 'button' && /rq-play/.test(n.props.className ?? ''))
  assert.equal(play.length, 1)
  assert.match(textOf(play[0]), /Read aloud/)
  play[0].props.onClick()
  await tick()
  assert.deepEqual(calls, [['/review-queue/v1/read', { id: 'f1' }]])
})

test('resolved: a follow-up without a session id has no Open session button; a cancelled one reads Cancelled', () => {
  const { T } = loadClient()
  assert.equal(T.openControl(sent(), true), 'button')
  assert.equal(T.openControl(sent({ sessionId: undefined }), true), 'none')
  assert.equal(T.openControl(sent(), false), 'none')
  assert.equal(T.resolutionText(sent({ state: 'cancelled', resolution: { kind: 'cancelled', by: 'card' } })), 'Cancelled')
})

// ---- the source ------------------------------------------------------------------------------------------------

test('source: the card and the form are exported to the tests, the shared helpers carry the follow-up cases to the phone page', () => {
  const { T, mod } = loadClient()
  for (const name of ['TodoBody', 'FollowUpBody', 'Card', 'TodoForm', 'setTodoMode', 'cardTitle']) need(T, name)
  for (const name of ['todoLine', 'todoSelect', 'todoTarget', 'todoCardState', 'cardTitle', 'resolutionText']) assert.equal(typeof mod.shared[name], 'function', 'shared.' + name)
  assert.match(source, /Which session/)
})
