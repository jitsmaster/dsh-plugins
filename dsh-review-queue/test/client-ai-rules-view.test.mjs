// Slice 5 of the AI triage plan (RED): the desktop "AI rules" view (phone is out of scope).
// Names chosen here (the implementation must match):
//   state keys   showRules (false), triageRules (the loaded payload { rules, lessons }), triageRulesError (string)
//   tabs         the "AI rules" tab of the Views tablist (data-tab="rules", role tab, aria-selected = st.showRules); the old header button is gone
//   component    RulesView, hook-free, rendered by Panel when st.showRules (found through T.Panel() like FilterBar in client-ai-filter-head)
//   rule block   data-rule="<id>"; a segmented role=radiogroup (aria-label "Mode") of role=radio buttons "Off" "Observe" "Auto" (class `on`, aria-checked); Auto asks first: data-rule-auto-confirm="<id>"
//                with "Auto acts for you","Confirm Auto" and "Cancel"; lessons: data-lesson="<id>" with a "Forget" button
//   endpoints    GET /review-queue/v1/triage-rules, POST .../triage-rule-mode { ruleId, mode }, POST .../triage-forget { id }
import test from 'node:test'
import assert from 'node:assert/strict'
import { loadClient, el, findAll, textOf, tick, okJson, deferred } from './client-todo-helpers.mjs'

const BASE = '/review-queue/v1/'
const PAYLOAD = () => ({
  ok: true,
  rules: [
    { id: 'r1', name: 'Read-only commands', class: 'permission', enabled: true, mode: 'observe', instruction: 'Approve ls, cat and git status.', version: 3, record: { current: { agreed: 18, overruled: 2 }, older: { agreed: 4, overruled: 1 } } },
    { id: 'r2', name: 'Safe deletes', class: 'permission', enabled: true, mode: 'off', instruction: 'Delete temp files only.', version: 1, record: { current: { agreed: 0, overruled: 0 }, older: { agreed: 0, overruled: 0 } } },
    { id: 'r3', name: 'Auto builds', class: 'completed', enabled: true, mode: 'auto', instruction: 'Mark green builds reviewed.', version: 2, record: { current: { agreed: 30, overruled: 0 }, older: { agreed: 0, overruled: 0 } } },
  ],
  lessons: [
    { id: 'l1', title: 'Never approve rm -rf', content: 'You overruled the approval of rm -rf build.', description: 'd', count: 3, lastAt: Date.UTC(2026, 9, 31), ruleId: 'r1', agreed: 0, confirmed: 3, active: true, since: 1 },
    { id: 'l2', title: 'Old habit', content: 'Superseded by a newer rule.', description: 'd', count: 1, lastAt: Date.UTC(2026, 8, 1), ruleId: 'r1', agreed: 0, confirmed: 1, active: false, since: 1 },
  ],
})

/** routes: { get: () => response, post: (url, body) => response }; every call is logged as [method, url-after-base, body]. */
function load({ get = () => okJson(PAYLOAD()), post = () => okJson({ ok: true }) } = {}) {
  const calls = []
  const fetchImpl = async (url, init) => {
    const method = (init && init.method) || 'GET'
    const body = init && init.body ? JSON.parse(init.body) : undefined
    calls.push([method, String(url).replace(BASE, ''), body])
    return method === 'GET' ? get(url) : post(url, body)
  }
  const { T } = loadClient({ fetchImpl, react: { createElement: el } })
  T.state.snap = { snapshotId: 'e:1', open: [], resolved: [] }
  return { T, calls }
}
const gets = (calls) => calls.filter((c) => c[0] === 'GET' && c[1] === 'triage-rules')
const posts = (calls) => calls.filter((c) => c[0] === 'POST')
const part = (T, name) => { const n = findAll(T.Panel(), (x) => typeof x.type === 'function' && x.type.name === name)[0]; assert.ok(n, name + ' is rendered'); return n.type(n.props) }
const rulesBtn = (T) => { const b = findAll(part(T, 'ViewTabs'), (n) => n.props?.role === 'tab' && n.props['data-tab'] === 'rules')[0]; assert.ok(b, 'the AI rules tab'); return b }
const view = (T) => part(T, 'RulesView')
const block = (tree, id) => { const b = findAll(tree, (n) => n.props && n.props['data-rule'] === id)[0]; assert.ok(b, 'rule block ' + id); return b }
const btn = (tree, text) => findAll(tree, (n) => n.type === 'button' && textOf(n) === text)[0]
const tabBtn = (T, view) => findAll(part(T, 'ViewTabs'), (n) => n.props?.role === 'tab' && n.props['data-tab'] === view)[0]
const press = (tree, text) => { const b = btn(tree, text); assert.ok(b, 'button ' + text); b.props.onClick(); return b }
const confirmLine = (tree, id) => findAll(tree, (n) => n.props && n.props['data-rule-auto-confirm'] === id)[0]
const on = (b) => b.props.className.split(' ').includes('on')
const open = async (T) => { rulesBtn(T).props.onClick(); await tick(); await tick() }

