// Phase 3 slice 1: the review-queue service methods behind "Resolved by AI": triageRules, triageRuleMode, triageForget, triageReview and
// the extended reopen. Items that auto mode will resolve later are built by hand through the store.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'
import { createStore } from '../store.js'
import { createReviewQueue } from '../service.js'

const aiResolution = (over = {}) => ({ kind: 'ai-resolved', by: 'ai', action: 'approved', ruleId: 'ro-permission', ruleVersion: 'v1', threshold: 8, basis: 'rule', evidenceSource: 'code', quote: 'git status', score: 9, decidedAt: 100, ...over })
const perm = (over = {}) => ({ type: 'permission', sessionId: 's1', workspace: 'D:/w', payload: { toolName: 'shell', detail: 'git status', summary: 'git status' }, ...over })
const done = (over = {}) => ({ type: 'completed', sessionId: 's1', sessionTitle: 'One', summary: 'Did X.', payload: { reply: 'All tests pass.' }, ...over })

function setup({ withApi = true, controller = true, promptFails = false, slow = false, gate = false, logs } = {}) {
  let n = 0
  const store = createStore({ now: () => 1000, uuid: () => 'i' + ++n })
  const calls = []
  const modes = { 'ro-permission': 'auto', 'green-done': 'auto' }
  const recorded = []
  const forgotten = new Set(['l1'])
  let cases = []
  const rules = {
    list: () => [
      { id: 'ro-permission', name: 'Read-only commands', class: 'permission', enabled: true, mode: modes['ro-permission'], instruction: 'approve read-only', version: 'v1' },
      { id: 'green-done', name: 'Mechanical done messages', class: 'done', enabled: true, mode: modes['green-done'], instruction: 'clear green done', version: 'd2' },
    ],
    get: (id) => rules.list().find((r) => r.id === id),
    setMode: (id, mode) => { calls.push(['setMode', id, mode]); if (!(id in modes) || !['off', 'observe', 'auto'].includes(mode)) return false; modes[id] = mode; return true },
  }
  const memory = {
    cases: () => cases,
    lessons: () => [{ id: 'l1', title: 'Keep it' }],
    forget: (id) => (forgotten.delete(id) ? true : false),
    record: (arg) => { recorded.push(arg); return { case: {} } },
  }
  const capture = {
    answerQuestion: () => ({ ok: true }), decidePermission: () => ({ ok: true }), lateAnswerQuestion: async () => ({ ok: true, sent: true }),
  }
  const ctl = { prompt: async (req) => { calls.push(['attempt']); if (slow) await new Promise((resolve) => setTimeout(resolve, 10)); if (gate) await gate.promise; if (promptFails) throw new Error('boom'); calls.push(['prompt', req]); return {} } }
  const posting = new Set()
  const queue = createReviewQueue({ store, capture, posting, controllerOf: () => (controller ? ctl : undefined), now: () => 5000, ...(logs ? { log: (m) => logs.push(m) } : {}), ...(withApi ? { triageApi: { rules, memory } } : {}) })
  return { store, queue, calls, recorded, modes, posting, setCases: (c) => { cases = c } }
}

function aiItem(env, input, resolution) {
  const item = env.store.add(input)
  assert.equal(env.store.resolve(item.id, aiResolution(resolution)), true)
  return item.id
}

test('without triageApi every new method answers triage-off', async () => {
  const { queue } = setup({ withApi: false })
  const off = { ok: false, error: 'triage-off' }
  assert.deepEqual(queue.triageRules(), off)
  assert.deepEqual(queue.triageRuleMode('ro-permission', 'off'), off)
  assert.deepEqual(queue.triageForget('l1'), off)
  assert.deepEqual(await queue.triageReview('x', { review: 'seen' }), off)
})

test('triageRules lists the rules with their record split into current and older versions, plus the lessons', () => {
  const env = setup()
  const c = (ruleId, ruleVersion, review) => ({ ruleId, ruleVersion, review })
  env.setCases([
    c('ro-permission', 'v1', 'agreed'), c('ro-permission', 'v1', 'matched-user'), c('ro-permission', 'v1', 'overruled'),
    c('ro-permission', 'v0', 'overruled'), c('ro-permission', 'v0', 'agreed'), c('ro-permission', 'v0', 'agreed'),
    c('green-done', 'd2', 'overruled'), c('other', 'x', 'agreed'),
  ])
  const out = env.queue.triageRules()
  assert.equal(out.ok, true)
  assert.deepEqual(out.lessons, [{ id: 'l1', title: 'Keep it' }])
  const ro = out.rules.find((r) => r.id === 'ro-permission')
  assert.deepEqual(ro.record, { current: { agreed: 2, overruled: 1 }, older: { agreed: 2, overruled: 1 } })
  assert.equal(ro.version, 'v1')
  assert.equal(ro.mode, 'auto')
  assert.equal(ro.name, 'Read-only commands')
  assert.equal(ro.instruction, 'approve read-only')
  assert.deepEqual(out.rules.find((r) => r.id === 'green-done').record, { current: { agreed: 0, overruled: 1 }, older: { agreed: 0, overruled: 0 } })
  assert.equal(out.rules.length, 2)
})

