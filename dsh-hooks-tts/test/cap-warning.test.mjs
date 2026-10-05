import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { installContextCap } from '../cap.js'
import { createSettings } from '../settings.js'

function harness({ cap = 400_000, prLines, ...extra } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'cap-'))
  const settings = createSettings(dir, { contextCapTokens: cap, ...extra })
  const state = { tokens: 0, title: undefined }
  let sink
  const calls = { create: 0, prompt: 0, rename: [] }
  const controller = {
    create: async () => { calls.create++; return { sessionId: 's2' } },
    resolveAgent: async () => ({ agent: { session: { append() {} } } }),
    rename: async (r) => { calls.rename.push(r) },
    prompt: async (req) => { calls.prompt++; sink?.push(req) },
  }
  const handlers = {}
  const ctx = {
    logger: { warn() {}, info() {} },
    get: (name) => {
      if (name === 'sessionProjections') return { snapshot: () => ({ values: { contextPressure: { projectedTokens: state.tokens } } }) }
      if (name === 'sessionTitle') return { get: () => (state.title === undefined ? undefined : { title: state.title }) }
      if (name === 'sessionController') return controller
      return undefined
    },
    on: (event, fn) => { handlers[event] = fn },
  }
  const cap_ = installContextCap(ctx, { handoffDir: dir }, { skip: () => false, makeMessage: (text) => ({ text }), settings, prHandoff: prLines ? () => prLines : undefined })
  const steered = []
  const agent = { id: 'a', session: { header: { cwd: 'C:/proj' }, snapshotEvents: () => [] }, steer: (m) => steered.push(m) }
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
  return { agentRef: agent, dir, spawnApproved: cap_.spawnApproved, step, stepFull, stop, steered, settings, state, calls, setPromptSink: (s) => { sink = s } }
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

test('PR-titled session at the cap gets the notice, never the handoff instruction', async () => {
  const h = harness()
  h.state.title = 'PR 12345 - fix login'
  assert.deepEqual(await h.step(340_000), ['CONTEXT NOTICE'])
  const out = await h.stepFull(450_000)
  assert.match(out[0].text, /PR state/)
  assert.match(out[0].text, /no new session opens/)
  assert.doesNotMatch(out[0].text, /Stop the current work|Write a handoff note NOW/)
  await h.stop(450_000)
  assert.equal(h.steered.length, 0)
})

test('PR-titled session is not auto-respawned and the setting value is untouched', async () => {
  const h = harness()
  h.state.title = 'PR 7'
  await h.stop(450_000)
  assert.equal(h.calls.create, 0)
  assert.equal(h.settings.get().autoResumeHandoff, true)
})

test('a mid-run rename to PR <n> after the handoff request cancels the respawn', async () => {
  const h = harness()
  h.state.title = 'feature work'
  const [msg] = await h.stepFull(450_000)
  const path = /Write a handoff note NOW to: (.+)/.exec(msg.text)[1]
  writeFileSync(path, '# note\nMode: plain\n')
  h.state.title = 'PR 99'
  await h.stop(450_000)
  assert.equal(h.calls.create, 0)
  assert.equal(h.settings.get().autoResumeHandoff, true)
})

test('non-PR session with auto-resume on still gets instructed and respawned', async () => {
  const h = harness()
  h.state.title = 'Project PR 12 review' // does not start with "PR <n>"
  const [msg] = await h.stepFull(450_000)
  assert.match(msg.text, /CONTEXT CAP REACHED/)
  writeFileSync(/Write a handoff note NOW to: (.+)/.exec(msg.text)[1], '# note\nMode: plain\n')
  await h.stop(450_000)
  assert.equal(h.calls.create, 1)
  assert.equal(h.calls.prompt, 1)
  assert.equal(h.settings.get().autoResumeHandoff, true)
})

test('handoff instruction carries the PR lines when a poll is registered', async () => {
  const h = harness({ prLines: ['PR: 42', 'PR-POLL: 42 seen=5:9'] })
  const [msg] = await h.stepFull(450_000)
  assert.match(msg.text, /^PR: 42$/m)
  assert.match(msg.text, /^PR-POLL: 42 seen=5:9$/m)
})

test('resume prompt re-emits the PR-POLL marker found in the note', async () => {
  const h = harness()
  const [msg] = await h.stepFull(450_000)
  writeFileSync(/Write a handoff note NOW to: (.+)/.exec(msg.text)[1], '# note\nMode: plain\nPR: 42\nPR-POLL: 42 seen=5:9\n')
  const prompts = []
  h.setPromptSink(prompts)
  await h.stop(450_000)
  assert.match(prompts[0].content[0].text, /^PR-POLL: 42 seen=5:9$/m)
})
// ---- user-approved one-shot spawn from a PR-state session ----

const note = (h, name, body, ageSec) => {
  const p = join(h.dir, name)
  writeFileSync(p, body)
  const when = new Date(Date.now() - ageSec * 1000)
  utimesSync(p, when, when)
  return p
}

test('spawnApproved: PR-state session spawns from the NEWEST handoff of its project, with a non-PR numbered title', async () => {
  const h = harness({ autoResumeHandoff: false })
  h.state.title = 'PR 7'
  note(h, 'proj-20260101-0900-handoff.md', '# old\nMode: plain\n', 300)
  note(h, 'proj-20260102-0900-handoff.md', '# new\nMode: plain\nPR-POLL: 7 seen=1:2 resume=suggested\n', 100)
  note(h, 'other-20260103-0900-handoff.md', '# unrelated project, newest\nMode: plain\n', 1)
  const prompts = []
  h.setPromptSink(prompts)
  assert.equal(await h.spawnApproved(h.agentRef), true)
  assert.equal(h.calls.create, 1)
  assert.equal(h.calls.prompt, 1)
  assert.match(prompts[0].content[0].text, /proj-20260102-0900-handoff\.md/)
  assert.doesNotMatch(prompts[0].content[0].text, /PR-POLL/) // the new session must not re-enter PR state
  assert.equal(h.calls.rename.length, 1)
  assert.doesNotMatch(h.calls.rename[0].title, /^PR \d+/)
  assert.equal(h.calls.rename[0].sessionId, 's2')
  assert.equal(h.settings.get().autoResumeHandoff, false) // global setting neither read for writing nor changed
})

test('spawnApproved: no handoff file for the project means no spawn', async () => {
  const h = harness()
  h.state.title = 'PR 7'
  note(h, 'other-20260103-0900-handoff.md', '# x\n', 1)
  assert.equal(await h.spawnApproved(h.agentRef), false)
  assert.equal(h.calls.create, 0)
})

test('spawnApproved leaves normal (non-PR) respawn behaviour untouched', async () => {
  const h = harness({ autoResumeHandoff: false })
  h.state.title = 'feature'
  const [msg] = await h.stepFull(450_000)
  writeFileSync(/Write a handoff note NOW to: (.+)/.exec(msg.text)?.[1] ?? join(h.dir, 'x'), '# n\n')
  await h.stop(450_000)
  assert.equal(h.calls.create, 0) // auto-resume off: still no automatic spawn
})
