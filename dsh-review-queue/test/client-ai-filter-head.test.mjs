// Slice 3 of the AI triage plan, as drawn by the tab design: the "Resolved by" tabs of the Resolved view (All / By me / By AI), the unseen
// count of AI items on the Resolved tab and on By AI (the header chip "AI handled N" is gone), and the empty message of the Resolved list.
// The tabs of the Resolved-by row carry data-resolved-by="all|me|ai" (the type tabs do not). See client-tabs.test.mjs for the tab roles and keys.
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
const tabs = (tree) => findAll(tree, (n) => n.props && n.props.role === 'tab' && n.props['data-resolved-by'])
const tab = (tree, v) => { const c = tabs(tree).find((c) => c.props['data-resolved-by'] === v); assert.ok(c, 'a Resolved-by tab ' + v); return c }
const badgeTexts = (t) => findAll(t, (n) => typeof n.props?.className === 'string' && n.props.className.split(' ').includes('rq-n')).map((b) => textOf(b))
const handled = (tree) => findAll(tree, (n) => n.props && 'data-ai-handled' in n.props)

test('in the Resolved view the "Resolved by" tablist has All / By me / By AI, All selected', () => {
  const T = load()
  T.state.snap = snapOf([ai('a1', { seen: true }), me('m1')])
  T.state.showResolved = true
  const bar = part(T, 'SubTabs')
  const list = findAll(bar, (n) => n.props?.role === 'tablist' && n.props['aria-label'] === 'Resolved by')[0]
  assert.ok(list)
  assert.deepEqual(tabs(bar).map((c) => c.props['data-resolved-by']), ['all', 'me', 'ai'])
  assert.deepEqual(tabs(bar).map((c) => c.children[0]), ['All', 'By me', 'By AI'])
  for (const c of tabs(bar)) assert.equal(c.props['aria-selected'], c.props['data-resolved-by'] === 'all')
})

test('clicking a Resolved-by tab sets filter.resolvedBy and keeps type and query', () => {
  const T = load()
  T.state.snap = snapOf([ai('a1', { seen: true })])
  T.state.showResolved = true
  T.set({ filter: { type: 'permission', query: 'ls', resolvedBy: 'all' } })
  tab(part(T, 'SubTabs'), 'ai').props.onClick()
  assert.deepEqual({ ...T.state.filter }, { type: 'permission', query: 'ls', resolvedBy: 'ai' })
  const bar = part(T, 'SubTabs')
  assert.equal(tab(bar, 'ai').props['aria-selected'], true)
  assert.equal(tab(bar, 'all').props['aria-selected'], false)
  tab(bar, 'me').props.onClick()
  assert.equal(T.state.filter.resolvedBy, 'me')
})

test('the Resolved-by tabs are not in the waiting view', () => {
  const T = load()
  T.state.snap = snapOf([ai('a1', { seen: true })])
  T.state.showResolved = false
  assert.equal(tabs(part(T, 'SubTabs')).length, 0)
})

test('the By AI tab and the Resolved tab show the unseen count (second badge "N new") when above zero, not otherwise', () => {
  const T = load()
  T.state.showResolved = true
  T.state.snap = snapOf([ai('a1'), ai('a2'), ai('a3', { seen: true }), ai('a4', { review: 'agreed' }), me('m1')])
  assert.deepEqual(badgeTexts(tab(part(T, 'SubTabs'), 'ai')), ['4', '2 new'])
  assert.deepEqual(badgeTexts(tab(part(T, 'SubTabs'), 'me')), ['1'])
  const resolvedTab = () => findAll(part(T, 'ViewTabs'), (n) => n.props?.role === 'tab' && n.props['data-tab'] === 'resolved')[0]
  assert.deepEqual(badgeTexts(resolvedTab()), ['5', '2 new'])
  T.state.snap = snapOf([ai('a3', { seen: true })])
  assert.deepEqual(badgeTexts(tab(part(T, 'SubTabs'), 'ai')), ['1'])
  assert.deepEqual(badgeTexts(resolvedTab()), ['1'])
})

test('the header has no "AI handled" chip, whatever is unseen', () => {
  const T = load()
  T.state.snap = snapOf([ai('a1'), ai('a2'), me('m1')])
  assert.equal(handled(part(T, 'Head')).length, 0)
  assert.doesNotMatch(textOf(part(T, 'Head')), /AI handled/)
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

test('the Phone tab replaces the header button: it leaves the filter alone and clears the other views', () => {
  const T = load()
  T.state.snap = snapOf([])
  T.set({ showRules: true, showPhone: false, filter: { type: 'question', query: 'a', resolvedBy: 'me' } })
  const phone = () => findAll(part(T, 'ViewTabs'), (n) => n.props?.role === 'tab' && n.props['data-tab'] === 'phone')[0]
  assert.ok(phone(), 'a Phone tab')
  phone().props.onClick()
  assert.equal(T.state.showPhone, true)
  assert.equal(T.state.showRules, false, 'one view at a time')
  assert.deepEqual({ ...T.state.filter }, { type: 'question', query: 'a', resolvedBy: 'me' })
})
