/** dsh-hooks-tts publishes the service 'handoffFollowUp' to other plugins (the review queue's "Follow handoff" button): latest(sessionId) and followUp(sessionId). */
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import assert from 'node:assert/strict'
import test from 'node:test'
import { apply } from '../index.js'

// A permissive stand-in for the cordis context (same idea as keep-awake-wiring.test.mjs) that records what the plugin provides to others.
function fakeCtx(provided) {
  const mk = (path) => new Proxy(function () {}, {
    get(_t, k) {
      if (typeof k === 'symbol' || k === 'then') return undefined
      if (path === 'ctx' && k === 'effect') return () => {}
      if (path === 'ctx' && k === 'provide') return (name, service) => { provided.set(name, service) }
      return mk(path + '.' + String(k))
    },
    apply() { return mk(path + '()') },
  })
  return mk('ctx')
}

function start() {
  const provided = new Map()
  apply(fakeCtx(provided), { stateDir: mkdtempSync(join(tmpdir(), 'handoff-svc-')), keepAwake: false })
  return provided
}

test('HF1 the plugin provides handoffFollowUp with latest and followUp', () => {
  const service = start().get('handoffFollowUp')
  assert.ok(service, 'ctx.provide("handoffFollowUp", ...) was called')
  assert.equal(typeof service.latest, 'function')
  assert.equal(typeof service.followUp, 'function')
})

test('HF2 latest(sessionId) is undefined for a session that wrote no handoff note', () => {
  const service = start().get('handoffFollowUp')
  assert.ok(service, 'handoffFollowUp is provided')
  assert.equal(service.latest('no-such-session'), undefined)
})

test('HF3 followUp(sessionId) is the context-cap follow-up: a session without a note is a 404 with no path in it, and it never rejects', async () => {
  const service = start().get('handoffFollowUp')
  assert.ok(service, 'handoffFollowUp is provided')
  const result = await service.followUp('no-such-session')
  assert.deepEqual(result, { status: 404, error: 'this session has no handoff note' })
})
