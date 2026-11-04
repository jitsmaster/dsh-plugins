// The tab-based desktop overlay (lib/client.js): header, primary and secondary tabs, the Paused strip, the left listbox, the phone tab, the dialogs
// of Hold / Mark wrong / Overrule, Esc order and the "a button only if it does something" rule.
// Components are found through T.Panel() and rendered by calling them (the harness builds { type, props, children } nodes).
import test from 'node:test'
import assert from 'node:assert/strict'
import { loadClient, el, findAll, textOf, tick, okJson } from './client-todo-helpers.mjs'

const react = { createElement: el, useEffect() {}, useState: () => [0, () => {}], useRef: () => ({ current: null }) }
function load({ fetchImpl } = {}) {
  const calls = []
  const f = fetchImpl ?? (async (url, init) => { calls.push([String(url).replace('/review-queue', ''), init && init.body ? JSON.parse(init.body) : undefined]); return okJson({ ok: true }) })
  const { T } = loadClient({ fetchImpl: f, react, globals: { AbortController, AbortSignal } })
  T.state.snap = snap()
  return { T, calls }
}
const item = (id, type, over = {}) => ({ id, type, status: 'open', position: 1, createdAt: 1, sessionId: 's-' + id, title: 'T ' + id, summary: 'x', payload: {}, ...over })
const ai = (id, res = {}) => ({ id, type: 'permission', status: 'resolved', title: 'Run ls', createdAt: 1, resolvedAt: 2, sessionId: 's1', resolution: { kind: 'ai-resolved', by: 'ai', action: 'approved', ruleId: 'r1', ...res } })
const me = (id) => ({ id, type: 'permission', status: 'resolved', title: 'Run pwd', createdAt: 1, resolvedAt: 2, resolution: { kind: 'approved', by: 'card' } })
const snap = (over = {}) => ({ snapshotId: 'e:1', open: [], resolved: [], ...over })
const part = (T, name, tree = T.Panel()) => { const n = findAll(tree, (x) => typeof x.type === 'function' && x.type.name === name)[0]; assert.ok(n, name + ' is rendered'); return n.type(n.props) }
const has = (T, name) => findAll(T.Panel(), (x) => typeof x.type === 'function' && x.type.name === name).length > 0
const tablist = (tree, label) => findAll(tree, (n) => n.props?.role === 'tablist' && n.props['aria-label'] === label)[0]
const tabsOf = (list) => findAll(list, (n) => n.props?.role === 'tab')
const label = (tab) => textOf(tab).replace(/\s+/g, ' ').trim()
const badges = (tab) => findAll(tab, (n) => typeof n.props?.className === 'string' && n.props.className.split(' ').includes('rq-n')).map((b) => textOf(b))
const labels = (list) => tabsOf(list).map((t) => textOf(t.children.find((c) => typeof c === 'string') ?? '').trim())
const selected = (list) => tabsOf(list).filter((t) => t.props['aria-selected'] === true).map((t) => t.props['data-tab'] ?? t.props['data-type'] ?? t.props['data-resolved-by'])
const press = (tab, key) => { let prevented = 0; tab.props.onKeyDown({ key, preventDefault: () => { prevented++ } }); return prevented }

// ---- the header ----------------------------------------------------------------------------------------------------------------------

test('the header has the title, counts, + New todo and a close icon button: no other button', () => {
  const { T } = load()
  T.state.snap = snap({ open: [item('p1', 'paused'), item('c1', 'completed'), item('h1', 'onhold', { payload: { reason: 'x', heldAt: 1 } })], resolved: [ai('a1'), me('m1')], sessions: { working: 1, open: 6 } })
  const head = part(T, 'Head')
  const buttons = findAll(head, (n) => n.type === 'button')
  assert.deepEqual(buttons.map((b) => textOf(b)), ['+ New todo', '✕'])
  assert.match(buttons[0].props.className, /rq-btn pri/)
  assert.equal(buttons[1].props['aria-label'], 'Close (Esc)')
  assert.match(buttons[1].props.className, /rq-iconx/)
  const words = textOf(head)
  assert.match(words, /Coding Boss Review Queue/)
  assert.match(words, /1 waiting/)
  assert.match(words, /1 working \/ 6 open/)
  assert.match(words, /⏸ 1 paused/)
  for (const gone of [/Resume all/, /Find paused/, /On hold/, /Resolved/, /Phone/, /AI rules/, /AI handled/]) assert.doesNotMatch(words, gone)
  assert.equal(findAll(head, (n) => n.props && 'data-ai-handled' in n.props).length, 0)
  assert.equal(findAll(head, (n) => n.props && 'aria-pressed' in n.props).length, 0)
})

test('the close icon button closes the overlay; + New todo opens the form', () => {
  const { T } = load()
  T.set({ overlay: true })
  const buttons = findAll(part(T, 'Head'), (n) => n.type === 'button')
  buttons[0].props.onClick()
  assert.equal(T.state.todoForm.open, true)
  buttons[1].props.onClick()
  assert.equal(T.state.overlay, false)
})

// ---- the primary tabs ----------------------------------------------------------------------------------------------------------------

test('viewOf reads the old flags; setView sets them exactly as the old buttons did', async () => {
  const { T, calls } = load()
  assert.equal(T.viewOf({ showResolved: false, showHeld: false, showRules: false, showPhone: false }), 'waiting')
  assert.equal(T.viewOf({ showResolved: true }), 'resolved')
  assert.equal(T.viewOf({ showHeld: true }), 'held')
  assert.equal(T.viewOf({ showRules: true }), 'rules')
  assert.equal(T.viewOf({ showPhone: true }), 'phone')
  assert.equal(T.viewOf({ showPhone: true, showRules: true, showResolved: true }), 'phone', 'phone wins over the others')
  const flags = () => [T.state.showResolved, T.state.showHeld, T.state.showRules, T.state.showPhone]
  T.set({ selected: 'x', showResolved: true, showPhone: true })
  T.setView('held')
  assert.deepEqual(flags(), [false, true, false, false]); assert.equal(T.state.selected, null)
  T.setView('resolved'); assert.deepEqual(flags(), [true, false, false, false])
  T.setView('phone'); assert.deepEqual(flags(), [false, false, false, true])
  assert.equal(calls.length, 0, 'no rules request before the rules tab')
  T.setView('rules'); assert.deepEqual(flags(), [false, false, true, false])
  await tick()
  assert.deepEqual(calls.map((c) => c[0]), ['/v1/triage-rules'], 'entering the rules tab loads the rules')
  T.setView('waiting'); assert.deepEqual(flags(), [false, false, false, false])
  assert.equal(T.viewOf(T.state), 'waiting')
})

