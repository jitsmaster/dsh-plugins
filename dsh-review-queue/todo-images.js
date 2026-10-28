/**
 * The images pasted into the "+ New todo" form (New session mode). Each is uploaded on its own (the JSON bodies of the API are capped at 64 KB),
 * kept as <root>/<uuid>.<ext> and handed to the first prompt of the session the todo starts; the files are removed after the start, after a cancel
 * and, as a net, when they are older than a week. The root is shared by every app and the hub of this PC, so whichever app starts the todo finds them.
 * Only png, jpeg, gif and webp are accepted, judged by the first bytes, never by what the caller says the file is.
 */
import { createHash, randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export const MAX_IMAGE_BYTES = 8 * 1024 * 1024
export const MAX_IMAGES = 5
export const KEEP_MS = 7 * 24 * 3600_000
const ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const FILE_RE = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.(png|jpg|gif|webp)$/
const TYPES = { png: 'image/png', jpg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp' }

const startsWith = (buf, bytes, at = 0) => bytes.every((b, i) => buf[at + i] === b)
const ascii = (text) => [...text].map((c) => c.charCodeAt(0))

/** { mediaType, ext } of a png, jpeg, gif or webp (by its first bytes); undefined for anything else. */
export function sniffImage(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 4) return undefined
  if (startsWith(buf, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return { mediaType: 'image/png', ext: 'png' }
  if (startsWith(buf, [0xff, 0xd8, 0xff])) return { mediaType: 'image/jpeg', ext: 'jpg' }
  if (startsWith(buf, ascii('GIF87a')) || startsWith(buf, ascii('GIF89a'))) return { mediaType: 'image/gif', ext: 'gif' }
  if (buf.length >= 12 && startsWith(buf, ascii('RIFF')) && startsWith(buf, ascii('WEBP'), 8)) return { mediaType: 'image/webp', ext: 'webp' }
  return undefined
}

/** @param {{ root: string, now?: () => number, uuid?: () => string }} deps */
export function createTodoImages({ root, now = Date.now, uuid = randomUUID }) {
  /** The file of an id (the extension is not part of the id), or undefined. */
  function find(id) {
    if (typeof id !== 'string' || !ID_RE.test(id)) return undefined
    for (const ext of Object.keys(TYPES)) {
      const path = join(root, id + '.' + ext)
      if (existsSync(path)) return { path, ext }
    }
    return undefined
  }

  return {
    /** { ok, id, mediaType, bytes } | { ok: false, error: 'bad-image' | 'too-large' } */
    save(buf) {
      if (!Buffer.isBuffer(buf) || !buf.length) return { ok: false, error: 'bad-image' }
      if (buf.length > MAX_IMAGE_BYTES) return { ok: false, error: 'too-large' }
      const kind = sniffImage(buf)
      if (!kind) return { ok: false, error: 'bad-image' }
      try {
        mkdirSync(root, { recursive: true })
        const id = uuid()
        writeFileSync(join(root, id + '.' + kind.ext), buf)
        return { ok: true, id, mediaType: kind.mediaType, bytes: buf.length }
      } catch { return { ok: false, error: 'bad-image' } }
    },
    /** The ids of a request: { ok, ids } (repeats dropped) | { ok: false, error: 'bad-images' | 'too-many-images' | 'unknown-image' }. */
    check(ids) {
      if (ids === undefined || ids === null) return { ok: true, ids: [] }
      if (!Array.isArray(ids) || ids.some((id) => typeof id !== 'string' || !ID_RE.test(id))) return { ok: false, error: 'bad-images' }
      if (ids.length > MAX_IMAGES) return { ok: false, error: 'too-many-images' }
      const unique = [...new Set(ids)]
      if (unique.some((id) => !find(id))) return { ok: false, error: 'unknown-image' }
      // The same picture uploaded twice (two ids, identical bytes) goes to the session once.
      const seen = new Set()
      const distinct = []
      for (const id of unique) {
        let digest
        try { digest = createHash('sha256').update(readFileSync(find(id).path)).digest('hex') } catch { return { ok: false, error: 'unknown-image' } }
        if (seen.has(digest)) continue
        seen.add(digest)
        distinct.push(id)
      }
      return { ok: true, ids: distinct }
    },
    /** The prompt parts of the ids, in order: [{ type: 'image', mediaType, data: <raw base64> }]. Throws when a file is gone (the todo then fails and says so). */
    load(ids) {
      return (ids ?? []).map((id) => {
        const file = find(id)
        if (!file) throw new Error('an attached image is no longer there')
        return { type: 'image', mediaType: TYPES[file.ext], data: readFileSync(file.path).toString('base64') }
      })
    },
    /** Deletes the files of the ids; unknown or malformed ids are ignored, nothing throws. */
    remove(ids) {
      for (const id of Array.isArray(ids) ? ids : []) {
        const file = find(id)
        if (file) { try { rmSync(file.path, { force: true }) } catch { /* a locked file is pruned later */ } }
      }
    },
    /** Deletes the image files older than maxAgeMs; { count } of them. Files that are not ours are never touched. */
    prune(maxAgeMs = KEEP_MS) {
      let count = 0
      let names = []
      try { names = readdirSync(root) } catch { return 0 }
      for (const name of names) {
        if (!FILE_RE.test(name)) continue
        try {
          const path = join(root, name)
          if (now() - statSync(path).mtimeMs > maxAgeMs) { rmSync(path, { force: true }); count++ }
        } catch { /* gone already */ }
      }
      return count
    },
  }
}
