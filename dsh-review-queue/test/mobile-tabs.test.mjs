// The tab-based phone redesign (docs/mobile.md, "Review Queue Tabs Design Mockup"): a <button> exists only if it does something;
// changing what is shown is a tab, moving around is a link. Hook-free pieces exported from lib/mobile/views.js are drawn here; the screens that
// hold them (hooks) are checked through their source.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const noop = () => {}
globalThis.location = { pathname: '/m/', hash: '', origin: 'http://x', href: 'http://x/m/' }
globalThis.window = globalThis
globalThis.document = { addEventListener: noop, removeEventListener: noop, hidden: false, createElement: () => ({}), head: { append: noop } }
globalThis.addEventListener = noop
globalThis.removeEventListener = noop
globalThis.localStorage = { getItem: () => null, setItem: noop, removeItem: noop }
const calls = []
let reply = () => ({ ok: true, status: 200, json: async () => ({ ok: true }) })
globalThis.fetch = async (url, init) => { calls.push([String(url), init && init.body ? JSON.parse(init.body) : undefined]); return reply() }

function loadOverlay() {
  let registered
  const file = join(root, 'lib', 'client.js')
  const sandbox = { window: { __ModuleLoader__: { load: (r) => { registered = r } }, localStorage: { getItem: () => null, setItem() {} } }, console, setTimeout, clearTimeout, setInterval, clearInterval, fetch: () => new Promise(() => {}) }
  vm.runInNewContext(readFileSync(file, 'utf8'), sandbox, { filename: file })
  return registered.factory(() => ({ createElement: () => null, Fragment: Symbol('Fragment'), useState() {}, useEffect() {}, useRef() {}, useSyncExternalStore() {} }))
}
const core = loadOverlay().shared
const api = await import('../lib/mobile/api.js')
api.setCoreForTests(core)
const views = await import('../lib/mobile/views.js')
const model = await import('../lib/mobile/model.js')
const { listModel } = model

// The vnode tree with every function component called (the ones that need hooks are left as placeholders).
const HOOKED = new Set(['ArchiveSessionButton', 'Mic', 'HoldSheet', 'MarkWrongSheet'])
function expand(n) {
  if (Array.isArray(n)) return n.map(expand)
  if (!n || typeof n !== 'object') return n
  if (typeof n.type === 'function' && HOOKED.has(n.type.name)) return { type: n.type.name, props: n.props, children: [] }
  if (typeof n.type === 'function') return expand(n.type(n.props))
  const kids = n.props && n.props.children
  return { type: n.type, props: n.props, ref: n.ref, children: [].concat(kids === undefined ? [] : kids).flat(Infinity).filter((c) => c !== null && c !== undefined && c !== false).map(expand) }
}
const walk = (n, out = []) => { if (Array.isArray(n)) n.forEach((c) => walk(c, out)); else if (n && typeof n === 'object') { out.push(n); n.children.forEach((c) => walk(c, out)) } return out }
const textOf = (n) => (Array.isArray(n) ? n.map(textOf).join('') : typeof n === 'string' || typeof n === 'number' ? String(n) : n && typeof n === 'object' ? n.children.map(textOf).join('') : '')
const draw = (name, props) => { assert.equal(typeof views[name], 'function', name + ' is exported'); return expand(views[name](props)) }
const find = (tree, pred) => walk(tree).filter(pred)
const buttons = (tree) => find(tree, (n) => n.type === 'button')
const links = (tree) => find(tree, (n) => n.type === 'a')
const tabs = (tree) => find(tree, (n) => n.props && n.props.role === 'tab')
const cls = (n) => String((n.props && (n.props.class || n.props.className)) || '').split(/\s+/)
const must = (x, what) => { assert.ok(x, 'missing: ' + what); return x }
const tt = (n) => textOf(n).replace(/\s+/g, ' ').trim() // the text of a tab: label, then its count after a space
const tick = () => new Promise((r) => setTimeout(r, 5))

const item = (type, over = {}) => ({ id: type + '-' + Math.random(), type, status: 'open', title: type + ' title', createdAt: 1, payload: {}, ...over })
const aiRes = (over = {}) => ({ id: 'r' + Math.random(), type: 'permission', status: 'resolved', title: 'ai', createdAt: 1, resolvedAt: 2, resolution: { kind: 'ai-resolved', by: 'ai', action: 'approved', ...over } })
const meRes = () => ({ id: 'm' + Math.random(), type: 'permission', status: 'resolved', title: 'me', createdAt: 1, resolvedAt: 2, resolution: { kind: 'approved', by: 'card' } })
const fresh = (filter = { type: 'all', query: '', resolvedBy: 'all' }) => { calls.length = 0; reply = () => ({ ok: true, status: 200, json: async () => ({ ok: true }) }); api.set({ busy: {}, errors: {}, sheet: null, snap: null, filter }); globalThis.location.hash = '' }
const waitingState = (open, filter) => { fresh(filter); api.set({ snap: { snapshotId: 'e:1', open, resolved: [] } }); return api.state }