test('the Views tablist: five tabs in order, counts, On hold always there, one selected, roving tabindex', () => {
  const { T } = load()
  T.state.snap = snap({ open: [item('c1', 'completed'), item('q1', 'question')], resolved: [me('m1'), me('m2'), me('m3')] })
  const list = tablist(part(T, 'ViewTabs'), 'Views')
  assert.ok(list, 'a tablist named Views')
  assert.deepEqual(labels(list), ['Waiting', 'On hold', 'Resolved', 'AI rules', 'Phone'])
  const tabs = tabsOf(list)
  assert.ok(tabs.every((t) => t.type === 'button' && /rq-tab/.test(t.props.className)))
  assert.deepEqual(badges(tabs[0]), ['2'])
  assert.deepEqual(badges(tabs[1]), ['0'], 'On hold shows with nothing held')
  assert.deepEqual(badges(tabs[2]), ['3'])
  assert.deepEqual(badges(tabs[3]), [])
  assert.deepEqual(tabs.map((t) => t.props['aria-selected']), [true, false, false, false, false])
  assert.deepEqual(tabs.map((t) => t.props.tabIndex), [0, -1, -1, -1, -1])
  T.state.snap = snap({ open: [item('h1', 'onhold', { payload: { reason: 'x', heldAt: 1 } })] })
  assert.deepEqual(badges(tabsOf(tablist(part(T, 'ViewTabs'), 'Views'))[1]), ['1'])
})

test('the Resolved tab carries a highlighted "N new" badge for unseen AI items, only when above zero', () => {
  const { T } = load()
  T.state.snap = snap({ resolved: [ai('a1'), ai('a2'), ai('a3', { seen: true }), ai('a4', { review: 'agreed' }), me('m1')] })
  const tab = () => tabsOf(tablist(part(T, 'ViewTabs'), 'Views'))[2]
  assert.deepEqual(badges(tab()), ['5', '2 new'])
  const hot = findAll(tab(), (n) => /\bhot\b/.test(n.props?.className ?? ''))
  assert.equal(hot.length, 1)
  assert.equal(textOf(hot[0]), '2 new')
  T.state.snap = snap({ resolved: [ai('a3', { seen: true }), me('m1')] })
  assert.deepEqual(badges(tab()), ['2'])
})

test('clicking a primary tab switches the view; the selected tab follows the flags', () => {
  const { T } = load()
  const tab = (i) => tabsOf(tablist(part(T, 'ViewTabs'), 'Views'))[i]
  tab(2).props.onClick()
  assert.equal(T.state.showResolved, true)
  assert.deepEqual(selected(tablist(part(T, 'ViewTabs'), 'Views')), ['resolved'])
  tab(1).props.onClick()
  assert.equal(T.state.showHeld, true); assert.equal(T.state.showResolved, false)
  tab(4).props.onClick()
  assert.equal(T.state.showPhone, true); assert.equal(T.state.showHeld, false)
  assert.deepEqual(selected(tablist(part(T, 'ViewTabs'), 'Views')), ['phone'])
  assert.deepEqual(tabsOf(tablist(part(T, 'ViewTabs'), 'Views')).map((t) => t.props.tabIndex), [-1, -1, -1, -1, 0])
  tab(0).props.onClick()
  assert.deepEqual(selected(tablist(part(T, 'ViewTabs'), 'Views')), ['waiting'])
})

test('Left and Right move and select a tab, wrapping around; Home and End jump; other keys do nothing', () => {
  const { T } = load()
  const tab = (i) => tabsOf(tablist(part(T, 'ViewTabs'), 'Views'))[i]
  assert.equal(press(tab(0), 'ArrowRight'), 1, 'the key is taken')
  assert.equal(T.viewOf(T.state), 'held')
  press(tab(1), 'ArrowRight'); assert.equal(T.viewOf(T.state), 'resolved')
  press(tab(2), 'ArrowLeft'); assert.equal(T.viewOf(T.state), 'held')
  press(tab(1), 'ArrowLeft'); assert.equal(T.viewOf(T.state), 'waiting')
  press(tab(0), 'ArrowLeft'); assert.equal(T.viewOf(T.state), 'phone', 'Left from the first wraps to the last')
  press(tab(4), 'ArrowRight'); assert.equal(T.viewOf(T.state), 'waiting', 'Right from the last wraps to the first')
  press(tab(0), 'End'); assert.equal(T.viewOf(T.state), 'phone')
  press(tab(4), 'Home'); assert.equal(T.viewOf(T.state), 'waiting')
  assert.equal(press(tab(0), 'ArrowDown'), 0)
  assert.equal(press(tab(0), 'a'), 0)
  assert.equal(T.viewOf(T.state), 'waiting')
})

test('an arrow key focuses the neighbour found by role=tab, not by child position', () => {
  const { T } = load()
  const focused = []
  const nodes = [0, 1, 2, 3, 4].map((i) => ({ focus: () => focused.push(i) }))
  const row = { children: [{ focus: () => focused.push('not a tab') }, ...nodes], querySelectorAll: (sel) => { assert.equal(sel, '[role="tab"]'); return nodes } }
  tabsOf(tablist(part(T, 'ViewTabs'), 'Views'))[0].props.onKeyDown({ key: 'ArrowRight', preventDefault() {}, currentTarget: { parentElement: row } })
  assert.deepEqual(focused, [1])
})

test('nextTabId is pure: it wraps and ignores other keys', () => {
  const { T } = load()
  assert.equal(T.nextTabId(['a', 'b', 'c'], 'a', 'ArrowRight'), 'b')
  assert.equal(T.nextTabId(['a', 'b', 'c'], 'c', 'ArrowRight'), 'a')
  assert.equal(T.nextTabId(['a', 'b', 'c'], 'a', 'ArrowLeft'), 'c')
  assert.equal(T.nextTabId(['a', 'b', 'c'], 'b', 'Home'), 'a')
  assert.equal(T.nextTabId(['a', 'b', 'c'], 'b', 'End'), 'c')
  assert.equal(T.nextTabId(['a', 'b', 'c'], 'b', 'Enter'), undefined)
  assert.equal(T.nextTabId([], 'a', 'ArrowRight'), undefined)
})

// ---- the secondary tabs: Waiting ---------------------------------------------------------------------------------------------------

const waitingSnap = () => snap({ open: [item('q1', 'question'), item('q2', 'question'), item('c1', 'completed'), item('pr', 'pr-merged'), item('h1', 'onhold', { payload: { reason: 'x', heldAt: 1 } })] })

test('Waiting: the Type tablist has All plus the types that have items, with counts; empty types are hidden', () => {
  const { T } = load()
  T.state.snap = waitingSnap()
  const list = tablist(part(T, 'SubTabs'), 'Type')
  assert.ok(list)
  assert.deepEqual(labels(list), ['All', 'Done', 'Question', 'PR merged', 'Paused'], 'Paused is always there (Find paused lives on it)')
  assert.deepEqual(tabsOf(list).map((t) => badges(t)[0]), ['4', '1', '2', '1', '0'], 'All does not count the held item')
  assert.deepEqual(selected(list), ['all'])
  assert.deepEqual(tabsOf(list).map((t) => t.props.tabIndex), [0, -1, -1, -1, -1])
})

