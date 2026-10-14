import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createStore } from '../store.js'
import { createReviewQueue } from '../service.js'
import { SUGGEST_TIMEOUT_MS } from '../todo.js'

// Why a \"Choose for me\" todo got no workspace is recorded on the item (suggestNote) and logged; an earlier started todo of the
// same project (a URL prefix) resolves a bare URL without the model; the model sees the earlier todos and has room to answer.
const WORKSPACES = [
  { id: 'w-orca', title: 'Orca', path: 'D:/dev/ai/orca-engine', sessionIds: [] },
  { id: 'w-plug', title: 'dsh-plugins', path: 'D:/dev/ai/dsh-plugins', sessionIds: [] },
  { id: 'w-ctnp', title: 'CTnP-Final', path: 'D:/dev/CTnP-Final', sessionIds: [] },
]
const URL_A = 'https://ingeniuxdev.visualstudio.com/Ingeniux/_workitems/edit/25597'
const URL_B = 'https://ingeniuxdev.visualstudio.com/Ingeniux/_workitems/edit/25001'

/** A fake llm service in the shape summary.js expects. */
function fakeLlm({ answer, fail, failMessage, hang, noModels, seen = {} } = {}) {
  return {
    listProviders: async () => [{ id: 'p1' }],
    listModels: async () => (noModels ? [] : [{ id: 'claude-haiku-x' }]),
    prepareCall: async (cfg) => ({
      config: {},
      stream: async function* (req) {
        seen.cfg = cfg
        seen.req = req
        seen.calls = (seen.calls ?? 0) + 1
        if (hang) await new Promise((_, rej) => req.signal.addEventListener('abort', () => rej(new Error('aborted'))))
        if (fail) throw new Error(failMessage ?? 'llm down')
        yield { type: 'text-delta', text: answer }
      },
    }),
  }
}

function setup({ llm, noRegistry, logs = [], workspaces = WORKSPACES } = {}) {
  let n = 0
  let t = 1000
  const store = createStore({ now: () => ++t, uuid: () => 'i' + ++n })
  const controller = { create: async () => ({ sessionId: 'S1' }), rename: async () => {}, prompt: async () => ({}) }
  const registry = { list: () => workspaces, archivedSessionIds: [] }
  const queue = createReviewQueue({
    store, capture: {}, controllerOf: () => controller, registryOf: noRegistry ? () => undefined : () => registry,
    llm, suggestTimeoutMs: 40, now: () => 5000, log: (line) => logs.push(line),
  })
  return { store, queue, logs }
}
const todo = (store, id) => store.get(id)
const promptOf = (seen) => seen.req.system + '\n' + JSON.stringify(seen.req.messages)

/** An earlier todo that was started in a workspace (resolved, state started). */
function seedStarted(store, text, workspaceId, workspaceTitle, state = 'started') {
  const item = store.add({ type: 'todo', text, sparc: false, state, workspaceId, workspaceTitle })
  if (state === 'started') store.resolve(item.id, { kind: 'started', by: 'card', sessionId: 's-' + item.id })
  else if (state === 'cancelled') store.resolve(item.id, { kind: 'cancelled', by: 'card' })
  return item
}

// ---- 1. the reason is recorded -------------------------------------------------------------------------------------
test('the default suggestion time limit is 30 s', () => {
  assert.equal(SUGGEST_TIMEOUT_MS, 30000)
})

test('a model pass without a suggestion records why on the item (suggestNote) together with suggesting:false', async () => {
  const long = 'x'.repeat(200)
  const cases = [
    ['unknown id', { llm: fakeLlm({ answer: '{\"workspaceId\":\"w-nope\",\"reason\":\"x\"}' }) }, 'the model answered something unusable'],
    ['null id', { llm: fakeLlm({ answer: '{\"workspaceId\":null}' }) }, 'the model found no clear fit'],
    ['no workspaceId key', { llm: fakeLlm({ answer: '{}' }) }, 'the model found no clear fit'],
    ['not json', { llm: fakeLlm({ answer: 'probably Orca' }) }, 'the model answered something unusable'],
    ['empty answer', { llm: fakeLlm({ answer: '' }) }, 'the model answered something unusable'],
    ['llm fails', { llm: fakeLlm({ fail: true }) }, 'LLM error: llm down'],
    ['llm hangs (time limit 40 ms in these tests)', { llm: fakeLlm({ hang: true }) }, 'timed out after 40 ms'],
    ['no models at all', { llm: fakeLlm({ noModels: true }) }, 'no model available'],
    ['no llm service', {}, 'no model available'],
    ['llm service throws', { llm: { listProviders: () => { throw new Error('down') }, listModels: async () => [], prepareCall: async () => ({}) } }, 'LLM error: down'],
  ]
  for (const [label, opts, note] of cases) {
    const { queue, store } = setup(opts)
    const { id } = queue.addTodo('Make the website header sticky')
    assert.equal(todo(store, id).suggesting, true, label)
    await queue.todoIdle()
    const item = todo(store, id)
    assert.equal(item.suggestNote, note, label)
    assert.equal(item.suggesting, false, label)
    assert.equal(item.suggested, undefined, label)
    assert.equal(item.state, 'awaiting-confirm', label)
  }
  const { queue, store } = setup({ llm: fakeLlm({ fail: true, failMessage: long }) })
  const { id } = queue.addTodo('Make the website header sticky')
  await queue.todoIdle()
  const note = todo(store, id).suggestNote
  assert.ok(note.startsWith('LLM error: xxxx'), note)
  assert.ok(note.length <= 'LLM error: '.length + 80, 'the message is cut to 80 characters: ' + note.length)
})

