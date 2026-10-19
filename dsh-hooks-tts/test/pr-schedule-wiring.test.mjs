/**
 * Integration tests: installPrPoller (pr.js) wired to the DSH Schedule service so that every "PR <id>"
 * session gets ONE visible Automation task ("PR <id> comment poll", every 600 s) instead of a setInterval, and the
 * plugin intercepts that task's tick in 'agent/pre-step' so no model call is spent. The poll logic itself is unchanged.
 *
 * Real DSH contracts encoded here (verified in D:/dev/DSH/packages):
 *  - ctx.get('schedule'): create(sessionId, { prompt, title, every_seconds }) -> record; list({ sessionId }); delete({ sessionId, id }).
 *  - The runtime delivers a tick as a UserMessage with source { kind: 'schedule' }; an 'every' task always uses the
 *    "[SCHEDULE REMINDER BATCH] ... reminders_json: [...]" text (schedule/src/domain.ts renderRecurringReminderBatchFraming).
 *  - 'agent/pre-step' is a waterfall: ({ agent, messages, turn, step, signal }, next) -> { kind: 'enter', messages } | { kind: 'reject' }.
 *    time-context registers with { prepend: true } and appends a message AFTER next(); an enter with zero messages on the
 *    first step spends no model call (agent-loop/src/agent.ts). A prepend listener registered later is outer.
 *  - 'workspace/session-activity' is a waterfall: ({ sessionId }, next) -> SessionActivity[]; Schedule contributes
 *    { kind: 'schedule', items: [{ id, label }] } for the session's active tasks and any non-empty result refuses archive.
 *  - Archive is observable through 'domain/changed' { domain: 'workspace', table: '', operation: 'put', value: { archivedSessionIds } }.
 *  - A title change is the session event { type: 'session/title', data: { title } } on 'session/event' (session, event).
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { installPrPoller } from '../pr.js'
import { createSettings } from '../settings.js'
import { fakeSchedule, renderBatch, renderSingle, scheduleMessage, messageText, scheduleError, marker, taskTitle, flush, until } from './pr-schedule-helpers.mjs'

const PAT = 'sup3r-secret-pat'
const thread = (id, lastId) => ({ id, status: 'active', comments: [{ id: 1, commentType: 'text', content: 'first' }, { id: lastId, commentType: 'text', content: 'last' }] })

function makeAgent(id = 'a1') {
  const restored = []
  return { id, session: { id }, inbox: { prepend: (target, message) => { restored.push({ target, message }) } }, restored }
}

/**
 * The `this` the host gives an agent/created listener: a scope carrier WITHOUT `on` (core/agent runtime-types.ts
 * `this: Scoped<Agent>`). Any property access fails the test, so a listener that relies on `this.on` is caught.
 */
const scopeCarrier = () => new Proxy({}, { get(_target, key) { throw new Error(`a listener must not touch \`this.${String(key)}\``) } })

/**
 * Fake ctx with a recording `on` (keeps the options), a waterfall dispatcher honouring { prepend: true } (a later
 * prepend listener is outer), a counting setInterval, and the real-shaped Schedule service.
 */
