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

import { Readable } from 'node:stream'
function require_stream(text) { return Readable.from([Buffer.from(text)]) }