test('a suggestion (by the model, by name) leaves no suggestNote; no registry or no workspaces means no model pass and no note', async () => {
  const a = setup({ llm: fakeLlm({ answer: '{\"workspaceId\":\"w-ctnp\",\"reason\":\"site\"}' }) })
  const one = a.queue.addTodo('Make the website header sticky').id
  await a.queue.todoIdle()
  assert.equal(todo(a.store, one).suggestNote, undefined)
  assert.equal(todo(a.store, one).suggested.workspaceId, 'w-ctnp')
  const b = setup()
  const two = b.queue.addTodo('Update the dsh-plugins readme').id
  await b.queue.todoIdle()
  assert.equal(todo(b.store, two).suggestNote, undefined)
  const c = setup({ noRegistry: true })
  const three = c.queue.addTodo('Something').id
  await c.queue.todoIdle()
  assert.equal(todo(c.store, three).suggestNote, undefined)
})

test('the note and the first 200 characters of the raw model answer go to the log', async () => {
  const raw = 'I think ' + 'blah '.repeat(80)
  const { queue, logs } = setup({ llm: fakeLlm({ answer: raw }) })
  queue.addTodo('Make the website header sticky')
  await queue.todoIdle()
  const line = logs.find((l) => /suggestion/.test(l) && /unusable/.test(l))
  assert.ok(line, JSON.stringify(logs))
  assert.ok(line.includes(raw.slice(0, 200).trim()), 'the first 200 characters of the answer')
  assert.ok(!line.includes(raw.slice(0, 260)), 'but not more than 200')
  const failing = setup({ llm: fakeLlm({ fail: true }) })
  failing.queue.addTodo('Make the website header sticky')
  await failing.queue.todoIdle()
  assert.ok(failing.logs.some((l) => /LLM error: llm down/.test(l)))
})

// ---- 2. room for a reasoning model ----------------------------------------------------------------------------------
test('the suggestion call allows 600 tokens, so a model that reasons first still gets to the JSON', async () => {
  const seen = {}
  const { queue } = setup({ llm: fakeLlm({ answer: '{\"workspaceId\":null}', seen }) })
  queue.addTodo('Make the website header sticky')
  await queue.todoIdle()
  assert.equal(seen.cfg.maxTokens, 600)
})

// ---- 3a. earlier todos in the prompt --------------------------------------------------------------------------------
test('the model also sees the last 8 started todos (text cut to 120 characters) and the workspace each started in', async () => {
  const seen = {}
  const { queue, store } = setup({ llm: fakeLlm({ answer: '{\"workspaceId\":null}', seen }) })
  for (let i = 1; i <= 10; i++) seedStarted(store, 'item-' + String(i).padStart(2, '0') + '-text ' + 'y'.repeat(200), i % 2 ? 'w-ctnp' : 'w-plug', i % 2 ? 'CTnP-Final' : 'dsh-plugins')
  seedStarted(store, 'a cancelled one', 'w-orca', 'Orca', 'cancelled')
  queue.addTodo('Make the website header sticky')
  await queue.todoIdle()
  const prompt = promptOf(seen)
  assert.match(prompt, /Earlier todos and where they started/)
  assert.ok(!prompt.includes('item-01-text') && !prompt.includes('item-02-text'), 'only the last 8')
  for (let i = 3; i <= 10; i++) assert.ok(prompt.includes('item-' + String(i).padStart(2, '0') + '-text'), 'item ' + i)
  assert.ok(!prompt.includes('y'.repeat(121)), 'cut to 120 characters')
  assert.ok(!prompt.includes('a cancelled one'), 'only started todos')
  assert.ok(prompt.includes('CTnP-Final') && prompt.includes('w-ctnp'), 'the workspace title and id')
  assert.match(seen.req.system, /earlier todo/i)
  assert.match(seen.req.system, /same (site|project)|URL/i)
  assert.match(seen.req.system, /untrusted/i)
})

