// The phone UI for items the AI resolved - the Resolved-by tabs, the AI badge, the detail block, the seen request and the review buttons.
// It mirrors the desktop (test/client-ai-card.test.mjs, client-ai-filter-head). Redesign (tab-based phone): the "Resolved by" chips are the
// By me / By AI tabs (test/mobile-tabs.test.mjs), the "AI handled N" banner button is gone (the Resolved nav badge and the By AI tab carry
// the count), and Mark wrong… / Overrule rule open the bottom confirm sheet instead of an inline form.
//
// The phone views use hooks, so the new pieces are hook-free components exported from lib/mobile/views.js (read the store from api.js `state`
// directly; the screens that contain them re-render on every store change), and the seen request is a function exported from lib/mobile/api.js:
//   views.AiBadge({ item })          the AI badge (data-ai-badge=id); null for anything not AI-resolved
//   views.AiDetail({ item })         the detail block (data-ai-detail=id): quote, rule name, "attention <score>"; null for non-AI
//   views.AiReview({ item })         Looks right / Mark wrong… / Overrule rule; the last two open a sheet (state.sheet = { kind, id, text }); null for non-AI
//   api.markAiSeen(item)             POST /v1/triage-review { id, review: 'seen' } once per item (module-level set); a failed request can retry
// In-memory state key of api.js `state` (never saved to storage): sheet { kind: 'mark-wrong' | 'overrule' | 'hold', id, text } or null.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const noop = () => {}
const stored = []
globalThis.location = { pathname: '/m/', hash: '', origin: 'http://x', href: 'http://x/m/' }
globalThis.window = globalThis
globalThis.document = { addEventListener: noop, removeEventListener: noop, hidden: false, createElement: () => ({}), head: { append: noop } }
globalThis.addEventListener = noop
globalThis.removeEventListener = noop
globalThis.localStorage = { getItem: () => null, setItem: (k, v) => { stored.push([String(k), String(v)]) }, removeItem: noop }

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
const { listModel } = await import('../lib/mobile/model.js')
const viewsSource = readFileSync(join(root, 'lib', 'mobile', 'views.js'), 'utf8')
const between = (from, to) => {
  const a = viewsSource.indexOf(from)
  const b = viewsSource.indexOf(to)
  assert.ok(a >= 0, 'marker not found in views.js: ' + from)
  assert.ok(b > a, 'end marker not found after start in views.js: ' + to)
  return viewsSource.slice(a, b)
}

/** The vnode tree with every function component called. */
function expand(n) {
  if (Array.isArray(n)) return n.map(expand)
  if (!n || typeof n !== 'object') return n
  if (typeof n.type === 'function' && n.type.name === 'MarkWrongSheet') return { type: 'MarkWrongSheet', props: n.props, children: [] } // hooked: its text is local state, like HoldSheet's
  if (typeof n.type === 'function') return expand(n.type(n.props))
  const kids = n.props && n.props.children
  return { type: n.type, props: n.props, children: [].concat(kids === undefined ? [] : kids).flat(Infinity).filter((c) => c !== null && c !== undefined && c !== false).map(expand) }
}
const walk = (n, out = []) => { if (Array.isArray(n)) n.forEach((c) => walk(c, out)); else if (n && typeof n === 'object') { out.push(n); n.children.forEach((c) => walk(c, out)) } return out }
const textOf = (n) => (Array.isArray(n) ? n.map(textOf).join('') : typeof n === 'string' ? n : n && typeof n === 'object' ? n.children.map(textOf).join('') : '')
const need = (name, from = views) => { assert.equal(typeof from[name], 'function', name + ' is exported'); return from[name] }
const draw = (name, props) => expand(need(name)(props))
const attr = (name, id) => (n) => n.props && n.props[name] === id
const buttons = (tree) => walk(tree).filter((n) => n.type === 'button')
const btn = (tree, re) => buttons(tree).find((b) => re.test(textOf(b)))
const must = (x, what) => { assert.ok(x, 'missing: ' + what); return x }
const press = (tree, re) => must(btn(tree, re), 'button ' + re).props.onClick()
const tick = () => new Promise((r) => setTimeout(r, 5))
const classes = (n) => String((n.props && (n.props.class || n.props.className)) || '').split(' ')

