import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

// Error wording for an old server, and "Open session" on resolved cards. Kept apart from client.test.mjs.
const file = join(dirname(fileURLToPath(import.meta.url)), '..', 'lib', 'client.js')
const source = readFileSync(file, 'utf8')

function load({ stored = {}, fetchImpl } = {}) {
  let registered
  const store = { ...stored }
  const sandbox = {
    window: { __ModuleLoader__: { load: (r) => { registered = r } }, localStorage: { getItem: (k) => store[k] ?? null, setItem: (k, v) => { store[k] = v } } },
    console, setTimeout, clearTimeout, setInterval, clearInterval,
    fetch: fetchImpl ?? (() => new Promise(() => {})),
  }
  vm.runInNewContext(source, sandbox, { filename: file })
  const stubReact = { createElement: () => null, Fragment: Symbol('Fragment'), useState() {}, useEffect() {}, useRef() {}, useSyncExternalStore() {} }
  const mod = registered.factory(() => stubReact)
  return { mod, T: mod.__test }
}
const OLD = 'The Coding Boss Review Queue server is older than this page and does not know this action. Restart DSH.'

test('errorText: unknown-action, or any HTTP 404, means the server is older than this page', () => {
  const { T } = load()
  assert.equal(T.errorText(404, { error: 'unknown-action' }), OLD)
  assert.equal(T.errorText(404, { error: 'not-found' }), OLD, 'an old server answers 404 not-found for a route it lacks')
  assert.equal(T.errorText(404, {}), OLD)
  assert.equal(T.errorText(404, undefined), OLD)
  assert.equal(T.errorText(409, { error: 'unknown-action' }), OLD)
})

test('errorText: every other mapping is unchanged', () => {
  const { T } = load()
  assert.equal(T.errorText(409, { error: 'not-found' }), 'That item no longer exists.')
  assert.equal(T.errorText(409, { error: 'not-open' }), 'That item is no longer waiting.')
  assert.equal(T.errorText(400, { error: 'empty' }), 'Type something first.')
  assert.equal(T.errorText(409, { error: 'muted' }), 'Voice is muted. Turn it back on in the TTS settings first.')
  assert.equal(T.errorText(500, { error: 'internal' }), 'Could not do that (internal).')
  assert.equal(T.errorText(502, {}), 'Could not do that (HTTP 502).')
  assert.equal(T.errorText(502, undefined), 'Could not do that (HTTP 502).')
})

test('act() (play button and the r key) shows the old-server text on 404 not-found and the item text on 409', async () => {
  let status = 404, body = { error: 'not-found' }
  const { T } = load({ fetchImpl: async () => ({ ok: false, status, json: async () => body }) })
  assert.equal(await T.act('/v1/read', { id: 'a' }, 'a'), false)
  assert.equal(T.state.errors.a, OLD)
  status = 409; body = { ok: false, error: 'not-found' }
  assert.equal(await T.act('/v1/read', { id: 'a' }, 'a'), false)
  assert.equal(T.state.errors.a, 'That item no longer exists.')
})

test('the r key reads through act(), so it gets the same error text', () => {
  assert.match(source, /action === "read"\)[^\n]*act\("\/v1\/read"/)
  assert.ok(!/ERRORS\[j\.error\]/.test(source), 'act() must not map errors on its own any more')
})

test('resolvedOpenAction: open only when the host can and the item has a session', () => {
  const { T } = load()
  assert.equal(T.resolvedOpenAction({ sessionId: 's1', resolution: { kind: 'reviewed' } }, true), 'open')
  assert.equal(T.resolvedOpenAction({ sessionId: 's1', resolution: { kind: 'session-ended' } }, true), 'open', 'session-ended still shows the control')
  assert.equal(T.resolvedOpenAction({ sessionId: 's1' }, false), 'none')
  assert.equal(T.resolvedOpenAction({}, true), 'none')
  assert.equal(T.resolvedOpenAction({ sessionId: '' }, true), 'none')
  assert.equal(T.resolvedOpenAction(undefined, true), 'none')
})

test('isButtonClick: clicks on buttons, links and form controls are not heading clicks', () => {
  const { T } = load()
  const el = (matches) => ({ closest: (sel) => (matches ? { matched: sel } : null) })
  assert.equal(T.isButtonClick(el(true)), true)
  assert.equal(T.isButtonClick(el(false)), false)
  assert.equal(T.isButtonClick(null), false)
  assert.equal(T.isButtonClick({}), false)
  let asked
  T.isButtonClick({ closest: (sel) => { asked = sel; return null } })
  for (const tag of ['button', 'a', 'input', 'textarea', 'select', 'summary']) assert.ok(asked.split(',').map((s) => s.trim()).includes(tag), tag)
})

function withHost(openImpl) {
  const { T, mod } = load()
  const calls = []
  mod.apply({ uiWorkspace: { openSession: (id) => { calls.push(id); return openImpl(id) } }, effect: () => {}, slots: {} })
  return { T, calls }
}

test('openSession closes the overlay on success', () => {
  const { T, calls } = withHost(() => {})
  T.set({ overlay: true })
  T.openSession({ id: 'r1', sessionId: 's9' })
  assert.deepEqual(calls, ['s9'])
  assert.equal(T.state.overlay, false)
  assert.equal(T.state.errors.r1, undefined)
})

test('openSession that throws keeps the overlay open and shows an error on the card', () => {
  const { T } = withHost(() => { throw new Error('gone') })
  T.set({ overlay: true })
  T.openSession({ id: 'r1', sessionId: 's9' })
  assert.equal(T.state.overlay, true)
  assert.equal(T.state.errors.r1, 'That session no longer exists.')
})

test('openSession that rejects keeps the overlay open and shows an error on the card', async () => {
  const { T } = withHost(() => Promise.reject(new Error('gone')))
  T.set({ overlay: true })
  T.openSession({ id: 'r1', sessionId: 's9' })
  await new Promise((r) => setTimeout(r, 0))
  assert.equal(T.state.overlay, true)
  assert.equal(T.state.errors.r1, 'That session no longer exists.')
})

test('ResolvedCard source has the Open session control and a heading click that opens it', () => {
  const start = source.indexOf('function ResolvedCard')
  const end = source.indexOf('function ResolvedList')
  assert.ok(start > 0 && end > start)
  const card = source.slice(start, end)
  assert.match(card, /Open session ↗/)
  assert.match(card, /resolvedOpenAction\(/)
  assert.match(card, /isButtonClick\(/)
  assert.match(card, /openSession\(it\)/)
  assert.match(card, /title: canOpen \? "Open session"/)
  assert.match(card, /cursor: canOpen \? "pointer"/)
})

test('a detached open question carries a note that the answer goes to the session; other cards do not', () => {
  const { T, mod } = load()
  const note = T.detachedNote({ type: 'question', status: 'open', detached: true, payload: { questions: [] } })
  assert.match(note, /live request ended/)
  assert.match(note, /sent to the session/)
  assert.equal(T.detachedNote({ type: 'question', status: 'open', payload: { questions: [] } }), undefined)
  assert.equal(T.detachedNote({ type: 'completed', detached: true }), undefined)
  assert.equal(mod.shared.detachedNote({ type: 'question', detached: true }), note, 'the phone page uses the same helper')
})

test('a refused answer to a session that is gone says the answer cannot be delivered', () => {
  const { T } = load()
  assert.match(T.errorText(409, { error: 'no-session' }), /session is not running any more/)
  assert.doesNotMatch(T.errorText(409, { error: 'no-session' }), /late answer/)
})