// ---- Tabs: roles, aria, roving tabindex, arrow keys ------------------------------------------------------------------------------------------

const sample = [{ key: 'a', label: 'Alpha', count: 3, on: true }, { key: 'b', label: 'Beta', count: 0, on: false }, { key: 'c', label: 'Gamma', on: false }]

test('Tabs: a tablist with a label, role=tab buttons, aria-selected, and a count badge when there is one', () => {
  const tree = draw('Tabs', { label: 'Type', tabs: sample, onSelect: noop })
  const list = must(find(tree, (n) => n.props && n.props.role === 'tablist')[0], 'the tablist')
  assert.equal(list.props['aria-label'], 'Type')
  const t = tabs(tree)
  assert.equal(t.length, 3)
  assert.ok(t.every((n) => n.type === 'button' && n.props.type === 'button'))
  assert.deepEqual(t.map((n) => n.props['aria-selected']), [true, false, false])
  assert.deepEqual(t.map(tt), ['Alpha 3', 'Beta 0', 'Gamma'])
  assert.deepEqual(t.map((n) => find(n, (x) => cls(x).includes('n')).length), [1, 1, 0])
})

test('Tabs: roving tabindex - only the selected tab is in the tab order', () => {
  const t = tabs(draw('Tabs', { label: 'Type', tabs: sample, onSelect: noop }))
  assert.deepEqual(t.map((n) => n.props.tabIndex ?? n.props.tabindex), [0, -1, -1])
})

test('Tabs: tapping a tab calls onSelect with its key', () => {
  const picked = []
  const t = tabs(draw('Tabs', { label: 'Type', tabs: sample, onSelect: (k) => picked.push(k) }))
  t[2].props.onClick()
  assert.deepEqual(picked, ['c'])
})

test('Tabs: Left / Right / Home / End select and focus the neighbour (wrapping), other keys do nothing', () => {
  const picked = []
  const focused = []
  const t = tabs(draw('Tabs', { label: 'Type', tabs: sample, onSelect: (k) => picked.push(k) }))
  const kids = sample.map((_, i) => ({ focus: () => focused.push(i) }))
  // The tab row also holds non-tab children in real life: the tabs are found by role, not by child position.
  const row = { children: [{ focus: () => focused.push('not a tab') }, ...kids], querySelectorAll: (sel) => { assert.equal(sel, '[role="tab"]'); return kids } }
  const press = (from, key) => { let prevented = false; t[from].props.onKeyDown({ key, preventDefault: () => { prevented = true }, currentTarget: { parentElement: row } }); return prevented }
  assert.equal(press(0, 'ArrowRight'), true)
  assert.equal(press(0, 'ArrowLeft'), true)
  assert.equal(press(2, 'ArrowRight'), true)
  assert.equal(press(1, 'Home'), true)
  assert.equal(press(0, 'End'), true)
  assert.equal(press(0, 'Enter'), false)
  assert.deepEqual(picked, ['b', 'c', 'a', 'a', 'c'])
  assert.deepEqual(focused, [1, 2, 0, 0, 2])
})

test('Tabs: disabled turns every tab off', () => {
  const t = tabs(draw('Tabs', { label: 'Type', tabs: sample, onSelect: noop, disabled: true }))
  assert.ok(t.every((n) => n.props.disabled === true))
})

test('Tabs: a hot pill (unseen AI items) is shown in addition to the count, in the accent class', () => {
  const t = tabs(draw('Tabs', { label: 'Resolved by', tabs: [{ key: 'ai', label: 'By AI', count: 4, countText: '2 new', hot: true, on: true }], onSelect: noop }))
  const [count, pill] = find(t[0], (x) => cls(x).includes('n'))
  assert.equal(textOf(count), '4')
  assert.ok(!cls(count).includes('hot'))
  assert.equal(textOf(pill), '2 new')
  assert.ok(cls(pill).includes('hot'))
})