// ---- state and header ----

test('the initial state has showRules false and nothing loaded', () => {
  const { T } = load()
  assert.equal(T.state.showRules, false)
  assert.equal(T.state.triageRules, undefined)
  assert.equal(T.state.triageRulesError, undefined)
})

test('the "AI rules" tab selects the view and clears the other views', () => {
  const { T } = load()
  const b = rulesBtn(T)
  assert.equal(textOf(b).trim(), 'AI rules')
  assert.equal(b.props['aria-selected'], false)
  T.set({ showResolved: true, showHeld: true, showPhone: true, selected: 'x' })
  rulesBtn(T).props.onClick()
  assert.equal(T.state.showRules, true)
  assert.equal(T.state.showResolved, false)
  assert.equal(T.state.showHeld, false)
  assert.equal(T.state.showPhone, false)
  assert.equal(T.state.selected, null)
  assert.equal(rulesBtn(T).props['aria-selected'], true)
  tabBtn(T, 'waiting').props.onClick()
  assert.equal(T.state.showRules, false)
  assert.equal(rulesBtn(T).props['aria-selected'], false)
})

test('the Resolved tab closes the rules view', () => {
  const { T } = load()
  T.set({ showRules: true })
  tabBtn(T, 'resolved').props.onClick()
  assert.equal(T.state.showRules, false)
  assert.equal(T.state.showResolved, true)
})

test('the On hold tab closes the rules view', () => {
  const { T } = load()
  T.state.snap = { snapshotId: 'e:1', open: [{ id: 'h1', type: 'onhold', status: 'open', title: 'Held', createdAt: 1, sessionId: 's1', payload: { reason: 'wait', heldAt: 1 } }], resolved: [] }
  assert.equal(T.heldCount(T.state.snap.open), 1, 'fixture: one held session')
  T.set({ showRules: true })
  tabBtn(T, 'held').props.onClick()
  assert.equal(T.state.showRules, false)
  assert.equal(T.state.showHeld, true)
})

test('Panel shows RulesView only while showRules, and the keyboard hint only outside Resolved and rules', () => {
  const { T } = load()
  const hint = () => findAll(T.Panel(), (n) => n.props && n.props.className === 'rq-hint').length
  const hasView = () => findAll(T.Panel(), (n) => typeof n.type === 'function' && n.type.name === 'RulesView').length
  assert.equal(hasView(), 0)
  assert.equal(hint(), 1)
  T.set({ showRules: true })
  assert.equal(hasView(), 1)
  assert.equal(hint(), 0, 'no keyboard hint under the rules view')
  assert.equal(findAll(T.Panel(), (n) => n.props && n.props.className === 'rq-split').length, 0, 'the waiting split is not shown')
})

// ---- loading ----

test('opening the view GETs /v1/triage-rules once and stores the payload', async () => {
  const { T, calls } = load()
  await open(T)
  assert.equal(gets(calls).length, 1)
  assert.equal(T.state.triageRules.rules.length, 3)
  assert.equal(T.state.triageRules.lessons.length, 2)
  assert.equal(T.state.triageRulesError, undefined)
})

test('closing the view does not GET again', async () => {
  const { T, calls } = load()
  await open(T)
  tabBtn(T, 'waiting').props.onClick()
  await tick()
  assert.equal(gets(calls).length, 1)
})

test('the view says "Loading AI rules…" while nothing is loaded and no error', () => {
  const { T } = load()
  T.set({ showRules: true })
  assert.match(textOf(view(T)), /Loading AI rules…/)
})

