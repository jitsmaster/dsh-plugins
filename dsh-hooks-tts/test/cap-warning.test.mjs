import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { installContextCap } from '../cap.js'
import { createSettings } from '../settings.js'
import { createGroups, deriveGroupName } from '../groups.js'

function harness({ cap = 400_000, prLines, ...extra } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'cap-'))
  const settings = createSettings(dir, { contextCapTokens: cap, ...extra })
  const state = { tokens: 0, title: undefined, events: [], workspace: undefined, messages: [] }
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
      if (name === 'workspaceRegistry') return { list: () => (state.workspace ? [{ id: state.workspace, sessionIds: ['a'] }] : []) }
      return undefined
    },
    on: (event, fn) => { handlers[event] = fn },
  }
  const groups = createGroups(dir)
  const cap_ = installContextCap(ctx, { handoffDir: dir, sparcCommandPath: join(dir, 'sparc.md') }, { skip: () => false, makeMessage: (text) => ({ text }), settings, prHandoff: prLines ? () => prLines : undefined, groups })
  const steered = []
  const agent = { id: 'a', session: { header: { cwd: 'C:/proj' }, snapshotEvents: () => state.events, deriveMessages: () => state.messages }, steer: (m) => steered.push(m) }
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
  return { agentRef: agent, groups, dir, prCreated: cap_.prCreated, step, stepFull, stop, steered, settings, state, calls, setPromptSink: (s) => { sink = s } }
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

// ---- session groups ----

test('groups: PR creation creates a group named after the session title; PR and follow-up sessions join it', async () => {
  const h = harness({ autoResumeHandoff: false })
  const p = await startHandover(h, 'Add dark mode to settings')
  writeFileSync(p.pr, '# pr\nMode: plain\n')
  writeFileSync(p.rest, '# rest\nMode: sparc\n')
  await h.stop(10_000)
  const groups = h.groups.list()
  assert.equal(groups.length, 1)
  assert.equal(groups[0].name, 'Add dark mode to settings')
  assert.deepEqual(groups[0].sessionIds, ['a', 's2', 's3'])
})

test('groups: a handoff-spawned session creates the group when the source has none, and a later handoff reuses it', async () => {
  const h = harness()
  h.state.title = 'Refactor the billing module'
  assert.match(await resumeWith(h, '# note\nMode: plain\n'), /Resume the work from this handoff/)
  let [g] = h.groups.list()
  assert.equal(g.name, 'Refactor the billing module')
  assert.deepEqual(g.sessionIds, ['a', 's2'])
  assert.equal(h.groups.groupOf('s2').id, g.id)
})

test('groups: a title that does not name the work falls back to the first request, then the project folder', async () => {
  const { deriveGroupName } = await import('../groups.js')
  assert.equal(deriveGroupName({ title: 'PR 42', request: 'Fix flaky login test', cwd: 'C:/proj' }), 'Fix flaky login test')
  assert.equal(deriveGroupName({ title: 'New session', cwd: 'C:/proj' }), 'proj work')
  assert.equal(deriveGroupName({ title: 'ab - after PR 5', request: 'Use the request' }), 'Use the request')
  assert.equal(deriveGroupName({ title: 'Upgrade deps - 2024' }), 'Upgrade deps - 2024')
  assert.equal(deriveGroupName({ title: 'Billing cleanup - 3' }), 'Billing cleanup')
  assert.equal(deriveGroupName({ title: 'Billing cleanup - after PR 5' }), 'Billing cleanup')
})

test('groups: persisted across restarts and one group per session', async () => {
  const h = harness()
  const g = h.groups.ensureGroup('x', 'ws1', { title: 'Alpha work' })
  h.groups.addToGroup(g.id, 'y')
  const again = createGroups(h.dir)
  assert.deepEqual(again.groupOf('y').sessionIds, ['x', 'y'])
  assert.equal(again.list('ws1').length, 1)
  assert.equal(again.list('other').length, 0)
  const g2 = again.ensureGroup('z', 'ws1', { title: 'Beta work' })
  again.addToGroup(g2.id, 'y')
  assert.deepEqual(again.groupOf('x').sessionIds, ['x'])
})

