// Slice 3 of the AI triage plan (RED): the Resolved-by filter row, the "AI handled N" header chip and the empty message of the Resolved list.
// The chips of the Resolved-by row carry data-resolved-by="all|me|ai" (the type chips do not).
import test from 'node:test'
import assert from 'node:assert/strict'
import { loadClient, el, findAll, textOf } from './client-todo-helpers.mjs'

function load() {
  const { T } = loadClient({ react: { createElement: el } })
  return T
}
const ai = (id, res = {}) => ({ id, type: 'permission', status: 'resolved', title: 'Run ls', createdAt: 1, resolvedAt: 2, resolution: { kind: 'ai-resolved', by: 'ai', action: 'approved', ruleId: 'r1', ...res } })
const me = (id) => ({ id, type: 'permission', status: 'resolved', title: 'Run pwd', createdAt: 1, resolvedAt: 2, resolution: { kind: 'approved', by: 'card' } })
const snapOf = (resolved) => ({ snapshotId: 'e:1', open: [], resolved })
const part = (T, name) => { const n = findAll(T.Panel(), (x) => typeof x.type === 'function' && x.type.name === name)[0]; assert.ok(n, name + ' is rendered'); return n.type(n.props) }
const chips = (tree) => findAll(tree, (n) => n.type === 'button' && n.props && n.props['data-resolved-by'])
const chip = (tree, v) => { const c = chips(tree).find((c) => c.props['data-resolved-by'] === v); assert.ok(c, 'a Resolved-by chip ' + v); return c }
const handled = (tree) => findAll(tree, (n) => n.props && 'data-ai-handled' in n.props)

test('in the Resolved view a second chip row "Resolved by:" has All / Me / AI, All active', () => {
  const T = load()
  T.state.snap = snapOf([ai('a1', { seen: true }), me('m1')])
  T.state.showResolved = true
  const bar = part(T, 'FilterBar')
  assert.match(textOf(bar), /Resolved by:/)
  assert.deepEqual(chips(bar).map((c) => c.props['data-resolved-by']), ['all', 'me', 'ai'])
  assert.deepEqual(chips(bar).map((c) => textOf(c)), ['All', 'Me', 'AI'])
  for (const c of chips(bar)) {
    const on = c.props['data-resolved-by'] === 'all'
    assert.equal(c.props['aria-pressed'], on)
    assert.equal(c.props.className.split(' ').includes('on'), on)
  }
})

test('clicking a Resolved-by chip sets filter.resolvedBy and keeps type and query', () => {
  const T = load()
  T.state.snap = snapOf([ai('a1', { seen: true })])
  T.state.showResolved = true
  T.set({ filter: { type: 'permission', query: 'ls', resolvedBy: 'all' } })
  chip(part(T, 'FilterBar'), 'ai').props.onClick()
  assert.deepEqual({ ...T.state.filter }, { type: 'permission', query: 'ls', resolvedBy: 'ai' })
  const bar = part(T, 'FilterBar')
  assert.equal(chip(bar, 'ai').props['aria-pressed'], true)
  assert.equal(chip(bar, 'all').props['aria-pressed'], false)
  chip(bar, 'me').props.onClick()
  assert.equal(T.state.filter.resolvedBy, 'me')
})

test('the Resolved-by row is hidden in the waiting view', () => {
  const T = load()
  T.state.snap = snapOf([ai('a1', { seen: true })])
  T.state.showResolved = false
  const bar = part(T, 'FilterBar')
  assert.ok(bar, 'the type chips still show')
  assert.equal(chips(bar).length, 0)
  assert.doesNotMatch(textOf(bar), /Resolved by:/)
})

test('the AI chip shows the unseen count when above zero, not otherwise', () => {
  const T = load()
  T.state.showResolved = true
  T.state.snap = snapOf([ai('a1'), ai('a2'), ai('a3', { seen: true }), ai('a4', { review: 'agreed' }), me('m1')])
  assert.equal(textOf(chip(part(T, 'FilterBar'), 'ai')), 'AI (2)')
  assert.equal(textOf(chip(part(T, 'FilterBar'), 'me')), 'Me')
  T.state.snap = snapOf([ai('a3', { seen: true })])
  assert.equal(textOf(chip(part(T, 'FilterBar'), 'ai')), 'AI')
})

test('the header shows "AI handled N" while AI items are unseen; clicking it opens Resolved filtered to AI', () => {
  const T = load()
  T.state.snap = snapOf([ai('a1'), ai('a2'), ai('a3', { seen: true }), me('m1')])
  T.set({ showResolved: false, showHeld: true, showPhone: true, selected: 'x' })
  const chip = handled(part(T, 'Head'))
  assert.equal(chip.length, 1)
  assert.match(textOf(chip[0]), /AI handled 2/)
  chip[0].props.onClick()
  assert.equal(T.state.showResolved, true)
  assert.equal(T.state.showHeld, false)
  assert.equal(T.state.showPhone, false)
  assert.equal(T.state.selected, null)
  assert.equal(T.state.filter.resolvedBy, 'ai')
})

test('the header has no "AI handled" chip when nothing AI-resolved is unseen', () => {
  const T = load()
  T.state.snap = snapOf([ai('a3', { seen: true }), ai('a4', { review: 'overruled' }), me('m1')])
  assert.equal(handled(part(T, 'Head')).length, 0)
  T.state.snap = snapOf([])
  assert.equal(handled(part(T, 'Head')).length, 0)
})

test('the Resolved list says "Nothing matches this filter." for resolvedBy ai with no AI items, and its other empty message is kept', () => {
  const T = load()
  T.state.showResolved = true
  T.state.snap = snapOf([me('m1')])
  T.set({ filter: { type: 'all', query: '', resolvedBy: 'ai' } })
  assert.match(textOf(part(T, 'ResolvedList')), /Nothing matches this filter\./)
  T.state.snap = snapOf([])
  T.set({ filter: { type: 'all', query: '', resolvedBy: 'all' } })
  assert.match(textOf(part(T, 'ResolvedList')), /Nothing resolved in the last 7 days\./)
})

test('"AI handled N" also resets type to all and query to empty, so the list matches the count', () => {
  const T = load()
  T.state.snap = snapOf([ai('a1'), ai('a2'), me('m1')])
  T.set({ showResolved: false, filter: { type: 'question', query: 'zzz', resolvedBy: 'me' } })
  handled(part(T, 'Head'))[0].props.onClick()
  assert.deepEqual({ ...T.state.filter }, { type: 'all', query: '', resolvedBy: 'ai' })
})

test('the header Phone button only toggles the dialog: it leaves showRules (the AI rules view) untouched', () => {
  const T = load()
  T.state.snap = snapOf([])
  T.set({ showRules: true, showPhone: false })
  const phone = () => findAll(part(T, 'Head'), (n) => n.type === 'button' && textOf(n) === 'Phone')[0]
  assert.ok(phone(), 'a Phone button')
  phone().props.onClick()
  assert.equal(T.state.showPhone, true)
  assert.equal(T.state.showRules, true, 'opening Phone keeps the rules view')
  phone().props.onClick()
  assert.equal(T.state.showPhone, false)
  assert.equal(T.state.showRules, true, 'closing Phone keeps the rules view')
})
