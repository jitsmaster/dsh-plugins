import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createStore } from '../store.js'
import { createReviewQueue } from '../service.js'
import { installCapture, cancelStalePending } from '../capture.js'

// The Todo item: start a new session from the task list, with the user's confirmation when the workspace was not given.
const WORKSPACES = [
  { id: 'w-orca', title: 'Orca', path: 'D:/dev/ai/orca-engine', sessionIds: ['o1', 'o2'] },
  { id: 'w-plug', title: 'dsh-plugins', path: 'D:/dev/ai/dsh-plugins', sessionIds: [] },
  { id: 'w-ctnp', title: 'Main site', path: 'D:/dev/CTnP-Final', sessionIds: [] },
]

/** A fake llm service in the shape summary.js expects; answer is what the model "says". */
function fakeLlm({ answer, fail, hang, seen = {} } = {}) {
  return {
    listProviders: async () => [{ id: 'p1' }],
    listModels: async () => [{ id: 'claude-haiku-x' }],
    prepareCall: async (cfg) => ({
      config: {},
      stream: async function* (req) {
        seen.cfg = cfg
        seen.req = req
        seen.calls = (seen.calls ?? 0) + 1
        if (hang) await new Promise((_, rej) => req.signal.addEventListener('abort', () => rej(new Error('aborted'))))
        if (fail) throw new Error('llm down')
        yield { type: 'text-delta', text: typeof answer === 'function' ? answer() : answer }
      },
    }),
  }
}

function setup({ workspaces = WORKSPACES, llm, createError, promptError, renameError, sparcText = 'SPARC SKILL BODY', titlesOf, noRegistry } = {}) {
  let n = 0
  let t = 1000
  const store = createStore({ now: () => ++t, uuid: () => 'i' + ++n })
  const calls = []
  let sessions = 0
  const controller = {
    create: async (arg) => { calls.push(['create', arg]); if (createError) throw new Error(createError); return { sessionId: 'S' + ++sessions } },
    rename: async (arg) => { calls.push(['rename', arg]); if (renameError) throw new Error(renameError) },
    prompt: async (req, signal) => { calls.push(['prompt', req, signal]); if (promptError) throw new Error(promptError); return {} },
    select: async (arg) => { calls.push(['select', arg]) },
    focus: async (arg) => { calls.push(['focus', arg]) },
  }
  const registry = { list: () => workspaces, archivedSessionIds: [] }
  const queue = createReviewQueue({
    store, capture: { decidePermission: () => ({ ok: false, error: 'not-pending' }) }, controllerOf: () => controller, registryOf: noRegistry ? () => undefined : () => registry,
    llm, titlesOf, sparcText: () => sparcText, suggestTimeoutMs: 40, now: () => 5000,
  })
  return { store, queue, calls, controller, registry }
}
const todo = (store) => store.list().find((i) => i.type === 'todo')
const names = (calls) => calls.map((c) => c[0])

test('a todo with a workspace starts at once: create, rename, prompt, in that order, nothing focused', async () => {
  const { queue, store, calls } = setup()
  const r = queue.addTodo('Fix the login redirect\nand add a test', { workspaceId: 'w-plug' })
  assert.equal(r.ok, true)
  assert.ok(r.id)
  await queue.todoIdle()
  assert.deepEqual(names(calls), ['create', 'rename', 'prompt'])
  assert.deepEqual(calls[0][1], { workspaceId: 'w-plug' })
  assert.deepEqual(calls[1][1], { sessionId: 'S1', title: 'Fix the login redirect' })
  const req = calls[2][1]
  assert.equal(req.sessionId, 'S1')
  assert.equal(req.mode, 'queue')
  assert.match(req.requestId, /^todo-/)
  assert.deepEqual(req.content, [{ type: 'text', text: 'Fix the login redirect\nand add a test' }])
  assert.ok(calls[2][2] instanceof AbortSignal, 'the Remote method needs a caller signal')
  const item = store.get(r.id)
  assert.equal(item.status, 'resolved')
  assert.equal(item.state, 'started')
  assert.equal(item.sessionId, 'S1')
  assert.deepEqual(item.resolution, { kind: 'started', by: 'card', sessionId: 'S1' })
  assert.equal(store.snapshot().open.length, 0)
})

