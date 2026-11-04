// Slice 3 of the AI triage plan (RED): the desktop Resolved card for an item the AI resolved - badge, details, seen, review buttons, reopen.
// State keys the card uses (desktop store): aiOpen { [id]: true } (expanded) and dialog { kind: 'wrong' | 'overrule', id, text } (the Mark wrong and Overrule rule
// dialogs; Looks right is a plain action button). The inline aiCorrection / aiOverrule keys are gone.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { file } from './client-todo-helpers.mjs'
import { loadClient, el, findAll, textOf, tick } from './client-todo-helpers.mjs'

const URL_REVIEW = '/review-queue/v1/triage-review'
const URL_REOPEN = '/review-queue/v1/reopen'

function load() {
  const calls = []
  const fetchImpl = async (url, init) => { calls.push([url, init && init.body ? JSON.parse(init.body) : undefined]); return { ok: true, status: 200, json: async () => ({ ok: true }) } }
  const { T } = loadClient({ fetchImpl, react: { createElement: el } })
  T.state.snap = { snapshotId: 'e:1', open: [], resolved: [] }
  return { T, calls }
}
const aiItem = (over = {}, res = {}) => ({ id: 'a1', sessionId: 's1', type: 'permission', status: 'resolved', title: 'Run ls', createdAt: 1, resolvedAt: 2, triage: { ruleName: 'Read-only commands' },
  resolution: { kind: 'ai-resolved', by: 'ai', action: 'approved', ruleId: 'r1', quote: 'ls is read only', score: 9.6, ...res }, ...over })
const meItem = () => ({ id: 'm1', type: 'permission', status: 'resolved', title: 'Run pwd', createdAt: 1, resolvedAt: 2, resolution: { kind: 'approved', by: 'card' } })
const attr = (name, id) => (n) => n.props && n.props[name] === id
const buttons = (tree) => findAll(tree, (n) => n.type === 'button')
const btn = (tree, re) => buttons(tree).find((b) => re.test(textOf(b)))
const header = (tree) => findAll(tree, (n) => typeof n.props.className === 'string' && n.props.className.split(' ').includes('rq-card-h'))[0]
const render = (T, it) => T.ResolvedCard({ it })
const must = (x, what) => { assert.ok(x, 'missing: ' + what); return x }
const toggle = (T, it) => { const h = header(render(T, it)); assert.equal(typeof h.props.onClick, 'function', 'the card header toggles the card'); h.props.onClick({ target: { closest: () => null } }) }
const press = (tree, re) => must(btn(tree, re), 'button ' + re).props.onClick()
const expand = (T, it) => { T.state.aiOpen = { [it.id]: true } }

test('isReopenable: an AI-resolved completed or paused item can be reopened; question, permission and other types cannot', () => {
  const { T } = load()
  const r = (type, kind = 'ai-resolved') => ({ type, status: 'resolved', resolution: { kind } })
  assert.equal(T.isReopenable(r('completed')), true)
  assert.equal(T.isReopenable(r('paused')), true)
  assert.equal(T.isReopenable(r('question')), false)
  assert.equal(T.isReopenable(r('permission')), false)
  assert.equal(T.isReopenable(r('todo')), false)
  assert.equal(T.isReopenable(r('pr-merged')), false)
})

test('isReopenable: the existing cases are unchanged', () => {
  const { T } = load()
  for (const kind of ['reviewed', 'superseded', 'no-action', 'trimmed']) assert.equal(T.isReopenable({ type: 'completed', resolution: { kind } }), true, kind)
  assert.equal(T.isReopenable({ type: 'completed', resolution: { kind: 'dismissed' } }), false)
  assert.equal(T.isReopenable({ type: 'paused', resolution: { kind: 'resumed' } }), false)
  assert.equal(T.isReopenable({ type: 'question', resolution: { kind: 'reviewed' } }), false)
  assert.equal(T.isReopenable(undefined), false)
})

test('an AI-resolved card shows an AI badge and the resolution line, collapsed', () => {
  const { T } = load()
  const tree = render(T, aiItem())
  assert.equal(findAll(tree, attr('data-ai-badge', 'a1')).length, 1)
  assert.match(textOf(findAll(tree, attr('data-ai-badge', 'a1'))[0]), /AI/)
  assert.match(textOf(tree), /AI approved it/)
  assert.equal(findAll(tree, attr('data-ai-detail', 'a1')).length, 0, 'details stay hidden until the card is opened')
})

