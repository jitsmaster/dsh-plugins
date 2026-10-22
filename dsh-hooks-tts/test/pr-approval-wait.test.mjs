import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { installPrPoller, isApproved, approvedStartText } from '../pr.js'
import { createSettings } from '../settings.js'

const vote = (v, extra = {}) => ({ displayName: 'r', vote: v, ...extra })

test('isApproved: one approval and nobody waiting or rejecting; required reviewers must approve', () => {
  assert.equal(isApproved(undefined), false)
  assert.equal(isApproved({ reviewers: [] }), false)
  assert.equal(isApproved({ reviewers: [vote(0)] }), false)
  assert.equal(isApproved({ reviewers: [vote(10)] }), true)
  assert.equal(isApproved({ reviewers: [vote(5)] }), true)
  assert.equal(isApproved({ reviewers: [vote(10), vote(-5)] }), false)
  assert.equal(isApproved({ reviewers: [vote(10), vote(-10)] }), false)
  assert.equal(isApproved({ reviewers: [vote(10), vote(0, { isRequired: true })] }), false)
  assert.equal(isApproved({ reviewers: [vote(10), vote(10, { isRequired: true })] }), true)
  assert.equal(isApproved({ reviewers: [vote(10), vote(0, { isContainer: true })] }), true) // a group that did not vote is not a blocker
})

function harness({ withSchedule = false } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'pr-appr-'))
  const settings = createSettings(dir, {})
  const state = { prStatus: 'active', reviewers: [], tasks: [] }
  const handlers = {}
  const prompts = []
  const service = {
    list: async () => state.tasks.slice(),
    create: async (sessionId, input) => { const t = { id: 't' + (state.tasks.length + 1), sessionId, ...input }; state.tasks.push(t); return t },
    delete: async ({ id }) => { state.tasks = state.tasks.filter((t) => t.id !== id) },
  }
  const ctx = {
    logger: { warn() {}, info() {} },
    get: (name) => (name === 'sessionController' ? { prompt: async (r) => { prompts.push(r) } } : name === 'schedule' && withSchedule ? service : name === 'sessionTitle' ? { get: () => ({ title: 'feature - after PR 5' }) } : undefined),
    on: (event, fn) => { (handlers[event] ??= []).push(fn) },
  }
  const fetchImpl = async () => ({ ok: true, status: 200, json: async () => ({ pullRequestId: 5, status: state.prStatus, reviewers: state.reviewers }) })
  const poller = installPrPoller(ctx, {}, { settings, fetchImpl, env: { AZURE_DEVOPS_EXT_PAT: 'pat' } })
  return { poller, state, prompts, handlers }
}
const settle = () => new Promise((r) => setTimeout(r, 30))

test('without a Schedule service the wait timer starts the waiting session once the PR is approved, once', async () => {
  const h = harness()
  h.poller.addWait('f1', '5')
  await settle()
  assert.equal(h.prompts.length, 0, 'not approved yet')
  h.state.reviewers = [vote(10)]
  await h.poller.checkWaits()
  assert.equal(h.prompts.length, 1)
  assert.equal(h.prompts[0].sessionId, 'f1')
  assert.equal(h.prompts[0].content[0].text, approvedStartText('5'))
  await h.poller.checkWaits()
  assert.equal(h.prompts.length, 1, 'never told twice')
  assert.deepEqual(h.poller.waits(), [['f1', '5']], 'the merge still starts / rebases it later')
  h.state.prStatus = 'completed'
  await h.poller.checkWaits()
  assert.equal(h.prompts.length, 2)
  assert.match(h.prompts[1].content[0].text, /was merged/)
})

test('with a Schedule service the waiting session gets ONE "PR <id> approval wait" task, deleted once it is approved and told', async () => {
  const h = harness({ withSchedule: true })
  h.poller.addWait('f1', '5')
  await settle()
  assert.deepEqual(h.state.tasks.map((t) => t.title), ['PR 5 approval wait'])
  assert.equal(h.state.tasks[0].every_seconds, 600)
  assert.match(h.state.tasks[0].prompt, /pr-approval v1 session=f1 pr=5/)
  h.poller.addWait('f1', '5')
  await settle()
  assert.equal(h.state.tasks.length, 1, 'still one task')
  // the tick of the task (a schedule message) is answered by the plugin, without a model call
  const tick = { source: { kind: 'schedule' }, content: [{ type: 'text', text: '[SCHEDULE REMINDER]\nschedule_id_json: "t1"\nreminder_prompt_json: ' + JSON.stringify(h.state.tasks[0].prompt) }] }
  for (const fn of h.handlers['agent/created'] ?? []) fn()
  const intercept = h.handlers['agent/pre-step'].at(-1) // registered by agent/created, outermost
  const out = await intercept({ agent: { id: 'f1' }, messages: [tick] }, async () => ({ kind: 'enter', messages: [] }))
  assert.equal(out.kind, 'enter')
  await settle()
  assert.equal(h.prompts.length, 0, 'not approved yet: nothing sent')
  h.state.reviewers = [vote(10)]
  await intercept({ agent: { id: 'f1' }, messages: [tick] }, async () => ({ kind: 'enter', messages: [] }))
  await settle()
  assert.equal(h.prompts.length, 1)
  assert.equal(h.prompts[0].sessionId, 'f1')
  assert.equal(h.state.tasks.length, 0, 'the task is deleted after the start')
})

test('a merge that ends the wait also deletes the approval task', async () => {
  const h = harness({ withSchedule: true })
  h.poller.addWait('f1', '5')
  await settle()
  assert.equal(h.state.tasks.length, 1)
  h.state.prStatus = 'completed'
  await h.poller.checkWaits()
  await settle()
  assert.equal(h.state.tasks.length, 0)
})
