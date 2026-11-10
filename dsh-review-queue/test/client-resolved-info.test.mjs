// A resolved card shows the same information as a waiting card: the session and workspace line, the time it was raised and the original message
// (read only: no answer box, no Approve / Deny / Send / Reviewed). The pure model is resolvedBody(item, now) and the line helpers
// resolvedSessionLine(item) / raisedText(item, now); the card (T.ResolvedCard) draws them.
import test from 'node:test'
import assert from 'node:assert/strict'
import { loadClient, el, findAll, textOf } from './client-todo-helpers.mjs'

const H = 3600e3
function load() {
  const { T, mod } = loadClient({ react: { createElement: el } })
  T.state.snap = { snapshotId: 'e:1', open: [], resolved: [] }
  return { T, shared: mod.shared }
}
const base = (over = {}) => ({ id: 'x1', sessionId: 's1', sessionTitle: 'Fix login', workspace: 'dsh-plugins', status: 'resolved', createdAt: Date.now() - 3 * H, resolvedAt: Date.now() - H, ...over })
const question = (over = {}) => base({
  type: 'question', title: 'Which db?',
  payload: { questions: [{ id: 'q1', header: 'Storage', question: 'Which database should we use?', options: [{ label: 'Postgres (Recommended)', description: 'Relational' }, { label: 'SQLite' }] }] },
  resolution: { kind: 'answered', by: 'card', answers: [{ id: 'q1', selected: ['SQLite'] }] }, ...over })
const permission = (over = {}) => base({
  type: 'permission', title: 'Run rm', risks: [{ code: 'delete', label: 'Deletes files' }],
  payload: { toolName: 'Bash', summary: 'rm -rf build', detail: 'rm -rf build && echo done', reason: 'Clean the build folder' },
  resolution: { kind: 'approved', by: 'card' }, ...over })
const completed = (over = {}) => base({
  type: 'completed', title: 'Done', summary: 'Fixed the **login** bug.', payload: { reply: 'Long reply with <img src=x onerror=1> text' },
  resolution: { kind: 'reviewed', by: 'card' }, ...over })
// The message is built only while its fold is open (state.resOpen[id]); this helper opens it first.
const render = (T, it) => { T.state.resOpen = { ...T.state.resOpen, [it.id]: true }; return T.ResolvedCard({ it }) }
const buttons = (tree) => findAll(tree, (n) => n.type === 'button')

test('resolvedSessionLine: session title and workspace; nothing when both are missing', () => {
  const { shared } = load()
  assert.equal(shared.resolvedSessionLine(base()), 'Fix login · dsh-plugins')
  assert.equal(shared.resolvedSessionLine(base({ workspace: undefined })), 'Fix login')
  assert.equal(shared.resolvedSessionLine(base({ sessionTitle: undefined, workspace: undefined })), '')
})

test('raisedText: "Raised <age>" counted from createdAt', () => {
  const { shared } = load()
  assert.equal(shared.raisedText(base({ createdAt: 1000 }), 1000 + 3 * H), 'Raised 3 h ago')
  assert.equal(shared.raisedText(base({ createdAt: undefined }), 5), '')
})

test('resolvedBody question: each question with its options, the chosen one marked, a custom answer kept', () => {
  const { shared } = load()
  const b = shared.resolvedBody(question(), Date.now())
  assert.equal(b.kind, 'question')
  assert.equal(b.questions.length, 1)
  assert.equal(b.questions[0].question, 'Which database should we use?')
  assert.equal(b.questions[0].header, 'Storage')
  assert.deepEqual(b.questions[0].options.map((o) => [o.label, o.chosen, o.recommended]), [['Postgres (Recommended)', false, true], ['SQLite', true, false]])
  const c = shared.resolvedBody(question({ resolution: { kind: 'answered', by: 'card', answers: [{ id: 'q1', selected: [], custom: 'MySQL' }] } }), Date.now())
  assert.equal(c.questions[0].custom, 'MySQL')
  assert.equal(shared.resolvedBody(question({ resolution: { kind: 'expired' } }), Date.now()).questions[0].options.every((o) => !o.chosen), true)
})

test('resolvedBody permission: command, risks and reason', () => {
  const { shared } = load()
  const b = shared.resolvedBody(permission(), Date.now())
  assert.equal(b.kind, 'permission')
  assert.equal(b.summary, 'rm -rf build')
  assert.equal(b.detail, 'rm -rf build && echo done')
  assert.deepEqual(b.risks.map((r) => r.label), ['Deletes files'])
  assert.equal(b.reason, 'Clean the build folder')
  assert.equal(shared.resolvedBody(permission({ payload: { toolName: 'Bash', summary: 'ls', detail: 'ls' } }), Date.now()).detail, undefined, 'a detail equal to the summary is not repeated')
})

