import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'

// Slice D: the phone's todo card for a follow-up (item.kind 'followup'), built with the desktop's own helpers (exports.shared of lib/client.js:
// todoLine, todoSelect, todoTarget, todoCardState, cardTitle, resolutionText), so the preselect rule and the sentences exist once.
//   todoCardModel(core, item, workspaces, pick?) for a follow-up adds:
//     kind 'followup' | 'todo', selectLabel ('Session' | 'Workspace'), needsWorkspaces (a follow-up never loads the workspaces),
//     startLabel ('Send', 'Retry' when failed), canStart (canAct and a session is selected); options are { id: sessionId, title }
//   todoConfirmBody(item, selected) -> { id, sessionId } for a follow-up, { id, workspaceId } otherwise
//   todoCancelBody(item)            -> { id }
// And lib/mobile/thread.js: a follow-up todo has NO conversation and no composer on the phone in any state (a phone may ask for a message to any session of
// any app, but it cannot read or post into it afterwards: hub/routing.js refuses thread and post of a sent follow-up to a phone); a done or paused item keeps its.
const root = join(dirname(fileURLToPath(import.meta.url)), '..')
function loadOverlay() {
  let registered
  const file = join(root, 'lib', 'client.js')
  const sandbox = { window: { __ModuleLoader__: { load: (r) => { registered = r } }, localStorage: { getItem: () => null, setItem() {} } }, console, setTimeout, clearTimeout, setInterval, clearInterval, fetch: () => new Promise(() => {}) }
  vm.runInNewContext(readFileSync(file, 'utf8'), sandbox, { filename: file })
  return registered.factory(() => ({ createElement: () => null, Fragment: Symbol('Fragment'), useState() {}, useEffect() {}, useRef() {}, useSyncExternalStore() {} }))
}
const core = loadOverlay().shared
const plain = (x) => JSON.parse(JSON.stringify(x)) // values built inside the overlay's vm context have another Array prototype
const model = () => import('../lib/mobile/model.js')
const card = async (item, pick, workspaces) => plain((await model()).todoCardModel(core, item, workspaces, pick))

const CANDIDATES = [{ sessionId: 's1', title: 'Login bug', workspaceTitle: 'Alpha' }, { sessionId: 's2', title: 'Docs' }]
const SUGGESTED = { sessionId: 's1', title: 'Login bug', workspaceTitle: 'Alpha', reason: 'title match' }
const fu = (over = {}) => ({ id: 'f-1', type: 'todo', kind: 'followup', text: 'Run the tests again', query: 'the login bug', state: 'awaiting-confirm', status: 'open', createdAt: 1, candidates: CANDIDATES, ...over })
const OPTIONS = [{ id: 's1', title: 'Login bug · Alpha' }, { id: 's2', title: 'Docs' }]

// ---- the card model, every state ------------------------------------------------------------------------------------------------------

test('awaiting confirmation with a suggestion: the suggestion line, the dropdown preselected on it, Send and Cancel', async () => {
  const m = await card(fu({ suggested: SUGGESTED }))
  assert.equal(m.kind, 'followup')
  assert.equal(m.text, 'Run the tests again')
  assert.equal(m.sparc, false)
  assert.equal(m.line, 'Session: Login bug (Alpha) — Model says: title match')
  assert.equal(m.failed, false)
  assert.equal(m.canAct, true)
  assert.equal(m.selected, 's1')
  assert.deepEqual(m.options, OPTIONS)
  assert.equal(m.placeholder, undefined)
  assert.equal(m.selectLabel, 'Session')
  assert.equal(m.startLabel, 'Send')
  assert.equal(m.canStart, true)
  assert.equal(m.needsWorkspaces, false)
})

test('the user pick beats the suggestion in the dropdown and in the line', async () => {
  const m = await card(fu({ suggested: SUGGESTED }), 's2')
  assert.equal(m.selected, 's2')
  assert.equal(m.line, 'Send to Docs')
  assert.equal(m.canStart, true)
})

test('a pick that is not among the candidates is ignored (the list changed under it): the suggestion stays selected', async () => {
  const m = await card(fu({ suggested: SUGGESTED }), 'gone')
  assert.equal(m.selected, 's1')
  assert.equal(m.line, 'Session: Login bug (Alpha) — Model says: title match')
})

test('the session the todo was sent to before (targetSessionId) beats the suggestion, like the desktop preselect', async () => {
  const m = await card(fu({ suggested: SUGGESTED, targetSessionId: 's2' }))
  assert.equal(m.selected, 's2')
})