test('a non-AI resolved card has no AI badge, details, review buttons or correction box', () => {
  const { T } = load()
  expand(T, meItem())
  const tree = render(T, meItem())
  assert.equal(findAll(tree, (n) => n.props && ('data-ai-badge' in n.props || 'data-ai-detail' in n.props || 'data-ai-correction' in n.props)).length, 0)
  for (const re of [/Looks right/, /Mark wrong/, /Overrule rule/]) assert.equal(btn(tree, re), undefined, String(re))
})

test('clicking the card header toggles aiOpen and the details block shows the quote, rule name and attention score', () => {
  const { T } = load()
  const it = aiItem({}, { seen: true })
  toggle(T, it)
  assert.equal(T.state.aiOpen.a1, true)
  const detail = findAll(render(T, it), attr('data-ai-detail', 'a1'))[0]
  assert.ok(detail, 'a details block')
  assert.match(textOf(detail), /ls is read only/)
  assert.match(textOf(detail), /Read-only commands/)
  assert.match(textOf(detail), /attention 10\b/)
  toggle(T, it)
  assert.equal(findAll(render(T, it), attr('data-ai-detail', 'a1')).length, 0)
})

test('the header of an AI card advertises what a click does: show or hide details, never Open session', () => {
  const { T } = load()
  const it = aiItem({}, { seen: true })
  assert.equal(header(render(T, it)).props.title, 'Show details')
  assert.equal(header(render(T, it)).props.style.cursor, 'pointer')
  expand(T, it)
  assert.equal(header(render(T, it)).props.title, 'Hide details')
})

test('details fall back to the rule id when there is no rule name', () => {
  const { T } = load()
  const it = aiItem({ triage: undefined }, { seen: true })
  expand(T, it)
  assert.match(textOf(must(findAll(render(T, it), attr('data-ai-detail', 'a1'))[0], 'details block')), /r1/)
})

test('expanding an unseen AI card posts review seen once; not again, not on collapse', async () => {
  const { T, calls } = load()
  const it = aiItem()
  toggle(T, it)
  await tick()
  assert.deepEqual(calls, [[URL_REVIEW, { id: 'a1', review: 'seen' }]])
  toggle(T, it) // collapse
  await tick()
  toggle(T, aiItem({}, { seen: true })) // expand again; the snapshot after the success carries the seen mark
  await tick()
  assert.equal(calls.length, 1, 'no second request once the snapshot shows it seen')
})

test('expanding an unseen AI card again while its seen request is in flight does not post twice', async () => {
  const { T, calls } = load()
  const it = aiItem({ id: 'fl1' })
  toggle(T, it)
  toggle(T, it) // collapse, no await: the first request is still in flight
  toggle(T, it) // expand again
  await tick()
  assert.equal(calls.length, 1)
})

test('expanding an already seen, or already reviewed, AI card posts nothing', async () => {
  const { T, calls } = load()
  toggle(T, aiItem({ id: 's1' }, { seen: true }))
  toggle(T, aiItem({ id: 'r1' }, { review: 'agreed' }))
  toggle(T, meItem())
  await tick()
  assert.deepEqual(calls, [])
})

test('Looks right posts review agreed; the three review buttons show only while there is no review', async () => {
  const { T, calls } = load()
  const it = aiItem({}, { seen: true })
  expand(T, it)
  const tree = render(T, it)
  assert.ok(btn(tree, /Mark wrong/) && btn(tree, /Overrule rule/))
  press(tree, /Looks right/)
  await tick()
  assert.deepEqual(calls, [[URL_REVIEW, { id: 'a1', review: 'agreed' }]])
  for (const review of ['agreed', 'matched-user', 'overruled']) {
    const reviewed = aiItem({}, { seen: true, review })
    const t = render(T, reviewed)
    assert.equal(btn(t, /Looks right/), undefined, review)
    assert.equal(btn(t, /Mark wrong/), undefined, review)
    assert.equal(!!btn(t, /Overrule rule/), review !== 'overruled', 'Overrule rule stays unless overruled: ' + review)
  }
})

const dialogTree = (T) => { const n = findAll(T.Panel(), (x) => typeof x.type === 'function' && x.type.name === 'DialogHost')[0]; assert.ok(n, 'DialogHost is rendered'); return n.type(n.props) }
const dlg = (T) => dialogTree(T)