test('triageRules counts interleaved cases per rule and ignores unknown rules and garbled entries', () => {
  const env = setup()
  const c = (ruleId, ruleVersion, review) => ({ ruleId, ruleVersion, review })
  env.setCases([
    c('green-done', 'd2', 'agreed'), null, c('ro-permission', 'v1', 'overruled'), { review: 'agreed' }, c('mystery', 'v9', 'agreed'),
    c('ro-permission', 'v0', 'matched-user'), undefined, c('green-done', 'd1', 'overruled'), c('ro-permission', 'v1', 'agreed'),
    c('green-done', 'd2', 'matched-user'), c('mystery', 'v9', 'overruled'), c('ro-permission', 'v1', 'pending'), 'junk', c('green-done', 'd2', 'overruled'),
  ])
  const rules = env.queue.triageRules().rules
  assert.deepEqual(rules.find((r) => r.id === 'ro-permission').record, { current: { agreed: 1, overruled: 1 }, older: { agreed: 1, overruled: 0 } })
  assert.deepEqual(rules.find((r) => r.id === 'green-done').record, { current: { agreed: 2, overruled: 1 }, older: { agreed: 0, overruled: 1 } })
  assert.equal(rules.length, 2)
})

test('triageRuleMode changes the mode, and reports bad-rule and bad-mode', () => {
  const env = setup()
  assert.deepEqual(env.queue.triageRuleMode('ro-permission', 'off'), { ok: true })
  assert.equal(env.modes['ro-permission'], 'off')
  assert.deepEqual(env.queue.triageRuleMode('nope', 'off'), { ok: false, error: 'bad-rule' })
  assert.deepEqual(env.queue.triageRuleMode('ro-permission', 'yolo'), { ok: false, error: 'bad-mode' })
  assert.equal(env.modes['ro-permission'], 'off')
})

test('triageForget deletes a lesson once and then says not-found', () => {
  const { queue } = setup()
  assert.deepEqual(queue.triageForget('l1'), { ok: true })
  assert.deepEqual(queue.triageForget('l1'), { ok: false, error: 'not-found' })
})

test('seen: marks an AI-resolved item seen and keeps the rest of the resolution', async () => {
  const env = setup()
  const id = aiItem(env, perm())
  assert.deepEqual(await env.queue.triageReview(id, { review: 'seen' }), { ok: true })
  const r = env.store.get(id).resolution
  assert.equal(r.seen, true)
  assert.equal(r.kind, 'ai-resolved')
  assert.equal(r.ruleId, 'ro-permission')
  assert.equal(r.review, undefined)
  assert.equal(env.store.get(id).status, 'resolved')
})

test('seen: refuses an item that is not AI-resolved and an unknown id', async () => {
  const env = setup()
  const open = env.store.add(perm())
  const human = env.store.add(done())
  env.store.resolve(human.id, { kind: 'reviewed', by: 'card' })
  assert.deepEqual(await env.queue.triageReview(open.id, { review: 'seen' }), { ok: false, error: 'not-ai-resolved' })
  assert.deepEqual(await env.queue.triageReview(human.id, { review: 'seen' }), { ok: false, error: 'not-ai-resolved' })
  assert.deepEqual(await env.queue.triageReview('nope', { review: 'seen' }), { ok: false, error: 'not-found' })
  assert.equal(env.store.get(human.id).resolution.seen, undefined)
})

test('agreed: Looks right sets review and seen and records a matched-user case with a triage built from the resolution', async () => {
  const env = setup()
  const id = aiItem(env, perm(), { action: 'approved', score: 9 })
  assert.deepEqual(await env.queue.triageReview(id, { review: 'agreed' }), { ok: true })
  const r = env.store.get(id).resolution
  assert.equal(r.review, 'agreed')
  assert.equal(r.seen, true)
  assert.equal(env.recorded.length, 1)
  const rec = env.recorded[0]
  assert.equal(rec.review, 'matched-user')
  assert.equal(rec.source, 'looks-right')
  assert.equal(rec.item.id, id)
  assert.equal(rec.item.triage.ruleId, 'ro-permission')
  assert.equal(rec.item.triage.ruleVersion, 'v1')
  assert.equal(rec.item.triage.score, 9)
  assert.equal(typeof rec.item.triage.would, 'string')
  assert.ok(rec.item.triage.would.length > 0)
})