test('Paused tab at zero, reached from the All tab: still drawn, opens, and its strip offers Find paused (no Resume all)', async () => {
  const { T, calls } = load()
  T.state.snap = snap({ open: [item('c1', 'completed')] })
  const list = tablist(part(T, 'SubTabs'), 'Type')
  const paused = tabsOf(list).find((t) => t.props['data-type'] === 'paused')
  assert.ok(paused, 'the Paused tab is rendered at zero')
  paused.props.onClick()
  assert.equal(T.state.filter.type, 'paused')
  const strip = part(T, 'PausedStrip')
  assert.deepEqual(findAll(strip, (n) => n.type === 'button').map((b) => textOf(b)), ['Find paused'])
  findAll(strip, (n) => n.type === 'button')[0].props.onClick()
  await tick()
  assert.deepEqual(calls.map((c) => c[0]), ['/v1/paused-scan'])
})

test('Waiting: the selected type stays even with zero items; a Paused tab carries the warning badge', () => {
  const { T } = load()
  T.state.snap = snap({ open: [item('p1', 'paused'), item('p2', 'paused')] })
  let list = tablist(part(T, 'SubTabs'), 'Type')
  assert.deepEqual(labels(list), ['All', 'Paused'])
  assert.match(findAll(tabsOf(list)[1], (n) => /\bwarn\b/.test(n.props?.className ?? '')).map((n) => n.props.className).join(), /warn/)
  T.set({ filter: { type: 'permission', query: '', resolvedBy: 'all' } })
  list = tablist(part(T, 'SubTabs'), 'Type')
  assert.deepEqual(labels(list), ['All', 'Permission', 'Paused'])
  assert.deepEqual(selected(list), ['permission'])
  assert.deepEqual(badges(tabsOf(list)[1]), ['0'])
})

test('Waiting: a type tab sets filter.type and keeps the query; arrows move and select; the search box sits in the same row', () => {
  const { T } = load()
  T.state.snap = waitingSnap()
  T.set({ filter: { type: 'all', query: 't', resolvedBy: 'all' } })
  const row = () => part(T, 'SubTabs')
  tabsOf(tablist(row(), 'Type'))[2].props.onClick()
  assert.deepEqual({ ...T.state.filter }, { type: 'question', query: 't', resolvedBy: 'all' })
  assert.deepEqual(selected(tablist(row(), 'Type')), ['question'])
  press(tabsOf(tablist(row(), 'Type'))[2], 'ArrowRight')
  assert.equal(T.state.filter.type, 'pr-merged')
  press(tabsOf(tablist(row(), 'Type'))[3], 'ArrowRight')
  assert.equal(T.state.filter.type, 'paused')
  press(tabsOf(tablist(row(), 'Type'))[4], 'ArrowRight')
  assert.equal(T.state.filter.type, 'all', 'wraps')
  const input = findAll(row(), (n) => n.type === 'input')[0]
  assert.equal(input.props.value, 't')
  assert.equal(input.props['aria-label'], 'Filter')
  input.props.onChange({ target: { value: 'zz' } })
  assert.equal(T.state.filter.query, 'zz')
  assert.equal(findAll(tablist(row(), 'Type'), (n) => n.type === 'input').length, 0, 'the search box is next to the tablist, not a tab')
})

test('Waiting: no old filter chips are left', () => {
  const { T } = load()
  T.state.snap = waitingSnap()
  assert.equal(findAll(T.Panel(), (n) => /rq-fchip/.test(n.props?.className ?? '')).length, 0)
  assert.equal(has(T, 'FilterBar'), false)
})

// ---- the secondary tabs: Resolved / On hold / rules / phone ------------------------------------------------------------------------

test('Resolved: the "Resolved by" tablist All / By me / By AI with counts and the unseen count on AI, a Type select and the search', () => {
  const { T } = load()
  T.state.snap = snap({ resolved: [ai('a1'), ai('a2'), ai('a3', { seen: true }), me('m1')] })
  T.set({ showResolved: true })
  const row = () => part(T, 'SubTabs')
  const list = tablist(row(), 'Resolved by')
  assert.ok(list)
  assert.deepEqual(labels(list), ['All', 'By me', 'By AI'])
  const tabs = tabsOf(list)
  assert.deepEqual(tabs.map((t) => t.props['data-resolved-by']), ['all', 'me', 'ai'])
  assert.deepEqual(badges(tabs[0]), ['4'])
  assert.deepEqual(badges(tabs[1]), ['1'])
  assert.deepEqual(badges(tabs[2]), ['3', '2 new'])
  assert.deepEqual(selected(list), ['all'])
  tabs[2].props.onClick()
  assert.equal(T.state.filter.resolvedBy, 'ai')
  assert.deepEqual(selected(tablist(row(), 'Resolved by')), ['ai'])
  press(tabsOf(tablist(row(), 'Resolved by'))[2], 'ArrowRight')
  assert.equal(T.state.filter.resolvedBy, 'all')
  T.state.snap = snap({ resolved: [ai('a3', { seen: true })] })
  assert.deepEqual(badges(tabsOf(tablist(row(), 'Resolved by'))[2]), ['1'], 'no "new" badge when everything is seen')
})

test('Resolved: the Type select sets filter.resolvedType (not the Waiting type), keeps the query; the search sets filter.query; no type tablist here', () => {
  const { T } = load()
  T.state.snap = snap({ resolved: [me('m1')] })
  T.set({ showResolved: true, filter: { type: 'all', query: 'q', resolvedBy: 'me' } })
  const row = part(T, 'SubTabs')
  assert.equal(tablist(row, 'Type'), undefined)
  const select = findAll(row, (n) => n.type === 'select')[0]
  assert.equal(select.props['aria-label'], 'Type')
  assert.equal(select.props.value, 'all')
  const opts = findAll(select, (n) => n.type === 'option').map((o) => [o.props.value, textOf(o)])
  assert.deepEqual(opts, [['all', 'All types'], ['completed', 'Done'], ['question', 'Question'], ['permission', 'Permission'], ['pr-merged', 'PR merged'], ['todo', 'Todo'], ['paused', 'Paused']])
  select.props.onChange({ target: { value: 'permission' } })
  assert.deepEqual({ ...T.state.filter }, { type: 'all', query: 'q', resolvedBy: 'me', resolvedType: 'permission' })
  findAll(row, (n) => n.type === 'input')[0].props.onChange({ target: { value: 'ls' } })
  assert.equal(T.state.filter.query, 'ls')
})

test('On hold: only the search box; rules and phone: nothing', () => {
  const { T } = load()
  T.set({ showHeld: true })
  let row = part(T, 'SubTabs')
  assert.equal(findAll(row, (n) => n.props?.role === 'tablist').length, 0)
  assert.equal(findAll(row, (n) => n.type === 'select').length, 0)
  const input = findAll(row, (n) => n.type === 'input')
  assert.equal(input.length, 1)
  input[0].props.onChange({ target: { value: 'tick' } })
  assert.equal(T.state.filter.query, 'tick')
  T.set({ showHeld: false, showRules: true })
  assert.equal(part(T, 'SubTabs'), null)
  T.set({ showRules: false, showPhone: true })
  assert.equal(part(T, 'SubTabs'), null)
})