test('without earlier started todos the prompt has no earlier-todos section', async () => {
  const seen = {}
  const { queue } = setup({ llm: fakeLlm({ answer: '{\"workspaceId\":null}', seen }) })
  queue.addTodo('Make the website header sticky')
  await queue.todoIdle()
  assert.ok(!/Earlier todos/.test(promptOf(seen)))
})

// ---- 3b. the deterministic same-project pass ------------------------------------------------------------------------
test('the real case: a bare ticket URL whose project an earlier todo started in CTnP-Final is suggested without the model', async () => {
  const seen = {}
  const { queue, store, logs } = setup({ llm: fakeLlm({ answer: '{\"workspaceId\":null}', seen }) })
  seedStarted(store, 'handle ticket ' + URL_B, 'w-ctnp', 'CTnP-Final')
  const r = queue.addTodo('handle ticket ' + URL_A)
  assert.deepEqual([r.ok, r.state], [true, 'awaiting-confirm'])
  const item = todo(store, r.id)
  assert.deepEqual(item.suggested, { workspaceId: 'w-ctnp', title: 'CTnP-Final', reason: 'same project as an earlier todo' })
  assert.notEqual(item.suggesting, true, 'no looking: the answer is already there')
  await queue.todoIdle()
  assert.equal(seen.calls, undefined, 'no LLM call')
  assert.equal(todo(store, r.id).state, 'awaiting-confirm', 'still waits for the user')
  assert.equal(store.list({ status: 'resolved' }).filter((i) => i.type === 'todo' && i.id === r.id).length, 0, 'nothing is started')
  assert.ok(Array.isArray(logs))
})

test('same project: origin and first path segment, any case, URLs among other text; the one workspace of several matching todos wins', async () => {
  const { queue, store } = setup()
  seedStarted(store, 'first (see HTTPS://IngeniuxDev.visualstudio.com/ingeniux/_workitems/edit/1).', 'w-ctnp', 'CTnP-Final')
  seedStarted(store, 'second ' + URL_B + ' and more', 'w-ctnp', 'CTnP-Final')
  const { id } = queue.addTodo('please look at <' + URL_A + '>, thanks')
  assert.equal(todo(store, id).suggested.workspaceId, 'w-ctnp')
})

test('the match looks at all earlier started todos, not only the last 8 shown to the model', async () => {
  const { queue, store } = setup()
  seedStarted(store, 'old ' + URL_B, 'w-ctnp', 'CTnP-Final')
  for (let i = 0; i < 9; i++) seedStarted(store, 'unrelated ' + i, 'w-plug', 'dsh-plugins')
  const { id } = queue.addTodo('handle ' + URL_A)
  assert.equal(todo(store, id).suggested.workspaceId, 'w-ctnp')
})

test('the same URL prefix started in different workspaces is ambiguous: no deterministic suggestion, the model is asked', async () => {
  const seen = {}
  const { queue, store } = setup({ llm: fakeLlm({ answer: '{\"workspaceId\":\"w-plug\",\"reason\":\"model pick\"}', seen }) })
  seedStarted(store, 'a ' + URL_B, 'w-ctnp', 'CTnP-Final')
  seedStarted(store, 'b ' + URL_B, 'w-plug', 'dsh-plugins')
  const { id } = queue.addTodo('handle ' + URL_A)
  assert.equal(todo(store, id).suggested, undefined)
  assert.equal(todo(store, id).suggesting, true)
  await queue.todoIdle()
  assert.equal(seen.calls, 1)
  assert.deepEqual(todo(store, id).suggested, { workspaceId: 'w-plug', title: 'dsh-plugins', reason: 'model pick' })
})