test('agreed twice records only once and still answers ok', async () => {
  const env = setup()
  const id = aiItem(env, perm())
  assert.deepEqual(await env.queue.triageReview(id, { review: 'agreed' }), { ok: true })
  assert.deepEqual(await env.queue.triageReview(id, { review: 'agreed' }), { ok: true })
  assert.equal(env.recorded.length, 1)
})

test('mark-wrong sends the correction to the session of a resolved item and marks it overruled', async () => {
  const env = setup()
  const id = aiItem(env, done({ sessionId: 'sess-7' }), { action: 'cleared', ruleId: 'green-done', ruleVersion: 'd2' })
  assert.deepEqual(await env.queue.triageReview(id, { review: 'mark-wrong', text: '  you missed a failing test  ' }), { ok: true })
  const [, req] = env.calls.find((c) => c[0] === 'prompt')
  assert.equal(req.sessionId, 'sess-7')
  assert.deepEqual(req.content, [{ type: 'text', text: 'you missed a failing test' }])
  const r = env.store.get(id).resolution
  assert.equal(r.kind, 'ai-resolved')
  assert.equal(r.review, 'overruled')
  assert.equal(r.seen, true)
  assert.equal(env.store.get(id).status, 'resolved')
  assert.equal(env.recorded.length, 1)
  assert.equal(env.recorded[0].review, 'overruled')
  assert.equal(env.recorded[0].source, 'mark-wrong')
})

test('mark-wrong needs non-empty text and then changes nothing', async () => {
  const env = setup()
  const id = aiItem(env, done())
  for (const text of [undefined, '', '   ']) assert.deepEqual(await env.queue.triageReview(id, { review: 'mark-wrong', text }), { ok: false, error: 'empty' })
  assert.equal(env.store.get(id).resolution.review, undefined)
  assert.equal(env.recorded.length, 0)
  assert.equal(env.calls.filter((c) => c[0] === 'prompt').length, 0)
})

test('mark-wrong whose sending fails returns that failure and does not mark overruled or record', async () => {
  const noCtl = setup({ controller: false })
  const a = aiItem(noCtl, done())
  const refused = await noCtl.queue.triageReview(a, { review: 'mark-wrong', text: 'fix it' })
  assert.equal(refused.ok, false)
  assert.equal(refused.error, 'no-controller')
  assert.equal(noCtl.store.get(a).resolution.review, undefined)
  assert.equal(noCtl.recorded.length, 0)
  const failing = setup({ promptFails: true })
  const b = aiItem(failing, done())
  const result = await failing.queue.triageReview(b, { review: 'mark-wrong', text: 'fix it' })
  assert.equal(result.ok, false)
  assert.equal(failing.store.get(b).resolution.review, undefined)
  assert.equal(failing.recorded.length, 0)
})

test('mark-wrong a second time does not record twice', async () => {
  const env = setup()
  const id = aiItem(env, done())
  await env.queue.triageReview(id, { review: 'mark-wrong', text: 'one' })
  await env.queue.triageReview(id, { review: 'mark-wrong', text: 'two' })
  assert.equal(env.recorded.length, 1)
  assert.equal(env.calls.filter((c) => c[0] === 'prompt').length, 1)
})

const prompts = (env) => env.calls.filter((c) => c[0] === 'prompt').length

test('mark-wrong sent twice at once reaches the session once, records once and answers ok both times', async () => {
  const env = setup({ slow: true })
  const id = aiItem(env, done())
  const out = await Promise.all([1, 2].map(() => env.queue.triageReview(id, { review: 'mark-wrong', text: 'fix it' })))
  assert.deepEqual(out, [{ ok: true }, { ok: true }])
  assert.equal(prompts(env), 1)
  assert.equal(env.store.get(id).resolution.review, 'overruled')
  assert.equal(env.recorded.length, 1)
})

test('mark-wrong whose first send fails releases the marker so a retry sends; a concurrent duplicate neither sends nor marks', async () => {
  const env = setup({ slow: true, promptFails: true })
  const id = aiItem(env, done())
  const out = await Promise.all([1, 2].map(() => env.queue.triageReview(id, { review: 'mark-wrong', text: 'fix it' })))
  assert.equal(out[0].ok, false)
  assert.equal(env.calls.filter((c) => c[0] === 'attempt').length, 1)
  assert.equal(env.store.get(id).resolution.review, undefined)
  assert.equal(env.recorded.length, 0)
  // a later retry is not blocked by a leftover marker: it reaches the (still failing) controller again, so it fails the same way
  const retry = await env.queue.triageReview(id, { review: 'mark-wrong', text: 'fix it' })
  assert.equal(retry.ok, false)
  assert.equal(env.store.get(id).resolution.review, undefined)
  const good = setup({ slow: true })
  const gid = aiItem(good, done())
  assert.equal(good.store.get(gid).resolution.review, undefined)
  assert.deepEqual(await good.queue.triageReview(gid, { review: 'mark-wrong', text: 'fix it' }), { ok: true })
  assert.equal(prompts(good), 1)
})