const aiItem = (over = {}, res = {}) => ({ id: 'a1', sessionId: 's1', type: 'permission', status: 'resolved', title: 'Run ls', createdAt: 1, resolvedAt: 2, triage: { ruleName: 'Read-only commands' },
  resolution: { kind: 'ai-resolved', by: 'ai', action: 'approved', ruleId: 'r1', quote: 'ls is read only', score: 9.6, ...res }, ...over })
const meItem = () => ({ id: 'm1', type: 'permission', status: 'resolved', title: 'Run pwd', createdAt: 1, resolvedAt: 2, resolution: { kind: 'approved', by: 'card' } })
const snapOf = (resolved, open = []) => ({ snapshotId: 'e:1', open, resolved })
const fresh = () => { calls.length = 0; reply = () => ({ ok: true, status: 200, json: async () => ({ ok: true }) }); api.set({ busy: {}, errors: {}, sheet: null, filter: { type: 'all', query: '', resolvedBy: 'all' } }); globalThis.location.hash = '' }
const URL_REVIEW = /\/v1\/triage-review$/

test('the phone state starts with no sheet open', () => {
  assert.equal(api.state.sheet, null)
  assert.ok(!('aiCorrection' in api.state) && !('aiOverrule' in api.state), 'the inline-form keys are gone')
})
// ---- 2. the list row badge -----------------------------------------------------------------------------------------------------------

test('AiBadge: an AI-resolved item gets an "AI" badge; a non-AI item and a missing item get none', () => {
  const badge = draw('AiBadge', { item: aiItem() })
  const found = walk(badge).filter(attr('data-ai-badge', 'a1'))
  assert.equal(found.length, 1)
  assert.match(textOf(found[0]), /AI/)
  assert.equal(draw('AiBadge', { item: meItem() }), null)
  assert.equal(draw('AiBadge', { item: { id: 'o', type: 'permission', status: 'open' } }), null)
})

test('the Resolved list shows the badge on its rows, next to the resolution line, and the waiting rows never do', () => {
  const list = between('export function ResolvedBody', 'function NewTodoView')
  assert.match(list, /<\$\{AiBadge\} item=\$\{i\} \/>/)
  assert.match(list, /resolutionText\(i\)/)
  assert.doesNotMatch(between('function ItemRow', 'export function Tabs'), /AiBadge/)
})

// ---- 3. the detail block and the seen request ----------------------------------------------------------------------------------------

test('AiDetail: shows the quote, the rule name and "attention <rounded score>"', () => {
  const d = must(walk(draw('AiDetail', { item: aiItem() })).filter(attr('data-ai-detail', 'a1'))[0], 'the detail block')
  assert.match(textOf(d), /ls is read only/)
  assert.match(textOf(d), /Read-only commands/)
  assert.match(textOf(d), /attention 10\b/)
})

test('AiDetail: with no rule name it falls back to the rule id; with no score it says nothing about attention', () => {
  const d = textOf(draw('AiDetail', { item: aiItem({ triage: undefined }, { score: undefined }) }))
  assert.match(d, /r1/)
  assert.doesNotMatch(d, /attention/)
})

test('AiDetail: nothing for a non-AI item', () => {
  assert.equal(draw('AiDetail', { item: meItem() }), null)
})

test('the item view shows the AI detail and review for a resolved item and asks for the seen mark', () => {
  const view = between('function ItemView', 'export function App')
  assert.match(view, /<\$\{AiDetail\} item=\$\{item\} \/>/)
  assert.match(view, /<\$\{AiReview\} item=\$\{item\} \/>/)
  assert.match(viewsSource, /markAiSeen\(/)
  assert.match(viewsSource, /import \{[^}]*\bmarkAiSeen\b[^}]*\} from '\.\/api\.js'/)
})