test('Tabs: no tab carries a class that has no CSS rule (the selected state is aria-selected)', () => {
  const t = tabs(draw('Tabs', { label: 'Type', tabs: sample, onSelect: noop }))
  assert.deepEqual(t.map((n) => cls(n).filter(Boolean)), [['tab'], ['tab'], ['tab']])
})

// ---- Waiting ------------------------------------------------------------------------------------------------------------------------------

const open7 = () => [item('permission'), item('question'), item('completed'), item('completed'), item('pr-merged'), item('todo', { text: 'x', state: 'awaiting-confirm' }), item('paused')]

test('WaitingTabs: the type tabs with counts replace the filter chips and set filter.type, keeping the query', () => {
  const st = waitingState(open7(), { type: 'all', query: '', resolvedBy: 'all' })
  const model = listModel(core, st.snap, st.filter)
  const tree = draw('WaitingTabs', { model })
  assert.equal(find(tree, (n) => n.props && n.props.role === 'tablist')[0].props['aria-label'], 'Type')
  assert.deepEqual(tabs(tree).map(tt), ['All 7', 'Permission 1', 'Question 1', 'Done 2', 'PR merged 1', 'Todo 1', 'Paused 1'])
  api.set({ filter: { type: 'all', query: 'x', resolvedBy: 'me' } })
  tabs(tree)[2].props.onClick()
  assert.deepEqual({ ...api.state.filter }, { type: 'question', query: 'x', resolvedBy: 'me' })
})

test('WaitingBody: a tab for a type with no items is not drawn, except All, Paused (always reachable) and the selected one', () => {
  const st = waitingState([item('permission'), item('question'), item('completed'), item('completed')], { type: 'all', query: '', resolvedBy: 'all' })
  assert.deepEqual(tabs(draw('WaitingBody', { st })).map(tt), ['All 4', 'Permission 1', 'Question 1', 'Done 2', 'Paused 0'])
  const st2 = waitingState([item('permission'), item('question'), item('completed'), item('completed')], { type: 'paused', query: '', resolvedBy: 'all' })
  const t = tabs(draw('WaitingBody', { st: st2 }))
  assert.equal(tt(t[t.length - 1]), 'Paused 0')
  assert.equal(t[t.length - 1].props['aria-selected'], true)
})

test('WaitingBody: Paused is a tab even with zero paused sessions, and opening it says so', () => {
  const st = waitingState([item('permission'), item('question'), item('completed'), item('completed')], { type: 'all', query: '', resolvedBy: 'all' })
  const paused = must(tabs(draw('WaitingBody', { st })).find((t) => t.props.id === 'wtab-paused'), 'the Paused tab')
  paused.props.onClick()
  assert.equal(api.state.filter.type, 'paused')
  assert.match(textOf(draw('WaitingBody', { st: api.state })), /Nothing matches this filter|Nothing is waiting/)
})

test('WaitingBody: the type tabs and the search box are always drawn, also with few items and no filter (as on the desktop)', () => {
  const tree = draw('WaitingBody', { st: waitingState([item('permission')], { type: 'all', query: '', resolvedBy: 'all' }) })
  assert.deepEqual(tabs(tree).map(tt), ['All 1', 'Permission 1', 'Paused 0'])
  assert.equal(find(tree, (n) => n.type === 'input' && n.props.type === 'search').length, 1)
  const empty = draw('WaitingBody', { st: waitingState([], { type: 'all', query: '', resolvedBy: 'all' }) })
  assert.deepEqual(tabs(empty).map(tt), ['All 0', 'Paused 0'])
  assert.equal(find(empty, (n) => n.type === 'input' && n.props.type === 'search').length, 1)
})

test('WaitingBody: the paused note is plain status text on the Paused tab only', () => {
  const st = waitingState(open7(), { type: 'paused', query: '', resolvedBy: 'all' })
  const tree = draw('WaitingBody', { st })
  const note = must(find(tree, (n) => cls(n).includes('paused-note'))[0], 'the note')
  assert.notEqual(note.type, 'button')
  assert.equal(buttons(note).length, 0)
  assert.match(textOf(note), /paused by a restart/)
  const all = draw('WaitingBody', { st: waitingState(open7(), { type: 'all', query: '', resolvedBy: 'all' }) })
  assert.equal(find(all, (n) => cls(n).includes('paused-note')).length, 0)
})

test('WaitingBody: "+ New todo" is a floating action link to #/new (class fab), not a button', () => {
  const tree = draw('WaitingBody', { st: waitingState(open7(), { type: 'all', query: '', resolvedBy: 'all' }) })
  const fab = must(links(tree).find((a) => cls(a).includes('fab')), 'the fab')
  assert.equal(fab.props.href, '#/new')
  assert.match(textOf(fab), /\+ New todo/)
  assert.ok(!buttons(tree).some((b) => /New todo/.test(textOf(b))))
})