// ---- the Paused strip -----------------------------------------------------------------------------------------------------------------

test('the Paused strip shows only on the Paused tab of the Waiting view, with Resume all (N) and Find paused', async () => {
  const { T, calls } = load()
  T.state.snap = snap({ open: [item('p1', 'paused'), item('p2', 'paused'), item('c1', 'completed')] })
  assert.equal(part(T, 'PausedStrip'), null, 'not on All')
  T.set({ filter: { type: 'question', query: '', resolvedBy: 'all' } })
  assert.equal(part(T, 'PausedStrip'), null)
  T.set({ filter: { type: 'paused', query: '', resolvedBy: 'all' } })
  const strip = part(T, 'PausedStrip')
  assert.ok(strip)
  const buttons = findAll(strip, (n) => n.type === 'button')
  assert.deepEqual(buttons.map((b) => textOf(b)), ['Resume all (2)', 'Find paused'])
  assert.match(buttons[0].props.className, /pri/)
  buttons[0].props.onClick()
  assert.equal(T.state.resumeAll.phase, 'running', 'no confirm step: the click starts resuming at once')
  assert.equal(T.state.resumeAll.total, 2)
  assert.equal(part(T, 'PausedStrip').children.length > 0, true)
  assert.equal(findAll(part(T, 'PausedStrip'), (n) => n.type === 'button')[0].props.disabled, true, 'disabled while a Resume all is open')
  await tick()
  assert.ok(calls.some((c) => c[0] === '/v1/paused-resume'), 'the resume prompts are sent without asking')
  buttons[1].props.onClick()
  await tick()
  assert.deepEqual(calls.map((c) => c[0]).filter((u) => u !== '/v1/paused-resume'), ['/v1/paused-scan'])
  T.set({ showResolved: true })
  assert.equal(part(T, 'PausedStrip'), null, 'not in the Resolved view even with the type set')
})

test('the scan note and the Resume all bar still show (ResumeAllBar)', () => {
  const { T } = load()
  T.set({ scanNote: 'No new paused sessions.' })
  assert.match(textOf(part(T, 'ResumeAllBar')), /No new paused sessions\./)
  T.set({ scanNote: undefined, resumeAll: { phase: 'running', total: 2, progress: { total: 2, started: 1, ok: 1, failed: 0, running: 1, waiting: 1 } } })
  assert.match(textOf(part(T, 'ResumeAllBar')), /Resuming/)
  assert.equal(T.askResumeAll, undefined, 'the confirm step is gone')
  assert.equal(T.resumeAllText, undefined, 'the confirm text is gone')
})

// ---- the left list --------------------------------------------------------------------------------------------------------------------

test('the left list is a listbox of options with aria-selected; a click selects; no row is a button', () => {
  const { T } = load()
  T.state.snap = snap({ open: [item('a', 'question', { position: 1 }), item('b', 'completed', { position: 2 })] })
  const side = findAll(T.Panel(), (n) => /\brq-side\b/.test(n.props?.className ?? ''))[0]
  assert.equal(side.props.role, 'listbox')
  assert.ok(side.props['aria-label'])
  const rows = findAll(side, (n) => typeof n.type === 'function' && n.type.name === 'SideRow').map((n) => n.type(n.props))
  assert.equal(rows.length, 2)
  assert.deepEqual(rows.map((r) => [r.type, r.props.role, r.props['aria-selected']]), [['div', 'option', true], ['div', 'option', false]])
  assert.deepEqual(rows.map((r) => r.props.tabIndex), [0, -1])
  assert.equal(findAll(side, (n) => n.type === 'button').length, 0)
  rows[1].props.onClick()
  assert.equal(T.state.selected, 'b')
})

test('a row answers Enter and Space by selecting; arrows still move through overlayKey', () => {
  const { T } = load()
  T.state.snap = snap({ open: [item('a', 'question', { position: 1 }), item('b', 'completed', { position: 2 })] })
  const side = findAll(T.Panel(), (n) => /\brq-side\b/.test(n.props?.className ?? ''))[0]
  const row = findAll(side, (n) => typeof n.type === 'function' && n.type.name === 'SideRow').map((n) => n.type(n.props))[1]
  let prevented = 0
  row.props.onKeyDown({ key: 'Enter', preventDefault: () => { prevented++ } })
  assert.equal(T.state.selected, 'b'); assert.equal(prevented, 1)
  T.set({ selected: 'a' })
  T.overlayKey({ key: 'ArrowDown', preventDefault() {}, target: {} })
  assert.equal(T.state.selected, 'b')
  T.overlayKey({ key: 'k', preventDefault() {}, target: {} })
  assert.equal(T.state.selected, 'a')
})

// ---- the phone tab --------------------------------------------------------------------------------------------------------------------

test('the Phone tab shows the PhoneHost as the body (no dialog over the list); the list and the type row are gone', () => {
  const { T } = load()
  T.state.snap = snap({ open: [item('a', 'question')] })
  T.set({ showPhone: true })
  const tree = T.Panel()
  assert.ok(findAll(tree, (n) => n.type === T.PhoneHost).length === 1, 'PhoneHost is the body')
  assert.equal(findAll(tree, (n) => n.props?.['data-rq'] === 'phone-dialog' || n.props?.role === 'dialog' && n.props['aria-label'] === 'Phone').length, 0, 'no phone dialog')
  assert.equal(findAll(tree, (n) => /\brq-split\b/.test(n.props?.className ?? '')).length, 0)
  assert.equal(findAll(tree, (n) => /\brq-hint\b/.test(n.props?.className ?? '')).length, 0, 'the item hotkeys do not apply here')
  assert.deepEqual(selected(tablist(part(T, 'ViewTabs'), 'Views')), ['phone'])
  assert.equal(typeof T.PhoneDialog, 'undefined')
})

// ---- Esc order and keys ---------------------------------------------------------------------------------------------------------------

test('Esc closes an open dialog first, then the todo form, then the overlay', () => {
  const { T } = load()
  T.set({ overlay: true, dialog: { kind: 'hold', id: 'd1', text: '' }, todoForm: { open: true, text: 'draft', workspaceId: '', sparc: false, busy: false } })
  T.overlayKey({ key: 'Escape', preventDefault() {}, target: {} })
  assert.equal(T.state.dialog, null)
  assert.equal(T.state.todoForm.open, true)
  assert.equal(T.state.overlay, true)
  T.overlayKey({ key: 'Escape', preventDefault() {}, target: {} })
  assert.equal(T.state.todoForm.open, false)
  assert.equal(T.state.overlay, true)
  T.overlayKey({ key: 'Escape', preventDefault() {}, target: {} })
  assert.equal(T.state.overlay, false)
})