test('Mark wrong opens a dialog with a correction box; Send correction is disabled while the trimmed text is empty and posts the trimmed text', async () => {
  const { T, calls } = load()
  const it = aiItem({ type: 'completed' }, { seen: true })
  expand(T, it)
  assert.equal(dlg(T), null)
  press(render(T, it), /Mark wrong/)
  assert.deepEqual({ ...T.state.dialog }, { kind: 'wrong', id: 'a1', text: '' })
  assert.equal(findAll(render(T, it), attr('data-ai-correction', 'a1')).length, 0, 'no inline box in the card')
  const box = () => must(findAll(dlg(T), (n) => n.type === 'textarea')[0], 'the correction box')
  const send = () => must(btn(dlg(T), /Send correction/), 'a Send correction button')
  assert.equal(send().props.disabled, true)
  box().props.onChange({ target: { value: '   ' } })
  assert.equal(send().props.disabled, true, 'blank text stays disabled')
  box().props.onChange({ target: { value: '  Use main instead  ' } })
  assert.ok(!send().props.disabled)
  send().props.onClick()
  await tick()
  assert.deepEqual(calls, [[URL_REVIEW, { id: 'a1', review: 'mark-wrong', text: 'Use main instead' }]])
})

test('for a question or permission the correction dialog says the answer cannot be unsent; for done it does not', () => {
  const { T } = load()
  for (const [type, unsent] of [['question', true], ['permission', true], ['completed', false]]) {
    const it = aiItem({ id: 'x-' + type, type }, { seen: true })
    expand(T, it)
    T.state.snap = { snapshotId: 'e:1', open: [], resolved: [it] }
    press(render(T, it), /Mark wrong/)
    assert.equal(/cannot be unsent/.test(textOf(dlg(T))), unsent, type)
  }
})

test('Overrule rule opens a dialog offering observe and off, each posting overrule-rule with its mode', async () => {
  const { T, calls } = load()
  const it = aiItem({}, { seen: true })
  expand(T, it)
  assert.equal(dlg(T), null, 'the choices wait for a click')
  press(render(T, it), /Overrule rule/)
  assert.deepEqual({ ...T.state.dialog }, { kind: 'overrule', id: 'a1', text: '' })
  press(dlg(T), /Set rule to observe/)
  await tick()
  press(render(T, it), /Overrule rule/)
  press(dlg(T), /Set rule to off/)
  await tick()
  assert.deepEqual(calls, [[URL_REVIEW, { id: 'a1', review: 'overrule-rule', mode: 'observe' }], [URL_REVIEW, { id: 'a1', review: 'overrule-rule', mode: 'off' }]])
})

test('Reopen shows for an AI-resolved completed or paused card and posts /v1/reopen; never for question or permission', async () => {
  const { T, calls } = load()
  for (const type of ['question', 'permission']) assert.equal(btn(render(T, aiItem({ id: type, type }, { seen: true })), /Reopen/), undefined, type)
  for (const type of ['completed', 'paused']) assert.ok(btn(render(T, aiItem({ id: type, type }, { seen: true })), /Reopen/), type)
  press(render(T, aiItem({ type: 'completed' }, { seen: true })), /Reopen/)
  await tick()
  assert.deepEqual(calls, [[URL_REOPEN, { id: 'a1' }]])
})

test('while busy the review buttons are disabled; a server error shows on the card', () => {
  const { T } = load()
  const it = aiItem({ type: 'completed' }, { seen: true })
  expand(T, it)
  T.state.busy = { a1: true }
  const tree = render(T, it)
  for (const re of [/Looks right/, /Mark wrong/, /Overrule rule/, /Reopen/]) assert.equal(must(btn(tree, re), 'button ' + re).props.disabled, true, String(re))
  T.state.busy = {}
  T.state.errors = { a1: 'Could not do that (boom).' }
  const err = findAll(render(T, it), (n) => n.props && n.props.className === 'rq-err')
  assert.equal(err.length, 1)
  assert.match(textOf(err[0]), /boom/)
})

test('Mark wrong is hidden on a paused item and on an item without a session; Looks right and Overrule rule stay', () => {
  const { T } = load()
  for (const over of [{ type: 'paused' }, { sessionId: undefined }, { sessionId: '' }]) {
    const it = aiItem(over, { seen: true })
    expand(T, it)
    const tree = render(T, it)
    assert.equal(btn(tree, /Mark wrong/), undefined, JSON.stringify(over))
    assert.ok(btn(tree, /Looks right/) && btn(tree, /Overrule rule/), JSON.stringify(over))
  }
})


// ---- the dialogs close after a success, stay on a failure, and are per item -------------------------------------------------------------------

function loadWith(reply) {
  const calls = []
  const fetchImpl = async (url, init) => { calls.push([url, init && init.body ? JSON.parse(init.body) : undefined]); return reply() }
  const { T } = loadClient({ fetchImpl, react: { createElement: el } })
  T.state.snap = { snapshotId: 'e:1', open: [], resolved: [] }
  return { T, calls }
}
const OKR = () => ({ ok: true, status: 200, json: async () => ({ ok: true }) })
const FAILR = () => ({ ok: false, status: 500, json: async () => ({}) })

