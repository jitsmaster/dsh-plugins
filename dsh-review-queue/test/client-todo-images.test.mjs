import { test } from 'node:test'
import assert from 'node:assert/strict'
import { FORM, KEY, loadClient, savedDraft, formOf, need, okJson, deferred, tick, el, findAll, textOf } from './client-todo-helpers.mjs'

// Pasting an image into the desktop "+ New todo" form (New session mode only): each image is uploaded on its own (POST /v1/todo-image, raw body),
// shown as a thumbnail with a remove button, and its id is sent with the todo ({ images: [ids] }). Images are never kept in the saved draft.
const UP = '/review-queue/v1/todo-image'
const file = (name, type = 'image/png', size = 100) => ({ name, type, size })
const clip = (items, files = []) => ({ items: items.map(([kind, type, f]) => ({ kind, type, getAsFile: () => f })), files })

function withFetch(handler) {
  const calls = []
  const fetchImpl = async (url, init) => { calls.push([url, init]); return handler(url, init, calls) }
  return { calls, fetchImpl }
}
const saved = (n) => okJson({ ok: true, id: 'id-' + n, mediaType: 'image/png', bytes: 100 })

test('imageFilesOf takes the image files of a paste (screenshots come as items of kind file) and nothing else', () => {
  const { T } = loadClient()
  need(T, 'imageFilesOf')
  const png = file('image.png')
  const jpg = file('p.jpg', 'image/jpeg')
  assert.deepEqual([...T.imageFilesOf(clip([['file', 'image/png', png], ['string', 'text/plain', null], ['file', 'application/pdf', file('a.pdf', 'application/pdf')], ['file', 'image/jpeg', jpg]]))], [png, jpg])
  assert.deepEqual([...T.imageFilesOf(clip([['string', 'text/plain', null]]))], [])
  assert.deepEqual([...T.imageFilesOf(clip([['file', 'image/svg+xml', file('x.svg', 'image/svg+xml')]]))], [], 'only png, jpeg, webp and gif')
  assert.deepEqual([...T.imageFilesOf(undefined)], [])
  assert.deepEqual([...T.imageFilesOf({ files: [png] })], [png], 'files, when the browser gives no items')
})

test('addImages uploads each file raw with its own content type and shows it in the form', async () => {
  const { fetchImpl, calls } = withFetch(() => saved(calls.length))
  const { T } = loadClient({ fetchImpl })
  need(T, 'addImages')
  T.set({ todoForm: FORM({ text: 'x' }) })
  const f = file('shot.png')
  assert.equal(await T.addImages([f]), true)
  assert.equal(calls.length, 1)
  assert.equal(calls[0][0], UP)
  assert.equal(calls[0][1].method, 'POST')
  assert.equal(calls[0][1].headers['content-type'], 'image/png')
  assert.equal(calls[0][1].body, f, 'the File itself is the body, not JSON')
  const form = formOf(T)
  assert.deepEqual(form.images.map((i) => [i.id, i.name]), [['id-1', 'shot.png']])
  assert.equal(form.uploading, 0)
})

test('while an upload runs the form says so; a failed upload shows the reason and adds nothing', async () => {
  const gate = deferred()
  const { fetchImpl } = withFetch(() => gate.promise)
  const { T } = loadClient({ fetchImpl })
  T.set({ todoForm: FORM({ text: 'x' }) })
  const pending = T.addImages([file('a.png')])
  await tick()
  assert.equal(formOf(T).uploading, 1)
  gate.resolve(okJson({ ok: false, error: 'bad-image' }, 400))
  assert.equal(await pending, false)
  const form = formOf(T)
  assert.equal(form.uploading, 0)
  assert.deepEqual(form.images ?? [], [])
  assert.match(form.error, /image/i)
})

test('a network failure of an upload is shown, not thrown', async () => {
  const { T } = loadClient({ fetchImpl: async () => { throw new Error('offline') } })
  T.set({ todoForm: FORM({ text: 'x' }) })
  assert.equal(await T.addImages([file('a.png')]), false)
  assert.match(formOf(T).error, /offline/)
})