test('mark-wrong retry after a failed first send really sends once the controller recovers', async () => {
  let fail = true
  let sent = 0
  const store = createStore({ now: () => 1000, uuid: () => 'x1' })
  const rules = { list: () => [], get: () => ({ id: 'green-done', mode: 'auto' }), setMode: () => true }
  const recorded = []
  const memory = { record: (a) => { recorded.push(a) } }
  const ctl = { prompt: async () => { await new Promise((resolve) => setTimeout(resolve, 5)); if (fail) throw new Error('boom'); sent++; return {} } }
  const queue = createReviewQueue({ store, capture: { answerQuestion: () => ({ ok: true }), decidePermission: () => ({ ok: true }), lateAnswerQuestion: async () => ({ ok: true }) }, controllerOf: () => ctl, now: () => 5000, triageApi: { rules, memory } })
  const item = store.add(done())
  store.resolve(item.id, aiResolution({ ruleId: 'green-done', ruleVersion: 'd2' }))
  assert.equal((await queue.triageReview(item.id, { review: 'mark-wrong', text: 'fix' })).ok, false)
  fail = false
  assert.deepEqual(await queue.triageReview(item.id, { review: 'mark-wrong', text: 'fix' }), { ok: true })
  assert.equal(sent, 1)
  assert.equal(store.get(item.id).resolution.review, 'overruled')
  assert.equal(recorded.length, 1)
})

test('mark-wrong with blank text neither marks the item nor blocks a valid send that follows', async () => {
  const env = setup({ slow: true })
  const id = aiItem(env, done())
  const [blank, valid] = await Promise.all([
    env.queue.triageReview(id, { review: 'mark-wrong', text: '   ' }),
    env.queue.triageReview(id, { review: 'mark-wrong', text: 'real' }),
  ])
  assert.deepEqual(blank, { ok: false, error: 'empty' })
  assert.deepEqual(valid, { ok: true })
  assert.equal(prompts(env), 1)
  assert.equal(env.store.get(id).resolution.review, 'overruled')
  assert.equal(env.recorded.length, 1)
})

test('agreed and overrule-rule sent twice at once record once and lower the mode once', async () => {
  const env = setup({ slow: true })
  const a = aiItem(env, perm())
  const outA = await Promise.all([1, 2].map(() => env.queue.triageReview(a, { review: 'agreed' })))
  assert.deepEqual(outA, [{ ok: true }, { ok: true }])
  assert.equal(env.recorded.length, 1)
  const o = setup({ slow: true })
  const b = aiItem(o, perm())
  const outB = await Promise.all([1, 2].map(() => o.queue.triageReview(b, { review: 'overrule-rule' })))
  assert.deepEqual(outB, [{ ok: true }, { ok: true }])
  assert.equal(o.recorded.length, 1)
  assert.equal(o.calls.filter((c) => c[0] === 'setMode').length, 1)
  assert.equal(o.modes['ro-permission'], 'observe')
})

test('overrule-rule drops the rule of the item from auto to observe by default and records an overrule', async () => {
  const env = setup()
  const id = aiItem(env, perm())
  assert.deepEqual(await env.queue.triageReview(id, { review: 'overrule-rule' }), { ok: true })
  assert.equal(env.modes['ro-permission'], 'observe')
  assert.equal(env.modes['green-done'], 'auto')
  const r = env.store.get(id).resolution
  assert.equal(r.review, 'overruled')
  assert.equal(r.seen, true)
  assert.equal(env.recorded.length, 1)
  assert.equal(env.recorded[0].review, 'overruled')
  assert.equal(env.recorded[0].source, 'overrule-rule')
})

test('overrule-rule can switch the rule off, and rejects any other mode without changing anything', async () => {
  const env = setup()
  const id = aiItem(env, perm())
  assert.deepEqual(await env.queue.triageReview(id, { review: 'overrule-rule', mode: 'auto' }), { ok: false, error: 'bad-mode' })
  assert.deepEqual(await env.queue.triageReview(id, { review: 'overrule-rule', mode: 'yolo' }), { ok: false, error: 'bad-mode' })
  assert.equal(env.modes['ro-permission'], 'auto')
  assert.equal(env.store.get(id).resolution.review, undefined)
  assert.equal(env.recorded.length, 0)
  assert.deepEqual(await env.queue.triageReview(id, { review: 'overrule-rule', mode: 'off' }), { ok: true })
  assert.equal(env.modes['ro-permission'], 'off')
})

