import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { installContextCap } from '../cap.js'
import { createSettings } from '../settings.js'

function harness({ cap = 400_000, prLines, ...extra } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'cap-'))
  const settings = createSettings(dir, { contextCapTokens: cap, ...extra })
  const state = { tokens: 0, title: undefined, events: [] }
  let sink
  const calls = { create: 0, prompt: 0, rename: [] }
  const controller = {
    create: async () => { calls.create++; return { sessionId: `s${calls.create + 1}` } },
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
  const cap_ = installContextCap(ctx, { handoffDir: dir, sparcCommandPath: join(dir, 'sparc.md') }, { skip: () => false, makeMessage: (text) => ({ text }), settings, prHandoff: prLines ? () => prLines : undefined })
  const steered = []
  const agent = { id: 'a', session: { header: { cwd: 'C:/proj' }, snapshotEvents: () => state.events }, steer: (m) => steered.push(m) }
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
  return { agentRef: agent, dir, prCreated: cap_.prCreated, step, stepFull, stop, steered, settings, state, calls, setPromptSink: (s) => { sink = s } }
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
// ---- SPARC mode on resume ----

const SPARC_EVENT = { type: 'message', data: { content: '--- modes:sparc skill content ---\n# Boomerang Commander Mode: Multi-Phase Workflow Orchestration' } }

async function resumeWith(h, noteBody) {
  const [msg] = await h.stepFull(450_000)
  writeFileSync(/Write a handoff note NOW to: (.+)/.exec(msg.text)[1], noteBody)
  const prompts = []
  h.setPromptSink(prompts)
  await h.stop(450_000)
  return prompts[0]?.content[0].text
}

test('resume: note without a Mode line resumes in SPARC when the source session ran SPARC', async () => {
  const h = harness()
  h.state.title = 'feature'
  h.state.events = [SPARC_EVENT]
  assert.match(await resumeWith(h, '# note\n'), /Remain in SPARC mode/)
})

test('resume: note without a Mode line and a non-SPARC source stays plain', async () => {
  const h = harness()
  h.state.title = 'feature'
  assert.doesNotMatch(await resumeWith(h, '# note\n'), /SPARC/)
})

test('resume: an explicit "Mode: plain" wins over a SPARC source; "Mode: sparc" wins over a plain source', async () => {
  const a = harness()
  a.state.title = 'feature'
  a.state.events = [SPARC_EVENT]
  assert.doesNotMatch(await resumeWith(a, '# note\nMode: plain\n'), /SPARC/)
  const b = harness()
  b.state.title = 'feature'
  assert.match(await resumeWith(b, '# note\nMode: sparc\n'), /Remain in SPARC mode/)
})


// ---- PR created: two hand-overs, two sessions ----

const pathsOf = (msg) => ({ pr: /PR handoff note path: (.+)/.exec(msg.text)[1], rest: /Remaining-work handoff note path: (.+)/.exec(msg.text)[1] })

async function startHandover(h, title = 'feature') {
  h.state.title = title
  await h.prCreated(h.agentRef, '42')
  assert.equal(h.steered.length, 0) // the skill's remaining steps run first
  await h.stop(10_000) // turn ends: both notes are requested
  assert.equal(h.steered.length, 1)
  return pathsOf(h.steered[0])
}

test('prCreated: spawns "PR 42" (plain, poll marker) and a gated SPARC "<title> - after PR 42", even with auto-resume off', async () => {
  const h = harness({ autoResumeHandoff: false })
  const p = await startHandover(h)
  assert.match(h.steered[0].text, /PR 42/)
  writeFileSync(p.pr, '# pr\nMode: plain\n')
  writeFileSync(p.rest, '# rest\nMode: sparc\n')
  const prompts = []
  h.setPromptSink(prompts)
  await h.stop(10_000)
  assert.equal(h.calls.create, 2)
  assert.deepEqual(h.calls.rename, [{ sessionId: 's2', title: 'PR 42' }, { sessionId: 's3', title: 'feature - after PR 42' }])
  const [a, b] = prompts.map((r) => r.content[0].text)
  assert.match(a, /^PR-POLL: 42$/m)
  assert.doesNotMatch(a, /SPARC/)
  assert.doesNotMatch(b, /PR-POLL/)
  assert.match(b, /ask_user_question/)
  assert.match(b, /Start now/)
  assert.match(b, /Wait for PR approval/)
  assert.match(b, /echo PR-WAIT: 42/)
  assert.match(b, /origin\/develop/)
  assert.match(b, /Remain in SPARC mode/)
  await h.stop(10_000) // only once
  assert.equal(h.calls.create, 2)
})

test('prCreated: a remaining-work note saying NO-REMAINING-WORK spawns only the PR session', async () => {
  const h = harness()
  const p = await startHandover(h)
  writeFileSync(p.pr, '# pr\n')
  writeFileSync(p.rest, 'NO-REMAINING-WORK\n')
  await h.stop(10_000)
  assert.equal(h.calls.create, 1)
  assert.equal(h.calls.rename[0].title, 'PR 42')
})

test('prCreated: missing notes get one reminder, then the PR session is spawned alone from a fallback note', async () => {
  const h = harness()
  const p = await startHandover(h)
  await h.stop(10_000) // nothing written: one reminder
  assert.equal(h.steered.length, 2)
  assert.equal(h.calls.create, 0)
  const prompts = []
  h.setPromptSink(prompts)
  await h.stop(10_000) // still nothing: fall back
  assert.equal(h.calls.create, 1)
  assert.equal(existsSync(p.pr), true)
  assert.equal(h.calls.rename[0].title, 'PR 42')
  assert.match(prompts[0].content[0].text, /^PR-POLL: 42$/m)
  assert.match(prompts[0].content[0].text, /remaining-work handoff was not written/i)
})

test('prCreated: PR note written but remaining-work note missing -> PR session alone, with a note to tell the user', async () => {
  const h = harness()
  const p = await startHandover(h)
  writeFileSync(p.pr, '# pr\n')
  await h.stop(10_000)
  await h.stop(10_000)
  assert.equal(h.calls.create, 1)
  assert.match(h.steered[1].text, /Remaining-work/)
})

test('prCreated: repeated or from a session already titled PR <n> does nothing', async () => {
  const h = harness()
  h.state.title = 'PR 42'
  await h.prCreated(h.agentRef, '42')
  await h.stop(10_000)
  assert.equal(h.steered.length, 0)
  h.state.title = 'feature'
  await h.prCreated(h.agentRef, '42')
  await h.prCreated(h.agentRef, '42')
  await h.stop(10_000)
  assert.equal(h.steered.length, 1)
})

test('the spawned PR session is not respawned at the cap', async () => {
  const h = harness()
  h.state.title = 'PR 42'
  assert.deepEqual(await h.step(450_000), ['CONTEXT NOTICE'])
})
