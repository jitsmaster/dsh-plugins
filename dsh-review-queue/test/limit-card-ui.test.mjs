import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadClient, okJson, tick, el, findAll, textOf } from './client-todo-helpers.mjs'
import { spokenFor, titleFor } from '../speech.js'

// The pinned "Session limit reached" card (Task 5): desktop body per state, phone status only, one spoken line.
const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const pin = (state = 'idle', note = '', over = {}) => ({ id: 'p1', type: 'paused', status: 'open', sessionId: '', position: 1, createdAt: 1, payload: { kinds: ['limit-signin'], count: 3, state, note }, ...over })

/** A React stub whose useState keeps cells by call order, so a test can type into an input and render again. */
function mount(item, { fetchImpl } = {}) {
  const cells = []
  const setCalls = []
  let idx = 0
  const react = {
    createElement: el, Fragment: Symbol('Fragment'), useEffect() {}, useRef: () => ({ current: null }), useSyncExternalStore: (_s, get) => get(),
    useState: (v) => { const i = idx++; if (!(i in cells)) cells[i] = v; return [cells[i], (n) => { const val = typeof n === 'function' ? n(cells[i]) : n; setCalls.push([i, val]); cells[i] = val }] },
  }
  const calls = []
  const f = fetchImpl ?? (async (url, opts) => { calls.push([String(url).replace(/^.*(\/v1\/)/, '$1'), JSON.parse(opts.body)]); return okJson({ ok: true }) })
  const c = loadClient({ react, fetchImpl: f })
  const expand = (n) => (Array.isArray(n) ? n.map(expand) : !n || typeof n !== 'object' ? n : typeof n.type === 'function' ? expand(n.type({ ...n.props, children: n.children })) : { ...n, children: (n.children || []).map(expand) })
  const render = () => { idx = 0; return expand(el(c.T.LimitSigninBody, { item, full: true })) }
  const buttons = (tree) => findAll(tree, (n) => n.type === 'button')
  const button = (tree, label) => buttons(tree).find((b) => textOf(b) === label)
  const inputs = (tree) => findAll(tree, (n) => n.type === 'input')
  return { ...c, calls, render, buttons, button, inputs, setCalls, labels: (tree) => buttons(tree).map(textOf), expand }
}

test('limit card UI: idle and awaiting-email ask for an email with Sign in and Not now', () => {
  for (const state of ['idle', 'awaiting-email']) {
    const m = mount(pin(state))
    const tree = m.render()
    assert.match(textOf(tree), /Claude session limit reached\. 3 sessions stopped\. Sign in with a different account\?/)
    assert.equal(m.inputs(tree).length, 1)
    assert.deepEqual(m.labels(tree), ['Sign in', 'Not now'])
    assert.equal(m.inputs(tree)[0].props.value, '')
  }
})

test('limit card UI: Sign in posts the typed email to limit-signin-start; Not now posts paused-dismiss', async () => {
  const m = mount(pin('idle'))
  m.inputs(m.render())[0].props.onChange({ target: { value: ' me@x.co ' } })
  await m.button(m.render(), 'Sign in').props.onClick()
  assert.deepEqual(m.calls, [['/v1/limit-signin-start', { email: 'me@x.co' }]])
  await m.button(m.render(), 'Not now').props.onClick()
  assert.deepEqual(m.calls[1], ['/v1/paused-dismiss', { id: 'p1' }])
})

test('limit card UI: Sign in with an empty email posts nothing', async () => {
  const m = mount(pin('idle'))
  await m.button(m.render(), 'Sign in').props.onClick()
  assert.deepEqual(m.calls, [])
})

test('limit card UI: opening and verifying show the progress note and only Cancel', async () => {
  for (const [state, note] of [['opening', 'Opening the sign-in page…'], ['verifying', 'Checking the new login…']]) {
    const m = mount(pin(state, note))
    const tree = m.render()
    assert.match(textOf(tree), new RegExp(note))
    assert.deepEqual(m.labels(tree), ['Cancel'])
    assert.equal(m.inputs(tree).length, 0)
    await m.button(tree, 'Cancel').props.onClick()
    assert.deepEqual(m.calls, [['/v1/limit-signin-cancel', {}]])
  }
})

test('limit card UI: awaiting-code shows the note (with the cookie fallback), a code field, Submit code and Cancel', () => {
  const note = 'Open the page, sign in as me@x.co, paste the code. No private window: clear the claude.ai cookies first.'
  const m = mount(pin('awaiting-code', note))
  const tree = m.render()
  assert.ok(textOf(tree).includes(note))
  assert.equal(m.inputs(tree).length, 1)
  assert.deepEqual(m.labels(tree), ['Submit code', 'Cancel'])
})

test('limit card UI: the code goes to limit-signin-code, the field is cleared, and the code is stored nowhere', async () => {
  const m = mount(pin('awaiting-code', 'Paste the code'))
  m.inputs(m.render())[0].props.onChange({ target: { value: 'SECRET#code' } })
  const p = m.button(m.render(), 'Submit code').props.onClick()
  assert.deepEqual(m.setCalls.at(-1), [m.setCalls.at(-1)[0], ''], 'the field is cleared right when sending')
  await p
  assert.deepEqual(m.calls, [['/v1/limit-signin-code', { code: 'SECRET#code' }]])
  assert.equal(m.inputs(m.render())[0].props.value, '')
  assert.ok(!JSON.stringify(m.writes).includes('SECRET'), 'nothing is saved to localStorage')
  assert.ok(!JSON.stringify(m.T.state).includes('SECRET'), 'nothing is kept in the module state')
})