test('an unknown review value is bad-review', async () => {
  const env = setup()
  const id = aiItem(env, perm())
  assert.deepEqual(await env.queue.triageReview(id, { review: 'shrug' }), { ok: false, error: 'bad-review' })
  assert.deepEqual(await env.queue.triageReview(id, {}), { ok: false, error: 'bad-review' })
})

test('agreed, mark-wrong and overrule-rule refuse an item that is not AI-resolved', async () => {
  const env = setup()
  const human = env.store.add(done())
  env.store.resolve(human.id, { kind: 'reviewed', by: 'card' })
  for (const review of ['agreed', 'mark-wrong', 'overrule-rule']) {
    const out = await env.queue.triageReview(human.id, { review, text: 'x' })
    assert.deepEqual(out, { ok: false, error: 'not-ai-resolved' }, review)
  }
  assert.equal(env.recorded.length, 0)
})

test('reopen puts an AI-resolved completed or paused item back, with its resolution gone', () => {
  const env = setup()
  const c = aiItem(env, done(), { action: 'cleared', ruleId: 'green-done' })
  const p = aiItem(env, { type: 'paused', sessionId: 's2', payload: { reason: 'limit' } }, { action: 'resumed' })
  assert.deepEqual(env.queue.reopen(c), { ok: true })
  assert.deepEqual(env.queue.reopen(p), { ok: true })
  for (const id of [c, p]) {
    assert.equal(env.store.get(id).status, 'open')
    assert.equal(env.store.get(id).resolution, undefined)
  }
})

test('reopen refuses an AI-resolved question or permission: the answer was already given', () => {
  const env = setup()
  const q = aiItem(env, { type: 'question', sessionId: 's', payload: { questions: [] } }, { action: 'answered', answer: 'A' })
  const p = aiItem(env, perm(), { action: 'approved' })
  assert.deepEqual(env.queue.reopen(q), { ok: false, error: 'not-reopenable' })
  assert.deepEqual(env.queue.reopen(p), { ok: false, error: 'not-reopenable' })
  assert.equal(env.store.get(q).status, 'resolved')
  assert.equal(env.store.get(p).status, 'resolved')
})

test('reopen keeps refusing a completed item resolved by a human with an old non-reopenable kind', () => {
  const env = setup()
  const c = env.store.add(done())
  env.store.resolve(c.id, { kind: 'replied', by: 'card' })
  assert.deepEqual(env.queue.reopen(c.id), { ok: false, error: 'not-reopenable' })
})

// The desktop client (isReopenable) and the service (reopen) each own a copy of the reopen rule; the same table runs through both.
const clientFile = fileURLToPath(new URL('../lib/client.js', import.meta.url))
function clientReopenable() {
  let registered
  const sandbox = { window: { __ModuleLoader__: { load: (r) => { registered = r } }, localStorage: { getItem: () => null, setItem: () => {} } }, console, setTimeout, clearTimeout, setInterval, clearInterval, fetch: () => new Promise(() => {}) }
  vm.runInNewContext(readFileSync(clientFile, 'utf8'), sandbox, { filename: clientFile })
  const stubReact = { createElement: () => null, Fragment: Symbol('Fragment'), useState() {}, useEffect() {}, useRef() {}, useSyncExternalStore() {} }
  return registered.factory(() => stubReact).__test.isReopenable
}

test('the client reopen rule and the service reopen agree on every (type, resolution kind, status)', () => {
  const isReopenable = clientReopenable()
  const inputOf = { completed: done(), paused: { type: 'paused', sessionId: 's2', payload: { reason: 'limit' } }, question: { type: 'question', sessionId: 's', payload: { questions: [] } }, permission: perm() }
  const humanKinds = ['reviewed', 'superseded', 'no-action', 'trimmed']
  const rows = []
  for (const type of Object.keys(inputOf)) {
    for (const kind of [...humanKinds, 'ai-resolved', 'replied']) {
      rows.push({ type, kind, status: 'resolved', expected: type === 'completed' ? kind !== 'replied' : kind === 'ai-resolved' && type === 'paused' })
    }
    rows.push({ type, kind: undefined, status: 'open', expected: false })
  }
  for (const row of rows) {
    const env = setup()
    const item = env.store.add(inputOf[row.type])
    if (row.status === 'resolved') assert.equal(env.store.resolve(item.id, row.kind === 'ai-resolved' ? aiResolution({ action: 'cleared' }) : { kind: row.kind, by: 'card' }), true)
    const label = row.type + '/' + row.kind + '/' + row.status
    assert.equal(isReopenable(env.store.get(item.id)), row.expected, 'client ' + label)
    assert.equal(env.queue.reopen(item.id).ok, row.expected, 'service ' + label)
  }
})
const gateOf = () => { let open; const promise = new Promise((resolve) => { open = resolve }); setTimeout(open, 500).unref(); return { promise, open } } // a failing assertion never leaves the send hanging
const tick = () => new Promise((resolve) => setTimeout(resolve, 5))

