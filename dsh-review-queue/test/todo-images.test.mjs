import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, readdirSync, writeFileSync, utimesSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createTodoImages, MAX_IMAGE_BYTES, MAX_IMAGES, sniffImage } from '../todo-images.js'

// The images pasted into the new-todo form: saved one by one, handed to the session prompt when the todo starts, removed afterwards.
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('rest of a png')])
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from('jfif')])
const GIF = Buffer.from('GIF89a......')
const WEBP = Buffer.concat([Buffer.from('RIFF'), Buffer.from([1, 2, 3, 4]), Buffer.from('WEBPVP8 ')])

function setup(over = {}) {
  const root = join(mkdtempSync(join(tmpdir(), 'rq-img-')), 'todo-images')
  return { root, images: createTodoImages({ root, ...over }), done: () => rmSync(join(root, '..'), { recursive: true, force: true }) }
}

test('sniffImage knows png, jpeg, gif and webp by their first bytes and nothing else', () => {
  assert.deepEqual(sniffImage(PNG), { mediaType: 'image/png', ext: 'png' })
  assert.deepEqual(sniffImage(JPEG), { mediaType: 'image/jpeg', ext: 'jpg' })
  assert.deepEqual(sniffImage(GIF), { mediaType: 'image/gif', ext: 'gif' })
  assert.deepEqual(sniffImage(WEBP), { mediaType: 'image/webp', ext: 'webp' })
  assert.equal(sniffImage(Buffer.from('<svg xmlns=...>')), undefined)
  assert.equal(sniffImage(Buffer.alloc(0)), undefined)
  assert.equal(sniffImage('not a buffer'), undefined)
})

test('save stores the file under a uuid in the folder and answers { ok, id, mediaType, bytes }', () => {
  const { root, images, done } = setup()
  try {
    const r = images.save(PNG)
    assert.equal(r.ok, true)
    assert.match(r.id, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)
    assert.equal(r.mediaType, 'image/png')
    assert.equal(r.bytes, PNG.length)
    assert.deepEqual(readdirSync(root), [r.id + '.png'])
  } finally { done() }
})

test('save refuses a file that is not an image (whatever the caller says it is), an empty one and one over the cap', () => {
  const { root, images, done } = setup()
  try {
    assert.deepEqual(images.save(Buffer.from('MZ\x90 an exe')), { ok: false, error: 'bad-image' })
    assert.deepEqual(images.save(Buffer.alloc(0)), { ok: false, error: 'bad-image' })
    const big = Buffer.concat([PNG, Buffer.alloc(MAX_IMAGE_BYTES)])
    assert.deepEqual(images.save(big), { ok: false, error: 'too-large' })
    assert.equal(existsSync(root) ? readdirSync(root).length : 0, 0, 'nothing was written')
  } finally { done() }
})

test('check: ok for saved ids; bad-images for a non-list or a bad id; too-many-images; unknown-image for an id that has no file', () => {
  const { images, done } = setup()
  try {
    const a = images.save(PNG).id
    assert.deepEqual(images.check([a]), { ok: true, ids: [a] })
    assert.deepEqual(images.check([]), { ok: true, ids: [] })
    assert.deepEqual(images.check(undefined), { ok: true, ids: [] })
    assert.deepEqual(images.check('x'), { ok: false, error: 'bad-images' })
    assert.deepEqual(images.check(['../../secret']), { ok: false, error: 'bad-images' })
    assert.deepEqual(images.check([5]), { ok: false, error: 'bad-images' })
    assert.deepEqual(images.check(['00000000-0000-4000-8000-000000000000']), { ok: false, error: 'unknown-image' })
    assert.deepEqual(images.check(Array.from({ length: MAX_IMAGES + 1 }, () => a)), { ok: false, error: 'too-many-images' })
  } finally { done() }
})

test('check drops a repeated id', () => {
  const { images, done } = setup()
  try {
    const a = images.save(PNG).id
    assert.deepEqual(images.check([a, a]), { ok: true, ids: [a] })
  } finally { done() }
})

test('load answers the parts the session prompt takes: raw base64 without a data: prefix, in the order of the ids', () => {
  const { images, done } = setup()
  try {
    const a = images.save(PNG).id
    const b = images.save(JPEG).id
    const parts = images.load([b, a])
    assert.deepEqual(parts, [
      { type: 'image', mediaType: 'image/jpeg', data: JPEG.toString('base64') },
      { type: 'image', mediaType: 'image/png', data: PNG.toString('base64') },
    ])
    assert.ok(!parts[0].data.startsWith('data:'))
  } finally { done() }
})

test('load throws when a file is gone, so the todo fails instead of starting without its picture', () => {
  const { images, done } = setup()
  try {
    const a = images.save(PNG).id
    images.remove([a])
    assert.throws(() => images.load([a]), /image/i)
  } finally { done() }
})

test('remove deletes the files, ignores unknown or malformed ids and never throws', () => {
  const { root, images, done } = setup()
  try {
    const a = images.save(PNG).id
    images.remove([a, 'nope', '../x', undefined, '00000000-0000-4000-8000-000000000000'])
    assert.deepEqual(readdirSync(root), [])
    assert.doesNotThrow(() => images.remove(undefined))
  } finally { done() }
})

test('prune deletes the files older than the age and keeps the newer ones', () => {
  let t = 10 * 24 * 3600_000
  const { root, images, done } = setup({ now: () => t })
  try {
    const old = images.save(PNG).id
    const fresh = images.save(JPEG).id
    const past = new Date(t - 8 * 24 * 3600_000)
    utimesSync(join(root, old + '.png'), past, past)
    assert.equal(images.prune(7 * 24 * 3600_000), 1)
    assert.deepEqual(readdirSync(root), [fresh + '.jpg'])
  } finally { done() }
})

test('prune leaves files it does not own alone and copes with a folder that does not exist', () => {
  const { root, images, done } = setup()
  try {
    assert.equal(images.prune(1), 0)
    images.save(PNG)
    writeFileSync(join(root, 'notes.txt'), 'mine')
    const past = new Date(0)
    utimesSync(join(root, 'notes.txt'), past, past)
    images.prune(1)
    assert.ok(readdirSync(root).includes('notes.txt'))
  } finally { done() }
})