function world(t, { withSchedule = true, timeContext = 'after', liveAgents = [], known, archived = [], intervalMs = 600_000, ...settingsExtra } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'prw-'))
  const settings = createSettings(dir, settingsExtra)
  const schedule = fakeSchedule()
  const controller = new AbortController()
  const state = { title: 'PR 5', threads: [], prStatus: 'active', urls: [], gate: undefined, known, archived: [...archived] }
  const calls = { rename: [], prompt: [] }
  const merged = []
  const registrations = []
  const makeOn = () => (event, fn, opts) => {
    const entry = { event, fn, opts, seq: registrations.length }
    registrations.push(entry)
    return () => { const i = registrations.indexOf(entry); if (i >= 0) registrations.splice(i, 1) }
  }
  const controllerFake = {
    rename: async (r) => { calls.rename.push(r); state.title = r.title },
    prompt: async (r) => { calls.prompt.push(r) },
  }
  const registry = { list: () => [{ sessionIds: Object.keys(state.known ?? {}) }], get archivedSessionIds() { return state.archived } }
  const ctx = {
    logger: { warn() {}, info() {} },
    agents: { list: () => liveAgents, get: (id) => liveAgents.find((a) => a.id === id) },
    get: (name) => {
      if (name === 'schedule') return withSchedule ? schedule.service : undefined
      if (name === 'sessionTitle') return { get: () => (state.title === undefined ? undefined : { title: state.title }) }
      if (name === 'sessionController') return controllerFake
      if (name === 'workspaceRegistry') return registry
      if (name === 'agents') return ctx.agents
      if (name === 'sessionQuery' && state.known) {
        return { readTitleSnapshots: async (ids) => ids.map((id) => ({ status: 'fulfilled', value: { title: { title: state.known[id] } } })) }
      }
      return undefined
    },
    on: makeOn(),
  }
  const fetchImpl = async (url) => {
    state.urls.push(url)
    if (state.gate) await state.gate
    if (url.includes('/build/builds')) return { ok: true, status: 200, json: async () => ({ value: [] }) }
    const body = url.includes('/threads') ? { value: state.threads } : { pullRequestId: 5, status: state.prStatus, lastMergeSourceCommit: { commitId: 'c1' }, targetRefName: 'refs/heads/develop' }
    return { ok: true, status: 200, json: async () => body }
  }

  // Count (and later clear) every interval created while this world is alive.
  const realSetInterval = globalThis.setInterval
  const realClearInterval = globalThis.clearInterval
  const intervals = []
  const timers = []
  const cleared = []
  globalThis.setInterval = (fn, ms, ...rest) => { intervals.push(ms); const timer = realSetInterval(fn, ms, ...rest); timers.push(timer); return timer }
  globalThis.clearInterval = (timer) => { cleared.push(timer); realClearInterval(timer) }
  t.after(() => { globalThis.setInterval = realSetInterval; globalThis.clearInterval = realClearInterval; for (const timer of timers) realClearInterval(timer); controller.abort() })

  /** Stands in for the core time-context plugin: prepend listener that appends a context message after next(). */
  const timeContextListener = async (payload, next) => {
    const decision = await next()
    if (decision.kind === 'reject') return decision
    return { ...decision, messages: [...decision.messages, { id: 'time-context', role: 'user', source: { kind: 'time-context' }, content: [{ type: 'text', text: 'It is now ...' }] }] }
  }
  const addTimeContext = () => ctx.on('agent/pre-step', timeContextListener, { prepend: true })

  if (timeContext === 'before') addTimeContext()
  const poller = installPrPoller(ctx, {}, { settings, fetchImpl, intervalMs, env: { AZURE_DEVOPS_EXT_PAT: PAT }, signal: controller.signal, onPrMerged: async (info) => { merged.push(info) } })
  if (timeContext === 'after') addTimeContext()

  /** Listener order of one event, outermost first: prepend listeners (latest registered is outermost), then the rest. */
  const ordered = (event) => {
    const list = registrations.filter((r) => r.event === event)
    return [...list.filter((r) => r.opts?.prepend).reverse(), ...list.filter((r) => !r.opts?.prepend)]
  }
  const waterfall = (event, payload, inner) => {
    const list = ordered(event)
    const run = (i) => (i >= list.length ? inner() : list[i].fn.call(scopeCarrier(), payload, () => run(i + 1)))
    return run(0)
  }
  const agent = makeAgent('a1')
  const w = {
    dir, settings, schedule, state, calls, merged, poller, agent, ctx, controller, intervals, cleared, timers, registrations, ordered, timeContextListener,
    /** A step proposal for `who` carrying `messages`: the decision the whole listener chain returns. */
    preStep: (who, messages, step = 1) => waterfall('agent/pre-step', { agent: who, messages, turn: 1, step, signal: new AbortController().signal }, async () => ({ kind: 'enter', messages: [...messages] })),
    /** Archive-admission query: the inner result is what the Schedule plugin itself would contribute. */
    sessionActivity: (sessionId, extra = []) => waterfall('workspace/session-activity', { sessionId }, async () => {
      const items = schedule.tasksOf(sessionId).map((r) => ({ id: r.id, label: r.title }))
      return [...(items.length ? [{ kind: 'schedule', items }] : []), ...extra]
    }),
    created: async (who) => { for (const r of registrations.filter((x) => x.event === 'agent/created')) await r.fn.call(scopeCarrier(), { agent: who, source: { kind: 'new' } }) },
    emit: async (event, ...args) => { for (const r of registrations.filter((x) => x.event === event)) await r.fn.call(scopeCarrier(), ...args) },
    /** Registers the PR poll and, when a schedule service exists, asserts its task was created (so later "is gone" checks are never vacuous). */
    register: async (who = agent, prId = '5') => {
      poller.register(who, prId)
      await flush()
      if (withSchedule && !schedule.hooks.createError) assert.equal(schedule.tasksOf(who.id).length, 1, `precondition: PR ${prId} session ${who.id} must have its poll task`)
    },
    taskId: (sessionId = 'a1') => schedule.tasksOf(sessionId)[0]?.id,
    tickFor: (id, extra = {}) => scheduleMessage(renderBatch([{ id, prompt: schedule.all().find((r) => r.id === id)?.prompt ?? 'p', ...extra }])),
    prFetches: () => state.urls.filter((u) => /pullRequests\/5\?/.test(u)).length,
  }
  return w
}

// ---- registration: one visible task per PR session, no timer ----

test('register creates exactly one "PR <id> comment poll" task for the session', async (t) => {
  const w = world(t)
  await w.register()
  assert.equal(w.schedule.calls.create.length, 1)
  const { sessionId, request } = w.schedule.calls.create[0]
  assert.equal(sessionId, 'a1')
  assert.equal(request.title, taskTitle('5'))
  assert.equal(request.every_seconds, 600)
  assert.equal(request.prompt.trim().split('\n').at(-1), marker('a1', '5'))
  assert.equal(w.schedule.tasksOf('a1').length, 1)
})

