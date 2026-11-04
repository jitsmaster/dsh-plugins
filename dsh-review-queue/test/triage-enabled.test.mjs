// Slice 1 of Auto mode: the GLOBAL AI-triage on/off switch (persisted in triage-rules.json, checked by the runner, POST /v1/triage-enabled, snapshot triage.enabled, desktop UI).
import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { createStore } from '../store.js'
import { createReviewQueue } from '../service.js'
import { createRouter } from '../server.js'
import { createTriageRules } from '../triage-rules.js'
import { createTriageRunner, DEFAULT_RULES } from '../triage-runner.js'
import { loadClient, el, findAll, textOf, tick, okJson } from './client-todo-helpers.mjs'

const memIo = (initial) => {
  const box = { text: initial, writes: 0 }
  return { box, read: () => box.text, write: (t) => { box.text = t; box.writes++ } }
}

// ---- rules persistence ----

test('rules: enabled defaults to true and an old file without it still loads', () => {
  assert.equal(createTriageRules({ io: memIo(), defaults: DEFAULT_RULES }).enabled(), true)
  const old = createTriageRules({ io: memIo(JSON.stringify({ v: 1, modes: { 'ro-permission': 'off' } })), defaults: DEFAULT_RULES })
  assert.equal(old.enabled(), true)
  assert.equal(old.get('ro-permission').mode, 'off')
})

test('rules: setEnabled persists { v: 1, modes, enabled } and round-trips', () => {
  const io = memIo()
  const rules = createTriageRules({ io, defaults: DEFAULT_RULES })
  assert.equal(rules.setEnabled(false), true)
  assert.equal(rules.enabled(), false)
  const saved = JSON.parse(io.box.text)
  assert.equal(saved.v, 1)
  assert.equal(saved.enabled, false)
  assert.equal(saved.modes['ro-permission'], 'observe')
  assert.equal(createTriageRules({ io, defaults: DEFAULT_RULES }).enabled(), false)
  rules.setMode('ro-permission', 'off') // a mode change keeps the switch
  assert.equal(JSON.parse(io.box.text).enabled, false)
})

test('rules: a non-boolean setEnabled is rejected and changes nothing; a stored non-boolean means true', () => {
  const io = memIo()
  const rules = createTriageRules({ io, defaults: DEFAULT_RULES })
  for (const bad of ['false', 0, null, undefined, {}]) assert.equal(rules.setEnabled(bad), false)
  assert.equal(rules.enabled(), true)
  assert.equal(io.box.writes, 0)
  for (const stored of ['false', 0, null, 'no']) assert.equal(createTriageRules({ io: memIo(JSON.stringify({ v: 1, modes: {}, enabled: stored, extra: 1 })), defaults: DEFAULT_RULES }).enabled(), true)
})

// ---- runner ----

const GOOD = { needs_decision: false, answer_basis: 'none', answer: null, evidence_quote: null, evidence_source: null, matched_rule: 'ro-permission', attention: 10, reversible: true, touches_outside_workspace: false, read_only: true }
const perm = () => ({ type: 'permission', sessionId: 's1', workspace: 'D:/w', payload: { toolName: 'shell', detail: 'git status', summary: 'git status' } })

function runnerSetup({ enabled, sourcesOf, judge } = {}) {
  let n = 0
  const store = createStore({ now: () => 1000 + n, uuid: () => 'i' + ++n })
  const calls = []
  const entries = []
  const runner = createTriageRunner({ store, judge: judge ?? { judge: async (a) => { calls.push(a); return { judgment: GOOD, raw: '' } } }, triageLog: { append: (e) => entries.push(e) }, enabled, sourcesOf })
  runner.start()
  return { store, runner, calls, entries }
}

test('runner: an item added while the switch is off is ignored', async () => {
  const { store, runner, calls, entries } = runnerSetup({ enabled: () => false })
  const item = store.add(perm())
  await runner.idle()
  assert.equal(calls.length, 0)
  assert.equal(entries.length, 0)
  assert.equal(store.get(item.id).triage, undefined)
})

