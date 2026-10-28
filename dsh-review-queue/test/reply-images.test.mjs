import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createStore } from '../store.js'
import { createReviewQueue } from '../service.js'
import { createTodoImages } from '../todo-images.js'

// A done card's reply may carry pasted images: they follow the text as image parts of one new user message of the session.
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('png body')])
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from('jfif')])

function setup({ withImages = true } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'rq-replyimg-'))
  const todoImages = createTodoImages({ root: join(dir, 'todo-images') })
  let n = 0
  const store = createStore({ uuid: () => 'i' + ++n })
  const calls = []
  const controller = { prompt: async (req) => { calls.push(req); return { accepted: true } } }
  const queue = createReviewQueue({ store, capture: {}, controllerOf: () => controller, ...(withImages ? { todoImages } : {}) })
  const item = store.add({ type: 'completed', sessionId: 'sess-9', sessionTitle: 'S', summary: 'Done', payload: { reply: 'ok' } })
  return { store, queue, calls, todoImages, item, done: () => rmSync(dir, { recursive: true, force: true }) }
}

test('reply with text and images sends one prompt: the text, then the image parts, and removes the files', async () => {
  const { store, queue, calls, todoImages, item, done } = setup()
  try {
    const a = queue.saveTodoImage(PNG).id
    const b = queue.saveTodoImage(JPEG).id
    assert.deepEqual(await queue.reply(item.id, 'look at this', { images: [a, b] }), { ok: true })
    assert.equal(calls.length, 1)
    assert.equal(calls[0].sessionId, 'sess-9')
    assert.deepEqual(calls[0].content, [
      { type: 'text', text: 'look at this' },
      { type: 'image', mediaType: 'image/png', data: PNG.toString('base64') },
      { type: 'image', mediaType: 'image/jpeg', data: JPEG.toString('base64') },
    ])
    assert.equal(store.get(item.id).resolution.kind, 'replied')
    assert.deepEqual(todoImages.check([a]), { ok: false, error: 'unknown-image' })
  } finally { done() }
})

test('a reply may be images alone; no text part is sent', async () => {
  const { queue, calls, item, done } = setup()
  try {
    const a = queue.saveTodoImage(PNG).id
    assert.deepEqual(await queue.reply(item.id, '', { images: [a] }), { ok: true })
    assert.deepEqual(calls[0].content, [{ type: 'image', mediaType: 'image/png', data: PNG.toString('base64') }])
  } finally { done() }
})

test('the same picture uploaded twice (two ids) reaches the session once', async () => {
  const { queue, calls, item, done } = setup()
  try {
    const a = queue.saveTodoImage(PNG).id
    const b = queue.saveTodoImage(PNG).id
    assert.notEqual(a, b)
    assert.deepEqual(await queue.reply(item.id, 'twice', { images: [a, b] }), { ok: true })
    assert.equal(calls[0].content.filter((p) => p.type === 'image').length, 1)
  } finally { done() }
})

test('a reply with an unknown or malformed image, or too many, is refused and sends nothing', async () => {
  const { store, queue, calls, item, done } = setup()
  try {
    assert.deepEqual(await queue.reply(item.id, 'x', { images: ['nope'] }), { ok: false, error: 'bad-images' })
    assert.deepEqual(await queue.reply(item.id, 'x', { images: ['00000000-0000-0000-0000-000000000000'] }), { ok: false, error: 'unknown-image' })
    const ids = Array.from({ length: 6 }, (_, i) => queue.saveTodoImage(Buffer.concat([PNG, Buffer.from(String(i))])).id)
    assert.deepEqual(await queue.reply(item.id, 'x', { images: ids }), { ok: false, error: 'too-many-images' })
    assert.equal(calls.length, 0)
    assert.equal(store.get(item.id).status, 'open')
  } finally { done() }
})

test('without an image store a reply with images is refused; one without images still works', async () => {
  const { queue, calls, item, done } = setup({ withImages: false })
  try {
    assert.deepEqual(await queue.reply(item.id, 'x', { images: ['a'] }), { ok: false, error: 'bad-images' })
    assert.deepEqual(await queue.reply(item.id, 'plain'), { ok: true })
    assert.deepEqual(calls[0].content, [{ type: 'text', text: 'plain' }])
  } finally { done() }
})

test('a failed send keeps the images for a retry', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rq-replyimg-'))
  try {
    const todoImages = createTodoImages({ root: join(dir, 'todo-images') })
    const store = createStore({ uuid: () => 'i1' })
    const queue = createReviewQueue({ store, capture: {}, controllerOf: () => ({ prompt: async () => { throw new Error('boom') } }), todoImages })
    const item = store.add({ type: 'completed', sessionId: 's', summary: 'Done', payload: {} })
    const a = queue.saveTodoImage(PNG).id
    assert.deepEqual(await queue.reply(item.id, 'x', { images: [a] }), { ok: false, error: 'post-failed' })
    assert.deepEqual(todoImages.check([a]), { ok: true, ids: [a] })
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