test('markAiSeen: an unseen AI item posts review seen once while the request is in flight, however often it is asked', async () => {
  fresh()
  const it = aiItem({ id: 'seen-once' })
  await Promise.all([need('markAiSeen', api)(it), need('markAiSeen', api)(it)])
  await tick()
  assert.deepEqual(calls.map(([u, b]) => [u.replace(/^.*(?=\/v1\/)/, ''), b]), [['/v1/triage-review', { id: 'seen-once', review: 'seen' }]])
})

test('markAiSeen: an already seen, reviewed or non-AI item posts nothing', async () => {
  fresh()
  const mark = need('markAiSeen', api)
  await mark(aiItem({ id: 'seen-1' }, { seen: true }))
  await mark(aiItem({ id: 'seen-2' }, { review: 'agreed' }))
  await mark(meItem())
  await tick()
  assert.deepEqual(calls, [])
})

test('markAiSeen: a failed request can be tried again; once the snapshot shows it seen, nothing more is posted', async () => {
  fresh()
  const mark = need('markAiSeen', api)
  const it = aiItem({ id: 'seen-retry' })
  reply = () => ({ ok: false, status: 500, json: async () => ({}) })
  await mark(it)
  await tick()
  assert.equal(calls.length, 1)
  reply = () => ({ ok: true, status: 200, json: async () => ({ ok: true }) })
  await mark(it)
  await tick()
  assert.equal(calls.length, 2, 'the failure was forgotten, so it is asked again')
  await mark(aiItem({ id: 'seen-retry' }, { seen: true })) // the next snapshot carries the mark
  await tick()
  assert.equal(calls.length, 2, 'the success stands')
})

test('markAiSeen is silent: busy and errors of the item stay unset, during the request and after a failure', async () => {
  fresh()
  const it = aiItem({ id: 'seen-quiet' })
  let release
  reply = () => new Promise((r) => { release = () => r({ ok: false, status: 500, json: async () => ({}) }) })
  const p = need('markAiSeen', api)(it)
  await tick()
  assert.equal(calls.length, 1)
  assert.ok(!api.state.busy['seen-quiet'], 'no busy while the request is in flight')
  release()
  assert.equal(await p, false)
  assert.ok(!api.state.busy['seen-quiet'], 'no busy after the failure')
  assert.equal(api.state.errors['seen-quiet'], undefined, 'no error text on a card that was only viewed')
})


// ---- 4. review buttons and the confirm sheets -----------------------------------------------------------------------------------------------

const dialog = (tree) => walk(tree).find((n) => n.props && n.props.role === 'dialog')
const sheetBtn = (tree, re) => { const d = dialog(tree); return d && buttons(d).find((b) => re.test(textOf(b))) }

test('AiReview: nothing for a non-AI item', () => {
  fresh()
  assert.equal(draw('AiReview', { item: meItem() }), null)
})

test('AiReview: Looks right posts review agreed; the three buttons show only while there is no review', async () => {
  fresh()
  const it = aiItem({}, { seen: true })
  const tree = draw('AiReview', { item: it })
  assert.ok(btn(tree, /Mark wrong/) && btn(tree, /Overrule rule/))
  press(tree, /Looks right/)
  await tick()
  assert.equal(calls.length, 1)
  assert.match(calls[0][0], URL_REVIEW)
  assert.deepEqual(calls[0][1], { id: 'a1', review: 'agreed' })
  for (const review of ['agreed', 'matched-user', 'overruled']) {
    const t = draw('AiReview', { item: aiItem({}, { seen: true, review }) })
    assert.equal(btn(t, /Looks right/), undefined, review)
    assert.equal(btn(t, /Mark wrong/), undefined, review)
    assert.equal(!!btn(t, /Overrule rule/), review !== 'overruled', 'Overrule rule stays unless overruled: ' + review)
  }
})

