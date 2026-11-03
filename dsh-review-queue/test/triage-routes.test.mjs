// Phase 3 slice 1: the HTTP routes of the AI triage review (POST /v1/triage-review, /v1/triage-rule-mode, /v1/triage-forget; GET /v1/triage-rules).
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { createRouter } from '../server.js'

let server, base
const seen = []
before(async () => {
  const queue = {
    triageReview: async (id, opts) => { seen.push(['review', id, opts]); return opts?.review === 'shrug' ? { ok: false, error: 'bad-review' } : { ok: true } },
    triageRuleMode: (id, mode, opts) => { seen.push(['mode', id, mode, opts]); if (id === 'nope') return { ok: false, error: 'bad-rule' }; if (id === 'needs') return { ok: false, error: 'needs-confirm' }; return mode === 'auto' || mode === 'off' || mode === 'observe' ? { ok: true } : { ok: false, error: 'bad-mode' } },
    triageForget: (id) => { seen.push(['forget', id]); return id === 'l1' ? { ok: true } : { ok: false, error: 'not-found' } },
    triageRules: () => ({ ok: true, rules: [{ id: 'ro-permission' }], lessons: [] }),
  }
  const serve = createRouter({ queue })
  server = createServer((req, res) => serve(req, res))
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  base = 'http://127.0.0.1:' + server.address().port
})
after(() => new Promise((r) => { server.closeAllConnections?.(); server.close(r) }))

const post = (path, body) => fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })

test('POST /v1/triage-review passes the id as a string, the review and the text to the queue', async () => {
  const res = await post('/v1/triage-review', { id: 42, review: 'mark-wrong', text: 'nope' })
  assert.equal(res.status, 200)
  assert.deepEqual(await res.json(), { ok: true })
  assert.deepEqual(seen.at(-1), ['review', '42', { review: 'mark-wrong', text: 'nope', mode: undefined }])
})

test('POST /v1/triage-review also hands the requested mode to overrule-rule', async () => {
  await post('/v1/triage-review', { id: 'a', review: 'overrule-rule', mode: 'off' })
  assert.deepEqual(seen.at(-1), ['review', 'a', { review: 'overrule-rule', text: undefined, mode: 'off' }])
})

test('POST /v1/triage-rule-mode passes ruleId as a string and the mode, and a bad mode is a failure outcome', async () => {
  const ok = await post('/v1/triage-rule-mode', { ruleId: 'ro-permission', mode: 'auto' })
  assert.equal(ok.status, 200)
  assert.deepEqual(seen.at(-1), ['mode', 'ro-permission', 'auto', { confirmed: false }])
  const bad = await post('/v1/triage-rule-mode', { ruleId: 'ro-permission', mode: 'yolo' })
  assert.notEqual(bad.status, 200)
  assert.deepEqual(await bad.json(), { ok: false, error: 'bad-mode' })
})

test('malformed triage input (bad-mode, bad-review, bad-rule, needs-confirm) is a 400, not a 409', async () => {
  assert.equal((await post('/v1/triage-rule-mode', { ruleId: 'ro-permission', mode: 'yolo' })).status, 400)
  assert.equal((await post('/v1/triage-review', { id: 'a', review: 'shrug' })).status, 400)
  assert.equal((await post('/v1/triage-rule-mode', { ruleId: 'nope', mode: 'off' })).status, 400)
  assert.equal((await post('/v1/triage-rule-mode', { ruleId: 'needs', mode: 'auto' })).status, 400)
})

test('POST /v1/triage-forget coerces the id and reports not-found', async () => {
  assert.equal((await post('/v1/triage-forget', { id: 'l1' })).status, 200)
  const gone = await post('/v1/triage-forget', { id: 7 })
  assert.notEqual(gone.status, 200)
  assert.deepEqual(seen.at(-1), ['forget', '7'])
})

test('GET /v1/triage-rules returns the rules and lessons; other methods are refused', async () => {
  const res = await fetch(base + '/v1/triage-rules')
  assert.equal(res.status, 200)
  const body = await res.json()
  assert.equal(body.ok, true)
  assert.equal(body.rules[0].id, 'ro-permission')
  assert.equal((await post('/v1/triage-rules', {})).status, 405)
})

test('the three triage POST routes are real actions, not unknown-action 404s', async () => {
  for (const path of ['/v1/triage-review', '/v1/triage-rule-mode', '/v1/triage-forget']) assert.notEqual((await post(path, {})).status, 404, path)
})

test('POST /v1/triage-rule-mode passes confirmed only when it is the boolean true', async () => {
  await post('/v1/triage-rule-mode', { ruleId: 'r', mode: 'auto', confirmed: true })
  assert.deepEqual(seen.at(-1), ['mode', 'r', 'auto', { confirmed: true }])
  await post('/v1/triage-rule-mode', { ruleId: 'r', mode: 'auto', confirmed: 'true' })
  assert.deepEqual(seen.at(-1), ['mode', 'r', 'auto', { confirmed: false }])
})


test('triage-review / triage-forget with a missing or non-string id, and triage-rule-mode with a missing or non-string ruleId, are 400 bad-input and never reach the queue', async () => {
  const before = seen.length
  const cases = [
    ['/v1/triage-review', { review: 'agreed' }], ['/v1/triage-review', { id: null, review: 'agreed' }], ['/v1/triage-review', { id: { x: 1 }, review: 'agreed' }],
    ['/v1/triage-forget', {}], ['/v1/triage-forget', { id: null }], ['/v1/triage-forget', { id: ['l1'] }],
    ['/v1/triage-rule-mode', { mode: 'off' }], ['/v1/triage-rule-mode', { ruleId: null, mode: 'off' }], ['/v1/triage-rule-mode', { ruleId: { x: 1 }, mode: 'off' }],
  ]
  for (const [path, body] of cases) {
    const res = await post(path, body)
    assert.equal(res.status, 400, path + ' ' + JSON.stringify(body))
    assert.deepEqual(await res.json(), { ok: false, error: 'bad-input' }, path + ' ' + JSON.stringify(body))
  }
  assert.equal(seen.length, before, 'the queue was not called')
})

test('valid string ids still reach the queue and behave as before', async () => {
  assert.equal((await post('/v1/triage-forget', { id: 'l1' })).status, 200)
  assert.equal((await post('/v1/triage-forget', { id: 'nope-id' })).status, 409)
  assert.equal((await post('/v1/triage-review', { id: 'a', review: 'agreed' })).status, 200)
  assert.equal((await post('/v1/triage-rule-mode', { ruleId: 'ro-permission', mode: 'off' })).status, 200)
})