test('j/k do nothing on the phone tab, and Esc there leaves the overlay open (see the Esc test below)', () => {
  const { T } = load()
  T.state.snap = snap({ open: [item('a', 'question', { position: 1 }), item('b', 'completed', { position: 2 })] })
  T.set({ overlay: true, showPhone: true, selected: 'a' })
  T.overlayKey({ key: 'j', preventDefault() {}, target: {} })
  assert.equal(T.state.selected, 'a')
})

test('while a dialog is open the list keys are off (the dialog owns the keyboard)', () => {
  const { T } = load()
  T.state.snap = snap({ open: [item('a', 'completed', { position: 1 }), item('b', 'completed', { position: 2 })] })
  T.set({ selected: 'a', dialog: { kind: 'hold', id: 'a', text: '' } })
  T.overlayKey({ key: 'j', preventDefault() {}, target: {} })
  assert.equal(T.state.selected, 'a')
})

// ---- no toggle buttons that only change the view --------------------------------------------------------------------------------------

test('no aria-pressed toggle is left outside the real actions (read aloud), in any view, with the components drawn', () => {
  const { T } = load()
  const expandAll = (n) => (n && typeof n === 'object' ? (typeof n.type === 'function' ? expandAll(n.type(n.props)) : { ...n, children: n.children.map(expandAll) }) : n)
  const open = [item('q', 'question', { position: 1, payload: { questions: [{ id: 'a', question: 'Which?', options: [{ label: 'A' }] }] } }), item('c', 'completed', { position: 2 }), item('h', 'onhold', { position: 3, payload: { reason: 'x', heldAt: 1 } })]
  const unscoped = []
  for (const view of ['waiting', 'held', 'resolved', 'rules', 'phone']) {
    T.state.snap = snap({ open, resolved: [ai('a1'), me('m1')] })
    T.set({ triageRules: { rules: [{ id: 'r1', name: 'R', class: 'permission', mode: 'observe', instruction: 'i', record: {} }], lessons: [] }, aiOpen: { a1: true } })
    T.setView(view)
    const tree = expandAll(T.Panel())
    for (const n of findAll(tree, (x) => x.props && 'aria-pressed' in x.props)) unscoped.push(view + ':' + n.type + ':' + n.props.className)
    assert.equal(findAll(tree, (x) => x.type === 'button' && /rq-fchip/.test(x.props.className ?? '')).length, 0)
  }
  for (const u of unscoped) assert.match(u, /rq-play|rq-opt/, 'only read aloud and the answer options (real selections of an answer) keep aria-pressed: ' + u)
})
// ---- the dialogs ----------------------------------------------------------------------------------------------------------------------

const done = () => item('d1', 'completed', { position: 1 })
const dialogOf = (T) => part(T, 'DialogHost')
const dlgButton = (tree, text) => findAll(tree, (n) => n.type === 'button' && textOf(n) === text)[0]

test('no dialog is rendered until one is opened; the Hold button opens the Hold dialog (no inline form, no holdOpen key)', () => {
  const { T } = load()
  T.state.snap = snap({ open: [done()] })
  assert.equal(dialogOf(T), null)
  assert.equal('holdOpen' in T.state, false)
  assert.equal('aiCorrection' in T.state, false)
  assert.equal('aiOverrule' in T.state, false)
  assert.equal(T.state.dialog, null)
  const hold = T.HoldButton({ item: done() })
  assert.equal(textOf(hold), 'Hold…')
  hold.props.onClick()
  assert.deepEqual({ ...T.state.dialog }, { kind: 'hold', id: 'd1', text: '' })
  assert.equal(T.HoldButton({ item: done() }).props.disabled, false, 'the button is not tied to the dialog any more')
  assert.equal(T.HoldForm, undefined, 'the inline form is gone')
})

test('the dialog is a modal: role, aria-modal, label, backdrop, Cancel', () => {
  const { T } = load()
  T.state.snap = snap({ open: [done()] })
  T.set({ dialog: { kind: 'hold', id: 'd1', text: '' } })
  const tree = dialogOf(T)
  assert.match(tree.props.className, /rq-modal-back/)
  const modal = findAll(tree, (n) => n.props?.role === 'dialog')[0]
  assert.equal(modal.props['aria-modal'], 'true')
  assert.match(modal.props['aria-label'], /hold/i)
  assert.match(modal.props.className, /rq-modal/)
  tree.props.onMouseDown({ target: {}, currentTarget: {} })
  assert.ok(T.state.dialog, 'a press inside does not close it')
  const back = {}
  tree.props.onMouseDown({ target: back, currentTarget: back })
  assert.equal(T.state.dialog, null, 'a press on the backdrop closes it')
  T.set({ dialog: { kind: 'hold', id: 'd1', text: '' } })
  dlgButton(dialogOf(T), 'Cancel').props.onClick()
  assert.equal(T.state.dialog, null)
})

test('Hold dialog: the reason input, Put on hold posts {id, reason} and closes it; Enter confirms', async () => {
  const { T, calls } = load()
  T.state.snap = snap({ open: [done()] })
  T.set({ dialog: { kind: 'hold', id: 'd1', text: '' } })
  const input = () => findAll(dialogOf(T), (n) => n.type === 'input')[0]
  assert.equal(input().props.placeholder.startsWith('Why?'), true)
  input().props.onChange({ target: { value: 'waiting for the customer' } })
  assert.equal(T.state.dialog.text, 'waiting for the customer')
  assert.equal(input().props.value, 'waiting for the customer')
  dlgButton(dialogOf(T), 'Put on hold').props.onClick()
  await tick(); await tick()
  assert.deepEqual(calls, [['/v1/hold', { id: 'd1', reason: 'waiting for the customer' }]])
  assert.equal(T.state.dialog, null)
  T.set({ dialog: { kind: 'hold', id: 'd1', text: 'again' } })
  input().props.onKeyDown({ key: 'Enter', nativeEvent: { key: 'Enter' }, preventDefault() {} })
  await tick(); await tick()
  assert.equal(calls.length, 2)
})

test('Hold dialog: an empty reason is allowed; busy disables the buttons; a failure keeps the dialog and shows the error', async () => {
  const { T } = load({ fetchImpl: async () => ({ ok: false, status: 409, json: async () => ({ error: 'not-holdable' }) }) })
  T.state.snap = snap({ open: [done()] })
  T.set({ dialog: { kind: 'hold', id: 'd1', text: '' } })
  T.set({ busy: { d1: true } })
  const busy = dialogOf(T)
  assert.equal(dlgButton(busy, 'Holding…').props.disabled, true)
  assert.equal(dlgButton(busy, 'Cancel').props.disabled, true)
  T.set({ busy: {} })
  assert.ok(!dlgButton(dialogOf(T), 'Put on hold').props.disabled)
  dlgButton(dialogOf(T), 'Put on hold').props.onClick()
  await tick(); await tick()
  assert.ok(T.state.dialog, 'stays open on failure')
  assert.match(textOf(dialogOf(T)), /finished work|paused/)
})