test('registering the same PR again, concurrently or from a later step, never makes a second task', async (t) => {
  const w = world(t)
  w.poller.register(w.agent, '5')
  w.poller.register(w.agent, '5')
  await flush()
  await w.preStep(w.agent, [scheduleMessage('hello', { kind: 'user' })]) // title is "PR 5": pr.js would register it again
  await flush()
  assert.equal(w.schedule.calls.create.length, 1)
  assert.equal(w.schedule.tasksOf('a1').length, 1)
})

test('with a schedule service no setInterval is armed for the PR poll', async (t) => {
  const w = world(t)
  await w.register()
  assert.deepEqual(w.intervals, [])
  assert.equal(w.poller.has('a1'), true)
})

test('without a schedule service the old 10-minute setInterval path is used and no task is created', async (t) => {
  const w = world(t, { withSchedule: false })
  await w.register()
  assert.deepEqual(w.intervals, [600_000])
  assert.equal(w.schedule.calls.create.length, 0)
  assert.equal(w.poller.has('a1'), true)
})

test('register still records seen threads and hand-off lines exactly as before', async (t) => {
  const w = world(t)
  await w.register(w.agent, '5')
  w.poller.register(w.agent, '5', [['9', '4']])
  assert.deepEqual(w.poller.handoffLines('a1'), ['PR: 5', 'PR-POLL: 5 seen=9:4'])
})

test('a schedule create that fails does not break register and is traced', async (t) => {
  const w = world(t)
  w.schedule.hooks.createError = scheduleError('subagent_session', 'boom-create')
  await w.register()
  assert.equal(w.poller.has('a1'), true)
  assert.match(await readLog(w), /boom-create/)
})

async function readLog(w) {
  const { readFileSync, existsSync } = await import('node:fs')
  const p = join(w.dir, 'spawn.log')
  return existsSync(p) ? readFileSync(p, 'utf8') : ''
}

// ---- tick interception ----

/** The plugin's own tick interceptor: the pre-step listeners that are neither the fake time-context nor pr.js's registration hook. */
const interceptors = (w) => w.registrations.filter((r) => r.event === 'agent/pre-step' && r.opts?.prepend === true && r.fn !== w.timeContextListener)

test('the first agent/created registers ONE plugin-level prepend pre-step listener, never touching `this`', async (t) => {
  const w = world(t)
  assert.equal(interceptors(w).length, 0, 'lazy: nothing is registered before an agent exists')
  await w.created(w.agent) // the listener runs with a scope carrier that has no .on and throws on any property access
  assert.equal(interceptors(w).length, 1)
})

test('the pre-step interceptor is registered exactly once however many agents are created', async (t) => {
  const w = world(t)
  await w.created(w.agent)
  await w.created(makeAgent('a2'))
  await w.created(makeAgent('a3'))
  assert.equal(interceptors(w).length, 1)
})

test('the interceptor is the outermost pre-step listener, outside a time-context plugin applied after it', async (t) => {
  const w = world(t) // time-context is applied AFTER the plugin and also uses { prepend: true }
  await w.created(w.agent)
  const order = w.ordered('agent/pre-step')
  assert.equal(order[0], interceptors(w)[0], 'our listener must come first in the chain')
  assert.ok(order.findIndex((r) => r.fn === w.timeContextListener) > 0, 'time-context must be inside ours')
})

test('an agent that already existed registers the interceptor eagerly, exactly once', async (t) => {
  const live = makeAgent('a1')
  const w = world(t, { liveAgents: [live], timeContext: 'before' })
  assert.equal(interceptors(w).length, 1)
  await w.created(makeAgent('a2'))
  assert.equal(interceptors(w).length, 1)
})

test('our tick alone is dropped: an empty enter, so no model call and no time-context message', async (t) => {
  const w = world(t)
  await w.created(w.agent)
  await w.register()
  const result = await w.preStep(w.agent, [w.tickFor(w.taskId())])
  assert.equal(result.kind, 'enter')
  assert.deepEqual(result.messages, [])
})

test('the single-reminder tick format is dropped too', async (t) => {
  const w = world(t)
  await w.created(w.agent)
  await w.register()
  const id = w.taskId()
  const result = await w.preStep(w.agent, [scheduleMessage(renderSingle({ id, prompt: 'p' }))])
  assert.equal(result.kind, 'enter')
  assert.deepEqual(result.messages, [])
})

test('an agent that already existed when the plugin applied is covered without an agent/created event', async (t) => {
  const live = makeAgent('a1')
  const w = world(t, { liveAgents: [live], timeContext: 'before' })
  await w.register(live)
  const result = await w.preStep(live, [w.tickFor(w.taskId())])
  assert.equal(result.kind, 'enter')
  assert.deepEqual(result.messages, [])
})

test('our tick triggers the poll: new comments are queued into the session', async (t) => {
  const w = world(t)
  w.state.threads = [thread(1, 3)]
  await w.created(w.agent)
  await w.register()
  await w.preStep(w.agent, [w.tickFor(w.taskId())])
  assert.ok(await until(() => w.calls.prompt.length === 1), 'the poll must run and queue the comment message')
  assert.match(w.calls.prompt[0].content[0].text, /New review comments on PR 5/)
  assert.equal(w.calls.prompt[0].mode, 'queue')
})