test('at most 5 images; a file over 8 MB is refused before it is sent', async () => {
  const { fetchImpl, calls } = withFetch(() => saved(calls.length))
  const { T } = loadClient({ fetchImpl })
  T.set({ todoForm: FORM({ text: 'x' }) })
  await T.addImages([1, 2, 3, 4, 5].map((n) => file('i' + n + '.png')))
  assert.equal(formOf(T).images.length, 5)
  calls.length = 0
  assert.equal(await T.addImages([file('six.png')]), false)
  assert.equal(calls.length, 0)
  assert.match(formOf(T).error, /5/)
  const t2 = loadClient({ fetchImpl })
  t2.T.set({ todoForm: FORM({ text: 'x' }) })
  assert.equal(await t2.T.addImages([file('big.png', 'image/png', 9 * 1024 * 1024)]), false)
  assert.equal(calls.length, 0)
  assert.match(formOf(t2.T).error, /8 MB/)
})

test('a follow-up form takes no images', async () => {
  const { fetchImpl, calls } = withFetch(() => saved(1))
  const { T } = loadClient({ fetchImpl })
  T.set({ todoForm: FORM({ text: 'x', mode: 'followup', followUp: 'login' }) })
  assert.equal(await T.addImages([file('a.png')]), false)
  assert.equal(calls.length, 0)
})

test('removeImage takes one thumbnail off the form', async () => {
  const { fetchImpl, calls } = withFetch(() => saved(calls.length))
  const { T } = loadClient({ fetchImpl })
  need(T, 'removeImage')
  T.set({ todoForm: FORM({ text: 'x' }) })
  await T.addImages([file('a.png'), file('b.png')])
  const [first, second] = formOf(T).images.map((i) => i.id)
  T.removeImage(first)
  assert.deepEqual(formOf(T).images.map((i) => i.id), [second])
})

test('submit sends the image ids with a new-session todo, then clears the form and its images', async () => {
  const { fetchImpl, calls } = withFetch((url) => (url === UP ? saved(calls.length) : okJson({ ok: true, id: 'i1', state: 'starting' })))
  const { T } = loadClient({ fetchImpl })
  T.set({ todoForm: FORM({ text: 'Look at this', workspaceId: 'w1' }) })
  await T.addImages([file('a.png'), file('b.png')])
  assert.equal(await T.submitTodo(), true)
  const todoCall = calls.find((c) => c[0] === '/review-queue/v1/todo')
  assert.deepEqual(JSON.parse(todoCall[1].body), { text: 'Look at this', workspaceId: 'w1', sparc: false, images: ['id-1', 'id-2'] })
  assert.equal(formOf(T).images, undefined)
  assert.equal(formOf(T).text, '')
})

test('submit without images sends no images key; a failed submit keeps the images for a retry', async () => {
  let fail = true
  const { fetchImpl, calls } = withFetch((url) => (url === UP ? saved(1) : fail ? okJson({ ok: false, error: 'unknown-image' }, 400) : okJson({ ok: true, id: 'i1' })))
  const { T } = loadClient({ fetchImpl })
  T.set({ todoForm: FORM({ text: 'plain' }) })
  await T.submitTodo()
  assert.equal('images' in JSON.parse(calls.at(-1)[1].body), false)
  T.set({ todoForm: FORM({ text: 'with' }) })
  await T.addImages([file('a.png')])
  assert.equal(await T.submitTodo(), false)
  assert.equal(formOf(T).images.length, 1, 'kept')
  assert.match(formOf(T).error, /image/i)
  fail = false
  assert.equal(await T.submitTodo(), true)
})

test('a follow-up never sends images, even when some were pasted before the switch', async () => {
  const { fetchImpl, calls } = withFetch((url) => (url === UP ? saved(1) : okJson({ ok: true, id: 'i1' })))
  const { T } = loadClient({ fetchImpl })
  T.set({ todoForm: FORM({ text: 'x' }) })
  await T.addImages([file('a.png')])
  T.patchForm({ mode: 'followup', followUp: 'the login session' })
  await T.submitTodo()
  assert.equal('images' in JSON.parse(calls.at(-1)[1].body), false)
})

