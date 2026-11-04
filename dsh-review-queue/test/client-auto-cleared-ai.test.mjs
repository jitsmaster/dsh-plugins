// RED: done cards the old auto-clear silently hid (resolution { kind: 'no-action', by: 'auto' }) read as AI-handled on the desktop overlay and the phone:
//  1. they carry the AI badge (data-ai-badge=id, plus data-ai-auto=id and a title saying it was cleared automatically, so it is told apart from a triage decision)
//  2. they match the Resolved-by "AI" filter and are left out by "Me"
//  3. they are NOT in aiUnseenCount (the "AI handled N" count is about kind 'ai-resolved' only)
//  4. no AI detail panel, no review buttons and no "seen" request (there is no quote/rule/score to review); Reopen keeps working
//  5. a manually hidden done card (kind 'no-action' with another `by`, or none) is unchanged: no badge, in "Me"
// Shared helpers (exports.shared): isAutoCleared(it) and isAiHandled(it) = isAiResolved(it) || isAutoCleared(it).
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadClient, el, findAll, textOf, tick } from './client-todo-helpers.mjs'

// ---- phone environment (same stubs as mobile-ai-ui.test.mjs) ----
const noop = () => {}
globalThis.location = { pathname: '/m/', hash: '', origin: 'http://x', href: 'http://x/m/' }
globalThis.window = globalThis
globalThis.document = { addEventListener: noop, removeEventListener: noop, hidden: false, createElement: () => ({}), head: { append: noop } }
globalThis.addEventListener = noop
globalThis.removeEventListener = noop
globalThis.localStorage = { getItem: () => null, setItem: noop, removeItem: noop }
const fetchCalls = []
globalThis.fetch = async (url, init) => { fetchCalls.push([String(url), init && init.body ? JSON.parse(init.body) : undefined]); return { ok: true, status: 200, json: async () => ({ ok: true }) } }

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const desktop = loadClient({ fetchImpl: async (url, init) => { fetchCalls.push([String(url), init && init.body ? JSON.parse(init.body) : undefined]); return { ok: true, status: 200, json: async () => ({ ok: true }) } }, react: { createElement: el } })
const S = desktop.mod.shared
const T = desktop.T
T.state.snap = { snapshotId: 'e:1', open: [], resolved: [] }
const api = await import('../lib/mobile/api.js')
api.setCoreForTests(S)
const views = await import('../lib/mobile/views.js')
const { listModel } = await import('../lib/mobile/model.js')
void root

// ---- items ----
const base = (id, resolution, over = {}) => ({ id, sessionId: 's1', type: 'completed', status: 'resolved', title: 'Done ' + id, createdAt: 1, resolvedAt: 2, resolution, ...over })
const aiRes = (id, over = {}) => base(id, { kind: 'ai-resolved', by: 'ai', action: 'cleared', ruleId: 'r1', quote: 'all good', score: 9, ...over })
const auto = (id = 'auto1') => base(id, { kind: 'no-action', by: 'auto' })
const hiddenByCard = (id = 'hid1') => base(id, { kind: 'no-action', by: 'card' })
const hiddenNoBy = (id = 'hid2') => base(id, { kind: 'no-action' })
const reviewed = (id = 'rev1') => base(id, { kind: 'reviewed', by: 'card' })
const answered = (id = 'ans1') => base(id, { kind: 'answered', by: 'auto' }, { type: 'question' })

// ---- helpers: desktop tree ----
const attr = (name, id) => (n) => n.props && n.props[name] === id
const buttons = (tree) => findAll(tree, (n) => n.type === 'button')
const btn = (tree, re) => buttons(tree).find((b) => re.test(textOf(b)))
const header = (tree) => findAll(tree, (n) => typeof n.props.className === 'string' && n.props.className.split(' ').includes('rq-card-h'))[0]
const card = (it) => T.ResolvedCard({ it })
const must = (x, what) => { assert.ok(x, 'missing: ' + what); return x }
const reviewBtns = [/Looks right/, /Mark wrong/, /Overrule rule/]

// ---- helpers: phone tree ----
function expand(n) {
  if (Array.isArray(n)) return n.map(expand)
  if (!n || typeof n !== 'object') return n
  if (typeof n.type === 'function') return expand(n.type(n.props))
  const kids = n.props && n.props.children
  return { type: n.type, props: n.props, children: [].concat(kids === undefined ? [] : kids).flat(Infinity).filter((c) => c !== null && c !== undefined && c !== false).map(expand) }
}
const walk = (n, out = []) => { if (Array.isArray(n)) n.forEach((c) => walk(c, out)); else if (n && typeof n === 'object') { out.push(n); n.children.forEach((c) => walk(c, out)) } return out }
const ptext = (n) => (Array.isArray(n) ? n.map(ptext).join('') : typeof n === 'string' ? n : n && typeof n === 'object' ? n.children.map(ptext).join('') : '')
const draw = (name, props) => expand(views[name](props))
const phoneBadge = (it) => walk(draw('AiBadge', { item: it })).filter(attr('data-ai-badge', it.id))[0]
const f = (resolvedBy) => ({ type: 'all', query: '', resolvedBy })
const snapOf = (resolved) => ({ snapshotId: 'e:1', open: [], resolved })
const idsOf = (list) => list.map((i) => i.id)