test('no suggestion and no pick: a placeholder, the reason in the line, and Send stays off until a session is picked', async () => {
  const m = await card(fu({ suggestNote: 'the model found no clear fit' }))
  assert.equal(m.selected, '')
  assert.equal(m.placeholder, 'Pick a session…')
  assert.equal(m.line, 'Pick a session (no suggestion: the model found no clear fit)')
  assert.equal(m.canAct, true)
  assert.equal(m.canStart, false, 'disabled until a session is selected')
  assert.equal(m.startLabel, 'Send')
  assert.equal((await card(fu({ suggestNote: 'x' }), 's2')).canStart, true, 'a pick enables it')
  assert.equal((await card(fu())).line, 'Pick a session')
})

test('while the suggestion is still being looked for the card says so; Send needs a picked session', async () => {
  const waiting = await card(fu({ suggesting: true }))
  assert.equal(waiting.line, 'Finding the session…')
  assert.equal(waiting.canAct, true)
  assert.equal(waiting.canStart, false)
  assert.equal((await card(fu({ suggesting: true }), 's1')).canStart, true)
})

test('a failed follow-up shows the error as such and offers Retry with the session it was sent to selected', async () => {
  const m = await card(fu({ state: 'failed', error: 'boom', targetSessionId: 's2', sessionTitle: 'Docs', suggested: SUGGESTED }))
  assert.equal(m.line, 'Could not send: boom')
  assert.equal(m.failed, true)
  assert.equal(m.canAct, true)
  assert.equal(m.startLabel, 'Retry')
  assert.equal(m.selected, 's2')
  assert.equal(m.canStart, true)
})

test('starting says "Sending…" and is read-only text: no dropdown, no buttons', async () => {
  const m = await card(fu({ state: 'starting', targetSessionId: 's2', sessionTitle: 'Docs' }))
  assert.equal(m.line, 'Sending…')
  assert.equal(m.canAct, false)
  assert.equal(m.canStart, false)
  assert.equal(m.failed, false)
})

test('started says "Sent to <session title>", cancelled says nothing; both are read-only', async () => {
  const started = await card(fu({ state: 'started', status: 'resolved', sessionId: 's2', sessionTitle: 'Docs' }))
  assert.equal(started.line, 'Sent to Docs')
  assert.equal(started.canAct, false)
  assert.equal(started.canStart, false)
  const cancelled = await card(fu({ state: 'cancelled', status: 'resolved' }))
  assert.equal(cancelled.line, '')
  assert.equal(cancelled.canAct, false)
  assert.equal(cancelled.canStart, false)
})

test('a suggested session that is not among the candidates is still an option, so the preselect shows', async () => {
  const m = await card(fu({ candidates: [], suggested: SUGGESTED }))
  assert.equal(m.selected, 's1')
  assert.deepEqual(m.options, [{ id: 's1', title: 'Login bug · Alpha' }])
})

test('the candidates of an item that has none (an odd item) still give a model: no options, nothing selectable', async () => {
  const m = await card(fu({ candidates: undefined }))
  assert.deepEqual(m.options, [])
  assert.equal(m.canStart, false)
})

test('the card model never changes the item it was given', async () => {
  const item = fu({ suggested: { ...SUGGESTED } })
  const before = JSON.stringify(item)
  const m = (await model()).todoCardModel(core, item, undefined, 's2')
  m.options.push({ id: 'x', title: 'x' })
  assert.equal(JSON.stringify(item), before)
})

test('an ordinary todo still gets its workspace dropdown model: kind todo, Workspace, Start, workspaces needed', async () => {
  const WS = [{ id: 'w1', title: 'Alpha' }, { id: 'w2', title: 'Beta' }]
  const m = await card({ id: 't', type: 'todo', text: 'Fix it', sparc: true, state: 'awaiting-confirm', status: 'open', suggested: { workspaceId: 'w2', title: 'Beta', reason: 'named in the text' } }, undefined, WS)
  assert.equal(m.kind, 'todo')
  assert.equal(m.selectLabel, 'Workspace')
  assert.equal(m.startLabel, 'Start')
  assert.equal(m.selected, 'w2')
  assert.equal(m.needsWorkspaces, true)
  assert.equal(m.sparc, true)
  assert.equal((await card({ id: 't', type: 'todo', text: 'x', state: 'started', status: 'resolved' }, undefined, WS)).needsWorkspaces, false, 'a read-only card loads nothing')
})

// ---- what Send, Retry and Cancel post -------------------------------------------------------------------------------------------------