const aiCard = (over = {}) => ({ ...ai('a1', { seen: true }), type: 'completed', triage: { ruleName: 'Rule' }, ...over })

test('Mark wrong dialog: textarea, Send correction disabled while empty, posts the trimmed text, keeps the unsent note', async () => {
  const { T, calls } = load()
  T.state.snap = snap({ resolved: [aiCard()] })
  const it = aiCard()
  T.set({ aiOpen: { a1: true } })
  const card = T.ResolvedCard({ it })
  findAll(card, (n) => n.type === 'button' && /Mark wrong/.test(textOf(n)))[0].props.onClick()
  assert.deepEqual({ ...T.state.dialog }, { kind: 'wrong', id: 'a1', text: '' })
  const tree = () => dialogOf(T)
  assert.match(findAll(tree(), (n) => n.props?.role === 'dialog')[0].props['aria-label'], /wrong/i)
  assert.equal(dlgButton(tree(), 'Send correction').props.disabled, true)
  const box = () => findAll(tree(), (n) => n.type === 'textarea')[0]
  box().props.onChange({ target: { value: '   ' } })
  assert.equal(dlgButton(tree(), 'Send correction').props.disabled, true)
  box().props.onChange({ target: { value: '  Use main instead  ' } })
  assert.equal(box().props.value, '  Use main instead  ')
  assert.doesNotMatch(textOf(tree()), /cannot be unsent/, 'a done item: nothing was sent that cannot be taken back')
  dlgButton(tree(), 'Send correction').props.onClick()
  await tick(); await tick()
  assert.deepEqual(calls, [['/v1/triage-review', { id: 'a1', review: 'mark-wrong', text: 'Use main instead' }]])
  assert.equal(T.state.dialog, null)
  for (const type of ['question', 'permission']) {
    T.state.snap = snap({ resolved: [aiCard({ type })] })
    T.set({ dialog: { kind: 'wrong', id: 'a1', text: '' } })
    assert.match(textOf(dialogOf(T)), /cannot be unsent/, type)
  }
})

test('Overrule dialog: two confirm choices post overrule-rule with their mode and close it', async () => {
  const { T, calls } = load()
  T.state.snap = snap({ resolved: [aiCard()] })
  T.set({ aiOpen: { a1: true } })
  findAll(T.ResolvedCard({ it: aiCard() }), (n) => n.type === 'button' && /Overrule rule/.test(textOf(n)))[0].props.onClick()
  assert.deepEqual({ ...T.state.dialog }, { kind: 'overrule', id: 'a1', text: '' })
  assert.match(findAll(dialogOf(T), (n) => n.props?.role === 'dialog')[0].props['aria-label'], /overrule/i)
  assert.deepEqual(findAll(dialogOf(T), (n) => n.type === 'button').map((b) => textOf(b)).filter((t) => /Set rule/.test(t)), ['Set rule to observe', 'Set rule to off'])
  dlgButton(dialogOf(T), 'Set rule to observe').props.onClick()
  await tick(); await tick()
  assert.equal(T.state.dialog, null)
  T.set({ dialog: { kind: 'overrule', id: 'a1', text: '' } })
  dlgButton(dialogOf(T), 'Set rule to off').props.onClick()
  await tick(); await tick()
  assert.deepEqual(calls, [['/v1/triage-review', { id: 'a1', review: 'overrule-rule', mode: 'observe' }], ['/v1/triage-review', { id: 'a1', review: 'overrule-rule', mode: 'off' }]])
  T.set({ dialog: { kind: 'overrule', id: 'a1', text: '' }, busy: { a1: true } })
  for (const b of findAll(dialogOf(T), (n) => n.type === 'button')) assert.equal(b.props.disabled, true, textOf(b))
})

test('while busy, Esc and a press on the backdrop do nothing (as the disabled Cancel does); once idle they close the dialog', () => {
  const { T } = load()
  T.state.snap = snap({ open: [done()] })
  T.set({ overlay: true, dialog: { kind: 'hold', id: 'd1', text: '' }, busy: { d1: true } })
  const back = {}
  dialogOf(T).props.onMouseDown({ target: back, currentTarget: back })
  assert.ok(T.state.dialog, 'backdrop press while busy')
  T.overlayKey({ key: 'Escape', preventDefault() {}, target: {} })
  assert.ok(T.state.dialog, 'Esc while busy')
  assert.equal(T.state.overlay, true, 'Esc is taken by the dialog: the overlay stays')
  T.set({ busy: { d1: false } })
  dialogOf(T).props.onMouseDown({ target: back, currentTarget: back })
  assert.equal(T.state.dialog, null, 'backdrop press when idle')
  T.set({ dialog: { kind: 'hold', id: 'd1', text: '' } })
  T.overlayKey({ key: 'Escape', preventDefault() {}, target: {} })
  assert.equal(T.state.dialog, null, 'Esc when idle')
})

test('opening a dialog clears the item\'s old error, so a stale one is not shown in it', () => {
  const { T } = load()
  T.state.snap = snap({ open: [done()], resolved: [aiCard()] })
  T.set({ errors: { d1: 'old failure', a1: 'old failure', other: 'keep me' } })
  T.HoldButton({ item: done() }).props.onClick()
  assert.equal(T.state.errors.d1, undefined)
  assert.doesNotMatch(textOf(dialogOf(T)), /old failure/)
  assert.equal(T.state.errors.other, 'keep me')
  T.set({ aiOpen: { a1: true }, dialog: null })
  findAll(T.ResolvedCard({ it: aiCard() }), (n) => n.type === 'button' && /Mark wrong/.test(textOf(n)))[0].props.onClick()
  assert.equal(T.state.errors.a1, undefined)
})

test('Resolved: the tab counts follow the Type select and the search; the "N new" badge is additional and counts every unseen AI item', () => {
  const { T } = load()
  T.state.snap = snap({ resolved: [{ ...ai('a1'), type: 'question' }, ai('a2'), ai('a3', { seen: true }), me('m1'), { ...me('m2'), title: 'zebra' }] })
  T.set({ showResolved: true, filter: { type: 'all', query: '', resolvedBy: 'all', resolvedType: 'permission' } })
  const row = () => tablist(part(T, 'SubTabs'), 'Resolved by')
  assert.deepEqual(tabsOf(row()).map(badges), [['4'], ['2'], ['2', '2 new']])
  T.set({ filter: { type: 'all', query: 'zebra', resolvedBy: 'all', resolvedType: 'permission' } })
  assert.deepEqual(tabsOf(row()).map(badges), [['1'], ['1'], ['0', '2 new']])
})

