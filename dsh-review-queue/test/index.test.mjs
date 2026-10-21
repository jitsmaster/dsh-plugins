import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply } from '../index.js'

function fakeCtx() {
  const handlers = {}
  const routes = []
  const ctx = {
    on: (n, f) => { (handlers[n] ??= []).push(f) },
    get: () => undefined,
    effect: () => {},
    logger: { warn() {}, info() {} },
    inject: (_names, fn) => fn({ effect: (f) => f(), connection: { admit: () => ({}) }, webServer: { register: (r) => routes.push(r) } }),
  }
  return { ctx, handlers, routes }
}

test('apply registers the capture handlers and one /review-queue route', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rq-'))
  try {
    const { ctx, handlers, routes } = fakeCtx()
    const queue = apply(ctx, { hub: false, stateDir: dir })
    for (const name of ['user-questions/request', 'approval/request', 'agent/turn-stopping', 'agent/pre-step', 'agent/disposed']) assert.ok(handlers[name]?.length, name)
    assert.equal(routes.length, 1)
    assert.equal(routes[0].path, '/review-queue')
    assert.equal(typeof queue.snapshot, 'function')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('the route rejects a request the Host refuses and strips the prefix otherwise', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rq-'))
  try {
    const { ctx, routes } = fakeCtx()
    ctx.inject = (_n, fn) => fn({ effect: (f) => f(), connection: { admit: (req) => (req.deny ? { rejection: 403 } : {}) }, webServer: { register: (r) => routes.push(r) } })
    apply(ctx, { hub: false, stateDir: dir })
    const res = { statusCode: 200, ended: false, end() { this.ended = true } }
    routes[0].handler({ deny: true, url: '/review-queue/v1/snapshot' }, res)
    assert.equal(res.statusCode, 403)
    assert.equal(res.ended, true)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('the queue is saved to queue.json and stale questions are cancelled on the next start', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rq-'))
  try {
    const one = fakeCtx()
    apply(one.ctx, { hub: false, stateDir: dir })
    const agent = { id: 'a', session: { header: {}, deriveMessages: () => [{ role: 'assistant', content: [{ type: 'text', text: 'Finished the thing.' }] }] } }
    await one.handlers['agent/turn-stopping'][0]({ agent })
    one.handlers['user-questions/request'][0]({ agent, questions: [{ id: 'q', question: 'Pick?', options: [{ label: 'A' }] }], wait: { callId: 'c' } }, () => new Promise(() => {}))
    assert.ok(existsSync(join(dir, 'queue.json')))
    const two = fakeCtx()
    const queue = apply(two.ctx, { hub: false, stateDir: dir })
    const snap = queue.snapshot()
    assert.deepEqual(snap.open.map((i) => i.type), ['completed'])
    assert.equal(snap.resolved[0].resolution.by, 'restart')
    assert.ok(readFileSync(join(dir, 'review-queue.log'), 'utf8').includes(snap.resolved[0].id), 'the log names the stale item it cancelled')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('the dev route is off by default and, when enabled, creates a real question item', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rq-'))
  try {
    const off = fakeCtx()
    apply(off.ctx, { hub: false, stateDir: dir })
    const post = (route, body) => new Promise((resolve) => {
      const res = { statusCode: 0, head(code) { this.statusCode = code }, writeHead(code) { this.statusCode = code }, end(text) { resolve({ status: this.statusCode, text }) } }
      const req = Object.assign(require_stream(JSON.stringify(body)), { url: '/review-queue/v1/dev/ask', method: 'POST', headers: { 'content-type': 'application/json' } })
      route.handler(req, res)
    })
    assert.equal((await post(off.routes[0], {})).status, 404)
    const on = fakeCtx()
    const queue = apply(on.ctx, { hub: false, stateDir: join(dir, 'on'), dev: true })
    const r = await post(on.routes[0], { kind: 'question', title: 'Demo', questions: [{ id: 'q', question: 'Pick?', options: [{ label: 'A' }] }] })
    assert.equal(r.status, 200)
    assert.equal(queue.snapshot().open[0].sessionTitle, 'Demo')
    assert.match(queue.snapshot().open[0].sessionId, /^dev-/)
    await post(on.routes[0], { kind: 'question', title: 'Real id', sessionId: 'abc-123', questions: [{ id: 'q', question: 'Pick?', options: [{ label: 'A' }] }] })
    assert.ok(queue.snapshot().open.some((i) => i.sessionId === 'abc-123'))
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

// ---- the question auto-answer is a plugin setting: questionAutoAnswer (default true), questionAutoAnswerLeadSeconds (default 10) ----
const REC_QUESTIONS = [{ id: 'q', question: 'Pick?', options: [{ label: 'A (Recommended)' }, { label: 'B' }] }]
function askRecommended(t, config) {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const dir = mkdtempSync(join(tmpdir(), 'rq-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const { ctx, handlers } = fakeCtx()
  const queue = apply(ctx, { hub: false, stateDir: dir, ...config })
  const agent = { id: 'a', session: { header: {}, deriveMessages: () => [] } }
  void handlers['user-questions/request'][0]({ agent, questions: REC_QUESTIONS, wait: { callId: 'c', timed: true } }, () => new Promise(() => {}))
  const tick = (ms) => t.mock.timers.tick(ms)
  const question = () => [...queue.snapshot().open, ...queue.snapshot().resolved].find((i) => i.type === 'question')
  return { queue, tick, question }
}

test('by default a pending question is answered with its recommended option 10 s before the 120 s window ends', (t) => {
  const x = askRecommended(t, {})
  x.tick(109_000)
  assert.equal(x.question().status, 'open')
  x.tick(1_000)
  assert.equal(x.question().status, 'resolved')
  assert.deepEqual({ kind: x.question().resolution.kind, by: x.question().resolution.by }, { kind: 'answered', by: 'auto' })
  const card = x.queue.snapshot().open.find((i) => i.type === 'completed')
  assert.equal(card?.title, 'Question auto-answered')
  assert.match(card.summary, /the Coding Boss Review Queue answered it for you with the recommended option: "A \(Recommended\)"/)
})

test('questionWindowSeconds is the window of a question the model gave no timeout', (t) => {
  const x = askRecommended(t, { questionWindowSeconds: 60 })
  x.tick(49_000)
  assert.equal(x.question().status, 'open')
  x.tick(1_000)
  assert.equal(x.question().resolution?.by, 'auto')
})

for (const bad of [0, -5, 'soon', Number.NaN, Infinity]) {
  test('questionWindowSeconds ' + String(bad) + ' falls back to the 120 s default', (t) => {
    const x = askRecommended(t, { questionWindowSeconds: bad })
    x.tick(109_000)
    assert.equal(x.question().status, 'open')
    x.tick(1_000)
    assert.equal(x.question().resolution?.by, 'auto')
  })
}

test('a questionAutoAnswerLeadSeconds that is not a number >= 0 falls back to the 10 s default', (t) => {
  const x = askRecommended(t, { questionAutoAnswerLeadSeconds: 'x' })
  x.tick(109_000)
  assert.equal(x.question().status, 'open')
  x.tick(1_000)
  assert.equal(x.question().resolution?.by, 'auto')
})

test('questionAutoAnswerLeadSeconds sets the lead', (t) => {
  const x = askRecommended(t, { questionAutoAnswerLeadSeconds: 30 })
  x.tick(89_000)
  assert.equal(x.question().status, 'open')
  x.tick(1_000)
  assert.equal(x.question().resolution?.by, 'auto')
})

test('questionAutoAnswer: false keeps every question waiting for the user', (t) => {
  const x = askRecommended(t, { questionAutoAnswer: false })
  x.tick(300_000)
  assert.equal(x.question().status, 'open')
})

import { Readable } from 'node:stream'
function require_stream(text) { return Readable.from([Buffer.from(text)]) }

// ---- doneKeepPerSession: how many open done cards one session keeps (default 20) ----
async function finishTurns(config, n) {
  const dir = mkdtempSync(join(tmpdir(), 'rq-'))
  try {
    const { ctx, handlers } = fakeCtx()
    const queue = apply(ctx, { hub: false, stateDir: dir, ...config })
    for (let i = 1; i <= n; i++) {
      const agent = { id: 'a', session: { header: {}, deriveMessages: () => [{ role: 'assistant', content: [{ type: 'text', text: 'Finished ' + i + '.' }] }] } }
      await handlers['agent/turn-stopping'][0]({ agent })
    }
    // The cap applies once each card's summarizer verdict is in (a card hidden as no-action takes no place), so let those settle first.
    for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r))
    const snap = queue.snapshot()
    return { open: snap.open.filter((i) => i.type === 'completed').length, trimmed: snap.resolved.filter((i) => i.resolution?.kind === 'trimmed').length }
  } finally { rmSync(dir, { recursive: true, force: true }) }
}

test('doneKeepPerSession caps the open done cards of a session', async () => {
  assert.deepEqual(await finishTurns({ doneKeepPerSession: 2 }, 5), { open: 2, trimmed: 3 })
})

test('by default a session keeps 20 open done cards, and an invalid doneKeepPerSession falls back to 20', async () => {
  assert.deepEqual(await finishTurns({}, 22), { open: 20, trimmed: 2 })
  for (const bad of [0, -3, 'x']) assert.deepEqual(await finishTurns({ doneKeepPerSession: bad }, 21), { open: 20, trimmed: 1 }, String(bad))
})