test('mark-wrong whose item is reopened during the send neither marks nor records, and answers ok', async () => {
  const gate = gateOf()
  const env = setup({ gate })
  const id = aiItem(env, done())
  const pending = env.queue.triageReview(id, { review: 'mark-wrong', text: 'fix it' })
  await tick()
  assert.deepEqual(env.queue.reopen(id), { ok: true })
  gate.open()
  assert.deepEqual(await pending, { ok: true })
  assert.equal(env.store.get(id).status, 'open')
  assert.equal(env.store.get(id).resolution, undefined)
  assert.equal(env.recorded.length, 0)
  assert.equal(prompts(env), 1)
})

test('mark-wrong is busy while its session has a post in flight, sends nothing and marks nothing; duplicates still answer ok', async () => {
  const env = setup()
  const id = aiItem(env, done())
  env.posting.add('s1')
  assert.deepEqual(await env.queue.triageReview(id, { review: 'mark-wrong', text: 'fix it' }), { ok: false, error: 'busy' })
  assert.equal(prompts(env), 0)
  assert.equal(env.store.get(id).resolution.review, undefined)
  env.posting.delete('s1')
  assert.deepEqual(await env.queue.triageReview(id, { review: 'mark-wrong', text: 'fix it' }), { ok: true })
  assert.equal(prompts(env), 1)
  assert.equal(env.posting.has('s1'), false)
})

test('a reply-path post to the session during a mark-wrong send is busy, and works once it settles', async () => {
  const gate = gateOf()
  const env = setup({ gate })
  const id = aiItem(env, done())
  const other = env.store.add(done({ sessionTitle: 'Two' }))
  const pending = env.queue.triageReview(id, { review: 'mark-wrong', text: 'fix it' })
  await tick()
  assert.deepEqual(await env.queue.post(other.id, 'hello'), { ok: false, error: 'busy' })
  gate.open()
  assert.deepEqual(await pending, { ok: true })
  assert.equal((await env.queue.post(other.id, 'hello')).ok, true)
})
test('raising a rule to auto needs confirmed === true: refused otherwise, mode unchanged', () => {
  const env = setup()
  env.modes['ro-permission'] = 'observe'
  env.modes['green-done'] = 'off'
  const refused = { ok: false, error: 'needs-confirm' }
  assert.deepEqual(env.queue.triageRuleMode('ro-permission', 'auto'), refused)
  assert.deepEqual(env.queue.triageRuleMode('ro-permission', 'auto', { confirmed: false }), refused)
  assert.deepEqual(env.queue.triageRuleMode('ro-permission', 'auto', { confirmed: 'true' }), refused)
  assert.deepEqual(env.queue.triageRuleMode('ro-permission', 'auto', { confirmed: 1 }), refused)
  assert.deepEqual(env.queue.triageRuleMode('green-done', 'auto'), refused)
  assert.equal(env.modes['ro-permission'], 'observe')
  assert.equal(env.modes['green-done'], 'off')
  assert.equal(env.calls.filter((c) => c[0] === 'setMode').length, 0)
  assert.deepEqual(env.queue.triageRuleMode('ro-permission', 'auto', { confirmed: true }), { ok: true })
  assert.equal(env.modes['ro-permission'], 'auto')
  assert.deepEqual(env.queue.triageRuleMode('green-done', 'auto', { confirmed: true }), { ok: true })
  assert.equal(env.modes['green-done'], 'auto')
})

test('lowering, setting the same mode (auto -> auto) and setting off or observe need no confirmation', () => {
  const env = setup()
  assert.deepEqual(env.queue.triageRuleMode('ro-permission', 'auto'), { ok: true })
  assert.deepEqual(env.queue.triageRuleMode('ro-permission', 'observe'), { ok: true })
  assert.equal(env.modes['ro-permission'], 'observe')
  assert.deepEqual(env.queue.triageRuleMode('ro-permission', 'observe'), { ok: true })
  assert.deepEqual(env.queue.triageRuleMode('ro-permission', 'off'), { ok: true })
  assert.equal(env.modes['ro-permission'], 'off')
  assert.deepEqual(env.queue.triageRuleMode('green-done', 'off'), { ok: true })
  assert.deepEqual(env.queue.triageRuleMode('green-done', 'observe'), { ok: true })
  assert.equal(env.modes['green-done'], 'observe')
})