test('limit card UI: an empty code posts nothing', async () => {
  const m = mount(pin('awaiting-code', 'Paste the code'))
  await m.button(m.render(), 'Submit code').props.onClick()
  assert.deepEqual(m.calls, [])
})

test('limit card UI: signed-in offers Resume all (N) without a confirm, and Not now', async () => {
  const m = mount(pin('signed-in', 'Signed in as me@x.co.'))
  const tree = m.render()
  assert.match(textOf(tree), /Signed in\. Resume the 3 sessions the limit stopped\?/)
  assert.deepEqual(m.labels(tree), ['Resume all (3)', 'Not now'])
  await m.button(tree, 'Resume all (3)').props.onClick()
  assert.deepEqual(m.calls, [['/v1/limit-resume', {}]])
  assert.equal(m.T.state.dialog ?? null, null)
})

test('limit card UI: failed shows the reason; Try again returns to the email field; Not now dismisses', async () => {
  const note = 'Sign-in failed: the code was rejected. Your previous login was restored.'
  const m = mount(pin('failed', note))
  let tree = m.render()
  assert.ok(textOf(tree).includes(note))
  assert.deepEqual(m.labels(tree), ['Try again', 'Not now'])
  assert.equal(m.inputs(tree).length, 0)
  m.button(tree, 'Try again').props.onClick()
  tree = m.render()
  assert.equal(m.inputs(tree).length, 1)
  assert.deepEqual(m.labels(tree), ['Sign in', 'Not now'])
  await m.button(tree, 'Not now').props.onClick()
  assert.deepEqual(m.calls, [['/v1/paused-dismiss', { id: 'p1' }]])
})

test('limit card UI: a refused request shows its words on the card', async () => {
  const m = mount(pin('idle'), { fetchImpl: async () => okJson({ ok: false, error: 'bad-email' }, 400) })
  m.inputs(m.render())[0].props.onChange({ target: { value: 'nope' } })
  await m.button(m.render(), 'Sign in').props.onClick()
  await tick()
  assert.equal(m.T.state.errors.p1, 'That email address is not valid.')
})

test('limit card UI: Card uses this body and the "Session limit" chip; a restart-paused card keeps PausedBody and "Paused"', () => {
  const m = mount(pin('idle'))
  const card = m.expand(el(m.T.Card ?? (() => null), { item: pin('idle') }))
  assert.equal(typeof m.T.Card, 'function', 'Card is exported through __test')
  const chip = findAll(card, (n) => n.type === 'span' && String(n.props.className).startsWith('rq-chip'))[0]
  assert.equal(textOf(chip), 'Session limit')
  assert.match(textOf(card), /Sign in with a different account/)
  const plain = { id: 'r1', type: 'paused', status: 'open', sessionId: 's', position: 2, createdAt: 1, sessionTitle: 'W', payload: { kinds: ['open-turn'], lastWrite: 1 } }
  const card2 = m.expand(el(m.T.Card, { item: plain }))
  assert.equal(textOf(findAll(card2, (n) => n.type === 'span' && String(n.props.className).startsWith('rq-chip'))[0]), 'Paused')
  assert.ok(findAll(card2, (n) => n.type === 'button' && textOf(n) === 'Resume').length === 1)
  assert.equal(m.T.typeLabel('paused'), 'Paused')
})

// ---------- phone ----------
const model = () => import('../lib/mobile/model.js')
test('limit card phone: status text only, no sign-in, code or resume', async () => {
  const { pausedView } = await model()
  const { mod } = loadClient()
  const v = pausedView(mod.shared, pin('idle'), 5000)
  assert.deepEqual(JSON.parse(JSON.stringify(v.facts)), ['Claude session limit reached, 3 sessions stopped. Sign in at the PC.'])
  assert.equal(v.actions, undefined)
  const one = pausedView(mod.shared, pin('idle', '', { payload: { kinds: ['limit-signin'], count: 1, state: 'idle', note: '' } }), 5000)
  assert.equal(one.facts[0], 'Claude session limit reached, 1 session stopped. Sign in at the PC.')
})

test('limit card phone: the code never mentions the sign-in routes; the chip says Session limit', () => {
  const mobile = ['api.js', 'views.js', 'model.js', 'app.js', 'core.js'].map((f) => readFileSync(join(root, 'lib', 'mobile', f), 'utf8')).join('\n')
  assert.ok(!/\/v1\/limit-/.test(mobile))
  const { mod } = loadClient()
  assert.equal(mod.shared.itemTypeLabel(pin()), 'Session limit')
  assert.equal(mod.shared.itemTypeLabel({ type: 'paused', payload: { kinds: ['limit'] } }), 'Paused')
})

// ---------- voice ----------
test('limit card voice: one spoken line for the pinned item; restart paused wording is unchanged', () => {
  const s = spokenFor(pin('idle'), 1)
  assert.match(s.full, /Claude session limit reached, 3 sessions stopped\./)
  assert.doesNotMatch(s.full, /Resume or dismiss/)
  assert.equal(spokenFor(pin('idle'), undefined).headline, 'Claude session limit reached, 3 sessions stopped.')
  assert.equal(spokenFor(pin('idle', '', { payload: { kinds: ['limit-signin'], count: 1 } }), undefined).full, 'Claude session limit reached, 1 session stopped.')
  assert.equal(titleFor(pin('idle')), 'Session limit reached')
  const restart = { type: 'paused', sessionTitle: 'Work', payload: { reason: 'Cut off', kinds: ['open-turn'] } }
  assert.equal(spokenFor(restart).full, 'Paused session Work was cut off. Cut off. Resume or dismiss it at the desktop.')
})