test('submit waits while an image is still uploading', async () => {
  const gate = deferred()
  const { fetchImpl, calls } = withFetch(() => gate.promise)
  const { T } = loadClient({ fetchImpl })
  T.set({ todoForm: FORM({ text: 'x' }) })
  const up = T.addImages([file('a.png')])
  await tick()
  assert.equal(await T.submitTodo(), false)
  assert.equal(calls.length, 1, 'no todo was posted')
  assert.match(formOf(T).error, /upload/i)
  gate.resolve(saved(1))
  await up
})

test('an upload that finishes after the todo was added is dropped, not put in the next form', async () => {
  const gate = deferred()
  const { fetchImpl } = withFetch((url) => (url === UP ? gate.promise : okJson({ ok: true, id: 'i1' })))
  const { T } = loadClient({ fetchImpl })
  T.set({ todoForm: FORM({ text: 'x' }) })
  const up = T.addImages([file('a.png')])
  await tick()
  T.set({ todoForm: FORM({ text: 'y' }) }) // the form was replaced (a submit does this) while the upload ran
  need(T, 'clearImages')
  T.clearImages()
  gate.resolve(saved(1))
  await up
  assert.deepEqual(formOf(T).images ?? [], [])
})

test('the images are not part of the saved draft', async () => {
  const { fetchImpl } = withFetch(() => saved(1))
  const { T, store } = loadClient({ fetchImpl })
  T.set({ todoForm: FORM({ text: 'x' }) })
  await T.addImages([file('a.png')])
  const draft = savedDraft(store)
  assert.ok(draft)
  assert.equal('images' in draft, false)
  assert.equal(store[KEY].includes('id-1'), false)
})

test('the form shows a thumbnail with a remove button per image, an uploading note, and the paste hint (new session only)', () => {
  const { T } = loadClient({ react: { createElement: el, useSyncExternalStore() {} } })
  need(T, 'TodoForm')
  T.set({ todoForm: FORM({ text: 'x', images: [{ id: 'a', name: 'one.png', url: 'blob:1' }, { id: 'b', name: 'two.png', url: 'blob:2' }], uploading: 1 }) })
  const tree = T.TodoForm()
  const thumbs = findAll(tree, (n) => n.props?.className === 'rq-thumb')
  assert.equal(thumbs.length, 2)
  assert.equal(findAll(tree, (n) => n.props?.['aria-label'] === 'Remove image one.png').length, 1)
  assert.match(textOf(tree), /Uploading/)
  assert.match(textOf(tree), /paste/i)
  const area = findAll(tree, (n) => n.type === 'textarea')[0]
  assert.equal(typeof area.props.onPaste, 'function')
  T.set({ todoForm: FORM({ text: 'x', mode: 'followup', followUp: 'q', images: [{ id: 'a', name: 'one.png' }] }) })
  const follow = T.TodoForm()
  assert.equal(findAll(follow, (n) => n.props?.className === 'rq-thumb').length, 0)
  assert.doesNotMatch(textOf(follow), /paste an image/i)
})

test('pasting an image into the box uploads it and keeps the browser from pasting a file name; pasted text is left alone', async () => {
  const { fetchImpl, calls } = withFetch(() => saved(1))
  const { T } = loadClient({ fetchImpl, react: { createElement: el, useSyncExternalStore() {} } })
  T.set({ todoForm: FORM({ text: 'x' }) })
  const area = findAll(T.TodoForm(), (n) => n.type === 'textarea')[0]
  let prevented = 0
  area.props.onPaste({ clipboardData: clip([['file', 'image/png', file('image.png')]]), preventDefault: () => { prevented++ } })
  await tick(); await tick()
  assert.equal(calls.length, 1)
  assert.equal(prevented, 1)
  area.props.onPaste({ clipboardData: clip([['string', 'text/plain', null]]), preventDefault: () => { prevented++ } })
  assert.equal(prevented, 1)
  assert.equal(calls.length, 1)
})