test('every successful mode change is logged with the old and new mode; a refusal is not', () => {
  const logs = []
  const env = setup({ logs })
  assert.deepEqual(env.queue.triageRuleMode('ro-permission', 'observe'), { ok: true })
  env.queue.triageRuleMode('ro-permission', 'auto')
  assert.deepEqual(logs, ['triage: rule ro-permission mode auto -> observe'])
  env.queue.triageRuleMode('ro-permission', 'auto', { confirmed: true })
  assert.deepEqual(logs, ['triage: rule ro-permission mode auto -> observe', 'triage: rule ro-permission mode observe -> auto'])
})

test('mark-wrong whose item is agreed during the send stays agreed: no overrule mark, one memory case, ok, one prompt', async () => {
  const gate = gateOf()
  const env = setup({ gate })
  const id = aiItem(env, done())
  const pending = env.queue.triageReview(id, { review: 'mark-wrong', text: 'fix it' })
  await tick()
  assert.deepEqual(await env.queue.triageReview(id, { review: 'agreed' }), { ok: true })
  gate.open()
  assert.deepEqual(await pending, { ok: true })
  assert.equal(env.store.get(id).resolution.review, 'agreed')
  assert.equal(env.recorded.length, 1)
  assert.equal(env.recorded[0].review, 'matched-user')
  assert.equal(prompts(env), 1)
})
test('mark-wrong whose item is overruled by a concurrent overrule-rule during the send learns once: no second record, ok, one prompt', async () => {
  const gate = gateOf()
  const env = setup({ gate })
  const id = aiItem(env, done())
  const pending = env.queue.triageReview(id, { review: 'mark-wrong', text: 'fix it' })
  await tick()
  assert.deepEqual(await env.queue.triageReview(id, { review: 'overrule-rule' }), { ok: true })
  gate.open()
  assert.deepEqual(await pending, { ok: true })
  assert.equal(env.store.get(id).resolution.review, 'overruled')
  assert.equal(env.recorded.length, 1)
  assert.equal(env.recorded[0].source, 'overrule-rule')
  assert.equal(prompts(env), 1)
})

test('triageRuleMode on an unknown rule is bad-rule even when raising to auto without confirmation', () => {
  const env = setup()
  assert.deepEqual(env.queue.triageRuleMode('nope', 'auto'), { ok: false, error: 'bad-rule' })
})

test('mark-wrong on a paused item is refused like a reply: paused, nothing sent, marked or recorded', async () => {
  const env = setup()
  const id = aiItem(env, { type: 'paused', sessionId: 's2', payload: { reason: 'limit' } }, { action: 'resumed' })
  assert.deepEqual(await env.queue.triageReview(id, { review: 'mark-wrong', text: 'fix it' }), { ok: false, error: 'paused' })
  assert.equal(prompts(env), 0)
  assert.equal(env.store.get(id).resolution.review, undefined)
  assert.equal(env.recorded.length, 0)
})

test('mark-wrong on an item without a session is not-a-session: nothing sent, marked or recorded, and two such items are never busy', async () => {
  const env = setup()
  const ids = [undefined, ''].map((sessionId) => aiItem(env, done({ sessionId })))
  for (const id of ids) {
    assert.deepEqual(await env.queue.triageReview(id, { review: 'mark-wrong', text: 'fix it' }), { ok: false, error: 'not-a-session' })
    assert.equal(env.store.get(id).resolution.review, undefined)
  }
  assert.equal(prompts(env), 0)
  assert.equal(env.recorded.length, 0)
  const out = await Promise.all(ids.map((id) => env.queue.triageReview(id, { review: 'mark-wrong', text: 'fix it' })))
  assert.deepEqual(out, [{ ok: false, error: 'not-a-session' }, { ok: false, error: 'not-a-session' }])
  assert.equal(env.posting.size, 0)
})

test('seen on an item already seen answers ok without touching the store', async () => {
  const env = setup()
  const id = aiItem(env, perm(), { seen: true })
  const updates = []
  const real = env.store.update.bind(env.store)
  env.store.update = (...a) => { updates.push(a); return real(...a) }
  assert.deepEqual(await env.queue.triageReview(id, { review: 'seen' }), { ok: true })
  assert.equal(updates.length, 0)
  assert.equal(env.store.get(id).resolution.seen, true)
})

test('seen on an unseen item still marks it seen through the store', async () => {
  const env = setup()
  const id = aiItem(env, perm())
  const updates = []
  const real = env.store.update.bind(env.store)
  env.store.update = (...a) => { updates.push(a); return real(...a) }
  assert.deepEqual(await env.queue.triageReview(id, { review: 'seen' }), { ok: true })
  assert.equal(updates.length, 1)
  assert.equal(env.store.get(id).resolution.seen, true)
})