test('Resolved by labels and counts come from the shared core (the phone uses the same ones)', () => {
  const { T } = load()
  assert.deepEqual({ ...T.RESOLVED_LABELS }, { all: 'All', me: 'By me', ai: 'By AI' })
  const resolved = [ai('a1'), me('m1'), me('m2')]
  assert.deepEqual({ ...T.resolvedCounts(resolved, { type: 'all', query: '' }) }, { all: 3, me: 2, ai: 1 })
  assert.deepEqual({ ...T.resolvedCounts(resolved, { type: 'question', query: '' }) }, { all: 0, me: 0, ai: 0 })
  assert.deepEqual({ ...T.resolvedCounts(undefined, undefined) }, { all: 0, me: 0, ai: 0 })
})

test('closing a dialog that is no longer the open one does nothing (a late answer must not close another dialog)', async () => {
  let release
  const { T } = load({ fetchImpl: () => new Promise((r) => { release = () => r(okJson({ ok: true })) }) })
  T.state.snap = snap({ open: [done(), item('d2', 'completed', { position: 2 })] })
  T.set({ dialog: { kind: 'hold', id: 'd1', text: '' } })
  dlgButton(dialogOf(T), 'Put on hold').props.onClick()
  T.set({ dialog: { kind: 'hold', id: 'd2', text: '' } })
  release()
  await tick(); await tick()
  assert.deepEqual({ ...T.state.dialog }, { kind: 'hold', id: 'd2', text: '' })
})

test('Panel renders the DialogHost; the dialog is not saved with the toggles', () => {
  const { T } = load()
  assert.ok(has(T, 'DialogHost'))
  assert.equal(T.state.dialog, null)
})

// ---- the late answer disclosure ---------------------------------------------------------------------------------------------------------

test('Answer now (late) is a native details/summary; its open state is lateOpen', () => {
  const { T } = load()
  const it = { id: 'q1', type: 'question', status: 'resolved', title: 'Q', createdAt: 1, resolvedAt: 2, sessionId: 's', payload: { questions: [{ id: 'a', question: 'Which?', options: [{ label: 'A' }] }] }, resolution: { kind: 'expired' } }
  let tree = T.ResolvedCard({ it })
  const details = findAll(tree, (n) => n.type === 'details')[0]
  assert.ok(details)
  assert.equal(details.props.open, false)
  assert.equal(textOf(findAll(details, (n) => n.type === 'summary')[0]), 'Answer now (late)', 'no literal arrow: the native details marker is the only one')
  assert.equal(findAll(tree, (n) => n.type === 'button' && /Answer now/.test(textOf(n))).length, 0)
  assert.equal(findAll(details, (n) => typeof n.type === 'function' && n.type.name === 'QuestionBody').length, 0, 'closed: no late body')
  details.props.onToggle({ currentTarget: { open: true } })
  assert.equal(T.state.lateOpen.q1, true)
  tree = T.ResolvedCard({ it })
  const open = findAll(tree, (n) => n.type === 'details')[0]
  assert.equal(open.props.open, true)
  assert.equal(findAll(open, (n) => typeof n.type === 'function' && n.type.name === 'QuestionBody').length, 1)
  open.props.onToggle({ currentTarget: { open: false } })
  assert.equal(T.state.lateOpen.q1, false)
})

// ---- the todo form tabs ---------------------------------------------------------------------------------------------------------------

test('the todo form kind is a tablist with two tabs (aria-selected), not toggle buttons', () => {
  const { T } = load()
  T.set({ todoForm: { open: true, text: '', workspaceId: '', sparc: false, busy: false } })
  const list = () => tablist(T.TodoForm(), 'Kind of todo')
  assert.ok(list())
  assert.deepEqual(tabsOf(list()).map((t) => textOf(t)), ['New session', 'Follow up'])
  assert.deepEqual(tabsOf(list()).map((t) => t.props['aria-selected']), [true, false])
  assert.deepEqual(tabsOf(list()).map((t) => t.props.tabIndex), [0, -1])
  assert.equal(findAll(T.TodoForm(), (n) => n.props && 'aria-pressed' in n.props).length, 0)
  tabsOf(list())[1].props.onClick()
  assert.equal(T.state.todoForm.mode, 'followup')
  assert.deepEqual(tabsOf(list()).map((t) => t.props['aria-selected']), [false, true])
  press(tabsOf(list())[1], 'ArrowLeft')
  assert.equal(T.state.todoForm.mode, 'new')
})


test('the New todo form sits above the tabs: header, notice, form, then the primary tabs', () => {
  const { T } = load()
  T.set({ todoForm: { open: true, text: '', workspaceId: '', sparc: false, busy: false } })
  const order = T.Panel().children.map((c) => (c && typeof c.type === 'function' ? c.type.name : c && c.type)).filter(Boolean)
  const at = (name) => order.indexOf(name)
  assert.ok(at('TodoForm') > at('Head'), 'below the header')
  assert.ok(at('TodoForm') < at('ViewTabs'), 'above the primary tabs, got ' + order.join(' > '))
  assert.ok(at('TodoForm') < at('SubTabs'), 'above the secondary tabs')
})

// ---- review fixes: stale dialog, focus handling, tab panels, Esc on the phone tab, memoised visibleOpen, Resolved type ----------------------

test('a dialog is closed by a tab switch, a type switch, and when its item is gone from the snapshot', () => {
  const { T } = load()
  T.state.snap = snap({ open: [done(), item('c2', 'completed', { position: 2 })], resolved: [ai('a1')] })
  const open = (id = 'd1') => T.set({ dialog: { kind: 'hold', id, text: 'typed' } })
  open(); T.setView('resolved')
  assert.equal(T.state.dialog, null, 'setView closes it')
  T.setView('waiting'); open()
  tabsOf(tablist(part(T, 'SubTabs'), 'Type'))[1].props.onClick()
  assert.equal(T.state.dialog, null, 'a type tab closes it')
  open(); T.applySnapshot(snap({ open: [item('c2', 'completed')], resolved: [ai('a1')] }))
  assert.equal(T.state.dialog, null, 'the item left the queue')
  T.set({ dialog: { kind: 'wrong', id: 'a1', text: 'x' } }); T.applySnapshot(snap({ open: [], resolved: [ai('a1')] }))
  assert.equal(T.state.dialog.id, 'a1', 'a resolved item that is still there keeps it')
  T.applySnapshot(snap({ open: [], resolved: [] }))
  assert.equal(T.state.dialog, null)
})

test('the dialog names the item it acts on', () => {
  const { T } = load()
  T.state.snap = snap({ open: [done()] })
  T.set({ dialog: { kind: 'hold', id: 'd1', text: '' } })
  assert.match(textOf(dialogOf(T)), /T d1/)
})

function loadFocus() {
  const effects = []
  const doc = {}
  const { T } = load2({ useEffect: (fn) => { effects.push(fn) } }, { document: doc })
  return { T, effects, doc }
}
function load2(react, globals) {
  const { T } = loadClient({ globals, fetchImpl: async () => okJson({ ok: true }), react: { createElement: el, useState: () => [0, () => {}], useRef: () => ({ current: null }), ...react } })
  T.state.snap = snap({ open: [done()] })
  return { T }
}
const fake = (name) => ({ name, focused: 0, focus() { this.focused++ } })