test('triage-off shows "AI triage is switched off." and no rule blocks', async () => {
  const { T } = load({ get: () => okJson({ ok: false, error: 'triage-off' }) })
  await open(T)
  const text = textOf(view(T))
  assert.match(text, /AI triage is switched off\./)
  assert.doesNotMatch(text, /Loading AI rules/)
  assert.equal(findAll(view(T), (n) => n.props && 'data-rule' in n.props).length, 0)
})

test('another failure shows the errorText of the response', async () => {
  const { T } = load({ get: () => okJson({ ok: false, error: 'boom' }, 500) })
  await open(T)
  assert.equal(T.state.triageRulesError, T.errorText(500, { error: 'boom' }))
  assert.match(textOf(view(T)), /Could not do that \(boom\)\./)
  assert.doesNotMatch(textOf(view(T)), /Loading AI rules/)
})

test('a failing fetch shows an error line rather than loading forever', async () => {
  const { T } = load({ get: () => { throw new Error('offline') } })
  await open(T)
  assert.equal(typeof T.state.triageRulesError, 'string')
  assert.doesNotMatch(textOf(view(T)), /Loading AI rules/)
})

// ---- rules ----

test('each rule block shows name, class, mode label, instruction and the current record', async () => {
  const { T } = load()
  await open(T)
  const t = textOf(block(view(T), 'r1'))
  assert.match(t, /Read-only commands/)
  assert.match(t, /permission/)
  assert.match(t, /Observe \(note only\)/)
  assert.match(t, /Approve ls, cat and git status\./)
  assert.match(t, /this version/)
  assert.match(t, /agreed 18 of 20/)
  assert.equal(findAll(view(T), (n) => n.props && 'data-rule' in n.props).length, 3)
})

test('the older record shows, labelled "older versions", only when its total is above 0', async () => {
  const { T } = load()
  await open(T)
  const withOlder = textOf(block(view(T), 'r1'))
  assert.match(withOlder, /older versions/)
  assert.match(withOlder, /agreed 4 of 5/)
  const none = textOf(block(view(T), 'r2'))
  assert.doesNotMatch(none, /older versions/)
  assert.match(none, /no record yet/)
})

test('the promotion hint shows for the good observe rule only', async () => {
  const { T } = load()
  await open(T)
  assert.match(textOf(block(view(T), 'r1')), /Record is good: you could try auto/)
  assert.doesNotMatch(textOf(block(view(T), 'r2')), /Record is good/)
  assert.doesNotMatch(textOf(block(view(T), 'r3')), /Record is good/, 'an auto rule gets no suggestion')
})

test('the modes are one segmented radiogroup of radios: the active one is `on` and aria-checked, the others are not', async () => {
  const { T } = load()
  await open(T)
  for (const [id, active] of [['r1', 'Observe'], ['r2', 'Off'], ['r3', 'Auto']]) {
    const group = findAll(block(view(T), id), (n) => n.props?.role === 'radiogroup')
    assert.equal(group.length, 1, `${id} has one radiogroup`)
    assert.equal(group[0].props['aria-label'], 'Mode')
    assert.match(group[0].props.className, /rq-seg/)
    assert.deepEqual(findAll(group[0], (n) => n.type === 'button').map((b) => b.props.role), ['radio', 'radio', 'radio'])
    for (const label of ['Off', 'Observe', 'Auto']) {
      const b = btn(block(view(T), id), label)
      assert.ok(b, `${id} has ${label}`)
      assert.equal(b.props.role, 'radio')
      assert.equal(on(b), label === active, `${id} ${label} class`)
      assert.equal(b.props['aria-checked'], label === active, `${id} ${label} aria-checked`)
      assert.equal('aria-pressed' in b.props, false, `${id} ${label} is not a toggle button`)
    }
  }
})
test('Off and Observe POST /v1/triage-rule-mode at once, with no confirm step, then reload', async () => {
  const { T, calls } = load()
  await open(T)
  press(block(view(T), 'r1'), 'Off')
  await tick(); await tick()
  assert.deepEqual(posts(calls).map((c) => [c[1], { ...c[2] }]), [['triage-rule-mode', { ruleId: 'r1', mode: 'off' }]])
  assert.equal(gets(calls).length, 2, 'the rules are loaded again after the change')
  press(block(view(T), 'r2'), 'Observe')
  await tick(); await tick()
  assert.deepEqual({ ...posts(calls)[1][2] }, { ruleId: 'r2', mode: 'observe' })
  assert.equal(confirmLine(view(T), 'r1'), undefined)
  assert.equal(confirmLine(view(T), 'r2'), undefined)
  assert.equal(gets(calls).length, 3)
})