test('the poll is fire-and-forget: the step proposal returns while the ADO call is still pending', async (t) => {
  const w = world(t)
  await w.created(w.agent)
  await w.register()
  let release
  w.state.gate = new Promise((resolve) => { release = resolve })
  const outcome = await Promise.race([w.preStep(w.agent, [w.tickFor(w.taskId())]), new Promise((resolve) => setTimeout(() => resolve('timed out'), 500))])
  assert.notEqual(outcome, 'timed out', 'pre-step must not await the poll')
  assert.ok(await until(() => w.state.urls.length > 0), 'the poll must have started')
  release()
  await flush()
})

test('a plugin:* notice batched with our tick is delivered this step (never put back), only the tick is removed', async (t) => {
  const w = world(t)
  await w.created(w.agent)
  await w.register()
  const notice = scheduleMessage('Context is at 80%.', { kind: 'plugin:hooks-tts' })
  const tick = w.tickFor(w.taskId())
  const result = await w.preStep(w.agent, [tick, notice])
  assert.equal(result.kind, 'enter')
  assert.ok(result.messages.some((m) => m.id === notice.id), 'the notice must reach the model in this step')
  assert.equal(result.messages.some((m) => m.id === tick.id), false)
  assert.deepEqual(w.agent.restored, [], 'nothing is put back in the inbox (inbox claims next-step first, which starved notices)')
  assert.ok(await until(() => w.state.urls.length > 0), 'the poll still runs')
})

test('a tick-only batch returns an empty enter WITHOUT running the rest of the chain (no model call)', async (t) => {
  const w = world(t)
  let inner = 0
  w.ctx.on('agent/pre-step', (payload, next) => { inner++; return next() }) // a later, inner listener
  await w.created(w.agent)
  await w.register()
  const result = await w.preStep(w.agent, [w.tickFor(w.taskId())])
  assert.deepEqual(result, { kind: 'enter', messages: [] })
  assert.equal(inner, 0, 'next() must not be called for a tick-only batch')
  const user = scheduleMessage('hi', { kind: 'user' })
  await w.preStep(w.agent, [user])
  assert.equal(inner, 1, 'a batch with a real message still runs the chain')
})

test('a real user message batched with our tick still goes through; only the tick is removed', async (t) => {
  const w = world(t)
  await w.created(w.agent)
  await w.register()
  const tick = w.tickFor(w.taskId())
  const user = scheduleMessage('please also fix the typo', { kind: 'user' })
  const result = await w.preStep(w.agent, [tick, user])
  assert.equal(result.kind, 'enter')
  assert.ok(result.messages.some((m) => m.id === user.id))
  assert.equal(result.messages.some((m) => m.id === tick.id), false)
  assert.ok(await until(() => w.state.urls.length > 0), 'the poll still runs')
})

test('a mixed batch (our entry plus another reminder) is rebuilt without our entry and the other reminder survives', async (t) => {
  const w = world(t)
  await w.created(w.agent)
  await w.register()
  const other = w.schedule.addForeign('a1', { title: 'standup', prompt: 'say hi' })
  const mine = { id: w.taskId(), prompt: w.schedule.tasksOf('a1')[0].prompt, occurrenceAt: '2026-10-16T22:50:00.000Z' }
  const theirs = { id: other.id, prompt: other.prompt, occurrenceAt: '2026-10-16T23:00:00.000Z' }
  const result = await w.preStep(w.agent, [scheduleMessage(renderBatch([mine, theirs]))])
  const reminders = result.messages.filter((m) => m.source?.kind === 'schedule')
  assert.equal(reminders.length, 1)
  assert.equal(messageText(reminders[0]), renderBatch([theirs]))
  assert.ok(await until(() => w.state.urls.length > 0), 'our entry still triggers the poll')
})

test('a reminder tick that is not ours passes through untouched and starts no poll', async (t) => {
  const w = world(t)
  await w.created(w.agent)
  await w.register()
  const other = w.schedule.addForeign('a1')
  const text = renderBatch([{ id: other.id, prompt: other.prompt }])
  const message = scheduleMessage(text)
  const result = await w.preStep(w.agent, [message])
  assert.ok(result.messages.some((m) => m.id === message.id && messageText(m) === text))
  await flush()
  assert.equal(w.state.urls.length, 0)
})

test('a user-typed message that quotes our tick is not intercepted (only source.kind "schedule" counts)', async (t) => {
  const w = world(t)
  await w.created(w.agent)
  await w.register()
  const quoted = scheduleMessage(renderBatch([{ id: w.taskId(), prompt: 'p' }]), { kind: 'user' })
  const result = await w.preStep(w.agent, [quoted])
  assert.ok(result.messages.some((m) => m.id === quoted.id))
  await flush()
  assert.equal(w.state.urls.length, 0)
})

test('two agents in the plugin: a tick for one of them runs exactly one poll', async (t) => {
  const w = world(t)
  const second = makeAgent('a2')
  await w.created(w.agent)
  await w.created(second)
  await w.register()
  await w.preStep(w.agent, [w.tickFor(w.taskId())])
  await flush(30)
  assert.equal(w.prFetches(), 1)
})