test('the FAB belongs to the Waiting list only', () => {
  const st = waitingState(open7(), undefined)
  assert.equal(find(draw('WaitingBody', { st }), (n) => cls(n).includes('fab')).length, 1)
  api.set({ snap: { ...st.snap, resolved: [meRes()] } })
  assert.equal(find(draw('ResolvedBody', { st: api.state }), (n) => cls(n).includes('fab')).length, 0)
})

// ---- Resolved -----------------------------------------------------------------------------------------------------------------------------

test('ResolvedBody: All / By me / By AI tabs (counts, plus an "N new" pill for unseen AI items) set filter.resolvedBy and keep type and query', () => {
  fresh({ type: 'permission', query: '', resolvedBy: 'all' })
  api.set({ snap: { snapshotId: 'e:1', open: [], resolved: [aiRes(), aiRes(), aiRes({ seen: true }), meRes()] } })
  const tree = draw('ResolvedBody', { st: api.state })
  assert.equal(find(tree, (n) => n.props && n.props.role === 'tablist')[0].props['aria-label'], 'Resolved by')
  assert.deepEqual(tabs(tree).map(tt), ['All 4', 'By me 1', 'By AI 3 2 new'])
  api.set({ filter: { type: 'permission', query: 'ls', resolvedBy: 'all' } })
  tabs(tree)[2].props.onClick()
  assert.deepEqual({ ...api.state.filter }, { type: 'permission', query: 'ls', resolvedBy: 'ai' })
  assert.equal(tabs(draw('ResolvedBody', { st: api.state }))[2].props['aria-selected'], true)
})

test('ResolvedBody: a native select labelled Type, beside the search box, sets filter.resolvedType (not the Waiting type); no chip row remains', () => {
  fresh()
  api.set({ snap: { snapshotId: 'e:1', open: [], resolved: [meRes()] } })
  const tree = draw('ResolvedBody', { st: api.state })
  const sel = must(find(tree, (n) => n.type === 'select')[0], 'the select')
  assert.equal(sel.props['aria-label'], 'Type')
  const opts = find(sel, (n) => n.type === 'option')
  assert.equal(textOf(opts[0]), 'All types')
  assert.ok(opts.some((o) => textOf(o) === 'Question'))
  const search = must(find(tree, (n) => n.type === 'input' && n.props.type === 'search')[0], 'the search box')
  assert.equal(search.props.placeholder, 'Search…')
  sel.props.onChange({ target: { value: 'question' } })
  assert.equal(api.state.filter.resolvedType, 'question')
  assert.equal(api.state.filter.type, 'all')
  assert.deepEqual(opts.map((o) => o.props.selected), opts.map(() => undefined), 'the select carries the value; no option repeats it as selected')
  assert.equal(sel.props.value, 'all')
})

test('ResolvedBody: the search box writes filter.query', () => {
  fresh()
  api.set({ snap: { snapshotId: 'e:1', open: [], resolved: [meRes()] } })
  must(find(draw('ResolvedBody', { st: api.state }), (n) => n.type === 'input')[0], 'search').props.onInput({ target: { value: 'abc' } })
  assert.equal(api.state.filter.query, 'abc')
})

// ---- the bottom nav -----------------------------------------------------------------------------------------------------------------------

const navFor = (open, resolved, tab = 'waiting', inItem = false) => {
  const model = listModel(core, { snapshotId: 'e:1', open, resolved }, { type: 'all', query: '', resolvedBy: 'all' })
  return draw('BottomNav', { tab, inItem, model })
}

test('BottomNav: Waiting, On hold, Resolved, Settings are always links, On hold also while nothing is on hold', () => {
  const a = links(navFor([item('permission')], []))
  assert.deepEqual(a.map((x) => x.props.href), ['#/', '#/onhold', '#/resolved', '#/settings'])
  assert.deepEqual(a.map((x) => textOf(x).replace(/\d+/g, '')), ['Waiting', 'On hold', 'Resolved', 'Settings'])
  assert.equal(buttons(navFor([], [])).length, 0)
})

test('BottomNav: count badges - waiting count, held count, resolved total; none for zero', () => {
  const a = links(navFor([item('permission'), item('question'), item('onhold')], [meRes(), meRes(), meRes()]))
  assert.deepEqual(a.map(textOf), ['Waiting2', 'On hold1', 'Resolved3', 'Settings'])
  assert.deepEqual(links(navFor([], [])).map(textOf), ['Waiting', 'On hold', 'Resolved', 'Settings'])
})

