import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createStore } from '../store.js'
import { createReviewQueue } from '../service.js'
import { createTodoImages } from '../todo-images.js'

// A pasted image is the attachment of the session the todo starts: it rides in the first prompt as an image part.
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('png body')])
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from('jfif')])
const WORKSPACES = [{ id: 'w1', title: 'Alpha', path: 'D:/a/alpha', sessionIds: [] }, { id: 'w2', title: 'Beta', path: 'D:/a/beta', sessionIds: [] }]

function setup({ promptError, withImages = true } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'rq-imgsvc-'))
  const root = join(dir, 'todo-images')
  const todoImages = createTodoImages({ root })
  let n = 0
  const store = createStore({ uuid: () => 'i' + ++n })
  const calls = []
  const controller = {
    create: async (arg) => { calls.push(['create', arg]); return { sessionId: 'S1' } },
    rename: async (arg) => { calls.push(['rename', arg]) },
    prompt: async (req) => { calls.push(['prompt', req]); if (promptError) throw new Error(promptError); return {} },
  }
  const queue = createReviewQueue({ store, capture: {}, controllerOf: () => controller, registryOf: () => ({ list: () => WORKSPACES }), ...(withImages ? { todoImages } : {}), suggestTimeoutMs: 40 })
  const files = () => { try { return readdirSync(root) } catch { return [] } }
  return { store, queue, calls, todoImages, files, done: () => rmSync(dir, { recursive: true, force: true }) }
}
const prompt = (calls) => calls.find((c) => c[0] === 'prompt')[1]

test('saveTodoImage stores an image; a file that is not one is refused', () => {
  const { queue, files, done } = setup()
  try {
    const r = queue.saveTodoImage(PNG)
    assert.equal(r.ok, true)
    assert.equal(r.mediaType, 'image/png')
    assert.equal(files().length, 1)
    assert.deepEqual(queue.saveTodoImage(Buffer.from('hello')), { ok: false, error: 'bad-image' })
  } finally { done() }
})

test('a todo with a workspace and images starts one session whose prompt is the text plus the image parts', async () => {
  const { queue, calls, store, todoImages, done } = setup()
  try {
    const a = queue.saveTodoImage(PNG).id
    const b = queue.saveTodoImage(JPEG).id
    const r = queue.addTodo('Fix this screen', { workspaceId: 'w1', images: [a, b] })
    assert.equal(r.ok, true)
    await queue.todoIdle()
    assert.deepEqual(prompt(calls).content, [
      { type: 'text', text: 'Fix this screen' },
      { type: 'image', mediaType: 'image/png', data: PNG.toString('base64') },
      { type: 'image', mediaType: 'image/jpeg', data: JPEG.toString('base64') },
    ])
    assert.equal(store.get(r.id).state, 'started')
    assert.equal(store.get(r.id).imageIds, undefined, 'a started todo no longer points at files')
    assert.deepEqual(todoImages.check([a]), { ok: false, error: 'unknown-image' }, 'the files are removed after the start')
  } finally { done() }
})

test('a SPARC todo keeps the image parts after the text part', async () => {
  const { queue, calls, done } = setup()
  try {
    const a = queue.saveTodoImage(PNG).id
    queue.addTodo('Task', { workspaceId: 'w1', sparc: true, images: [a] })
    await queue.todoIdle()
    const content = prompt(calls).content
    assert.equal(content.length, 2)
    assert.equal(content[0].type, 'text')
    assert.equal(content[1].type, 'image')
  } finally { done() }
})

test('a todo without images sends exactly the text part, as before', async () => {
  const { queue, calls, done } = setup()
  try {
    queue.addTodo('Plain', { workspaceId: 'w1' })
    await queue.todoIdle()
    assert.deepEqual(prompt(calls).content, [{ type: 'text', text: 'Plain' }])
  } finally { done() }
})

test('a todo waiting for a confirm keeps its images; confirm starts it with them', async () => {
  const { queue, calls, store, files, done } = setup()
  try {
    const a = queue.saveTodoImage(PNG).id
    const r = queue.addTodo('Nobody named here', { images: [a] })
    await queue.todoIdle()
    assert.equal(store.get(r.id).state, 'awaiting-confirm')
    assert.deepEqual(store.get(r.id).imageIds, [a])
    assert.equal(files().length, 1)
    assert.equal(queue.confirmTodo(r.id, { workspaceId: 'w2' }).ok, true)
    await queue.todoIdle()
    assert.equal(prompt(calls).content[1].type, 'image')
    assert.equal(files().length, 0)
  } finally { done() }
})