test('a different project prefix, a different host, no URL, a cancelled or failed earlier todo, or a workspace that is gone: no deterministic suggestion', async () => {
  const cases = [
    ['other first segment', 'earlier https://ingeniuxdev.visualstudio.com/Other/_workitems/edit/9', 'w-ctnp', 'started'],
    ['other host', 'earlier https://dev.azure.com/Ingeniux/_workitems/edit/9', 'w-ctnp', 'started'],
    ['no url in the earlier todo', 'earlier fix the header', 'w-ctnp', 'started'],
    ['cancelled earlier todo', 'earlier ' + URL_B, 'w-ctnp', 'cancelled'],
    ['failed earlier todo', 'earlier ' + URL_B, 'w-ctnp', 'failed'],
    ['workspace gone', 'earlier ' + URL_B, 'w-gone', 'started'],
  ]
  for (const [label, text, ws, state] of cases) {
    const seen = {}
    const { queue, store } = setup({ llm: fakeLlm({ answer: '{\"workspaceId\":null}', seen }) })
    seedStarted(store, text, ws, 'Somewhere', state)
    const { id } = queue.addTodo('handle ' + URL_A)
    assert.equal(todo(store, id).suggested, undefined, label)
    await queue.todoIdle()
    assert.equal(seen.calls, 1, label + ': the model is asked')
    assert.equal(todo(store, id).suggestNote, 'the model found no clear fit', label)
  }
  const none = setup({ llm: fakeLlm({ answer: '{\"workspaceId\":null}' }) })
  seedStarted(none.store, 'earlier ' + URL_B, 'w-ctnp', 'CTnP-Final')
  const { id } = none.queue.addTodo('handle the header, no link')
  assert.equal(todo(none.store, id).suggested, undefined)
})

test('a workspace named in the text still wins over the earlier-todo pass', async () => {
  const { queue, store } = setup()
  seedStarted(store, 'earlier ' + URL_B, 'w-ctnp', 'CTnP-Final')
  const { id } = queue.addTodo('handle ' + URL_A + ' in Orca')
  assert.deepEqual(todo(store, id).suggested, { workspaceId: 'w-orca', title: 'Orca', reason: 'named in the text' })
})

test('the earlier-todo suggestion starts nothing until the user confirms', async () => {
  const calls = []
  const store = createStore()
  const controller = { create: async (a) => { calls.push(['create', a]); return { sessionId: 'S1' } }, rename: async () => {}, prompt: async () => ({}) }
  const queue = createReviewQueue({ store, capture: {}, controllerOf: () => controller, registryOf: () => ({ list: () => WORKSPACES }) })
  seedStarted(store, 'earlier ' + URL_B, 'w-ctnp', 'CTnP-Final')
  const { id } = queue.addTodo('handle ' + URL_A)
  await queue.todoIdle()
  assert.deepEqual(calls, [])
  assert.deepEqual(queue.confirmTodo(id), { ok: true, state: 'starting' })
  await queue.todoIdle()
  assert.deepEqual(calls, [['create', { workspaceId: 'w-ctnp' }]])
})

// ---- 4. a structured answer for the dropdown ------------------------------------------------------------------------
test('the model is shown the workspaces as dropdown options and asked for the value to select', async () => {
  const seen = {}
  const { queue } = setup({ llm: fakeLlm({ answer: '{"select":null}', seen }) })
  queue.addTodo('Make the website header sticky')
  await queue.todoIdle()
  assert.match(seen.req.system, /"select"/)
  assert.match(seen.req.system, /dropdown|option/i)
  const text = seen.req.messages[0].content[0].text
  assert.match(text, /"value":"w-ctnp"/)
  assert.match(text, /"label":"CTnP-Final"/)
})

test('the answer {"select": <option value>} becomes the suggestion; {"select": null} is no fit', async () => {
  const a = setup({ llm: fakeLlm({ answer: '{"select":"w-ctnp","reason":"site work"}' }) })
  const one = a.queue.addTodo('Make the website header sticky').id
  await a.queue.todoIdle()
  assert.deepEqual(todo(a.store, one).suggested, { workspaceId: 'w-ctnp', title: 'CTnP-Final', reason: 'site work' })
  const b = setup({ llm: fakeLlm({ answer: '{"select":null}' }) })
  const two = b.queue.addTodo('Make the website header sticky').id
  await b.queue.todoIdle()
  assert.equal(todo(b.store, two).suggestNote, 'the model found no clear fit')
})

test('a model that answers with the workspace name instead of the id is still understood (label or folder, any case); an unknown name is unusable', async () => {
  for (const [answer, id] of [['{"select":"dsh-plugins"}', 'w-plug'], ['{"workspaceId":"CTNP-final","reason":"x"}', 'w-ctnp'], ['{"select":"orca-engine"}', 'w-orca']]) {
    const { queue, store } = setup({ llm: fakeLlm({ answer }) })
    const { id: todoId } = queue.addTodo('Make the website header sticky')
    await queue.todoIdle()
    assert.equal(todo(store, todoId).suggested?.workspaceId, id, answer)
  }
  const { queue, store } = setup({ llm: fakeLlm({ answer: '{"select":"Nowhere"}' }) })
  const { id } = queue.addTodo('Make the website header sticky')
  await queue.todoIdle()
  assert.equal(todo(store, id).suggestNote, 'the model answered something unusable')
})