test('a successful review closes the dialog of that item (Set rule to observe, Send correction); a failure keeps it with its text', async () => {
  for (const how of ['overrule', 'mark-wrong']) {
    for (const ok of [true, false]) {
      const { T } = loadWith(ok ? OKR : FAILR)
      T.set({ dialog: { kind: how === 'overrule' ? 'overrule' : 'wrong', id: 'a1', text: how === 'overrule' ? '' : 'Use main' } })
      press(dlg(T), how === 'overrule' ? /Set rule to observe/ : /Send correction/)
      await tick(); await tick()
      assert.equal(T.state.dialog === null, ok, how + ': dialog ' + (ok ? 'closed' : 'kept'))
      if (!ok) assert.equal(T.state.dialog.text, how === 'overrule' ? '' : 'Use main', how + ': the open dialog keeps its text')
    }
  }
})

test('Looks right is a plain action: it posts agreed at once and opens no dialog', async () => {
  const { T, calls } = loadWith(OKR)
  const it = aiItem({ type: 'completed' }, { seen: true })
  expand(T, it)
  press(render(T, it), /Looks right/)
  await tick()
  assert.equal(T.state.dialog, null)
  assert.deepEqual(calls, [[URL_REVIEW, { id: 'a1', review: 'agreed' }]])
})

test('opening Mark wrong replaces any other dialog: one dialog at a time, no stale text', () => {
  const { T } = loadWith(OKR)
  const it = aiItem({ type: 'completed' }, { seen: true })
  expand(T, it)
  T.set({ dialog: { kind: 'wrong', id: 'other', text: 'typed for the other card' } })
  press(render(T, it), /Mark wrong/)
  assert.deepEqual({ ...T.state.dialog }, { kind: 'wrong', id: 'a1', text: '' })
})

test('the seen call of an expanded unseen AI card is silent: no busy and no error text, in flight or after a failure; earlier ones are kept', async () => {
  let release
  const { T, calls } = loadWith(() => new Promise((r) => { release = () => r(FAILR()) }))
  T.state.errors = { a1: 'Could not do that (earlier).' }
  T.state.busy = {}
  toggle(T, aiItem())
  await tick()
  assert.equal(calls.length, 1)
  assert.ok(!T.state.busy.a1, 'no busy while the seen request is in flight')
  assert.equal(T.state.errors.a1, 'Could not do that (earlier).', 'an earlier error is not cleared while in flight')
  release()
  await tick()
  assert.ok(!T.state.busy.a1, 'no busy after the failure')
  assert.equal(T.state.errors.a1, 'Could not do that (earlier).', 'a failed seen call writes no error text')
})

test('a successful silent seen call leaves an earlier error and busy untouched', async () => {
  const { T, calls } = loadWith(OKR)
  T.state.errors = { a1: 'Could not do that (earlier).' }
  T.state.busy = { a1: true }
  toggle(T, aiItem())
  await tick()
  assert.equal(calls.length, 1)
  assert.equal(T.state.busy.a1, true, 'busy was not reset by the seen call')
  assert.equal(T.state.errors.a1, 'Could not do that (earlier).')
})

test('the seen in-flight guard still blocks duplicates and is cleared in finally, so a failed call can be retried', async () => {
  let n = 0
  const { T, calls } = loadWith(() => { n += 1; return n === 1 ? FAILR() : OKR() })
  const it = aiItem()
  toggle(T, it) // expand: request 1 (fails)
  toggle(T, it) // collapse
  toggle(T, it) // expand again while request 1 is in flight: no duplicate
  assert.equal(calls.length, 1, 'no duplicate while in flight')
  await tick()
  toggle(T, it) // collapse
  toggle(T, it) // expand: the guard was cleared, retry
  await tick()
  assert.equal(calls.length, 2, 'a failed seen call can be tried again')
})


test('source: the review node has no inline form state any more (no aiCorrection, no aiOverrule, no data-ai-correction box)', () => {
  const src = readFileSync(file, 'utf8')
  const a = src.indexOf('function aiReviewNode'), b = src.indexOf('function ResolvedCard')
  assert.ok(a >= 0 && b > a, 'aiReviewNode markers found')
  const body = src.slice(a, b)
  assert.doesNotMatch(body, /aiCorrection|aiOverrule|data-ai-correction/)
  assert.doesNotMatch(src, /aiCorrection|aiOverrule|holdOpen/, 'the old inline state keys are gone from the whole file')
  assert.match(body, /openDialog\(/, 'Mark wrong and Overrule rule open a dialog')
})