test('groups: the group records the session workspace, and backfills it when it was unknown at creation', async () => {
  const h = harness({ autoResumeHandoff: false })
  h.state.workspace = 'ws-7'
  const p = await startHandover(h, 'Add dark mode to settings')
  writeFileSync(p.pr, '# pr\nMode: plain\n')
  writeFileSync(p.rest, 'NO-REMAINING-WORK\n')
  await h.stop(10_000)
  assert.equal(h.groups.list('ws-7').length, 1)
  const g = h.groups.ensureGroup('late', undefined, { title: 'Late work' })
  assert.equal(g.workspaceId, undefined)
  assert.equal(h.groups.ensureGroup('late', 'ws-9').workspaceId, 'ws-9')
})

test('groups: a follow-up PR created from the "after PR" session reuses the original group', async () => {
  const h = harness({ autoResumeHandoff: false })
  const first = await startHandover(h, 'Add dark mode to settings')
  writeFileSync(first.pr, '# pr\nMode: plain\n')
  writeFileSync(first.rest, '# rest\nMode: sparc\n')
  await h.stop(10_000)
  const [group] = h.groups.list()
  assert.ok(group.sessionIds.includes('s3'))
  assert.equal(h.groups.ensureGroup('s3').id, group.id)
  assert.equal(h.groups.list().length, 1)
})

test('groups: naming skips boilerplate opening lines and the name is only computed when a group is created', async () => {
  const h = harness({ autoResumeHandoff: false })
  h.state.title = 'New session'
  h.state.messages = [{ role: 'user', content: '/modes:sparc\nSession start: do vault things\nAdd retry to the upload client' }]
  let calls = 0
  const origDerive = h.agentRef.session.deriveMessages
  h.agentRef.session.deriveMessages = () => { calls++; return origDerive() }
  await h.prCreated(h.agentRef, '42')
  assert.equal(h.groups.list()[0].name, 'Add retry to the upload client')
  assert.equal(calls, 1)
  // A meaningful title never scans the conversation.
  let scanned = 0
  assert.equal(deriveGroupName({ title: 'Real title', request: () => { scanned++; return 'x' } }), 'Real title')
  assert.equal(scanned, 0)
  let again = 0
  h.groups.ensureGroup('a', undefined, () => { again++; return {} }) // group exists: naming is not evaluated
  assert.equal(again, 0)
})

test('groups: an unreadable groups.json is kept aside instead of being overwritten', async () => {
  const h = harness()
  writeFileSync(h.groups.path, '{not json')
  const traced = []
  const again = createGroups(h.dir, { trace: (l) => traced.push(l) })
  assert.equal(again.list().length, 0)
  assert.equal(existsSync(h.groups.path + '.corrupt'), true)
  assert.match(traced[0], /unreadable/)
  again.ensureGroup('x', 'ws', { title: 'Fresh start' })
  assert.equal(createGroups(h.dir).list().length, 1)
})

test('groups: malformed entries in groups.json are dropped and extra keys are never served', async () => {
  const h = harness()
  writeFileSync(h.groups.path, JSON.stringify({ groups: [{ id: 'g1', name: 'Ok', createdAt: 1, sessionIds: ['a'], secret: 'x' }, { id: 'g2', name: 'Bad' }, { id: 'g3', name: 'Bad2', createdAt: 1, sessionIds: [1] }] }))
  const again = createGroups(h.dir)
  assert.deepEqual(again.list(), [{ id: 'g1', workspaceId: undefined, name: 'Ok', createdAt: 1, sessionIds: ['a'] }])
  assert.equal(again.groupOf('zzz'), undefined)
})