test('runner: switching off after the run started but before the judge call makes no judge call', async () => {
  let on = true
  const { store, runner, calls, entries } = runnerSetup({ enabled: () => on, sourcesOf: async () => { on = false; return [] } })
  const item = store.add(perm())
  await runner.idle()
  assert.equal(calls.length, 0)
  assert.equal(store.get(item.id).triage, undefined)
  assert.deepEqual(entries.map((e) => [e.stage, e.reasons]), [['skipped', ['off']]])
})

test('runner: switching off during the judge call leaves no note (the act re-check)', async () => {
  let on = true
  const judge = { judge: async () => { on = false; return { judgment: GOOD, raw: '' } } }
  const { store, runner } = runnerSetup({ enabled: () => on, judge })
  const item = store.add(perm())
  await runner.idle()
  assert.equal(store.get(item.id).triage, undefined)
})

// ---- review / service / routes ----

function queueSetup({ withEnabled = true } = {}) {
  const store = createStore()
  let on = true
  const rules = {
    list: () => [{ id: 'ro-permission', mode: 'observe', version: 'v1' }],
    get: (id) => (id === 'ro-permission' ? { id, mode: 'observe', version: 'v1' } : undefined),
    setMode: () => true,
    ...(withEnabled ? { enabled: () => on, setEnabled: (v) => { if (typeof v !== 'boolean') return false; on = v; return true } } : {}),
  }
  const queue = createReviewQueue({ store, capture: {}, now: () => 5000, triageApi: { rules, memory: { cases: () => [], lessons: () => [] } } })
  return { queue, store }
}

test('review: triageEnabled sets the switch, wakes listeners, and rejects a non-boolean', () => {
  const { queue } = queueSetup()
  let woke = 0
  queue.onChange(() => { woke++ })
  assert.deepEqual(queue.triageEnabled(false), { ok: true })
  assert.equal(queue.snapshot().triage.enabled, false)
  assert.equal(woke, 1)
  assert.deepEqual(queue.triageEnabled('yes'), { ok: false, error: 'bad-input' })
  assert.equal(queue.snapshot().triage.enabled, false)
  assert.deepEqual(queue.triageEnabled(true), { ok: true }) // turning on needs no confirm
  assert.equal(queue.snapshot().triage.enabled, true)
})

test('review: triage-off when there is no triage, and the snapshot has no triage part then', () => {
  const none = createReviewQueue({ store: createStore(), capture: {}, now: () => 1 })
  assert.deepEqual(none.triageEnabled(true), { ok: false, error: 'triage-off' })
  assert.equal('triage' in none.snapshot(), false)
  assert.equal('triage' in queueSetup({ withEnabled: false }).queue.snapshot(), false)
})

test('review: GET triageRules carries enabled', () => {
  const { queue } = queueSetup()
  assert.equal(queue.triageRules().enabled, true)
  queue.triageEnabled(false)
  assert.equal(queue.triageRules().enabled, false)
})