test('BottomNav: the Resolved badge uses the accent colour (no dim) while AI-resolved items are unseen, dim otherwise', () => {
  const badge = (resolved) => must(find(links(navFor([], resolved))[2], (n) => cls(n).includes('badge'))[0], 'the badge')
  assert.ok(!cls(badge([meRes(), aiRes()])).includes('dim'))
  assert.ok(cls(badge([meRes(), aiRes({ seen: true })])).includes('dim'))
  assert.ok(cls(badge([meRes(), aiRes({ review: 'agreed' })])).includes('dim'))
})

test('BottomNav: the Resolved link says how many are unseen AI and how many in all (aria-label and title), also when the badge is dim', () => {
  const resolvedLink = (resolved) => links(navFor([], resolved))[2]
  const hot = resolvedLink([meRes(), aiRes(), aiRes(), aiRes({ seen: true })])
  assert.equal(hot.props['aria-label'], 'Resolved: 2 unseen AI of 4 total')
  assert.equal(hot.props.title, 'Resolved: 2 unseen AI of 4 total')
  assert.equal(resolvedLink([meRes(), aiRes({ seen: true })]).props['aria-label'], 'Resolved: 0 unseen AI of 2 total')
  assert.equal(resolvedLink([]).props['aria-label'], 'Resolved: nothing yet')
  assert.equal(links(navFor([], []))[0].props['aria-label'], undefined, 'only the Resolved link needs the extra words')
})

test('BottomNav: the current tab is marked on, and none while an item or the new-todo screen is open', () => {
  assert.deepEqual(links(navFor([], [], 'resolved')).map((a) => cls(a).includes('on')), [false, false, true, false])
  assert.deepEqual(links(navFor([], [], 'waiting', true)).map((a) => cls(a).includes('on')), [false, false, false, false])
})

// ---- the app-bar back arrow -------------------------------------------------------------------------------------------------------------

test('BackLink: an app-bar link with aria-label Back, to the given href', () => {
  const a = must(links(draw('BackLink', { href: '#/' }))[0], 'the link')
  assert.equal(a.props['aria-label'], 'Back')
  assert.equal(a.props.href, '#/')
  assert.ok(cls(a).includes('back'))
})

test('backHref is always the Waiting list, for a resolved item too, and needs no item', () => {
  assert.equal(model.backHref.length, 0, 'takes no argument')
  assert.equal(model.backHref(), '#/')
})

// ---- New todo kind tabs -------------------------------------------------------------------------------------------------------------------

test('TodoKindTabs: a tablist "Kind of todo" with New session / Follow up tabs, aria-selected follows the mode, no aria-pressed', () => {
  const tree = draw('TodoKindTabs', { follow: false, disabled: false, onSelect: noop })
  assert.equal(find(tree, (n) => n.props && n.props.role === 'tablist')[0].props['aria-label'], 'Kind of todo')
  assert.deepEqual(tabs(tree).map(tt), ['New session', 'Follow up'])
  assert.deepEqual(tabs(tree).map((t) => t.props['aria-selected']), [true, false])
  const picked = []
  const f = draw('TodoKindTabs', { follow: true, disabled: false, onSelect: (m) => picked.push(m) })
  assert.deepEqual(tabs(f).map((t) => t.props['aria-selected']), [false, true])
  tabs(f)[0].props.onClick()
  assert.deepEqual(picked, ['new'])
})

// ---- the Hold sheet ------------------------------------------------------------------------------------------------------------------------

const dialog = (tree) => find(tree, (n) => n.props && n.props.role === 'dialog')[0]
const doneItem = (over = {}) => ({ id: 'h1', type: 'completed', status: 'open', title: 'Done', createdAt: 1, sessionId: 's1', ...over })

test('OnHoldButton: Hold… opens the Hold sheet (no inline form); the reason is the hooked sheet\'s own state, not state.sheet', () => {
  fresh()
  const it = doneItem()
  assert.equal(find(draw('OnHoldForm', { item: it }), (n) => n.type === 'HoldSheet').length, 0)
  const hold = must(buttons(draw('OnHoldButton', { item: it })).find((b) => /Hold…/.test(textOf(b))), 'Hold…')
  hold.props.onClick()
  assert.deepEqual({ ...api.state.sheet }, { kind: 'hold', id: 'h1', text: '' })
  assert.equal(find(draw('OnHoldForm', { item: it }), (n) => n.type === 'HoldSheet').length, 1, 'the hooked HoldSheet draws the sheet')
})