test('resolvedBody completed: summary and the full reply', () => {
  const { shared } = load()
  const b = shared.resolvedBody(completed(), Date.now())
  assert.equal(b.kind, 'completed')
  assert.equal(b.summary, 'Fixed the **login** bug.')
  assert.match(b.reply, /Long reply/)
  assert.equal(shared.resolvedBody(completed({ summary: undefined, payload: {} }), Date.now()).summary, 'Finished.')
  assert.equal(shared.resolvedBody(completed({ payload: {} }), Date.now()).reply, undefined)
})

test('resolvedBody paused, on hold, todo, pr-merged, archive: facts or text; unknown types have no body', () => {
  const { shared } = load()
  const now = Date.now()
  const p = shared.resolvedBody(base({ type: 'paused', payload: { reason: 'Cut off by a restart', lastWrite: now - H, lastUser: 'Do X' } }), now)
  assert.equal(p.kind, 'facts')
  assert.equal(p.facts[0], 'Cut off by a restart')
  assert.ok(p.facts.some((f) => /Last request: Do X/.test(f)))
  const h = shared.resolvedBody(base({ type: 'onhold', payload: { reason: 'Waiting for the customer', heldAt: now - H } }), now)
  assert.equal(h.kind, 'facts')
  assert.equal(h.facts[0], 'Waiting for the customer')
  assert.deepEqual({ ...shared.resolvedBody(base({ type: 'todo', text: 'Write the docs' }), now) }, { kind: 'text', text: 'Write the docs' })
  assert.match(shared.resolvedBody(base({ type: 'pr-merged', payload: { prId: 42 } }), now).text, /42/)
  assert.doesNotMatch(shared.resolvedBody(base({ type: 'pr-merged', payload: {} }), now).text, /undefined/, 'a missing prId never prints undefined')
  assert.match(shared.resolvedBody(base({ type: 'archive', payload: { reason: 'All done' } }), now).text, /All done/)
  assert.equal(shared.resolvedBody(base({ type: 'mystery' }), now), undefined)
  assert.equal(shared.resolvedBody(undefined, now), undefined)
})

test('resolvedBody never throws on a malformed payload (null entries, non-string text): one bad item must not blank the list', () => {
  const { shared } = load()
  const now = Date.now()
  const q = shared.resolvedBody(base({ type: 'question', payload: { questions: [null, { id: 'q', question: { x: 1 }, options: [null, { label: 5 }, { label: 'A' }] }, 'str'] }, resolution: { kind: 'answered', answers: [null, { id: 'q', selected: 'A' }] } }), now)
  assert.equal(q.kind, 'question')
  assert.equal(q.questions.length, 1)
  assert.equal(q.questions[0].question, '')
  assert.deepEqual(q.questions[0].options.map((o) => o.label), ['A'])
  const p = shared.resolvedBody(base({ type: 'permission', risks: [null, { label: 7 }, { code: 'x', label: 'Risky' }], payload: { summary: { a: 1 }, detail: 3, reason: [] } }), now)
  assert.equal(p.summary, '')
  assert.equal(p.detail, undefined)
  assert.equal(p.reason, undefined)
  assert.deepEqual(p.risks.map((r) => r.label), ['Risky'])
  const c = shared.resolvedBody(base({ type: 'completed', summary: { a: 1 }, payload: { reply: 5 } }), now)
  assert.equal(c.summary, 'Finished.')
  assert.equal(c.reply, undefined)
  assert.equal(shared.resolvedBody(base({ type: 'todo', text: 7 }), now), undefined)
})

test('resolvedBody: a paused item with a non-array danglingCalls does not throw; archive reason and prId are coerced to text', () => {
  const { shared } = load()
  const now = Date.now()
  assert.doesNotThrow(() => shared.resolvedBody(base({ type: 'paused', payload: { reason: 'x', lastWrite: now, danglingCalls: 'Bash' } }), now))
  assert.doesNotThrow(() => shared.resolvedBody(base({ type: 'onhold', payload: { reason: 'x', heldAt: now, ticket: 'AB#1' } }), now))
  assert.doesNotMatch(shared.resolvedBody(base({ type: 'archive', payload: { reason: { a: 1 } } }), now).text, /object/)
  assert.doesNotMatch(shared.resolvedBody(base({ type: 'pr-merged', payload: { prId: { a: 1 } } }), now).text, /object/)
})