test('AiReview: no sheet until a button is pressed; Mark wrong… and Overrule rule open one and do not post anything', () => {
  fresh()
  const it = aiItem({ type: 'completed' }, { seen: true })
  assert.equal(dialog(draw('AiReview', { item: it })), undefined)
  press(draw('AiReview', { item: it }), /Mark wrong/)
  assert.deepEqual({ ...api.state.sheet }, { kind: 'mark-wrong', id: 'a1', text: '' })
  assert.equal(walk(draw('AiReview', { item: it })).filter((n) => n.type === 'MarkWrongSheet').length, 1, 'the hooked Mark wrong sheet')
  api.set({ sheet: null })
  press(draw('AiReview', { item: it }), /Overrule rule/)
  assert.deepEqual({ ...api.state.sheet }, { kind: 'overrule', id: 'a1', text: '' })
  assert.ok(dialog(draw('AiReview', { item: it })))
  assert.equal(calls.length, 0)
})

test('AiReview: a sheet of another item does not show here', () => {
  fresh()
  api.set({ sheet: { kind: 'mark-wrong', id: 'other', text: '' } })
  assert.equal(dialog(draw('AiReview', { item: aiItem({}, { seen: true }) })), undefined)
})

test('confirmMarkWrong: posts the trimmed correction and closes the sheet; a failed send keeps the sheet open', async () => {
  fresh()
  const it = aiItem({ type: 'completed' }, { seen: true })
  api.set({ sheet: { kind: 'mark-wrong', id: 'a1', text: '' } })
  assert.equal(await need('confirmMarkWrong')(it, '  Use main instead  '), true)
  assert.equal(calls.length, 1)
  assert.match(calls[0][0], URL_REVIEW)
  assert.deepEqual(calls[0][1], { id: 'a1', review: 'mark-wrong', text: 'Use main instead' })
  assert.equal(api.state.sheet, null, 'the sheet closes after a successful send')
  fresh()
  api.set({ sheet: { kind: 'mark-wrong', id: 'a1', text: '' } })
  reply = () => ({ ok: false, status: 500, json: async () => ({}) })
  assert.equal(await need('confirmMarkWrong')(it, 'Use main'), false)
  assert.equal(calls.length, 1)
  assert.equal(api.state.sheet.kind, 'mark-wrong', 'the sheet (and the text typed in it) stays')
  fresh()
  assert.equal(await need('confirmMarkWrong')(it, '   '), false, 'blank text is never sent')
  assert.equal(calls.length, 0)
})

test('the Mark wrong text is never written to state.sheet while typing: it lives in the sheet component', () => {
  fresh()
  const it = aiItem({ type: 'completed' }, { seen: true })
  press(draw('AiReview', { item: it }), /Mark wrong/)
  assert.deepEqual({ ...api.state.sheet }, { kind: 'mark-wrong', id: 'a1', text: '' })
  const sheet = must(walk(draw('AiReview', { item: it })).find((n) => n.type === 'MarkWrongSheet'), 'the sheet component')
  assert.equal(sheet.props.item.id, 'a1')
  assert.deepEqual(Object.keys(sheet.props).sort(), ['item'], 'no text prop: the sheet owns it')
})

test('AiReview: the Overrule sheet offers observe and off, each posting overrule-rule with its mode and closing the sheet', async () => {
  fresh()
  const it = aiItem({}, { seen: true })
  assert.equal(sheetBtn(draw('AiReview', { item: it }), /Set rule to observe/), undefined, 'the choices wait for the sheet')
  press(draw('AiReview', { item: it }), /Overrule rule/)
  press(dialog(draw('AiReview', { item: it })), /Set rule to observe/)
  await tick()
  assert.equal(api.state.sheet, null, 'a successful review closes the sheet')
  press(draw('AiReview', { item: it }), /Overrule rule/)
  press(dialog(draw('AiReview', { item: it })), /Set rule to off/)
  await tick()
  assert.deepEqual(calls.map((c) => c[1]), [{ id: 'a1', review: 'overrule-rule', mode: 'observe' }, { id: 'a1', review: 'overrule-rule', mode: 'off' }])
  for (const c of calls) assert.match(c[0], URL_REVIEW)
})