test('without a schedule service a reminder tick is left alone', async (t) => {
  const w = world(t, { withSchedule: false })
  await w.created(w.agent)
  await w.register()
  const message = scheduleMessage(renderBatch([{ id: 'schedule-x', prompt: 'p' }]))
  const result = await w.preStep(w.agent, [message])
  assert.ok(result.messages.some((m) => m.id === message.id))
})

test('a tick that arrives while Poll PR comments is off is dropped, deletes the tasks and checks nothing', async (t) => {
  const w = world(t)
  await w.created(w.agent)
  await w.register()
  const tick = w.tickFor(w.taskId())
  writeFileSync(w.settings.path, JSON.stringify({ pollPrComments: false })) // edited on disk: no set() call, so only the poll itself can notice
  const result = await w.preStep(w.agent, [tick])
  assert.deepEqual(result.messages, [])
  assert.ok(await until(() => w.schedule.tasksOf('a1').length === 0), 'the poll must delete the tasks when the setting is off')
  assert.equal(w.prFetches(), 0)
})

// ---- stopping, finishing, retiring ----

test('stop on agent/disposed is memory-only: the task is NOT deleted (it fires on shutdown)', async (t) => {
  const w = world(t)
  await w.register()
  await w.emit('agent/disposed', { agent: w.agent })
  await flush()
  assert.equal(w.poller.has('a1'), false)
  assert.equal(w.schedule.calls.delete.length, 0)
  assert.equal(w.schedule.tasksOf('a1').length, 1)
})

test('plugin shutdown (abort signal) does not delete the tasks either', async (t) => {
  const w = world(t)
  await w.register()
  w.controller.abort()
  await flush()
  assert.equal(w.schedule.calls.delete.length, 0)
  assert.equal(w.schedule.tasksOf('a1').length, 1)
})

for (const status of ['completed', 'abandoned']) {
  test(`finish on a ${status} PR deletes the task and retires its id so a late tick is dropped without a poll`, async (t) => {
    const w = world(t)
    await w.created(w.agent)
    await w.register()
    const id = w.taskId()
    const tick = w.tickFor(id)
    w.state.prStatus = status
    await w.poller.poll('a1')
    assert.ok(await until(() => w.schedule.tasksOf('a1').length === 0), 'finish must delete the task')
    const fetchesBefore = w.state.urls.length
    const result = await w.preStep(w.agent, [tick]) // a tick that was already queued when the task was deleted
    assert.deepEqual(result.messages, [])
    await flush()
    assert.equal(w.state.urls.length, fetchesBefore, 'a retired tick must not start another poll')
  })
}

test('switching Poll PR comments off deletes every PR poll task (and only those)', async (t) => {
  const w = world(t)
  const second = makeAgent('a2')
  await w.register(w.agent, '5')
  await w.register(second, '6')
  const mine = w.schedule.addForeign('a1', { title: 'standup' })
  assert.equal(w.schedule.all().length, 3)
  w.settings.set({ pollPrComments: false })
  assert.ok(await until(() => w.schedule.tasksOf('a1').length === 1 && w.schedule.tasksOf('a2').length === 0))
  assert.equal(w.schedule.tasksOf('a1')[0].id, mine.id)
})

test('switching Poll PR comments back on restores the poll tasks of the PR sessions', async (t) => {
  const w = world(t, { known: { a1: 'PR 5' } })
  await w.register()
  w.settings.set({ pollPrComments: false })
  assert.ok(await until(() => w.schedule.tasksOf('a1').length === 0))
  w.settings.set({ pollPrComments: true })
  assert.ok(await until(() => w.schedule.tasksOf('a1').length === 1), 'restore() must run and recreate the task')
  assert.equal(w.schedule.tasksOf('a1')[0].title, taskTitle('5'))
})

// ---- restore after a host restart ----

test('restore creates one task per PR session and skips archived sessions', async (t) => {
  const w = world(t, { known: { s1: 'PR 5', s2: 'PR 6', s3: 'refactor' }, archived: ['s2'] })
  const restored = await w.poller.restore()
  await flush()
  assert.equal(restored, 1)
  assert.deepEqual(w.schedule.calls.create.map((c) => c.sessionId), ['s1'])
  assert.equal(w.schedule.tasksOf('s1').length, 1)
  assert.equal(w.schedule.tasksOf('s2').length, 0)
  assert.equal(w.state.urls.some((u) => u.includes('/pullRequests/6')), false, 'an archived session is not polled')
})

// ---- archive ----

test('the session-activity filter is a prepend listener registered by the plugin', (t) => {
  const w = world(t)
  const found = w.registrations.filter((r) => r.event === 'workspace/session-activity')
  assert.ok(found.some((r) => r.opts?.prepend === true))
})

test('archive filter hides our task from the schedule activity entry but keeps the user\'s own reminder, and deletes nothing', async (t) => {
  const w = world(t)
  await w.register()
  const mine = w.schedule.addForeign('a1', { title: 'standup' })
  const result = await w.sessionActivity('a1')
  assert.deepEqual(result, [{ kind: 'schedule', items: [{ id: mine.id, label: 'standup' }] }])
  assert.equal(w.schedule.calls.delete.length, 0)
  assert.equal(w.schedule.tasksOf('a1').length, 2)
})