test('mark-wrong on an item already marked Looks right answers already-reviewed before sending anything', async () => {
  const env = setup()
  const id = aiItem(env, done({ sessionId: 'sess-9' }))
  assert.deepEqual(await env.queue.triageReview(id, { review: 'agreed' }), { ok: true })
  const recordedBefore = env.recorded.length
  const out = await env.queue.triageReview(id, { review: 'mark-wrong', text: 'actually wrong' })
  assert.deepEqual(out, { ok: false, error: 'already-reviewed' })
  assert.equal(env.calls.filter((c) => c[0] === 'attempt' || c[0] === 'prompt').length, 0)
  assert.equal(env.posting.size, 0)
  assert.equal(env.store.get(id).resolution.review, 'agreed')
  assert.equal(env.recorded.length, recordedBefore)
})

test('mark-wrong on an agreed item answers already-reviewed even with blank text and while the session has a prompt in flight', async () => {
  const env = setup()
  const id = aiItem(env, done({ sessionId: 'sess-9' }), { review: 'agreed', seen: true })
  env.posting.add('sess-9')
  assert.deepEqual(await env.queue.triageReview(id, { review: 'mark-wrong', text: '' }), { ok: false, error: 'already-reviewed' })
  assert.deepEqual(await env.queue.triageReview(id, { review: 'mark-wrong', text: 'x' }), { ok: false, error: 'already-reviewed' })
  assert.deepEqual([...env.posting], ['sess-9'])
  assert.equal(env.calls.filter((c) => c[0] === 'attempt' || c[0] === 'prompt').length, 0)
})


// Failure logging: guard() and triageReview's catch hand the injected log one sanitized line (an error code/name, never the message) and still answer 'failed'.
const LOG_LINE = /^triage-review: [A-Za-z0-9_-]{1,60}$/
const SECRET = 'secret item text git status'
const boom = () => Object.assign(new Error(SECRET), { code: 'EBOOM' })

function failingApi(method) {
  const rules = { list: () => [], get: () => undefined, setMode: () => true }
  const memory = { cases: () => [], lessons: () => [], forget: () => true, record: () => ({ case: {} }) }
  if (method === 'cases') memory.cases = () => { throw boom() }
  return { rules, memory }
}

test('a store whose get throws makes triageReview answer failed and log one triage-review line without the message', async () => {
  const logs = []
  const env = setup({ logs })
  env.store.get = () => { throw boom() }
  assert.deepEqual(await env.queue.triageReview('x', { review: 'seen' }), { ok: false, error: 'failed' })
  assert.equal(logs.length, 1)
  assert.match(logs[0], LOG_LINE)
  assert.ok(!logs[0].includes(SECRET))
})

test('a memory method that throws inside triageRules answers failed and logs one triage-review line', () => {
  const logs = []
  const store = createStore({ now: () => 1000, uuid: () => 'i1' })
  const queue = createReviewQueue({ store, capture: {}, posting: new Set(), controllerOf: () => undefined, now: () => 5000, log: (m) => logs.push(m), triageApi: failingApi('cases') })
  assert.deepEqual(queue.triageRules(), { ok: false, error: 'failed' })
  assert.equal(logs.length, 1)
  assert.match(logs[0], LOG_LINE)
  assert.ok(!logs[0].includes(SECRET))
})

test('a log that throws does not change the failed answer and does not throw', async () => {
  const store = createStore({ now: () => 1000, uuid: () => 'i1' })
  const queue = createReviewQueue({ store, capture: {}, posting: new Set(), controllerOf: () => undefined, now: () => 5000, log: () => { throw new Error('log down') }, triageApi: failingApi('cases') })
  assert.deepEqual(queue.triageRules(), { ok: false, error: 'failed' })
  const env = setup({ logs: [] })
  env.store.get = () => { throw boom() }
  const q2 = createReviewQueue({ store: env.store, capture: {}, posting: new Set(), controllerOf: () => undefined, now: () => 5000, log: () => { throw new Error('log down') }, triageApi: failingApi() })
  assert.deepEqual(await q2.triageReview('x', { review: 'seen' }), { ok: false, error: 'failed' })
})

test('successful triage calls and plain not-found answers do not log a triage-review line', async () => {
  const logs = []
  const env = setup({ logs })
  assert.equal(env.queue.triageRules().ok, true)
  assert.deepEqual(env.queue.triageForget('l1'), { ok: true })
  assert.deepEqual(await env.queue.triageReview('missing', { review: 'seen' }), { ok: false, error: 'not-found' })
  assert.deepEqual(logs.filter((l) => l.startsWith('triage-review: ')), [])
})