// ======================= helpers (shared) =======================

test('shared exports isAutoCleared and isAiHandled', () => {
  assert.equal(typeof S.isAutoCleared, 'function', 'isAutoCleared in shared')
  assert.equal(typeof S.isAiHandled, 'function', 'isAiHandled in shared')
})

test('isAutoCleared is true only for a resolved no-action item cleared by "auto"', () => {
  assert.equal(S.isAutoCleared?.(auto()), true)
  for (const it of [hiddenByCard(), hiddenNoBy(), aiRes('x'), reviewed(), answered(), base('o', { kind: 'no-action', by: 'auto' }, { status: 'open' }), { id: 'z', status: 'resolved' }, null, undefined]) {
    assert.equal(S.isAutoCleared?.(it), false, JSON.stringify(it))
  }
})

test('isAiHandled covers AI-resolved and auto-cleared items, nothing else', () => {
  assert.equal(S.isAiHandled?.(aiRes('x')), true)
  assert.equal(S.isAiHandled?.(auto()), true)
  for (const it of [hiddenByCard(), hiddenNoBy(), reviewed(), answered(), null, undefined]) assert.equal(S.isAiHandled?.(it), false, JSON.stringify(it))
})

// ======================= 2 + 5. filter, desktop & phone model =======================

test('filter table: which resolutions each Resolved-by filter keeps', () => {
  const items = [aiRes('ai1', { seen: true }), auto('auto1'), hiddenByCard('card1'), hiddenNoBy('nob1'), reviewed('rev1'), answered('ans1')]
  const expected = {
    ai: ['ai1', 'auto1'],
    me: ['card1', 'nob1', 'rev1', 'ans1'],
    all: ['ai1', 'auto1', 'card1', 'nob1', 'rev1', 'ans1'],
  }
  for (const [by, ids] of Object.entries(expected)) {
    assert.deepEqual(idsOf(S.filterItems(items, f(by))), ids, 'desktop/shared filter ' + by)
    assert.deepEqual(idsOf(listModel(S, snapOf(items), f(by)).resolved), ids, 'phone list model filter ' + by)
  }
})

test('aiUnseenCount table: only unseen, unreviewed kind "ai-resolved" items count; auto-cleared and the rest never do', () => {
  const cases = [
    [[auto()], 0],
    [[auto('a'), auto('b')], 0],
    [[aiRes('u1')], 1],
    [[aiRes('u1'), auto('a'), hiddenByCard(), reviewed(), answered()], 1],
    [[aiRes('s', { seen: true }), aiRes('r', { review: 'agreed' }), auto()], 0],
  ]
  for (const [list, n] of cases) {
    assert.equal(S.aiUnseenCount(list), n, JSON.stringify(idsOf(list)))
    assert.equal(listModel(S, snapOf(list), f('all')).aiUnseen, n, 'phone model ' + JSON.stringify(idsOf(list)))
  }
})

test('the filter result and the AI count agree: auto-cleared items are listed under AI but not counted', () => {
  const items = [aiRes('u1'), auto('a'), auto('b')]
  assert.deepEqual(idsOf(S.filterItems(items, f('ai'))), ['u1', 'a', 'b'])
  assert.equal(S.aiUnseenCount(items), 1)
})

test('the phone "AI" chip shows the count of AI decisions only, not of auto-cleared items', () => {
  const labels = (list) => walk(draw('ResolvedByRow', { model: listModel(S, snapOf(list), f('all')) })).filter((n) => n.type === 'button').map(ptext)
  assert.deepEqual(labels([aiRes('u1'), auto('a'), auto('b')]), ['All', 'Me', 'AI (1)'])
  assert.deepEqual(labels([auto('a'), auto('b')]), ['All', 'Me', 'AI'])
})

// ======================= 1 + 5. badge, desktop card =======================

test('desktop: an auto-cleared card shows the AI badge, marked as automatic with its own title', () => {
  const it = auto()
  const badge = must(findAll(card(it), attr('data-ai-badge', it.id))[0], 'AI badge on an auto-cleared card')
  assert.match(textOf(badge), /AI/)
  assert.equal(badge.props['data-ai-auto'], it.id, 'tells it apart from an AI decision')
  assert.match(String(badge.props.title), /cleared automatically/i)
})