test('opening the Hold sheet or the Mark wrong / Overrule sheets clears the item\'s old error, so a stale one is not shown again', () => {
  fresh()
  const it = doneItem()
  api.set({ errors: { h1: 'old failure', other: 'keep me' } })
  must(buttons(draw('OnHoldButton', { item: it }))[0], 'Hold…').props.onClick()
  assert.equal(api.state.errors.h1, undefined)
  assert.equal(api.state.errors.other, 'keep me', 'only this item\'s error goes')
  for (const re of [/Mark wrong/, /Overrule rule/]) {
    const ai = { ...aiRes(), id: 'a9', sessionId: 's1', type: 'completed', resolution: { kind: 'ai-resolved', by: 'ai', action: 'approved', seen: true } }
    api.set({ errors: { a9: 'old failure' }, sheet: null })
    must(buttons(draw('AiReview', { item: ai })).find((b) => re.test(textOf(b))), String(re)).props.onClick()
    assert.equal(api.state.errors.a9, undefined, String(re))
    assert.equal(api.state.sheet.id, 'a9')
  }
})

test('cardError: a card does not repeat an error that its open sheet already shows', () => {
  const { cardError } = model
  assert.equal(cardError(null, 'a', 'boom'), 'boom')
  assert.equal(cardError({ kind: 'hold', id: 'b' }, 'a', 'boom'), 'boom', 'a sheet of another item')
  assert.equal(cardError({ kind: 'hold', id: 'a' }, 'a', 'boom'), undefined)
  assert.equal(cardError({ kind: 'mark-wrong', id: 'a' }, 'a', undefined), undefined)
})