test('route: POST /v1/triage-enabled happy path, bad body, and the real queue end to end', async () => {
  const { queue } = queueSetup()
  const server = createServer((req, res) => createRouter({ queue })(req, res))
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  const base = 'http://127.0.0.1:' + server.address().port
  const post = (body) => fetch(base + '/v1/triage-enabled', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  try {
    const ok = await post({ enabled: false })
    assert.equal(ok.status, 200)
    assert.deepEqual(await ok.json(), { ok: true })
    assert.equal(queue.triageRules().enabled, false)
    for (const body of [{}, { enabled: 'false' }, { enabled: 0 }, { enabled: null }]) {
      const bad = await post(body)
      assert.equal(bad.status, 400, JSON.stringify(body))
      assert.deepEqual(await bad.json(), { ok: false, error: 'bad-input' })
    }
    assert.equal(queue.triageRules().enabled, false)
    const snap = await (await fetch(base + '/v1/snapshot')).json()
    assert.deepEqual(snap.triage, { enabled: false })
    assert.equal((await (await fetch(base + '/v1/triage-rules')).json()).enabled, false)
  } finally { server.closeAllConnections?.(); await new Promise((r) => server.close(r)) }
})

// ---- client ----

const PAYLOAD = (enabled) => ({ ok: true, enabled, rules: [{ id: 'r1', name: 'Read-only', class: 'permission', enabled: true, mode: 'observe', instruction: 'x', version: 1, record: { current: { agreed: 0, overruled: 0 }, older: { agreed: 0, overruled: 0 } } }], lessons: [] })

function clientSetup({ enabled = true } = {}) {
  const calls = []
  const fetchImpl = async (url, init) => {
    const method = (init && init.method) || 'GET'
    const body = init && init.body ? JSON.parse(init.body) : undefined
    calls.push([method, String(url), body])
    return method === 'GET' ? okJson(PAYLOAD(enabled)) : okJson({ ok: true })
  }
  const { T } = loadClient({ fetchImpl, react: { createElement: el } })
  T.state.snap = { snapshotId: 'e:1', open: [], resolved: [] }
  return { T, calls }
}
const part = (T, name) => { const n = findAll(T.Panel(), (x) => typeof x.type === 'function' && x.type.name === name)[0]; assert.ok(n, name); return n.type(n.props) }
const toggle = (tree) => findAll(tree, (n) => n.props && n.props['data-triage-enabled'] !== undefined)[0]
const switchBtn = (tree, text) => findAll(toggle(tree), (n) => n.type === 'button' && textOf(n) === text)[0]

test('client: RulesView shows the AI triage On/Off switch and posts { enabled }', async () => {
  const { T, calls } = clientSetup({ enabled: true })
  T.set({ triageRules: PAYLOAD(true), showRules: true })
  const tree = part(T, 'RulesView')
  assert.ok(toggle(tree), 'the switch is rendered')
  const on = switchBtn(tree, 'On'), off = switchBtn(tree, 'Off')
  assert.equal(on.props['aria-checked'], true)
  assert.equal(off.props['aria-checked'], false)
  for (const b of [on, off]) assert.equal(b.props.type, 'button')
  assert.ok(findAll(toggle(tree), (n) => n.props && n.props['aria-label'] === 'AI triage').length >= 1)
  off.props.onClick()
  await tick(); await tick()
  const posted = calls.filter((c) => c[0] === 'POST')
  assert.equal(posted.length, 1)
  assert.match(posted[0][1], /\/v1\/triage-enabled$/)
  assert.deepEqual(posted[0][2], { enabled: false })
  assert.equal(T.state.snap.triage.enabled, false) // the header chip follows at once
})

test('client: the switch is disabled while busy, and shows Off when triage is disabled', () => {
  const { T } = clientSetup()
  T.set({ triageRules: PAYLOAD(false), showRules: true, rulesBusy: { 'triage-enabled': true } })
  const tree = part(T, 'RulesView')
  assert.equal(switchBtn(tree, 'Off').props['aria-checked'], true)
  assert.equal(switchBtn(tree, 'On').props.disabled, true)
  assert.equal(switchBtn(tree, 'Off').props.disabled, true)
})

test('client: the header shows an "AI off" button only when the snapshot says triage is off; click opens the AI rules tab', () => {
  const { T } = clientSetup()
  const chip = (snap) => findAll(part(T, 'Head'), (n) => n.props && n.props['data-ai-off'] !== undefined)
  assert.equal(chip().length, 0)
  T.set({ snap: { snapshotId: 'e:1', open: [], resolved: [], triage: { enabled: true } } })
  assert.equal(chip().length, 0)
  T.set({ snap: { snapshotId: 'e:1', open: [], resolved: [], triage: { enabled: false } } })
  const [b] = chip()
  assert.ok(b, 'AI off chip')
  assert.equal(b.type, 'button')
  assert.equal(b.props.type, 'button')
  assert.equal(textOf(b), 'AI off')
  assert.match(b.props.title, /AI triage is switched off; click to open AI rules/)
  b.props.onClick()
  assert.equal(T.state.showRules, true)
})