test('todoConfirmBody: a follow-up posts { id, sessionId }, an ordinary todo { id, workspaceId }', async () => {
  const { todoConfirmBody, todoCancelBody } = await model()
  assert.deepEqual(todoConfirmBody(fu(), 's2'), { id: 'f-1', sessionId: 's2' })
  assert.deepEqual(todoConfirmBody({ id: 't-1', type: 'todo', text: 'x' }, 'w1'), { id: 't-1', workspaceId: 'w1' })
  assert.deepEqual(todoCancelBody(fu()), { id: 'f-1' })
  assert.equal('workspaceId' in todoConfirmBody(fu(), 's2'), false)
  assert.equal('sessionId' in todoConfirmBody({ id: 't-1', type: 'todo' }, 'w1'), false)
})

test('Send, Retry and Cancel reach the hub through api.js act() with those bodies on /v1/todo-confirm and /v1/todo-cancel', async () => {
  globalThis.location = { pathname: '/review-queue/m/' }
  const store = new Map()
  globalThis.localStorage = { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => { store.set(k, String(v)) }, removeItem: (k) => { store.delete(k) } }
  const api = await import('../lib/mobile/api.js?followup-card')
  api.setCoreForTests(core)
  const calls = []
  globalThis.fetch = async (url, init = {}) => { calls.push([url, init.method, JSON.parse(init.body)]); return { ok: true, status: 200, headers: { get: () => null }, json: async () => ({ ok: true }) } }
  const { todoConfirmBody, todoCancelBody, todoCardModel } = await model()
  const item = fu({ suggested: SUGGESTED })
  const send = todoCardModel(core, item, undefined, 's2')
  assert.equal(await api.act('/v1/todo-confirm', todoConfirmBody(item, send.selected), item.id), true)
  const failed = fu({ state: 'failed', error: 'boom', targetSessionId: 's2' })
  assert.equal(await api.act('/v1/todo-confirm', todoConfirmBody(failed, todoCardModel(core, failed).selected), failed.id), true)
  assert.equal(await api.act('/v1/todo-cancel', todoCancelBody(item), item.id), true)
  assert.deepEqual(calls.map(([u, method, body]) => [u.replace(/^.*\/v1/, '/v1'), method, body]), [
    ['/v1/todo-confirm', 'POST', { id: 'f-1', sessionId: 's2' }],
    ['/v1/todo-confirm', 'POST', { id: 'f-1', sessionId: 's2' }],
    ['/v1/todo-cancel', 'POST', { id: 'f-1' }],
  ])
})

test('act() words a refused Send like the desktop: unknown-session, empty-query and no-session come from the shared core', async () => {
  const api = await import('../lib/mobile/api.js?followup-card')
  globalThis.fetch = async () => ({ ok: false, status: 409, headers: { get: () => null }, json: async () => ({ ok: false, error: 'unknown-session' }) })
  assert.equal(await api.act('/v1/todo-confirm', { id: 'f-9', sessionId: 'zz' }, 'f-9'), false)
  assert.equal(api.state.errors['f-9'], 'That session is not in the list any more. Pick another one.')
  globalThis.fetch = async () => ({ ok: false, status: 409, headers: { get: () => null }, json: async () => ({ ok: false, error: 'no-session' }) })
  await api.act('/v1/todo-confirm', { id: 'f-9' }, 'f-9')
  assert.equal(api.state.errors['f-9'], core.errorText(409, { error: 'no-session' }))
})

// ---- the card in views.js --------------------------------------------------------------------------------------------------------------

const views = readFileSync(join(root, 'lib', 'mobile', 'views.js'), 'utf8')
function body(name) {
  const start = views.search(new RegExp('(?:^|\\n)(?:export )?(?:async )?function ' + name + '\\b'))
  assert.notEqual(start, -1, name)
  const rest = views.slice(start + 1)
  const next = rest.search(/\n(?:export )?(?:async )?function \w+|\n\/\/ ---- /)
  return next === -1 ? rest : rest.slice(0, next)
}