test('resolvedBody facts are always text: an object reason, lastUser or error never reaches the card as a React child', () => {
  const { T, shared } = load()
  const now = Date.now()
  const bad = { a: 1 }
  const items = [
    base({ type: 'paused', payload: { reason: bad, lastWrite: now, lastUser: bad, danglingCalls: [bad, 'Bash'] } }),
    base({ type: 'onhold', payload: { reason: bad, heldAt: now, ticket: { id: bad }, checkError: bad, continueError: bad } }),
  ]
  for (const it of items) {
    const b = shared.resolvedBody(it, now)
    assert.equal(b.kind, 'facts')
    assert.ok(b.facts.length > 0 && b.facts.every((f) => typeof f === 'string'), 'every fact is a string: ' + JSON.stringify(b.facts))
    assert.doesNotThrow(() => render(T, it))
  }
})

test('resolvedBody facts never print NaN or [object Object] for non-numeric times or an object ticket id', () => {
  const { shared } = load()
  const now = Date.now()
  const items = [
    base({ type: 'paused', payload: { reason: 'x', lastWrite: 'soon' } }),
    base({ type: 'onhold', payload: { reason: 'x', heldAt: 'soon', lastCheckedAt: 'soon', ticket: { id: { a: 1 } } } }),
    base({ type: 'onhold', payload: { reason: 'x', heldAt: now, ticket: { id: NaN } } }),
  ]
  for (const it of items) {
    const text = shared.resolvedBody(it, now).facts.join(' | ')
    assert.doesNotMatch(text, /NaN|\[object Object\]|undefined/, text)
  }
})

test('resolvedBody paused: no "half done" line when no dangling call is a usable name', () => {
  const { shared } = load()
  const now = Date.now()
  const none = shared.resolvedBody(base({ type: 'paused', payload: { reason: 'x', lastWrite: now, danglingCalls: [{ a: 1 }, ''] } }), now)
  assert.ok(!none.facts.some((f) => /half done/.test(f)), none.facts.join(' | '))
  const some = shared.resolvedBody(base({ type: 'paused', payload: { reason: 'x', lastWrite: now, danglingCalls: ['Bash', { a: 1 }] } }), now)
  assert.ok(some.facts.some((f) => /half done: Bash$/.test(f)))
})

test('a closed ResolvedCard does not build its message: the payload is read only once the fold is open', () => {
  const { T } = load()
  let reads = 0
  const it = question()
  const payload = it.payload
  Object.defineProperty(it, 'payload', { get() { reads++; return payload } })
  const closed = T.ResolvedCard({ it })
  assert.equal(reads, 0, 'closed: payload untouched')
  assert.ok(findAll(closed, (n) => n.props && n.props['data-res-body'] === 'x1').length, 'the closed fold is still there')
  T.state.resOpen = { ...T.state.resOpen, x1: true }
  T.ResolvedCard({ it })
  assert.ok(reads > 0, 'open: the message is built')
  assert.equal(findAll(T.ResolvedCard({ it: base({ type: 'mystery' }) }), (n) => n.props && n.props['data-res-body']).length, 0, 'no fold for an unknown type')
  assert.equal(findAll(T.ResolvedCard({ it: base({ type: 'todo', text: '' }) }), (n) => n.props && n.props['data-res-body']).length, 0, 'no fold for a todo without text')
})

test('ResolvedCard renders a risk without a code and a malformed item without throwing', () => {
  const { T } = load()
  assert.doesNotThrow(() => render(T, permission({ risks: [{ label: 'No code' }, { label: 'Also none' }] })))
  assert.doesNotThrow(() => render(T, question({ payload: { questions: [null] } })))
})

test('ResolvedCard shows the session and workspace line and the time raised', () => {
  const { T } = load()
  const tree = render(T, question())
  const info = findAll(tree, (n) => n.props && n.props['data-res-info'] === 'x1')[0]
  assert.ok(info, 'a session / raised line')
  assert.match(textOf(info), /Fix login · dsh-plugins/)
  assert.match(textOf(info), /Raised 3 h ago/)
})

test('ResolvedCard without a session still shows when it was raised, and never prints undefined', () => {
  const { T } = load()
  const tree = render(T, question({ sessionTitle: undefined, workspace: undefined }))
  assert.match(textOf(tree), /Raised 3 h ago/)
  assert.doesNotMatch(textOf(tree), /undefined/)
})

test('ResolvedCard question: the question, every option, the chosen one marked, and no answer controls', () => {
  const { T } = load()
  const tree = render(T, question())
  const text = textOf(tree)
  assert.match(text, /Which database should we use\?/)
  assert.match(text, /Postgres/)
  assert.match(text, /SQLite/)
  const chosen = findAll(tree, (n) => n.props && n.props['data-chosen'] === 'true')
  assert.equal(chosen.length, 1)
  assert.match(textOf(chosen[0]), /SQLite/)
  assert.equal(findAll(tree, (n) => n.type === 'input' || n.type === 'textarea').length, 0)
  for (const b of buttons(tree)) assert.doesNotMatch(textOf(b), /Send|Approve|Deny|Reviewed/, 'no action button: ' + textOf(b))
})

