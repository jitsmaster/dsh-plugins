import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createStore } from '../store.js'
import { createReviewQueue } from '../service.js'

// The effort of a new todo: the form can pick a reasoning effort for the session it starts. It applies to that session only: the default
// model selection (agentDefaultModel) is never left changed, because Remote selectModel also saves its selection as the default.
const WORKSPACES = [{ id: 'w-plug', title: 'dsh-plugins', path: 'D:/dev/ai/dsh-plugins', sessionIds: [] }]
const EFFORTS = [{ id: 'low', name: 'Low' }, { id: 'medium', name: 'Medium', description: 'balanced' }, { id: 'high', name: 'High' }]
const catalogOf = ({ defaultEffort = 'medium', selected, reasoning = true } = {}) => ({
  default: { provider: 'deepseek', model: 'm1', ...(selected ? { reasoningEffort: selected } : {}) },
  routableProviders: ['deepseek'],
  groups: [{ id: 'deepseek', name: 'DeepSeek', models: [{ id: 'm1', name: 'Model One', ...(reasoning ? { reasoning: { efforts: EFFORTS, defaultEffort } } : {}) }] }],
  failures: [],
})

function setup({ catalog = catalogOf(), selectError, noDefaultModel, catalogError } = {}) {
  let n = 0
  let t = 1000
  const store = createStore({ now: () => ++t, uuid: () => 'i' + ++n })
  const calls = []
  const controller = {
    create: async (arg) => { calls.push(['create', arg]); return { sessionId: 'S1' } },
    rename: async (arg) => { calls.push(['rename', arg]) },
    modelCatalog: async () => { calls.push(['modelCatalog']); if (catalogError) throw new Error(catalogError); return catalog },
    selectModel: async (arg) => { calls.push(['selectModel', arg]); if (selectError) throw new Error(selectError); return { selected: { provider: arg.provider, model: arg.model, reasoningEffort: arg.reasoningEffort } } },
    prompt: async (req) => { calls.push(['prompt', req]); return {} },
  }
  const defaultModel = { saveSelection: async (sel) => { calls.push(['saveDefault', sel]) } }
  const registry = { list: () => WORKSPACES, archivedSessionIds: [] }
  const queue = createReviewQueue({ store, capture: {}, controllerOf: () => controller, registryOf: () => registry, ...(noDefaultModel ? {} : { defaultModelOf: () => defaultModel }), now: () => 5000 })
  return { store, queue, calls }
}
const names = (calls) => calls.map((c) => c[0])
const todoOf = (store) => store.list().find((i) => i.type === 'todo')

test('modelEfforts lists the efforts of the default model and which one is the default', async () => {
  const { queue } = setup()
  assert.deepEqual(await queue.modelEfforts(), { ok: true, model: { provider: 'deepseek', id: 'm1', name: 'Model One' }, efforts: EFFORTS, defaultEffort: 'medium' })
})

test('modelEfforts: the effort chosen as default wins over the model default; a model without efforts, and a failing catalog, give an empty list', async () => {
  assert.equal((await setup({ catalog: catalogOf({ selected: 'high' }) }).queue.modelEfforts()).defaultEffort, 'high')
  const none = await setup({ catalog: catalogOf({ reasoning: false }) }).queue.modelEfforts()
  assert.deepEqual(none.efforts, [])
  assert.equal(none.ok, true)
  assert.deepEqual(await setup({ catalogError: 'down' }).queue.modelEfforts(), { ok: true, efforts: [] })
})

test('a todo with another effort: create, select the effort for that session, give the default back, then rename and prompt', async () => {
  const { queue, store, calls } = setup()
  assert.equal(queue.addTodo('Fix it', { workspaceId: 'w-plug', effort: 'high' }).ok, true)
  await queue.todoIdle()
  assert.deepEqual(names(calls), ['create', 'modelCatalog', 'selectModel', 'saveDefault', 'rename', 'prompt'])
  assert.deepEqual(calls.find((c) => c[0] === 'selectModel')[1], { sessionId: 'S1', provider: 'deepseek', model: 'm1', reasoningEffort: 'high' })
  assert.deepEqual(calls.find((c) => c[0] === 'saveDefault')[1], { provider: 'deepseek', model: 'm1' }, 'the default selection as it was before')
  assert.equal(todoOf(store).effort, 'high')
  assert.equal(todoOf(store).state, 'started')
})

test('the default the user had chosen (with its own effort) is what is given back', async () => {
  const { queue, calls } = setup({ catalog: catalogOf({ selected: 'low' }) })
  queue.addTodo('Fix it', { workspaceId: 'w-plug', effort: 'high' })
  await queue.todoIdle()
  assert.deepEqual(calls.find((c) => c[0] === 'saveDefault')[1], { provider: 'deepseek', model: 'm1', reasoningEffort: 'low' })
})

test('no effort, or the effort that already is the default: nothing is selected and nothing is saved', async () => {
  const expected = { none: ['create', 'rename', 'prompt'], empty: ['create', 'rename', 'prompt'], same: ['create', 'modelCatalog', 'rename', 'prompt'] }
  for (const [label, opts] of [['none', {}], ['empty', { effort: '' }], ['same', { effort: 'medium' }]]) {
    const { queue, calls } = setup()
    queue.addTodo('Fix it', { workspaceId: 'w-plug', ...opts })
    await queue.todoIdle()
    assert.deepEqual(names(calls), expected[label], label)
  }
})

test('an effort the default model does not have fails the todo before the prompt (Retry is offered) and saves nothing', async () => {
  const { queue, store, calls } = setup()
  queue.addTodo('Fix it', { workspaceId: 'w-plug', effort: 'turbo' })
  await queue.todoIdle()
  const item = todoOf(store)
  assert.equal(item.state, 'failed')
  assert.match(item.error, /turbo/)
  assert.ok(!names(calls).includes('prompt') && !names(calls).includes('selectModel') && !names(calls).includes('saveDefault'))
})

test('a selectModel that fails fails the todo and saves nothing; a missing default-model service still starts the session', async () => {
  const bad = setup({ selectError: 'model-unavailable' })
  bad.queue.addTodo('Fix it', { workspaceId: 'w-plug', effort: 'high' })
  await bad.queue.todoIdle()
  assert.equal(todoOf(bad.store).state, 'failed')
  assert.ok(!names(bad.calls).includes('saveDefault') && !names(bad.calls).includes('prompt'))
  const bare = setup({ noDefaultModel: true })
  bare.queue.addTodo('Fix it', { workspaceId: 'w-plug', effort: 'high' })
  await bare.queue.todoIdle()
  assert.equal(todoOf(bare.store).state, 'started')
})

test('a todo that waits for its workspace keeps the effort until Start', async () => {
  const { queue, store, calls } = setup()
  const added = queue.addTodo('Fix it', { effort: 'low' })
  assert.equal(added.state, 'awaiting-confirm')
  assert.equal(todoOf(store).effort, 'low')
  queue.confirmTodo(added.id, { workspaceId: 'w-plug' })
  await queue.todoIdle()
  assert.equal(calls.find((c) => c[0] === 'selectModel')[1].reasoningEffort, 'low')
})

test('a bad effort (not a short string) is refused; a follow-up ignores it', async () => {
  const { queue } = setup()
  assert.deepEqual(queue.addTodo('Fix it', { workspaceId: 'w-plug', effort: { x: 1 } }), { ok: false, error: 'bad-effort' })
  assert.deepEqual(queue.addTodo('Fix it', { workspaceId: 'w-plug', effort: 'x'.repeat(100) }), { ok: false, error: 'bad-effort' })
})