test('Auto first shows a confirm line and posts nothing', async () => {
  const { T, calls } = load()
  await open(T)
  press(block(view(T), 'r1'), 'Auto')
  await tick()
  assert.equal(posts(calls).length, 0)
  const line = confirmLine(view(T), 'r1')
  assert.ok(line, 'confirm line for r1')
  assert.match(textOf(line), /Auto acts for you: the AI will approve read-only commands without asking, and shows each one under Resolved by AI\. Switch to Auto\?/)
  assert.doesNotMatch(textOf(line), /not active yet/)
  assert.ok(btn(line, 'Confirm Auto') || btn(view(T), 'Confirm Auto'), 'a Confirm Auto button')
  assert.equal(confirmLine(view(T), 'r2'), undefined, 'only the clicked rule asks')
})

test('Confirm Auto POSTs mode auto and reloads; the confirm line goes away', async () => {
  const { T, calls } = load()
  await open(T)
  press(block(view(T), 'r1'), 'Auto')
  press(confirmLine(view(T), 'r1'), 'Confirm Auto')
  await tick(); await tick()
  assert.deepEqual(posts(calls).map((c) => [c[1], { ...c[2] }]), [['triage-rule-mode', { ruleId: 'r1', mode: 'auto', confirmed: true }]])
  assert.equal(gets(calls).length, 2)
  assert.equal(confirmLine(view(T), 'r1'), undefined)
})

test('Cancel dismisses the confirm line without posting', async () => {
  const { T, calls } = load()
  await open(T)
  press(block(view(T), 'r1'), 'Auto')
  press(confirmLine(view(T), 'r1'), 'Cancel')
  assert.equal(confirmLine(view(T), 'r1'), undefined)
  assert.equal(posts(calls).length, 0)
})

test('while a mode change is in flight the rule buttons are disabled', async () => {
  const gate = deferred()
  const { T } = load({ post: () => gate.promise })
  await open(T)
  press(block(view(T), 'r2'), 'Observe')
  await tick()
  for (const label of ['Off', 'Observe', 'Auto']) assert.equal(btn(block(view(T), 'r2'), label).props.disabled, true, label + ' disabled')
  gate.resolve(okJson({ ok: true }))
  await tick(); await tick()
  for (const label of ['Off', 'Observe', 'Auto']) assert.ok(!btn(block(view(T), 'r2'), label).props.disabled, label + ' enabled again')
})

test('a server error on the mode change is shown and the view stays', async () => {
  const { T } = load({ post: () => okJson({ ok: false, error: 'bad-rule' }, 409) })
  await open(T)
  press(block(view(T), 'r2'), 'Observe')
  await tick(); await tick()
  assert.match(textOf(view(T)), /bad-rule/)
  assert.equal(findAll(view(T), (n) => n.props && 'data-rule' in n.props).length, 3)
})

test('a needs-confirm answer to the mode change reads as a Confirm-before-Auto line', async () => {
  const { T } = load({ post: () => okJson({ ok: false, error: 'needs-confirm' }, 400) })
  await open(T)
  press(block(view(T), 'r2'), 'Observe')
  await tick(); await tick()
  assert.match(textOf(view(T)), /Confirm before switching a rule to Auto\./)
})

test('a rule list that is empty says "No rules."', async () => {
  const { T } = load({ get: () => okJson({ ok: true, rules: [], lessons: [] }) })
  await open(T)
  assert.match(textOf(view(T)), /No rules\./)
})

// ---- lessons ----