test('archive filter drops the schedule entry entirely when only our task was in it, and keeps other activity kinds', async (t) => {
  const w = world(t)
  await w.register()
  const job = { kind: 'job', items: [{ id: 'job-1', label: 'build' }] }
  const turn = { kind: 'turn' }
  assert.deepEqual(await w.sessionActivity('a1'), [])
  assert.deepEqual(await w.sessionActivity('a1', [job, turn]), [job, turn])
  assert.equal(w.schedule.calls.delete.length, 0)
})

test('archive filter leaves a session without our task untouched', async (t) => {
  const w = world(t)
  await w.register()
  const foreign = w.schedule.addForeign('other-session', { title: 'standup' })
  assert.deepEqual(await w.sessionActivity('other-session'), [{ kind: 'schedule', items: [{ id: foreign.id, label: 'standup' }] }])
})

test('domain/changed archive deletes the session\'s poll tasks (and retires them)', async (t) => {
  const w = world(t)
  await w.created(w.agent)
  await w.register()
  const id = w.taskId()
  const keep = w.schedule.addForeign('a1', { title: 'standup' })
  await w.emit('domain/changed', { domain: 'workspace', table: '', key: '', operation: 'put', value: { archivedSessionIds: ['a1'] } })
  assert.ok(await until(() => w.schedule.tasksOf('a1').length === 1))
  assert.equal(w.schedule.tasksOf('a1')[0].id, keep.id)
  const result = await w.preStep(w.agent, [w.tickFor(id, { prompt: 'late' })])
  assert.deepEqual(result.messages, [], 'a tick queued before the archive is dropped')
})

test('domain/changed only acts on sessions that are newly archived', async (t) => {
  const w = world(t)
  const second = makeAgent('a2')
  await w.register(w.agent, '5')
  await w.register(second, '6')
  await w.emit('domain/changed', { domain: 'workspace', table: '', key: '', operation: 'put', value: { archivedSessionIds: ['a1'] } })
  assert.ok(await until(() => w.schedule.tasksOf('a1').length === 0))
  assert.equal(w.schedule.tasksOf('a2').length, 1, 'a2 was not archived')
  await w.emit('domain/changed', { domain: 'workspace', table: '', key: '', operation: 'put', value: { archivedSessionIds: ['a1', 'a2'] } })
  assert.ok(await until(() => w.schedule.tasksOf('a2').length === 0))
})

test('domain/changed for other domains, deletions or values without archivedSessionIds is ignored', async (t) => {
  const w = world(t)
  await w.register()
  await w.emit('domain/changed', { domain: 'schedule', table: 'tasks', key: 'x', operation: 'put', value: { archivedSessionIds: ['a1'] } })
  await w.emit('domain/changed', { domain: 'workspace', table: '', key: '', operation: 'deleted' })
  await w.emit('domain/changed', { domain: 'workspace', table: '', key: '', operation: 'put', value: { pinnedSessionIds: ['a1'] } })
  await flush()
  assert.equal(w.schedule.calls.delete.length, 0)
  assert.equal(w.schedule.tasksOf('a1').length, 1)
})

// ---- title change ----

test('a title change away from "PR <n>" deletes the session\'s poll tasks', async (t) => {
  const w = world(t)
  await w.register()
  w.state.title = 'refactor the parser'
  await w.emit('session/event', { id: 'a1' }, { type: 'session/title', data: { title: 'refactor the parser' } })
  assert.ok(await until(() => w.schedule.tasksOf('a1').length === 0))
})

test('a title change that still reads "PR <n>" keeps the task, and other sessions are never touched', async (t) => {
  const w = world(t)
  await w.register()
  const second = makeAgent('a2')
  await w.register(second, '6')
  w.state.title = 'PR 5 - tidy'
  await w.emit('session/event', { id: 'a1' }, { type: 'session/title', data: { title: 'PR 5 - tidy' } })
  await w.emit('session/event', { id: 'a2' }, { type: 'user/message', data: {} })
  await flush()
  assert.equal(w.schedule.calls.delete.length, 0)
  w.state.title = 'unrelated'
  await w.emit('session/event', { id: 'a1' }, { type: 'session/title', data: { title: 'unrelated' } })
  assert.ok(await until(() => w.schedule.tasksOf('a1').length === 0))
  assert.equal(w.schedule.tasksOf('a2').length, 1)
})

// ---- a task that cannot be created must not leave the session unpolled ----

test('a failed create arms the setInterval fallback so the session is still polled', async (t) => {
  const w = world(t)
  w.schedule.hooks.createError = scheduleError('subagent_session', 'boom-create')
  w.poller.register(w.agent, '5')
  await flush()
  assert.deepEqual(w.intervals, [600_000], 'the old timer is armed for that entry')
  assert.equal(w.schedule.tasksOf('a1').length, 0)
  w.state.threads = [thread(1, 3)]
  await w.poller.poll('a1') // what the timer would run
  assert.equal(w.calls.prompt.length, 1)
})