test('the session title is the first line, at most 60 characters', async () => {
  const { queue, calls } = setup()
  queue.addTodo('x'.repeat(200) + '\nsecond line', { workspaceId: 'w-plug' })
  await queue.todoIdle()
  const title = calls.find((c) => c[0] === 'rename')[1].title
  assert.ok(title.length <= 60, String(title.length))
  assert.ok(title.startsWith('xxxx'))
  const b = setup()
  b.queue.addTodo('\n\n  Tidy   the   README  \nmore', { workspaceId: 'w-plug' })
  await b.queue.todoIdle()
  assert.equal(b.calls.find((c) => c[0] === 'rename')[1].title, 'Tidy the README')
})

test('a rename that fails does not stop the todo from starting', async () => {
  const { queue, store, calls } = setup({ renameError: 'no rename' })
  const { id } = queue.addTodo('Do it', { workspaceId: 'w-plug' })
  await queue.todoIdle()
  assert.deepEqual(names(calls), ['create', 'rename', 'prompt'])
  assert.equal(store.get(id).state, 'started')
})

test('no workspace and one name in the text: awaiting confirmation with that suggestion, and NO session is created', async () => {
  const seen = {}
  const { queue, store, calls } = setup({ llm: fakeLlm({ answer: '{"workspaceId":"w-orca"}', seen }) })
  const r = queue.addTodo('Update the DSH-Plugins readme.')
  assert.deepEqual([r.ok, r.state], [true, 'awaiting-confirm'])
  await queue.todoIdle()
  const item = store.get(r.id)
  assert.equal(item.status, 'open')
  assert.equal(item.state, 'awaiting-confirm')
  assert.deepEqual(item.suggested, { workspaceId: 'w-plug', title: 'dsh-plugins', reason: 'named in the text' })
  assert.deepEqual(calls, [])
  assert.equal(seen.calls, undefined, 'the model is not asked when the text names a workspace')
})

test('the folder name counts as a name too, as a whole word, any case', async () => {
  const a = setup()
  a.queue.addTodo('bump the version in ORCA-ENGINE please')
  await a.queue.todoIdle()
  assert.equal(todo(a.store).suggested.workspaceId, 'w-orca')
  const b = setup()
  b.queue.addTodo('the orcas are not a workspace')
  await b.queue.todoIdle()
  assert.equal(todo(b.store).suggested, undefined, 'orcas is not the word Orca')
  const c = setup()
  c.queue.addTodo('look at the main site header')
  await c.queue.todoIdle()
  assert.equal(todo(c.store).suggested.workspaceId, 'w-ctnp')
})

test('a name inside a longer matched name does not make it ambiguous; two different names do', async () => {
  const workspaces = [{ id: 'a', title: 'dsh', path: 'D:/x/dsh', sessionIds: [] }, { id: 'b', title: 'dsh-plugins', path: 'D:/x/dsh-plugins', sessionIds: [] }, { id: 'c', title: 'Orca', path: 'D:/x/orca', sessionIds: [] }]
  const one = setup({ workspaces })
  one.queue.addTodo('fix dsh-plugins')
  await one.queue.todoIdle()
  assert.equal(todo(one.store).suggested.workspaceId, 'b')
  const two = setup({ workspaces })
  two.queue.addTodo('copy something from dsh-plugins to Orca')
  await two.queue.todoIdle()
  assert.equal(todo(two.store).suggested, undefined)
})

test('no name in the text: the model picks, the id is validated against the list, a call to the model carries the todo and the workspaces', async () => {
  const seen = {}
  const titlesOf = async (ids) => new Map(ids.map((id) => [id, 'Session ' + id]))
  const { queue, store, calls } = setup({ llm: fakeLlm({ answer: 'Sure:\n{"workspaceId":"w-ctnp","reason":"it is about the website header"}', seen }), titlesOf })
  const { id } = queue.addTodo('Make the website header sticky')
  assert.equal(store.get(id).suggesting, true, 'the card can say it is looking')
  await queue.todoIdle()
  const item = store.get(id)
  assert.deepEqual(item.suggested, { workspaceId: 'w-ctnp', title: 'Main site', reason: 'it is about the website header' })
  assert.notEqual(item.suggesting, true)
  assert.equal(item.state, 'awaiting-confirm')
  assert.deepEqual(calls, [])
  const prompt = JSON.stringify(seen.req.messages) + seen.req.system
  assert.match(prompt, /Make the website header sticky/)
  for (const ws of WORKSPACES) { assert.ok(prompt.includes(ws.id), ws.id); assert.ok(prompt.includes(ws.title), ws.title) }
  assert.match(prompt, /Session o2/, 'recent session titles are included when cheaply available')
  assert.match(seen.req.system, /untrusted/i)
})

