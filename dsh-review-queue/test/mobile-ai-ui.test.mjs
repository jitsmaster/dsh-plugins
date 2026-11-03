// Slice 4 of the AI triage plan (RED): the phone UI for items the AI resolved - the "Resolved by" chips, the AI badge, the detail block,
// the seen request, the review buttons and the "AI handled N" banner. It mirrors the desktop (test/client-ai-card.test.mjs, client-ai-filter-head).
//
// The phone views use hooks, so the new pieces are hook-free components exported from lib/mobile/views.js (read the store from api.js `state`
// directly; the screens that contain them re-render on every store change), and the seen request is a function exported from lib/mobile/api.js:
//   views.ResolvedByRow({ model })   the "Resolved by" chip row (model = listModel(...)); chips carry data-resolved-by, class `on`, aria-pressed
//   views.AiBadge({ item })          the AI badge (data-ai-badge=id); null for anything not AI-resolved
//   views.AiDetail({ item })         the detail block (data-ai-detail=id): quote, rule name, "attention <score>"; null for non-AI
//   views.AiReview({ item })         Looks right / Mark wrong… (+ correction box data-ai-correction=id and Send) / Overrule rule (+ observe / off); null for non-AI
//   views.AiHandledBanner({ count }) the banner (data-ai-handled): null when count is 0; its click sets filter.resolvedBy 'ai' and goes to #/resolved
//   api.markAiSeen(item)             POST /v1/triage-review { id, review: 'seen' } once per item (module-level set); a failed request can retry
// Wiring in views.js: ResolvedList renders ResolvedByRow and AiBadge, WaitingList renders AiHandledBanner (count = model.aiUnseen) and NOT the
// Resolved-by row, ItemView renders AiDetail and AiReview for a resolved item and calls markAiSeen.
// In-memory state keys added to api.js `state` (never saved to storage): aiCorrection { [id]: string } (the correction box is open while the key
// exists), aiOverrule { [id]: true } (the two rule choices are showing).
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
const fresh = () => { calls.length = 0; reply = () => ({ ok: true, status: 200, json: async () => ({ ok: true }) }); api.set({ busy: {}, errors: {}, aiCorrection: {}, aiOverrule: {}, filter: { type: 'all', query: '', resolvedBy: 'all' } }); globalThis.location.hash = '' }
const URL_REVIEW = /\/v1\/triage-review$/

test('the phone state starts with empty aiCorrection and aiOverrule maps', () => {
  assert.deepEqual({ ...api.state.aiCorrection }, {})
  assert.deepEqual({ ...api.state.aiOverrule }, {})
})

// ---- 1. the Resolved by chip row -----------------------------------------------------------------------------------------------------

test('ResolvedByRow: a "Resolved by" row with All / Me / AI, the active chip has class on and aria-pressed', () => {
  fresh()
  const model = listModel(core, snapOf([aiItem({}, { seen: true }), meItem()]), api.state.filter)
  const row = draw('ResolvedByRow', { model })
  assert.match(textOf(row), /Resolved by/)
  const chips = buttons(row)
  assert.deepEqual(chips.map((c) => c.props['data-resolved-by']), ['all', 'me', 'ai'])
  assert.deepEqual(chips.map(textOf), ['All', 'Me', 'AI'])
  for (const c of chips) {
    const on = c.props['data-resolved-by'] === 'all'
    assert.equal(c.props['aria-pressed'], on)
    assert.equal(classes(c).includes('on'), on)
  }
})

test('ResolvedByRow: clicking a chip sets filter.resolvedBy and keeps type and query', () => {
  fresh()
  api.set({ filter: { type: 'permission', query: 'ls', resolvedBy: 'all' } })
  const model = () => listModel(core, snapOf([aiItem({}, { seen: true })]), api.state.filter)
  const chip = (v) => must(buttons(draw('ResolvedByRow', { model: model() })).find((c) => c.props['data-resolved-by'] === v), 'chip ' + v)
  chip('ai').props.onClick()
  assert.deepEqual({ ...api.state.filter }, { type: 'permission', query: 'ls', resolvedBy: 'ai' })
  assert.equal(chip('ai').props['aria-pressed'], true)
  assert.equal(chip('all').props['aria-pressed'], false)
  chip('me').props.onClick()
  assert.equal(api.state.filter.resolvedBy, 'me')
})