test('a rejecting list() (ensure fails before create) arms the fallback too', async (t) => {
  const w = world(t)
  w.schedule.hooks.listError = new Error('boom-list')
  w.poller.register(w.agent, '5')
  await flush()
  assert.deepEqual(w.intervals, [600_000])
})

test('the fallback timer is cleared once the task could be created on a later step', async (t) => {
  const w = world(t)
  w.schedule.hooks.createError = Object.assign(scheduleError('subagent_session', 'boom-create'), { once: true })
  w.poller.register(w.agent, '5')
  await flush()
  assert.equal(w.timers.length, 1)
  await w.created(w.agent)
  w.poller.register(w.agent, '5', [], undefined, false) // the same PR again: re-ensures, and may not leave both a timer and a task
  await w.preStep(w.agent, [scheduleMessage('go on', { kind: 'user' })])
  assert.ok(await until(() => w.schedule.tasksOf('a1').length === 1), 'the task is created on the next step')
  assert.ok(await until(() => w.cleared.includes(w.timers[0])), 'the fallback timer must be cleared once the task exists')
})

test('a task the user deleted in the Automation UI is re-created on the next step of the session', async (t) => {
  const w = world(t)
  await w.created(w.agent)
  await w.register()
  const first = w.taskId()
  w.schedule.userDelete(first)
  assert.equal(w.schedule.tasksOf('a1').length, 0)
  await w.preStep(w.agent, [scheduleMessage('are you there?', { kind: 'user' })])
  assert.ok(await until(() => w.schedule.tasksOf('a1').length === 1), 'the next step must re-ensure the task')
  assert.notEqual(w.taskId(), first)
  await flush()
  assert.equal(w.schedule.calls.create.length, 2, 'exactly one re-creation')
  assert.deepEqual(w.intervals, [], 'no fallback timer when the task could be created')
})

test('register() for a PR that has an entry but neither a timer nor a task creates the task', async (t) => {
  const w = world(t, { pollPrComments: false })
  w.poller.register(w.agent, '5')
  await flush()
  assert.equal(w.schedule.tasksOf('a1').length, 0, 'Poll PR comments is off: nothing is created')
  assert.deepEqual(w.intervals, [])
  writeFileSync(w.settings.path, JSON.stringify({ pollPrComments: true })) // switched on by editing the file
  w.poller.register(w.agent, '5')
  assert.ok(await until(() => w.schedule.tasksOf('a1').length === 1))
})

// ---- the seen list survives a disposed agent ----

test('a re-registered PR session does not re-announce threads that were already announced before the agent was disposed', async (t) => {
  const w = world(t)
  w.state.threads = [thread(1, 3)]
  await w.register()
  await w.poller.poll('a1')
  assert.equal(w.calls.prompt.length, 1)
  await w.emit('agent/disposed', { agent: w.agent })
  assert.equal(w.poller.has('a1'), false)
  w.poller.register(w.agent, '5')
  await flush()
  await w.poller.poll('a1')
  assert.equal(w.calls.prompt.length, 1, 'the unresolved thread must not be announced a second time')
  assert.match(w.poller.handoffLines('a1')[1], /seen=1:3/)
})

test('a thread that changed after the disposal is still announced', async (t) => {
  const w = world(t)
  w.state.threads = [thread(1, 3)]
  await w.register()
  await w.poller.poll('a1')
  await w.emit('agent/disposed', { agent: w.agent })
  w.poller.register(w.agent, '5')
  w.state.threads = [thread(1, 4)]
  await w.poller.poll('a1')
  assert.equal(w.calls.prompt.length, 2)
})

// ---- archive and unarchive ----

test('archive stops the in-memory entry; unarchive then the next step creates exactly one new task', async (t) => {
  const w = world(t)
  await w.created(w.agent)
  await w.register()
  await w.emit('domain/changed', { domain: 'workspace', table: '', key: '', operation: 'put', value: { archivedSessionIds: ['a1'] } })
  assert.ok(await until(() => w.schedule.tasksOf('a1').length === 0))
  assert.equal(w.poller.has('a1'), false, 'the archived session is no longer registered in memory')
  assert.equal(w.schedule.calls.delete.length, 1, 'no extra delete beyond the task deletion')
  await w.emit('domain/changed', { domain: 'workspace', table: '', key: '', operation: 'put', value: { archivedSessionIds: [] } }) // unarchived
  await w.preStep(w.agent, [scheduleMessage('welcome back', { kind: 'user' })])
  assert.ok(await until(() => w.schedule.tasksOf('a1').length === 1), 'the next step must re-register and create the task')
  await flush()
  assert.equal(w.schedule.calls.create.length, 2)
  assert.equal(w.schedule.tasksOf('a1').length, 1)
  assert.equal(w.poller.has('a1'), true)
})

test('archive of a session polled by the setInterval fallback stops its timer too', async (t) => {
  const w = world(t, { withSchedule: false })
  await w.register()
  await w.emit('domain/changed', { domain: 'workspace', table: '', key: '', operation: 'put', value: { archivedSessionIds: ['a1'] } })
  assert.equal(w.poller.has('a1'), false)
  assert.ok(w.cleared.includes(w.timers[0]))
})

// ---- ids are encoded into ADO URLs ----