test('a model answer that is not a known workspace id, is not JSON, throws, hangs or is missing gives no suggestion', async () => {
  const cases = [
    ['unknown id', { llm: fakeLlm({ answer: '{"workspaceId":"w-nope","reason":"x"}' }) }],
    ['null id', { llm: fakeLlm({ answer: '{"workspaceId":null}' }) }],
    ['not json', { llm: fakeLlm({ answer: 'probably Orca' }) }],
    ['llm fails', { llm: fakeLlm({ fail: true }) }],
    ['llm hangs (time limit)', { llm: fakeLlm({ hang: true }) }],
    ['no llm service', {}],
    ['llm service throws', { llm: { listProviders: () => { throw new Error('down') }, listModels: async () => [], prepareCall: async () => ({}) } }],
  ]
  for (const [label, opts] of cases) {
    const { queue, store, calls } = setup(opts)
    const { id } = queue.addTodo('Make the website header sticky')
    await queue.todoIdle()
    const item = store.get(id)
    assert.equal(item.suggested, undefined, label)
    assert.equal(item.state, 'awaiting-confirm', label)
    assert.notEqual(item.suggesting, true, label)
    assert.deepEqual(calls, [], label)
  }
})

test('confirm starts the session in the suggested workspace; Change workspace overrides it', async () => {
  const a = setup()
  const { id } = a.queue.addTodo('Update the dsh-plugins readme')
  assert.deepEqual(a.queue.confirmTodo(id), { ok: true, state: 'starting' })
  await a.queue.todoIdle()
  assert.deepEqual(a.calls[0], ['create', { workspaceId: 'w-plug' }])
  assert.equal(a.store.get(id).state, 'started')
  const b = setup()
  const second = b.queue.addTodo('Update the dsh-plugins readme').id
  b.queue.confirmTodo(second, { workspaceId: 'w-orca' })
  await b.queue.todoIdle()
  assert.deepEqual(b.calls[0], ['create', { workspaceId: 'w-orca' }])
  assert.equal(b.store.get(second).sessionId, 'S1')
})

test('confirm with nothing to start in, or a workspace that does not exist, is refused and creates nothing', async () => {
  const { queue, store, calls } = setup()
  const { id } = queue.addTodo('Something nobody names')
  await queue.todoIdle()
  assert.deepEqual(queue.confirmTodo(id), { ok: false, error: 'no-workspace' })
  assert.deepEqual(queue.confirmTodo(id, { workspaceId: 'w-gone' }), { ok: false, error: 'unknown-workspace' })
  assert.deepEqual(queue.confirmTodo('nope'), { ok: false, error: 'not-open' })
  assert.deepEqual(calls, [])
  assert.equal(store.get(id).state, 'awaiting-confirm')
})

test('cancel resolves the todo and creates no session; a started or unknown item cannot be cancelled', async () => {
  const { queue, store, calls } = setup()
  const { id } = queue.addTodo('Update the dsh-plugins readme')
  assert.deepEqual(queue.cancelTodo(id), { ok: true })
  assert.deepEqual(store.get(id).resolution, { kind: 'cancelled', by: 'card' })
  assert.equal(store.get(id).state, 'cancelled')
  assert.deepEqual(queue.confirmTodo(id), { ok: false, error: 'not-open' })
  assert.deepEqual(queue.cancelTodo(id), { ok: false, error: 'not-open' })
  assert.deepEqual(queue.cancelTodo('nope'), { ok: false, error: 'not-open' })
  const done = store.add({ type: 'completed', sessionId: 's', payload: { reply: 'x' } })
  assert.deepEqual(queue.cancelTodo(done.id), { ok: false, error: 'not-todo' })
  assert.deepEqual(calls, [])
})

test('a failing create leaves the todo open as failed with the reason; Retry (confirm) starts it', async () => {
  const { queue, store, calls, controller } = setup({ createError: 'workspace is not available' })
  const { id } = queue.addTodo('Fix it', { workspaceId: 'w-plug' })
  await queue.todoIdle()
  const failed = store.get(id)
  assert.equal(failed.status, 'open')
  assert.equal(failed.state, 'failed')
  assert.match(failed.error, /workspace is not available/)
  assert.equal(failed.sessionId, undefined)
  assert.deepEqual(names(calls), ['create'])
  controller.create = async (arg) => { calls.push(['create', arg]); return { sessionId: 'S9' } }
  assert.deepEqual(queue.confirmTodo(id), { ok: true, state: 'starting' })
  await queue.todoIdle()
  assert.equal(store.get(id).state, 'started')
  assert.equal(store.get(id).error, undefined)
  assert.deepEqual(names(calls), ['create', 'create', 'rename', 'prompt'])
})

