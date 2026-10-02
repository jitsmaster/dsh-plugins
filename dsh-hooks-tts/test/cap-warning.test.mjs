import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { installContextCap } from '../cap.js'
import { createSettings } from '../settings.js'

function harness({ cap = 400_000, ...extra } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'cap-'))
  const settings = createSettings(dir, { contextCapTokens: cap, ...extra })
  const state = { tokens: 0 }
  const handlers = {}
  const ctx = {
    logger: { warn() {}, info() {} },
    get: (name) => name === 'sessionProjections'
      ? { snapshot: () => ({ values: { contextPressure: { projectedTokens: state.tokens } } }) }
      : undefined,
    on: (event, fn) => { handlers[event] = fn },
  }
  installContextCap(ctx, { handoffDir: dir }, { skip: () => false, makeMessage: (text) => ({ text }), settings })
  const steered = []
  const agent = { id: 'a', session: { header: { cwd: 'C:/proj' } }, steer: (m) => steered.push(m) }
  const step = async (tokens) => {
    state.tokens = tokens
    const out = await handlers['agent/pre-step']({ agent }, async () => ({ kind: 'enter', messages: [] }))
    return out.messages.map((m) => m.text.split(':')[0])
  }
  const stepFull = async (tokens) => {
    state.tokens = tokens
    return (await handlers['agent/pre-step']({ agent }, async () => ({ kind: 'enter', messages: [] }))).messages
  }
  const stop = async (tokens) => { state.tokens = tokens; await handlers['agent/turn-stopping']({ agent }) }
  return { step, stepFull, stop, steered, settings }
}

test('warns once at warnPercent, then hands off at the cap', async () => {
  const h = harness()
  assert.deepEqual(await h.step(300_000), [])
  assert.deepEqual(await h.step(340_000), ['CONTEXT CAP WARNING'])
  assert.deepEqual(await h.step(350_000), [])
  assert.deepEqual(await h.step(400_000), ['CONTEXT CAP REACHED'])
  assert.deepEqual(await h.step(410_000), [])
})

test('re-arms the warning after context drops', async () => {
  const h = harness()
  assert.deepEqual(await h.step(340_000), ['CONTEXT CAP WARNING'])
  assert.deepEqual(await h.step(100_000), [])
  assert.deepEqual(await h.step(345_000), ['CONTEXT CAP WARNING'])
})

test('warnPercent 0 disables the warning but keeps the handoff', async () => {
  const h = harness({ warnPercent: 0 })
  assert.deepEqual(await h.step(390_000), [])
  assert.deepEqual(await h.step(400_000), ['CONTEXT CAP REACHED'])
})

test('never steers a warning when a turn is stopping', async () => {
  const h = harness()
  await h.stop(345_000)
  assert.equal(h.steered.length, 0)
  await h.stop(400_000)
  assert.equal(h.steered.length, 1)
})

test('warnPercent is validated', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cap-'))
  const settings = createSettings(dir, {})
  assert.throws(() => settings.set({ warnPercent: 120 }))
  assert.equal(settings.set({ warnPercent: 70 }).warnPercent, 70)
})

test('auto-handoff off: only notices, never a handoff instruction', async () => {
  const h = harness({ autoResumeHandoff: false })
  assert.deepEqual(await h.step(300_000), [])
  assert.deepEqual(await h.step(340_000), ['CONTEXT NOTICE'])
  assert.deepEqual(await h.step(399_000), [])
  assert.deepEqual(await h.step(400_000), ['CONTEXT NOTICE'])
  assert.deepEqual(await h.step(450_000), [])
})

test('auto-handoff off: never steers the agent to stop when a turn ends over the cap', async () => {
  const h = harness({ autoResumeHandoff: false })
  await h.stop(450_000)
  assert.equal(h.steered.length, 0)
})

test('auto-handoff off: notice wording says nothing will stop or write a note', async () => {
  const h = harness({ autoResumeHandoff: false })
  const out = await h.stepFull(450_000)
  assert.match(out[0].text, /Automatic handoff is OFF/)
  assert.match(out[0].text, /will NOT be stopped/)
  assert.match(out[0].text, /Never say or imply that the session will stop/)
  assert.doesNotMatch(out[0].text, /Stop the current work|Write a handoff note NOW/)
})

test('turning auto-handoff off mid-session stops handoff instructions', async () => {
  const h = harness()
  assert.deepEqual(await h.step(340_000), ['CONTEXT CAP WARNING'])
  h.settings.set({ autoResumeHandoff: false })
  assert.deepEqual(await h.step(400_000), ['CONTEXT NOTICE'])
})