test('ResolvedCard permission: the command and the risks, and no Approve / Deny', () => {
  const { T } = load()
  const tree = render(T, permission())
  const text = textOf(tree)
  assert.match(text, /rm -rf build/)
  assert.match(text, /Deletes files/)
  assert.match(text, /Clean the build folder/)
  for (const b of buttons(tree)) assert.doesNotMatch(textOf(b), /Approve|Deny/, textOf(b))
})

test('ResolvedCard completed: the summary and a collapsed Full reply, no reply box; reply text is plain text, never markup', () => {
  const { T } = load()
  const tree = render(T, completed())
  assert.match(textOf(tree), /Fixed the login bug\./)
  const details = findAll(tree, (n) => n.type === 'details' && n.children.some((c) => c && c.type === 'summary' && /Full reply/.test(textOf(c))))
  assert.equal(details.length, 1)
  assert.ok(!details[0].props.open, 'collapsed by default')
  assert.equal(findAll(tree, (n) => n.type === 'textarea').length, 0)
  assert.equal(findAll(tree, (n) => n.type === 'img' || n.type === 'script').length, 0, 'assistant text never becomes HTML')
  assert.match(textOf(details[0]), /<img src=x onerror=1>/)
  for (const b of buttons(tree)) assert.doesNotMatch(textOf(b), /Send reply|Reviewed/, textOf(b))
})

test('ResolvedCard: the original message is folded away by default (a closed details titled Message); the session line stays visible', () => {
  const { T } = load()
  for (const it of [question(), permission(), completed()]) {
    const tree = T.ResolvedCard({ it }) // not opened
    const fold = findAll(tree, (n) => n.type === 'details' && n.props['data-res-body'] === it.id)
    assert.equal(fold.length, 1, it.type + ': one fold around the message')
    assert.ok(!fold[0].props.open, it.type + ': closed by default')
    assert.equal(fold[0].children[0].type, 'summary')
    assert.match(textOf(fold[0].children[0]), /Message/)
    const info = findAll(tree, (n) => n.props && n.props['data-res-info'] === it.id)[0]
    assert.ok(info, 'the session line is outside the fold')
    assert.equal(findAll(fold[0], (n) => n === info).length, 0)
  }
})

test('ResolvedCard: a closed message is not built at all (no body nodes); opening it stores the state and builds it; the state is pruned with the snapshot', () => {
  const { T } = load()
  const it = completed()
  const closed = findAll(T.ResolvedCard({ it }), (n) => n.type === 'details' && n.props['data-res-body'] === it.id)[0]
  assert.equal(closed.children.length, 1, 'only the summary while closed')
  assert.doesNotMatch(textOf(closed), /Fixed the login bug/)
  closed.props.onToggle({ currentTarget: { open: true } })
  assert.equal(T.state.resOpen[it.id], true)
  const open = findAll(T.ResolvedCard({ it }), (n) => n.type === 'details' && n.props['data-res-body'] === it.id)[0]
  assert.equal(open.props.open, true)
  assert.match(textOf(open), /Fixed the login bug/)
  open.props.onToggle({ currentTarget: { open: false } })
  assert.equal(!!T.state.resOpen[it.id], false)
  T.state.resOpen = { [it.id]: true, gone: true }
  T.applySnapshot({ open: [], resolved: [it] })
  assert.deepEqual(Object.keys(T.state.resOpen), [it.id], 'an item that left the snapshot loses its open mark')
})

test('ResolvedCard: an unknown type or a todo without text has no Message fold', () => {
  const { T } = load()
  for (const it of [base({ type: 'mystery' }), base({ type: 'todo' })]) {
    assert.equal(findAll(T.ResolvedCard({ it }), (n) => n.type === 'details' && n.props['data-res-body']).length, 0, it.type)
  }
})

test('ResolvedCard keeps what it showed: the resolution line, Reopen and the late answer of an expired question', () => {
  const { T } = load()
  const tree = render(T, completed())
  assert.match(textOf(tree), /Reviewed/)
  assert.ok(buttons(tree).some((b) => /Reopen/.test(textOf(b))))
  const late = render(T, question({ resolution: { kind: 'expired' } }))
  assert.equal(findAll(late, (n) => n.type === 'details' && n.props.className === 'rq-late').length, 1)
})