test('lessons: the section lists each lesson line and its content, with a Forget button', async () => {
  const { T } = load()
  await open(T)
  const t = textOf(view(T))
  assert.match(t, /Corrections the AI learned/)
  const l1 = findAll(view(T), (n) => n.props && n.props['data-lesson'] === 'l1')[0]
  assert.ok(l1, 'lesson block l1')
  assert.match(textOf(l1), /Never approve rm -rf \(overruled 3 times, last 2026-10-31\)/)
  assert.match(textOf(l1), /You overruled the approval of rm -rf build\./)
  assert.ok(btn(l1, 'Forget'))
  assert.doesNotMatch(textOf(l1), /retired/)
})

test('an inactive lesson is labelled "retired"', async () => {
  const { T } = load()
  await open(T)
  const l2 = findAll(view(T), (n) => n.props && n.props['data-lesson'] === 'l2')[0]
  assert.ok(l2, 'lesson block l2')
  assert.match(textOf(l2), /retired/)
})

test('Forget POSTs /v1/triage-forget { id } and reloads', async () => {
  const { T, calls } = load()
  await open(T)
  const l1 = findAll(view(T), (n) => n.props && n.props['data-lesson'] === 'l1')[0]
  btn(l1, 'Forget').props.onClick()
  await tick(); await tick()
  assert.deepEqual(posts(calls).map((c) => [c[1], { ...c[2] }]), [['triage-forget', { id: 'l1' }]])
  assert.equal(gets(calls).length, 2)
})

test('a failed Forget shows the error', async () => {
  const { T } = load({ post: () => okJson({ ok: false, error: 'not-found' }, 409) })
  await open(T)
  btn(findAll(view(T), (n) => n.props && n.props['data-lesson'] === 'l1')[0], 'Forget').props.onClick()
  await tick(); await tick()
  assert.match(textOf(view(T)), /not-found|Could not do that/)
})

test('no lessons says "No corrections learned yet."', async () => {
  const { T } = load({ get: () => okJson({ ok: true, rules: PAYLOAD().rules, lessons: [] }) })
  await open(T)
  assert.match(textOf(view(T)), /No corrections learned yet\./)
})

test('garbled payloads do not throw while rendering', () => {
  const { T } = load()
  for (const bad of [{}, { rules: 'x', lessons: 5 }, { rules: [null, {}, { id: 'x' }], lessons: [null, {}] }, null]) {
    T.set({ showRules: true, triageRules: bad })
    assert.doesNotThrow(() => textOf(view(T)), JSON.stringify(bad))
  }
})

// ---- rulesAct robustness: a non-string error with a code set must not throw ----
// postJson always builds r.error through errorText in production; the sandbox's Object.prototype.hasOwnProperty is made to say yes to every key
// so errorText yields undefined (code 'x') or a non-string (code 'constructor') and rulesAct sees `{ ok: false, code, error: <non-string> }`.
function loadWithLooseErrors(post) {
  const Loose = function Object_() {}
  for (const k of Object.getOwnPropertyNames(Object)) if (k !== 'prototype' && k !== 'name' && k !== 'length') Object.defineProperty(Loose, k, Object.getOwnPropertyDescriptor(Object, k))
  Loose.prototype = { hasOwnProperty: () => true }
  const calls = []
  const fetchImpl = async (url, init) => {
    const method = (init && init.method) || 'GET'
    calls.push([method, String(url).replace(BASE, '')])
    return method === 'GET' ? okJson(PAYLOAD()) : post()
  }
  const { T } = loadClient({ fetchImpl, react: { createElement: el }, globals: { Object: Loose } })
  T.state.snap = { snapshotId: 'e:1', open: [], resolved: [] }
  return { T, calls }
}

for (const [label, code] of [['an undefined error', 'x'], ['a non-string error', 'constructor']]) {
  test('rulesAct with a code and ' + label + ' does not throw, clears busy and shows a string', async () => {
    const { T } = loadWithLooseErrors(() => okJson({ ok: false, error: code }, 409))
    await open(T)
    const unhandled = []
    const onRejection = (e) => unhandled.push(e)
    process.on('unhandledRejection', onRejection)
    try {
      press(block(view(T), 'r2'), 'Observe')
      await tick(); await tick(); await tick()
    } finally { process.off('unhandledRejection', onRejection) }
    assert.deepEqual(unhandled.map(String), [])
    assert.equal(T.state.rulesBusy.r2, false)
    assert.equal(typeof T.state.rulesError, 'string')
    assert.ok(T.state.rulesError.length > 0)
  })
}