test('a prompt that fails after the session was created keeps its id; Retry reuses that session instead of creating a second one', async () => {
  const { queue, store, calls, controller } = setup({ promptError: 'busy' })
  const { id } = queue.addTodo('Fix it', { workspaceId: 'w-plug' })
  await queue.todoIdle()
  assert.equal(store.get(id).state, 'failed')
  assert.equal(store.get(id).sessionId, 'S1')
  controller.prompt = async (req) => { calls.push(['prompt', req]); return {} }
  queue.confirmTodo(id)
  await queue.todoIdle()
  assert.equal(store.get(id).state, 'started')
  assert.equal(calls.filter((c) => c[0] === 'create').length, 1)
  assert.equal(calls.filter((c) => c[0] === 'prompt').length, 2)
})

test('no controller is a failed todo, not a crash', async () => {
  const store = createStore()
  const queue = createReviewQueue({ store, capture: {}, controllerOf: () => undefined, registryOf: () => ({ list: () => WORKSPACES }) })
  const { id } = queue.addTodo('x', { workspaceId: 'w-plug' })
  await queue.todoIdle()
  assert.equal(store.get(id).state, 'failed')
  assert.match(store.get(id).error, /session/i)
})

test('a second confirm while the first is starting is refused (no second session)', async () => {
  const { queue, calls } = setup()
  const { id } = queue.addTodo('Update the dsh-plugins readme')
  assert.equal(queue.confirmTodo(id).ok, true)
  assert.deepEqual(queue.confirmTodo(id), { ok: false, error: 'not-confirmable' })
  assert.deepEqual(queue.cancelTodo(id), { ok: false, error: 'not-confirmable' })
  await queue.todoIdle()
  assert.equal(calls.filter((c) => c[0] === 'create').length, 1)
})

test('Use SPARC wraps the prompt: the task first, the SPARC flow and the skill text after it; without the skill text it asks for the skill', async () => {
  const a = setup({ sparcText: 'SPARC SKILL BODY' })
  a.queue.addTodo('Build the thing', { workspaceId: 'w-plug', sparc: true })
  await a.queue.todoIdle()
  const text = a.calls.find((c) => c[0] === 'prompt')[1].content[0].text
  assert.ok(text.startsWith('Build the thing'), 'the request stays first so the done card titles from it')
  assert.match(text, /\/sparc flow/)
  assert.match(text, /--- modes:sparc skill content ---\nSPARC SKILL BODY/)
  assert.match(text, /NEW task/)
  const b = setup({ sparcText: '' })
  b.queue.addTodo('Build the thing', { workspaceId: 'w-plug', sparc: true })
  await b.queue.todoIdle()
  assert.match(b.calls.find((c) => c[0] === 'prompt')[1].content[0].text, /Invoke Skill\(modes:sparc\) if available/)
  const c = setup()
  c.queue.addTodo('Plain task', { workspaceId: 'w-plug' })
  await c.queue.todoIdle()
  assert.equal(c.calls.find((x) => x[0] === 'prompt')[1].content[0].text, 'Plain task')
})

test('empty, too long and unknown-workspace todos are rejected and nothing is added or created', async () => {
  const { queue, store, calls } = setup()
  assert.deepEqual(queue.addTodo('   \n '), { ok: false, error: 'empty' })
  assert.deepEqual(queue.addTodo(undefined), { ok: false, error: 'empty' })
  assert.deepEqual(queue.addTodo(42), { ok: false, error: 'empty' })
  assert.deepEqual(queue.addTodo('x'.repeat(4001)), { ok: false, error: 'too-long' })
  assert.equal(queue.addTodo('x'.repeat(4000), { workspaceId: undefined }).ok, true)
  assert.deepEqual(queue.addTodo('ok', { workspaceId: 'w-gone' }), { ok: false, error: 'unknown-workspace' })
  assert.equal(store.list().length, 1)
  await queue.todoIdle()
  assert.deepEqual(calls, [])
  const bare = setup({ noRegistry: true })
  assert.deepEqual(bare.queue.addTodo('ok', { workspaceId: 'w-plug' }), { ok: false, error: 'no-registry' })
})