test('ResolvedByRow: the AI chip reads "AI (N)" while N unseen AI items exist, plain "AI" otherwise; Me never has a count', () => {
  fresh()
  const labels = (resolved) => buttons(draw('ResolvedByRow', { model: listModel(core, snapOf(resolved), api.state.filter) })).map(textOf)
  assert.deepEqual(labels([aiItem({ id: 'u1' }), aiItem({ id: 'u2' }), aiItem({ id: 's' }, { seen: true }), aiItem({ id: 'r' }, { review: 'agreed' }), meItem()]), ['All', 'Me', 'AI (2)'])
  assert.deepEqual(labels([aiItem({}, { seen: true })]), ['All', 'Me', 'AI'])
})

test('the Resolved-by row belongs to the Resolved view only, in both the list and the waiting view', () => {
  assert.match(between('function ResolvedList', 'function NewTodoView'), /<\$\{ResolvedByRow\} model=\$\{model\} \/>/)
  assert.doesNotMatch(between('function WaitingList', 'function HeldList'), /ResolvedByRow/)
  assert.doesNotMatch(between('function HeldList', 'function ResolvedList'), /ResolvedByRow/)
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
  const list = between('function ResolvedList', 'function NewTodoView')
  assert.match(list, /<\$\{AiBadge\} item=\$\{i\} \/>/)
  assert.match(list, /resolutionText\(i\)/)
  assert.doesNotMatch(between('function ItemRow', 'function FilterBar'), /AiBadge/)
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

// ---- 4. review buttons ---------------------------------------------------------------------------------------------------------------

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

test('AiReview: Mark wrong opens a correction box; Send is disabled while the trimmed text is empty and posts the trimmed text', async () => {
  fresh()
  const it = aiItem({ type: 'completed' }, { seen: true })
  const tree = () => draw('AiReview', { item: it })
  const box = () => must(walk(tree()).filter(attr('data-ai-correction', 'a1'))[0], 'the correction box')
  assert.equal(walk(tree()).filter(attr('data-ai-correction', 'a1')).length, 0)
  assert.equal(btn(tree(), /Send/), undefined, 'no Send before the box is open')
  press(tree(), /Mark wrong/)
  assert.equal(api.state.aiCorrection.a1, '')
  const send = () => must(btn(tree(), /Send/), 'a Send button')
  assert.equal(send().props.disabled, true)
  box().props.onInput({ target: { value: '   ' } })
  assert.equal(send().props.disabled, true, 'blank text stays disabled')
  box().props.onInput({ target: { value: '  Use main instead  ' } })
  assert.ok(!send().props.disabled)
  send().props.onClick()
  await tick()
  assert.equal(calls.length, 1)
  assert.match(calls[0][0], URL_REVIEW)
  assert.deepEqual(calls[0][1], { id: 'a1', review: 'mark-wrong', text: 'Use main instead' })
  assert.equal(api.state.aiCorrection.a1, undefined, 'the box closes after a successful send')
})

test('AiReview: a failed send keeps the correction box and its text', async () => {
  fresh()
  const it = aiItem({ type: 'completed' }, { seen: true })
  api.set({ aiCorrection: { a1: 'Use main' } })
  reply = () => ({ ok: false, status: 500, json: async () => ({}) })
  press(draw('AiReview', { item: it }), /Send/)
  await tick()
  assert.equal(api.state.aiCorrection.a1, 'Use main')
})

test('AiReview: only a question or permission correction says the answer cannot be unsent, and only while the box is open', () => {
  fresh()
  for (const [type, unsent] of [['question', true], ['permission', true], ['completed', false]]) {
    const it = aiItem({ id: 'x-' + type, type }, { seen: true })
    assert.doesNotMatch(textOf(draw('AiReview', { item: it })), /cannot be unsent/, type + ' with the box closed')
    press(draw('AiReview', { item: it }), /Mark wrong/)
    assert.equal(/cannot be unsent/.test(textOf(draw('AiReview', { item: it }))), unsent, type)
  }
})

test('AiReview: Overrule rule offers observe and off, each posting overrule-rule with its mode', async () => {
  fresh()
  const it = aiItem({}, { seen: true })
  assert.equal(btn(draw('AiReview', { item: it }), /Set rule to observe/), undefined, 'the choices wait for a click')
  press(draw('AiReview', { item: it }), /Overrule rule/)
  assert.equal(api.state.aiOverrule.a1, true)
  press(draw('AiReview', { item: it }), /Set rule to observe/)
  await tick()
  assert.equal(api.state.aiOverrule.a1, undefined, 'a successful review closes the choices')
  press(draw('AiReview', { item: it }), /Overrule rule/)
  press(draw('AiReview', { item: it }), /Set rule to off/)
  await tick()
  assert.deepEqual(calls.map((c) => c[1]), [{ id: 'a1', review: 'overrule-rule', mode: 'observe' }, { id: 'a1', review: 'overrule-rule', mode: 'off' }])
  for (const c of calls) assert.match(c[0], URL_REVIEW)
})

test('AiReview: while busy every button is disabled, including Send and the rule choices', () => {
  fresh()
  const it = aiItem({ type: 'completed' }, { seen: true })
  api.set({ busy: { a1: true }, aiCorrection: { a1: 'text' }, aiOverrule: { a1: true } })
  const tree = draw('AiReview', { item: it })
  for (const re of [/Looks right/, /Mark wrong/, /Overrule rule/, /Send/, /Set rule to observe/, /Set rule to off/]) assert.equal(must(btn(tree, re), 'button ' + re).props.disabled, true, String(re))
})

test('Reopen stays in the item view for an AI-resolved done or paused item, never for a question or permission', () => {
  const r = (type) => ({ type, status: 'resolved', resolution: { kind: 'ai-resolved' } })
  assert.equal(core.isReopenable(r('completed')), true)
  assert.equal(core.isReopenable(r('paused')), true)
  assert.equal(core.isReopenable(r('question')), false)
  assert.equal(core.isReopenable(r('permission')), false)
  assert.match(between('function ItemView', 'export function App'), /c\.isReopenable\(item\)/)
  assert.doesNotMatch(between('function AiReview', 'function AiHandledBanner'), /Reopen/, 'AiReview leaves Reopen to the item view')
})

// ---- 5. the AI handled banner --------------------------------------------------------------------------------------------------------

test('AiHandledBanner: nothing at zero, "AI handled N" with the count otherwise', () => {
  fresh()
  assert.equal(draw('AiHandledBanner', { count: 0 }), null)
  const b = must(walk(draw('AiHandledBanner', { count: 3 })).filter((n) => n.props && 'data-ai-handled' in n.props)[0], 'the banner')
  assert.match(textOf(b), /AI handled 3/)
})

test('AiHandledBanner: tapping it sets filter.resolvedBy to ai (resetting type and query) and opens the Resolved view', () => {
  fresh()
  api.set({ filter: { type: 'permission', query: 'ls', resolvedBy: 'all' } })
  const tree = draw('AiHandledBanner', { count: 2 })
  const target = must(walk(tree).find((n) => n.props && typeof n.props.onClick === 'function'), 'a tappable element')
  target.props.onClick()
  assert.deepEqual({ ...api.state.filter }, { type: 'all', query: '', resolvedBy: 'ai' })
  assert.match(globalThis.location.hash, /^#?\/resolved$/)
})

test('the waiting list shows the banner from the unseen count and the Resolved list does not', () => {
  assert.match(between('function WaitingList', 'function HeldList'), /<\$\{AiHandledBanner\} count=\$\{model\.aiUnseen\} \/>/)
  assert.doesNotMatch(between('function ResolvedList', 'function NewTodoView'), /AiHandledBanner/)
})

// ---- 6. nothing of this is saved -----------------------------------------------------------------------------------------------------

test('the correction text, the rule choices and the seen marks are kept in memory only: nothing about them reaches storage', async () => {
  fresh()
  stored.length = 0
  const it = aiItem({ id: 'mem-1', type: 'completed' })
  press(draw('AiReview', { item: it }), /Mark wrong/)
  must(walk(draw('AiReview', { item: it })).filter(attr('data-ai-correction', 'mem-1'))[0], 'the box').props.onInput({ target: { value: 'secret correction' } })
  press(draw('AiReview', { item: it }), /Overrule rule/)
  await need('markAiSeen', api)(it)
  await tick()
  assert.equal(api.state.aiCorrection['mem-1'], 'secret correction')
  for (const [k, v] of stored) {
    assert.doesNotMatch(k + ' ' + v, /secret correction|aiCorrection|aiOverrule|mem-1/, 'storage write ' + k)
  }
})

test('AiReview: Mark wrong is hidden on a paused item and on an item without a session; Looks right and Overrule rule stay', () => {
  fresh()
  for (const over of [{ type: 'paused' }, { sessionId: undefined }, { sessionId: '' }]) {
    const t = draw('AiReview', { item: aiItem(over, { seen: true }) })
    assert.equal(btn(t, /Mark wrong/), undefined, JSON.stringify(over))
    assert.ok(btn(t, /Looks right/) && btn(t, /Overrule rule/), JSON.stringify(over))
  }
})


// ---- RED: a successful review closes aiOverrule too ------------------------------------------------------------------------------------

test('AiReview: a successful review (Looks right, Overrule rule, Mark wrong + Send) closes aiOverrule for the item; a failure keeps it open', async () => {
  for (const how of ['agreed', 'overrule', 'mark-wrong']) {
    for (const ok of [true, false]) {
      fresh()
      reply = () => ({ ok, status: ok ? 200 : 500, json: async () => ({ ok }) })
      const it = aiItem({ type: 'completed' }, { seen: true })
      api.set({ aiOverrule: { a1: true, other: true }, aiCorrection: how === 'mark-wrong' ? { a1: 'Use main' } : {} })
      if (how === 'agreed') press(draw('AiReview', { item: it }), /Looks right/)
      if (how === 'overrule') press(draw('AiReview', { item: it }), /Set rule to observe/)
      if (how === 'mark-wrong') press(draw('AiReview', { item: it }), /Send/)
      await tick()
      assert.equal('a1' in api.state.aiOverrule, !ok, how + (ok ? ': closed on success' : ': kept on failure'))
      assert.equal(api.state.aiOverrule.other, true, how + ': another item keeps its choices')
    }
  }
})

test('AiReview source: the success path closes aiOverrule through closeKey', () => {
  assert.match(between('export function AiReview', 'export function AiHandledBanner'), /closeKey\(\s*'aiOverrule'\s*,\s*id\s*\)/)
})

test('AiReview: a successful review also closes aiCorrection for the item (Looks right, Overrule rule, Mark wrong + Send); a failure keeps both', async () => {
  for (const how of ['agreed', 'overrule', 'mark-wrong']) {
    for (const ok of [true, false]) {
      fresh()
      reply = () => ({ ok, status: ok ? 200 : 500, json: async () => ({ ok }) })
      const it = aiItem({ type: 'completed' }, { seen: true })
      api.set({ aiOverrule: { a1: true, other: true }, aiCorrection: { a1: 'Use main', other: 'keep me' } })
      if (how === 'agreed') press(draw('AiReview', { item: it }), /Looks right/)
      if (how === 'overrule') press(draw('AiReview', { item: it }), /Set rule to observe/)
      if (how === 'mark-wrong') press(draw('AiReview', { item: it }), /Send/)
      await tick()
      assert.equal('a1' in api.state.aiOverrule, !ok, how + ': aiOverrule[a1] ' + (ok ? 'closed' : 'kept'))
      assert.equal('a1' in api.state.aiCorrection, !ok, how + ': aiCorrection[a1] ' + (ok ? 'closed' : 'kept'))
      if (!ok) assert.equal(api.state.aiCorrection.a1, 'Use main', how + ': the open box keeps its text')
      assert.equal(api.state.aiOverrule.other, true, how + ': another item keeps its choices')
      assert.equal(api.state.aiCorrection.other, 'keep me', how + ': another item keeps its correction text')
    }
  }
})

test('AiHandledBanner: tapping it also resets type to all and query to empty', () => {
  fresh()
  api.set({ filter: { type: 'permission', query: 'ls', resolvedBy: 'me' } })
  const tree = draw('AiHandledBanner', { count: 2 })
  must(walk(tree).find((n) => n.props && typeof n.props.onClick === 'function'), 'a tappable element').props.onClick()
  assert.deepEqual({ ...api.state.filter }, { type: 'all', query: '', resolvedBy: 'ai' })
})