test('DialogHost focus: the first control gets the focus on open, the opener gets it back on close, Tab stays inside', () => {
  const { T, effects, doc } = loadFocus()
  const opener = fake('opener'), first = fake('first'), last = fake('last')
  const root = { querySelectorAll: () => [first, last], contains: (n) => n === first || n === last }
  Object.assign(doc, { activeElement: opener, querySelector: () => root })
  {
    T.set({ dialog: { kind: 'hold', id: 'd1', text: '' } })
    const host = findAll(T.DialogHost(), (n) => typeof n.type === 'function' && n.type.name === 'DialogFocus')[0]
    assert.ok(host, 'DialogHost mounts a DialogFocus')
    host.type(host.props)
    assert.equal(effects.length, 1)
    const cleanup = effects[0]()
    assert.equal(first.focused, 1, 'focus moves to the first control')
    cleanup()
    assert.equal(opener.focused, 1, 'focus goes back to the opener')
    const modal = findAll(T.DialogHost(), (n) => n.props?.role === 'dialog')[0]
    const key = (shiftKey, active) => { doc.activeElement = active; let p = 0; modal.props.onKeyDown({ key: 'Tab', shiftKey, currentTarget: root, preventDefault: () => { p++ } }); return p }
    assert.equal(key(false, last), 1); assert.equal(first.focused, 2, 'Tab on the last control wraps to the first')
    assert.equal(key(true, first), 1); assert.equal(last.focused, 1, 'Shift+Tab on the first wraps to the last')
    assert.equal(key(false, first), 0, 'Tab in the middle is left alone')
    let escaped = 0
    modal.props.onKeyDown({ key: 'Escape', currentTarget: root, preventDefault() {} })
    assert.ok(T.state.dialog, 'Esc is overlayKey’s job (one close per press), not the dialog’s own handler')
  }
})

test('the primary tabs control one tabpanel, and every main body is that tabpanel labelled by the selected tab', () => {
  const { T } = load()
  T.state.snap = snap({ open: [item('c1', 'completed')], resolved: [me('m1')] })
  T.set({ triageRules: { rules: [], lessons: [] } })
  const ids = ['waiting', 'held', 'resolved', 'rules', 'phone']
  for (const view of ids) {
    T.setView(view)
    const tree = T.Panel()
    const tabs = tabsOf(tablist(part(T, 'ViewTabs', tree), 'Views'))
    assert.deepEqual(tabs.map((t) => t.props.id), ids.map((v) => 'rq-vtab-' + v))
    assert.ok(tabs.every((t) => t.props['aria-controls'] === 'rq-vpanel'))
    const panels = findAll(tree, (n) => n.props?.role === 'tabpanel')
    const main = view === 'rules' ? [part(T, 'RulesView', tree)] : panels
    assert.equal(main.length, 1, view + ': exactly one tabpanel')
    assert.equal(main[0].props.id, 'rq-vpanel')
    assert.equal(main[0].props['aria-labelledby'], 'rq-vtab-' + view)
  }
})

test('Esc on the Phone tab does not close the overlay: it goes back to the tab you came from; other tabs still close it', () => {
  const { T } = load()
  const esc = () => T.overlayKey({ key: 'Escape', preventDefault() {}, target: {} })
  T.set({ overlay: true }); T.setView('resolved'); T.setView('phone')
  esc()
  assert.equal(T.state.overlay, true); assert.equal(T.viewOf(T.state), 'resolved')
  T.setView('phone'); T.setView('phone'); esc()
  assert.equal(T.state.overlay, true)
  T.set({ overlay: true }); T.setView('phone'); T.setView('waiting')
  esc()
  assert.equal(T.state.overlay, false, 'Esc on a non-phone tab closes the overlay as before')
  T.set({ overlay: true }); T.setView('phone'); T.set({ dialog: { kind: 'hold', id: 'x', text: '' } })
  esc()
  assert.equal(T.state.dialog, null); assert.equal(T.state.overlay, true); assert.equal(T.viewOf(T.state), 'phone', 'a dialog closes first')
})

test('visibleOpen is computed once per snapshot, filter and view (Panel asks for it several times)', () => {
  const { T } = load()
  T.state.snap = snap({ open: [item('q1', 'question'), item('c1', 'completed')] })
  assert.equal(T.visibleOpen(), T.visibleOpen(), 'same array while nothing changed')
  const a = T.visibleOpen()
  T.set({ filter: { type: 'question', query: '', resolvedBy: 'all' } })
  assert.notEqual(T.visibleOpen(), a); assert.equal(T.visibleOpen().length, 1)
  T.set({ showHeld: true }); assert.equal(T.visibleOpen().length, 0)
  T.set({ showHeld: false }); T.state.snap = snap({ open: [item('q1', 'question'), item('q2', 'question')] })
  assert.equal(T.visibleOpen().length, 2, 'a new snapshot is read again')
})

test('the Resolved Type select does not change the Waiting type tab, and the Waiting type does not filter Resolved', () => {
  const { T } = load()
  T.state.snap = snap({ open: [item('c1', 'completed')], resolved: [ai('a1'), { ...me('m1'), type: 'question' }] })
  const cards = () => findAll(part(T, 'ResolvedList'), (n) => typeof n.type === 'function' && n.type.name === 'ResolvedCard').length
  T.setView('resolved')
  findAll(part(T, 'SubTabs'), (n) => n.type === 'select')[0].props.onChange({ target: { value: 'question' } })
  assert.equal(cards(), 1, 'the select filters Resolved')
  T.setView('waiting')
  assert.equal(T.state.filter.type, 'all', 'the Waiting tabs still show All')
  T.set({ filter: { ...T.state.filter, type: 'paused' } })
  T.setView('resolved')
  assert.equal(cards(), 1, 'a Waiting type of Paused does not hide Resolved items; the Resolved select keeps its own choice')
  assert.equal(findAll(part(T, 'SubTabs'), (n) => n.type === 'select')[0].props.value, 'question')
})
test('desktop tab counts follow the search, like the phone: Waiting types and Resolved by', () => {
  const { T } = load()
  T.state.snap = snap({ open: [item('q1', 'question', { title: 'alpha' }), item('q2', 'question', { title: 'beta' }), item('c1', 'completed', { title: 'alpha' })], resolved: [{ ...ai('a1'), title: 'alpha' }, { ...me('m1'), title: 'beta' }] })
  T.set({ filter: { type: 'all', query: 'alpha', resolvedBy: 'all', resolvedType: 'all' } })
  assert.deepEqual(tabsOf(tablist(part(T, 'SubTabs'), 'Type')).map((t) => badges(t)[0]), ['2', '1', '1', '0'], 'All, Done, Question and the always-there Paused')
  T.setView('resolved')
  assert.deepEqual(tabsOf(tablist(part(T, 'SubTabs'), 'Resolved by')).map((t) => badges(t)[0]), ['1', '0', '1'])
})