test('cancelling a todo removes its images', async () => {
  const { queue, store, files, done } = setup()
  try {
    const a = queue.saveTodoImage(PNG).id
    const r = queue.addTodo('Nobody named here', { images: [a] })
    await queue.todoIdle()
    assert.equal(queue.cancelTodo(r.id).ok, true)
    assert.equal(files().length, 0)
    assert.equal(store.get(r.id).imageIds, undefined)
  } finally { done() }
})

test('a start that fails keeps the images, so Retry sends them', async () => {
  const { queue, store, files, done } = setup({ promptError: 'model down' })
  try {
    const a = queue.saveTodoImage(PNG).id
    const r = queue.addTodo('Task', { workspaceId: 'w1', images: [a] })
    await queue.todoIdle()
    assert.equal(store.get(r.id).state, 'failed')
    assert.deepEqual(store.get(r.id).imageIds, [a])
    assert.equal(files().length, 1)
  } finally { done() }
})

test('an image file that vanished makes the start fail with a plain message, not a start without the picture', async () => {
  const { queue, calls, store, todoImages, done } = setup()
  try {
    const a = queue.saveTodoImage(PNG).id
    const r = queue.addTodo('Nobody named here', { images: [a] })
    await queue.todoIdle()
    todoImages.remove([a])
    queue.confirmTodo(r.id, { workspaceId: 'w1' })
    await queue.todoIdle()
    assert.equal(store.get(r.id).state, 'failed')
    assert.match(store.get(r.id).error, /image/)
    assert.equal(calls.some((c) => c[0] === 'prompt'), false)
  } finally { done() }
})

test('bad image ids are refused before anything is added', () => {
  const { queue, store, done } = setup()
  try {
    const good = queue.saveTodoImage(PNG).id
    assert.deepEqual(queue.addTodo('x', { workspaceId: 'w1', images: 'nope' }), { ok: false, error: 'bad-images' })
    assert.deepEqual(queue.addTodo('x', { workspaceId: 'w1', images: ['../../etc/passwd'] }), { ok: false, error: 'bad-images' })
    assert.deepEqual(queue.addTodo('x', { workspaceId: 'w1', images: ['00000000-0000-4000-8000-000000000000'] }), { ok: false, error: 'unknown-image' })
    assert.deepEqual(queue.addTodo('x', { workspaceId: 'w1', images: Array(6).fill(good) }), { ok: false, error: 'too-many-images' })
    assert.equal(store.list().length, 0)
  } finally { done() }
})

test('a follow-up with bad image ids is refused before anything is added', () => {
  const { queue, store, done } = setup()
  try {
    assert.deepEqual(queue.addTodo('hello', { followUp: 'the login session', images: ['00000000-0000-4000-8000-000000000000'] }), { ok: false, error: 'unknown-image' })
    assert.equal(store.list().length, 0)
  } finally { done() }
})

test('a follow-up carries its images as image parts after the text, then the files are removed', async () => {
  const { queue, store, calls, files, done } = setup()
  try {
    const a = queue.saveTodoImage(PNG).id
    const added = queue.addTodo('hello', { followUp: 'the login session', images: [a], sessions: [{ sessionId: 'S9', title: 'Login session', updatedAt: 1 }] })
    assert.equal(added.ok, true)
    await queue.todoIdle()
    assert.deepEqual(store.get(added.id).imageIds, [a])
    assert.deepEqual(queue.confirmTodo(added.id, { sessionId: 'S9' }), { ok: true, state: 'starting' })
    await queue.todoIdle()
    const content = prompt(calls).content
    assert.equal(content[0].text, 'hello')
    assert.equal(content.length, 2)
    assert.equal(content[1].type, 'image')
    assert.equal(files().length, 0)
    assert.equal(store.get(added.id).imageIds, undefined)
  } finally { done() }
})

test('without an image store (a test, an unusable state folder) images are refused and plain todos still work', async () => {
  const { queue, calls, done } = setup({ withImages: false })
  try {
    assert.deepEqual(queue.saveTodoImage(PNG), { ok: false, error: 'bad-image' })
    assert.deepEqual(queue.addTodo('x', { workspaceId: 'w1', images: ['00000000-0000-4000-8000-000000000000'] }), { ok: false, error: 'bad-images' })
    queue.addTodo('x', { workspaceId: 'w1' })
    await queue.todoIdle()
    assert.deepEqual(prompt(calls).content, [{ type: 'text', text: 'x' }])
  } finally { done() }
})