test('without a workspace registry a todo with no workspace still waits for the user, with no suggestion', async () => {
  const { queue, store } = setup({ noRegistry: true })
  const { id } = queue.addTodo('Something')
  await queue.todoIdle()
  assert.equal(store.get(id).state, 'awaiting-confirm')
  assert.equal(store.get(id).suggested, undefined)
  assert.deepEqual(queue.confirmTodo(id, { workspaceId: 'w-plug' }), { ok: false, error: 'no-registry' })
})

test('the snapshot carries the todo with a card title; workspaces() lists id and title', async () => {
  const { queue } = setup()
  const { id } = queue.addTodo('Update the dsh-plugins readme\nwith the new routes')
  await queue.todoIdle()
  const item = queue.snapshot().open.find((i) => i.id === id)
  assert.equal(item.title, 'Update the dsh-plugins readme')
  assert.equal(item.type, 'todo')
  assert.deepEqual(queue.workspaces(), [{ id: 'w-orca', title: 'Orca' }, { id: 'w-plug', title: 'dsh-plugins' }, { id: 'w-ctnp', title: 'Main site' }])
})

test('count(): a todo waits while it needs the user (awaiting or failed), not while it is starting', async () => {
  const { queue } = setup({ createError: 'boom' })
  const a = queue.addTodo('Update the dsh-plugins readme').id
  await queue.todoIdle()
  assert.deepEqual(queue.count(), { total: 1, byType: { question: 0, permission: 0, completed: 0, 'pr-merged': 0, todo: 1 } })
  queue.confirmTodo(a)
  assert.equal(queue.count().total, 0, 'starting')
  await queue.todoIdle()
  assert.equal(queue.count().byType.todo, 1, 'failed waits again')
  assert.equal(queue.first().id, a)
})

test('other card actions do not apply to a todo', async () => {
  const { queue } = setup()
  const { id } = queue.addTodo('Update the dsh-plugins readme')
  assert.equal(queue.markReviewed(id).ok, false)
  assert.equal((await queue.reply(id, 'hi')).ok, false)
  assert.equal(queue.deny(id).ok, false)
  assert.equal((await queue.archive(id)).ok, false)
})

test('a restart: a todo waiting for confirmation or failed survives, one that was starting becomes failed and can be retried', async () => {
  const store = createStore()
  const waiting = store.add({ type: 'todo', text: 'a', sparc: false, state: 'awaiting-confirm' })
  const failed = store.add({ type: 'todo', text: 'b', sparc: false, state: 'failed', error: 'x' })
  const starting = store.add({ type: 'todo', text: 'c', sparc: false, state: 'starting', workspaceId: 'w-plug' })
  const question = store.add({ type: 'question', sessionId: 's', payload: {} })
  assert.equal(cancelStalePending(store), 1)
  assert.equal(store.get(question.id).status, 'resolved')
  assert.equal(store.get(waiting.id).state, 'awaiting-confirm')
  assert.equal(store.get(failed.id).status, 'open')
  assert.equal(store.get(starting.id).state, 'failed')
  assert.match(store.get(starting.id).error, /restart/i)
  assert.equal(store.get(starting.id).status, 'open')
})

test('the new session is a normal session: its done and permission items reach the list, linked by session id; the todo itself is untouched by them', async () => {
  const handlers = {}
  const ctx = { on: (name, fn) => { (handlers[name] ??= []).push(fn) }, get: () => undefined, logger: { warn() {}, info() {} } }
  const { queue, store, calls } = setup()
  const capture = installCapture(ctx, { store, summarizer: { summarize: async () => ({ text: 'Done it.', source: 'llm' }) } })
  const { id } = queue.addTodo('Fix the login redirect', { workspaceId: 'w-plug' })
  await queue.todoIdle()
  const sessionId = store.get(id).sessionId
  assert.equal(sessionId, 'S1')
  assert.deepEqual(names(calls), ['create', 'rename', 'prompt'])
  const agent = { id: sessionId, session: { id: sessionId, header: { cwd: 'D:/dev/ai/dsh-plugins' }, deriveMessages: () => [{ role: 'user', content: 'Fix the login redirect' }, { role: 'assistant', content: [{ type: 'text', text: 'Fixed. Please check the callback URL.' }] }] } }
  await handlers['agent/turn-stopping'][0]({ agent })
  void handlers['approval/request'][0]({ agent, toolName: 'shell', callId: 'c1' }, () => new Promise(() => {}))
  const open = queue.snapshot().open
  assert.deepEqual(open.map((i) => i.type).sort(), ['completed', 'permission'])
  assert.ok(open.every((i) => i.sessionId === sessionId))
  assert.equal(store.get(id).state, 'started', 'the later items do not disturb the todo')
  capture.dispose()
})