test('desktop: the badge of a real AI decision is not marked as automatic', () => {
  const it = aiRes('a1', { seen: true })
  const badge = must(findAll(card(it), attr('data-ai-badge', 'a1'))[0], 'AI badge')
  assert.equal(badge.props['data-ai-auto'], undefined)
  assert.doesNotMatch(String(badge.props.title || ''), /automatically/i)
})

test('desktop: a manually hidden done card (by card, or no by) gets no AI badge and keeps its hidden text', () => {
  for (const it of [hiddenByCard(), hiddenNoBy()]) {
    const tree = card(it)
    assert.equal(findAll(tree, (n) => n.props && ('data-ai-badge' in n.props || 'data-ai-auto' in n.props)).length, 0, JSON.stringify(it.resolution))
    assert.match(textOf(tree), /^.*Hidden: nothing for you to do/s)
  }
})

// ======================= 4. no detail / review / seen on desktop =======================

test('desktop: opening an auto-cleared card shows no AI detail or review buttons, and it still offers Reopen', () => {
  const it = auto()
  T.state.aiOpen = { [it.id]: true }
  const tree = card(it)
  assert.ok(findAll(tree, attr('data-ai-badge', it.id)).length === 1, 'badge present (AI-handled)')
  assert.equal(findAll(tree, (n) => n.props && ('data-ai-detail' in n.props || 'data-ai-correction' in n.props)).length, 0, 'no detail panel')
  for (const re of reviewBtns) assert.equal(btn(tree, re), undefined, String(re))
  assert.ok(btn(tree, /Reopen/), 'Reopen stays')
})

test('desktop: clicking an auto-cleared card header does not toggle an AI panel or post a seen request', async () => {
  const it = auto('auto-click')
  fetchCalls.length = 0
  T.state.aiOpen = {}
  const h = must(header(card(it)), 'card header')
  assert.notEqual(h.props.title, 'Show details')
  if (typeof h.props.onClick === 'function') h.props.onClick({ target: { closest: () => null } })
  await tick()
  assert.equal(T.state.aiOpen[it.id], undefined)
  assert.deepEqual(fetchCalls.filter(([u]) => /triage-review/.test(u)), [])
  assert.ok(findAll(card(it), attr('data-ai-badge', it.id)).length === 1, 'still badged as AI-handled')
})

test('desktop: Reopen on an auto-cleared card posts /v1/reopen', async () => {
  const it = auto('auto-reopen')
  fetchCalls.length = 0
  must(btn(card(it), /Reopen/), 'Reopen button').props.onClick()
  await tick()
  assert.deepEqual(fetchCalls.map(([u, b]) => [u.replace(/^.*(?=\/v1\/)/, ''), b]), [['/v1/reopen', { id: 'auto-reopen' }]])
  assert.ok(findAll(card(it), attr('data-ai-badge', it.id)).length === 1, 'badge present')
})

// ======================= 1 + 5. badge, phone =======================

test('phone: an auto-cleared row gets the AI badge, marked as automatic with its own title', () => {
  const it = auto()
  const badge = must(phoneBadge(it), 'AI badge on an auto-cleared row')
  assert.match(ptext(badge), /AI/)
  assert.equal(badge.props['data-ai-auto'], it.id)
  assert.match(String(badge.props.title), /cleared automatically/i)
})

test('phone: a real AI decision keeps its plain badge; a manually hidden done card gets none', () => {
  const real = must(phoneBadge(aiRes('a1', { seen: true })), 'AI badge')
  assert.equal(real.props['data-ai-auto'], undefined)
  for (const it of [hiddenByCard(), hiddenNoBy(), reviewed(), answered()]) assert.equal(draw('AiBadge', { item: it }), null, JSON.stringify(it.resolution))
})

// ======================= 4. no detail / review / seen on phone =======================

test('phone: no AI detail or review block for an auto-cleared item, and the AI-handled badge is the only AI mark', () => {
  const it = auto()
  assert.ok(phoneBadge(it), 'AI badge present')
  assert.equal(draw('AiDetail', { item: it }), null)
  assert.equal(draw('AiReview', { item: it }), null)
})

test('phone: viewing an auto-cleared item sends no "seen" request', async () => {
  fetchCalls.length = 0
  assert.equal(await api.markAiSeen(auto('auto-seen')), false)
  await tick()
  assert.deepEqual(fetchCalls, [])
  assert.ok(phoneBadge(auto('auto-seen')), 'badged as AI-handled')
})

test('phone: the Resolved list row wiring still draws the badge through AiBadge', () => {
  const src = readFileSync(join(root, 'lib', 'mobile', 'views.js'), 'utf8')
  const list = src.slice(src.indexOf('function ResolvedList'), src.indexOf('function NewTodoView'))
  assert.match(list, /<\$\{AiBadge\} item=\$\{i\} \/>/)
})