test('the todo card posts through todoConfirmBody / todoCancelBody, labels the dropdown from the model and loads the workspaces only when it needs them', () => {
  const v = body('TodoBody')
  assert.match(views, /import\s*\{[^}]*\btodoConfirmBody\b[^}]*\}\s*from\s*['"]\.\/model\.js['"]/)
  assert.match(views, /import\s*\{[^}]*\btodoCancelBody\b[^}]*\}\s*from\s*['"]\.\/model\.js['"]/)
  assert.match(v, /act\(\s*['"]\/v1\/todo-confirm['"],\s*todoConfirmBody\(item,\s*m\.selected\)/)
  assert.match(v, /act\(\s*['"]\/v1\/todo-cancel['"],\s*todoCancelBody\(item\)/)
  assert.match(v, /aria-label=\$\{m\.selectLabel\}/)
  assert.match(v, /needsWorkspaces/)
  assert.doesNotMatch(v, /m\.canAct\s*&&\s*!state\.workspaces|if \(m\.canAct && !state\.workspaces\)/, 'no longer loads the workspaces for every todo')
  assert.match(v, /disabled=\$\{[^}]*!m\.canStart/, 'Send is disabled until a session is selected')
  assert.match(v, /m\.startLabel/)
  assert.match(v, /Cancel/)
})

test('the item view gives every todo, follow-up or not, the same card body; the phone still has no Open session', () => {
  const v = body('ItemView')
  assert.match(v, /item\.type === 'todo' \? TodoBody/)
  assert.doesNotMatch(views, /Open session/i)
  assert.doesNotMatch(views, /open-session/)
})

// ---- the thread guard: a follow-up has no conversation on the phone, sent or not ---------------------------------------------------------------

const thread = () => import('../lib/mobile/thread.js')
const started = (over = {}) => fu({ state: 'started', status: 'resolved', sessionId: 's2', sessionTitle: 'Docs', resolution: { kind: 'followed-up', by: 'card', sessionId: 's2' }, ...over })

test('a started follow-up (state started, sessionId set) has no conversation and no composer on the phone: it only says where it was sent', async () => {
  const { hasThread, canPost } = await thread()
  assert.equal(hasThread(started()), false)
  assert.equal(canPost(started()), false)
  assert.equal(hasThread(started({ status: 'open' })), false)
  assert.equal((await card(started())).line, 'Sent to Docs')
})

test('an unsent follow-up has no conversation and no composer either: awaiting confirmation, starting (even with a session id), failed, cancelled', async () => {
  const { hasThread, canPost } = await thread()
  for (const item of [fu(), fu({ suggested: SUGGESTED }), fu({ state: 'starting', targetSessionId: 's2', sessionId: 's2' }), fu({ state: 'failed', error: 'x', targetSessionId: 's2', sessionId: 's2' }), fu({ state: 'cancelled', status: 'resolved', sessionId: 's2' })]) {
    assert.equal(hasThread(item), false, item.state)
    assert.equal(canPost(item), false, item.state)
  }
})

test('a started ordinary todo has none either', async () => {
  const { hasThread, canPost } = await thread()
  const plain = { id: 't', type: 'todo', text: 'x', state: 'started', status: 'resolved', sessionId: 's9' }
  assert.equal(hasThread(plain), false)
  assert.equal(canPost(plain), false)
  assert.equal(hasThread({ ...plain, kind: 'other' }), false)
})

test('the other item types are unchanged: a done item and a paused item', async () => {
  const { hasThread, canPost } = await thread()
  assert.equal(hasThread({ type: 'completed', sessionId: 's1' }), true)
  assert.equal(canPost({ type: 'completed', sessionId: 's1' }), true)
  assert.equal(hasThread({ type: 'paused', sessionId: 's1' }), true)
  assert.equal(canPost({ type: 'paused', sessionId: 's1' }), false)
  assert.equal(hasThread({ type: 'question' }), false)
})

test('the thread refresh never runs for the screen of a follow-up, sent or not (the phone has no thread to refresh), but does for a done item', async () => {
  const { shouldPoll } = await thread()
  const base = { route: '/item/f-1', visible: true, paused: false }
  assert.equal(shouldPoll({ ...base, item: started() }), false)
  assert.equal(shouldPoll({ ...base, item: fu({ suggested: SUGGESTED }) }), false)
  assert.equal(shouldPoll({ ...base, item: { type: 'completed', sessionId: 's1' } }), true)
})

test('the resolved started follow-up reads "Sent to <title>" in the shared resolution text and heads its card "Follow up: <text>"', () => {
  assert.equal(core.resolutionText(started()), 'Sent to Docs')
  assert.equal(core.cardTitle(started()), 'Follow up: Run the tests again')
})

test('the item view opens the conversation of a resolved item by default (a follow-up has none: hasThread is false for it)', () => {
  const v = body('ItemView')
  assert.match(v, /const chat = hasThread\(item\)/)
  assert.match(v, /defaultOpen=\$\{!!resolved/)
  assert.match(v, /const writable = canPost\(item\)/)
})