test('AiReview: Cancel closes the Overrule sheet and a failed overrule keeps it open', async () => {
  fresh()
  const it = aiItem({}, { seen: true })
  api.set({ sheet: { kind: 'overrule', id: 'a1', text: '' } })
  press(dialog(draw('AiReview', { item: it })), /Cancel/)
  assert.equal(api.state.sheet, null)
  api.set({ sheet: { kind: 'overrule', id: 'a1', text: '' } })
  reply = () => ({ ok: false, status: 500, json: async () => ({}) })
  press(dialog(draw('AiReview', { item: it })), /Set rule to off/)
  await tick()
  assert.equal(api.state.sheet.kind, 'overrule')
})

test('AiReview: while busy every button is disabled, including the sheet confirm buttons', () => {
  fresh()
  const it = aiItem({ type: 'completed' }, { seen: true })
  api.set({ busy: { a1: true } })
  for (const re of [/Looks right/, /Mark wrong/, /Overrule rule/]) assert.equal(must(btn(draw('AiReview', { item: it }), re), 'button ' + re).props.disabled, true, String(re))
  api.set({ sheet: { kind: 'overrule', id: 'a1', text: '' } })
  for (const re of [/Set rule to observe/, /Set rule to off/]) assert.equal(must(sheetBtn(draw('AiReview', { item: it }), re), String(re)).props.disabled, true, String(re))
})

test('AiReview: an error of the item shows inside the Overrule sheet (it covers the card)', () => {
  fresh()
  api.set({ errors: { a1: 'Could not send' }, sheet: { kind: 'overrule', id: 'a1', text: '' } })
  assert.match(textOf(dialog(draw('AiReview', { item: aiItem({ type: 'completed' }, { seen: true }) }))), /Could not send/)
})
test('Reopen stays in the item view for an AI-resolved done or paused item, never for a question or permission', () => {
  const r = (type) => ({ type, status: 'resolved', resolution: { kind: 'ai-resolved' } })
  assert.equal(core.isReopenable(r('completed')), true)
  assert.equal(core.isReopenable(r('paused')), true)
  assert.equal(core.isReopenable(r('question')), false)
  assert.equal(core.isReopenable(r('permission')), false)
  assert.match(between('function ItemView', 'export function App'), /c\.isReopenable\(item\)/)
  assert.doesNotMatch(between('export function AiReview', '// ---- screens'), /Reopen/, 'AiReview leaves Reopen to the item view')
})

test('AiReview: Mark wrong is hidden on a paused item and on an item without a session; Looks right and Overrule rule stay', () => {
  fresh()
  for (const over of [{ type: 'paused' }, { sessionId: undefined }, { sessionId: '' }]) {
    const t = draw('AiReview', { item: aiItem(over, { seen: true }) })
    assert.equal(btn(t, /Mark wrong/), undefined, JSON.stringify(over))
    assert.ok(btn(t, /Looks right/) && btn(t, /Overrule rule/), JSON.stringify(over))
  }
})

// ---- 5. the AI handled banner is gone ---------------------------------------------------------------------------------------------------

test('there is no "AI handled N" banner: no component, no data-ai-handled button; the Resolved nav badge and the By AI tab carry the count', () => {
  assert.equal(views.AiHandledBanner, undefined)
  assert.equal(views.ResolvedByRow, undefined)
  assert.doesNotMatch(viewsSource, /AiHandledBanner|ai-handled|data-ai-handled|AI handled/)
})

// ---- 6. nothing of this is saved -----------------------------------------------------------------------------------------------------

test('the open sheet and the seen marks are kept in memory only: nothing about them reaches storage', async () => {
  fresh()
  stored.length = 0
  const it = aiItem({ id: 'mem-1', type: 'completed' })
  press(draw('AiReview', { item: it }), /Mark wrong/)
  await need('markAiSeen', api)(it)
  await tick()
  assert.equal(api.state.sheet.id, 'mem-1')
  for (const [k, v] of stored) {
    assert.doesNotMatch(k + ' ' + v, /sheet|mem-1/, 'storage write ' + k)
  }
})

test('AiReview source: the success path closes the sheet, and no inline-form state is left in the views', () => {
  assert.match(between('export function AiReview', '// ---- screens'), /set\(\{ sheet: null \}\)/)
  assert.doesNotMatch(viewsSource, /aiCorrection|aiOverrule|closeKey/)
})