test('confirmHold: posts /v1/hold with the reason, closes the sheet and goes to the list; an empty reason is allowed', async () => {
  fresh()
  const it = doneItem()
  api.set({ sheet: { kind: 'hold', id: 'h1', text: '' } })
  assert.equal(await views.confirmHold(it, 'waiting for the customer'), true)
  assert.deepEqual(calls.map((c) => [c[0].replace(/^.*(?=\/v1\/)/, ''), c[1]]), [['/v1/hold', { id: 'h1', reason: 'waiting for the customer' }]])
  assert.equal(api.state.sheet, null)
  assert.match(globalThis.location.hash, /^#?\/$/)
  fresh()
  api.set({ sheet: { kind: 'hold', id: 'h1', text: '' } })
  assert.equal(await views.confirmHold(it, ''), true)
  assert.deepEqual(calls.map((c) => c[1]), [{ id: 'h1', reason: '' }])
})

test('confirmHold: a failed hold keeps the sheet; while busy Hold… is disabled', async () => {
  fresh()
  const it = doneItem()
  api.set({ sheet: { kind: 'hold', id: 'h1', text: '' } })
  reply = () => ({ ok: false, status: 500, json: async () => ({}) })
  assert.equal(await views.confirmHold(it, 'r'), false)
  assert.equal(api.state.sheet.kind, 'hold')
  api.set({ busy: { h1: true } })
  assert.equal(buttons(draw('OnHoldButton', { item: it }))[0].props.disabled, true)
})

// ---- review fixes ----------------------------------------------------------------------------------------------------------------------

test('Paused is a tab even with no paused session (Waiting type tabs always offer it)', () => {
  const model = listModel(core, { snapshotId: 'e:1', open: [item('permission'), item('question'), item('completed'), item('completed')], resolved: [] }, { type: 'all', query: '', resolvedBy: 'all' })
  assert.deepEqual(model.tabs.map((t) => t.type), ['all', 'permission', 'question', 'completed', 'paused'])
  assert.equal(model.tabs.at(-1).count, 0)
})

test('listModel is computed once per snapshot and filter (every screen and the app shell ask for it on each store change)', () => {
  const snap = { snapshotId: 'e:1', open: [item('permission')], resolved: [meRes()] }
  const f = { type: 'all', query: '', resolvedBy: 'all' }
  const a = listModel(core, snap, f)
  assert.equal(listModel(core, snap, f), a, 'same object for the same snapshot and filter')
  assert.notEqual(listModel(core, snap, { ...f }), a, 'a new filter is read again')
  assert.notEqual(listModel(core, { ...snap }, f), a, 'a new snapshot is read again')
  assert.equal(listModel(core, null, f).waiting, 0)
})

test('navCounts: the app shell gets the header and nav numbers without building the lists', () => {
  const { navCounts } = model
  assert.equal(typeof navCounts, 'function')
  const snap = { snapshotId: 'e:1', open: [item('permission'), item('onhold'), item('paused')], resolved: [aiRes(), meRes()], sessions: { working: 1, open: 3 } }
  const n = navCounts(core, snap)
  assert.deepEqual({ waiting: n.waiting, paused: n.paused, held: n.held, resolvedCount: n.resolvedCount, aiUnseen: n.aiUnseen }, { waiting: 1, paused: 1, held: 1, resolvedCount: 2, aiUnseen: 1 })
  assert.match(n.sessions, /1 working/)
  assert.equal(navCounts(core, snap), n, 'memoised per snapshot')
  assert.equal(navCounts(core, null).waiting, 0)
})

test('the Resolved Type select and the Waiting type tabs are separate choices', () => {
  const resolved = [{ ...meRes(), type: 'question' }, meRes()]
  const snap = { snapshotId: 'e:1', open: [item('paused')], resolved }
  const m = listModel(core, snap, { type: 'paused', query: '', resolvedBy: 'all' })
  assert.equal(m.resolved.length, 2, 'a Waiting type of Paused does not hide Resolved items')
  const m2 = listModel(core, snap, { type: 'paused', query: '', resolvedBy: 'all', resolvedType: 'question' })
  assert.equal(m2.resolved.length, 1)
  assert.deepEqual(m2.resolvedTabs.map((t) => t.count), [1, 1, 0])
  fresh({ type: 'all', query: '', resolvedBy: 'all' })
  api.set({ snap })
  const sel = must(find(draw('ResolvedBody', { st: api.state }), (n) => n.type === 'select')[0], 'the select')
  sel.props.onChange({ target: { value: 'question' } })
  assert.equal(api.state.filter.type, 'all'); assert.equal(api.state.filter.resolvedType, 'question')
  assert.equal(must(find(draw('ResolvedBody', { st: api.state }), (n) => n.type === 'select')[0], 'the select').props.value, 'question')
})

test('Resolved tab counts: one rule with the desktop - they follow the Type select and the search, the "N new" pill is additional', () => {
  const resolved = [{ ...aiRes(), type: 'question' }, aiRes(), aiRes({ seen: true }), meRes(), { ...meRes(), title: 'zebra' }]
  const snap = { snapshotId: 'e:1', open: [], resolved }
  const base = { type: 'all', query: '', resolvedBy: 'all', resolvedType: 'permission' }
  const row = (m) => m.resolvedTabs.map((t) => [t.value, t.label, t.count, t.countText])
  assert.deepEqual(row(listModel(core, snap, base)), [['all', 'All', 4, undefined], ['me', 'By me', 2, undefined], ['ai', 'By AI', 2, '2 new']])
  assert.deepEqual(row(listModel(core, snap, { ...base, query: 'zebra' })), [['all', 'All', 1, undefined], ['me', 'By me', 1, undefined], ['ai', 'By AI', 0, '2 new']], 'the pill counts every unseen AI item, whatever the filter')
  for (const f of [base, { ...base, query: 'zebra' }, { ...base, resolvedType: 'all' }, { ...base, resolvedType: 'question' }]) {
    const c = core.resolvedCounts(resolved, { type: f.resolvedType, query: f.query })
    assert.deepEqual(listModel(core, snap, f).resolvedTabs.map((t) => t.count), [c.all, c.me, c.ai], JSON.stringify(f))
  }
})

test('Resolved by labels come from one place (core.RESOLVED_LABELS) for the phone tabs', () => {
  assert.deepEqual({ ...core.RESOLVED_LABELS }, { all: 'All', me: 'By me', ai: 'By AI' })
  const m = listModel(core, { snapshotId: 'e:1', open: [], resolved: [] }, { type: 'all', query: '', resolvedBy: 'all' })
  assert.deepEqual(m.resolvedTabs.map((t) => t.label), Array.from(core.RESOLVED_BY, (v) => core.RESOLVED_LABELS[v]))
})

test('markWrongView: Send correction stays disabled for blank text or while busy; only a question or permission says it cannot be unsent', () => {
  const { markWrongView } = model
  assert.deepEqual({ ...markWrongView({ type: 'completed' }, '   ', false) }, { confirmDisabled: true, unsent: false, correction: '' })
  assert.deepEqual({ ...markWrongView({ type: 'completed' }, '  Use main  ', false) }, { confirmDisabled: false, unsent: false, correction: 'Use main' })
  assert.equal(markWrongView({ type: 'completed' }, 'x', true).confirmDisabled, true)
  assert.equal(markWrongView({ type: 'question' }, 'x', false).unsent, true)
  assert.equal(markWrongView({ type: 'permission' }, 'x', false).unsent, true)
})

test('BottomNav: the Resolved badge number matches its colour - the unseen AI count when accent, the total when dim', () => {
  const badge = (resolved) => must(find(links(navFor([], resolved))[2], (n) => cls(n).includes('badge'))[0], 'the badge')
  const hot = badge([meRes(), meRes(), aiRes(), aiRes()])
  assert.ok(!cls(hot).includes('dim')); assert.equal(textOf(hot), '2')
  const dim = badge([meRes(), meRes(), aiRes({ seen: true })])
  assert.ok(cls(dim).includes('dim')); assert.equal(textOf(dim), '3')
})

test('a sheet is closed when its item leaves the queue (sheetGone)', () => {
  const { sheetGone } = model
  const snap = { open: [{ id: 'a' }], resolved: [{ id: 'b' }] }
  assert.equal(typeof sheetGone, 'function')
  assert.equal(sheetGone(null, snap), false)
  assert.equal(sheetGone({ kind: 'hold', id: 'a' }, snap), false)
  assert.equal(sheetGone({ kind: 'overrule', id: 'b' }, snap), false)
  assert.equal(sheetGone({ kind: 'hold', id: 'zz' }, snap), true)
})

test('tabs control their panel: aria-controls on every tab, the panel carries that id and is labelled by the selected tab', () => {
  const t = tabs(draw('Tabs', { label: 'Type', tabs: sample, onSelect: noop, idPrefix: 'wtab', panelId: 'wpanel' }))
  assert.ok(t.every((x) => x.props['aria-controls'] === 'wpanel'))
  const st = waitingState(open7(), { type: 'question', query: '', resolvedBy: 'all' })
  const w = draw('WaitingBody', { st })
  const wp = must(find(w, (n) => n.props && n.props.role === 'tabpanel')[0], 'waiting panel')
  assert.equal(wp.props.id, 'wpanel'); assert.equal(wp.props['aria-labelledby'], 'wtab-question')
  assert.ok(tabs(w).every((x) => x.props['aria-controls'] === 'wpanel'))
  fresh({ type: 'all', query: '', resolvedBy: 'ai' })
  api.set({ snap: { snapshotId: 'e:1', open: [], resolved: [aiRes()] } })
  const r = draw('ResolvedBody', { st: api.state })
  const rp = must(find(r, (n) => n.props && n.props.role === 'tabpanel')[0], 'resolved panel')
  assert.equal(rp.props.id, 'rpanel'); assert.equal(rp.props['aria-labelledby'], 'rtab-ai')
  assert.ok(tabs(r).every((x) => x.props['aria-controls'] === 'rpanel'))
})

test('Sheet focus: the first control gets the focus on open, the opener gets it back, Tab stays inside, Esc cancels', () => {
  const opener = { focused: 0, focus() { this.focused++ } }
  const first = { focused: 0, focus() { this.focused++ } }, last = { focused: 0, focus() { this.focused++ } }
  const node = { querySelectorAll: () => [first, last], contains: (n) => n === first || n === last }
  let cancelled = 0
  const d = must(find(draw('Sheet', { title: 'T', confirmLabel: 'Go', onConfirm: noop, onCancel: () => { cancelled++ } }), (n) => n.props && n.props.role === 'dialog')[0], 'the sheet')
  assert.equal(typeof d.ref, 'function', 'a ref callback (hook-free)')
  const saved = globalThis.document.activeElement
  globalThis.document.activeElement = opener
  try {
    d.ref(node)
    assert.equal(first.focused, 1)
    d.ref(null)
    assert.equal(opener.focused, 1, 'closing gives the focus back')
    const key = (shiftKey, active) => { globalThis.document.activeElement = active; let p = 0; d.props.onKeyDown({ key: 'Tab', shiftKey, currentTarget: node, preventDefault: () => { p++ } }); return p }
    assert.equal(key(false, last), 1); assert.equal(first.focused, 2)
    assert.equal(key(true, first), 1); assert.equal(last.focused, 1)
    assert.equal(key(false, first), 0)
    d.props.onKeyDown({ key: 'Escape', currentTarget: node, preventDefault() {}, stopPropagation() {} })
    assert.equal(cancelled, 1)
  } finally { globalThis.document.activeElement = saved }
})