test('a PR id is URL-encoded wherever it is put into an Azure DevOps URL', async (t) => {
  const w = world(t, { withSchedule: false })
  w.poller.register(w.agent, '5/../x?y=1')
  await w.poller.poll('a1')
  const url = w.state.urls[0]
  assert.ok(url.includes('/pullRequests/5%2F..%2Fx%3Fy%3D1?api-version=7.1'), url)
  assert.equal(w.state.urls.some((u) => u.includes('/x?y=1')), false)
})

// ---- a stale tick after a restart ----

test('a tick carrying our marker for this session but an unknown task id (retired set lost) is dropped without a poll', async (t) => {
  const w = world(t)
  await w.created(w.agent)
  await w.register()
  const stale = scheduleMessage(renderBatch([{ id: 'schedule-from-before-restart', prompt: `Check ...\n${marker('a1', '5')}` }]))
  const result = await w.preStep(w.agent, [stale])
  assert.deepEqual(result.messages, [])
  await flush()
  assert.equal(w.state.urls.length, 0, 'a stale tick starts no poll')
})

test('a tick with our marker for ANOTHER session is not touched', async (t) => {
  const w = world(t)
  await w.created(w.agent)
  await w.register()
  const foreign = scheduleMessage(renderBatch([{ id: 'schedule-elsewhere', prompt: `Check ...\n${marker('other-session', '5')}` }]))
  const result = await w.preStep(w.agent, [foreign])
  assert.ok(result.messages.some((m) => m.id === foreign.id))
})

// ---- fallback path: restore skips archived sessions ----

test('restore without a schedule service (timer fallback) skips archived sessions and arms one timer per live PR session', async (t) => {
  const w = world(t, { withSchedule: false, known: { s1: 'PR 5', s2: 'PR 6', s3: 'refactor' }, archived: ['s2'] })
  const restored = await w.poller.restore()
  await flush()
  assert.equal(restored, 1)
  assert.deepEqual(w.intervals, [600_000])
  assert.equal(w.poller.has('s1'), true)
  assert.equal(w.poller.has('s2'), false)
  assert.equal(w.state.urls.some((u) => u.includes('/pullRequests/6')), false, 'an archived session is not polled')
})

// ---- a tick must not register or poll an archived session, nor a session other than the receiving agent ----

test('a tick of ours for an ARCHIVED session is dropped without a model call, a registration or a poll, and its tasks are deleted', async (t) => {
  const w = world(t)
  await w.created(w.agent)
  await w.register()
  const tick = w.tickFor(w.taskId())
  await w.emit('agent/disposed', { agent: w.agent }) // memory-only: the entry is gone, the task stays (as after a restart)
  assert.equal(w.poller.has('a1'), false)
  w.state.archived.push('a1') // archived without a domain/changed we saw: only the registry says so
  const result = await w.preStep(w.agent, [tick])
  assert.deepEqual(result.messages, [], 'no model call')
  assert.equal(w.poller.has('a1'), false, 'an archived session is not registered again')
  assert.ok(await until(() => w.schedule.tasksOf('a1').length === 0), 'its tasks are deleted')
  assert.equal(w.state.urls.length, 0, 'no poll')
  assert.match(await readLog(w), /dropped a tick of a1: session is archived/)
})

test('an archived-session tick is still dropped when the registry lookup throws or is missing (and then polls as before)', async (t) => {
  const w = world(t)
  await w.created(w.agent)
  await w.register()
  const tick = w.tickFor(w.taskId())
  const original = w.ctx.get
  w.ctx.get = (name) => { if (name === 'workspaceRegistry') throw new Error('registry not ready'); return original(name) }
  const result = await w.preStep(w.agent, [tick])
  assert.deepEqual(result.messages, [])
  assert.ok(await until(() => w.prFetches() === 1), 'the lookup failure is not "archived": the poll still runs')
})

test('a tick of ours delivered to a DIFFERENT agent is skipped and traced: no entry is keyed by the receiving agent, no poll', async (t) => {
  const w = world(t)
  const other = makeAgent('a2')
  await w.created(w.agent)
  await w.register()
  const tick = w.tickFor(w.taskId('a1')) // the task of a1 ...
  await w.emit('agent/disposed', { agent: w.agent })
  const result = await w.preStep(other, [tick]) // ... arrives at a2
  assert.deepEqual(result.messages, [], 'the tick is still removed from the step')
  await flush()
  assert.equal(w.poller.has('a2'), false, 'never keyed by the receiving agent')
  assert.equal(w.poller.has('a1'), false)
  assert.equal(w.state.urls.length, 0)
  assert.match(await readLog(w), /skipped a tick of a1 delivered to a2/)
  assert.equal(w.schedule.tasksOf('a1').length, 1, 'the task itself is left alone')
})

test('a tick delivered to its own agent still registers and polls (the guard only rejects a mismatch)', async (t) => {
  const w = world(t)
  await w.created(w.agent)
  await w.register()
  const tick = w.tickFor(w.taskId())
  await w.emit('agent/disposed', { agent: w.agent })
  await w.preStep(w.agent, [tick])
  assert.ok(await until(() => w.prFetches() === 1))
  assert.equal(w.poller.has('a1'), true)
})
