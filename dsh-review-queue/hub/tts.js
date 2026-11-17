/**
 * The hub's bridge to the PC's local TTS server (Kokoro, dsh-hooks-tts): a paired phone asks GET /review-queue/v1/tts?id&n and gets one WAV chunk of
 * the card's read-out (the same text and chunking the desktop Read aloud speaks), so the phone reads aloud with the PC's voice, not only with its own.
 * The server is a loopback URL (hub.config.json `ttsUrl`, default http://127.0.0.1:8880/tts): the hub never fetches any other host, never follows a
 * redirect, accepts only an audio answer up to a size cap, and runs a bounded number of syntheses at once (a phone cannot queue the PC's TTS full).
 */
import { chunkForSpeech, fullTextFor } from '../speech.js'

export const DEFAULT_TTS_URL = 'http://127.0.0.1:8880/tts'
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]'])
const MAX_BYTES = 8 * 1024 * 1024
const MAX_ACTIVE = 2
const TIMEOUT_MS = 30_000
const MAX_CHUNKS = 200

/** The URL as a normal string when it is http(s) on this PC without credentials, else undefined. */
export function loopbackTtsUrl(value) {
  if (typeof value !== 'string') return undefined
  let u
  try { u = new URL(value) } catch { return undefined }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return undefined
  if (u.username || u.password) return undefined
  return LOOPBACK_HOSTS.has(u.hostname) ? u.href : undefined
}

/** Reads a response body up to `max` bytes: a Buffer, or undefined when it is larger. */
async function readCapped(res, max) {
  if (Number(res.headers.get('content-length')) > max) return undefined
  const parts = []
  let size = 0
  for await (const part of res.body ?? []) {
    size += part.length
    if (size > max) return undefined
    parts.push(Buffer.from(part))
  }
  return Buffer.concat(parts)
}

/** @param {{ url?: string, fetchFn?: typeof fetch, maxBytes?: number, maxActive?: number, timeoutMs?: number, gender?: 'male' | 'female' }} [opts] */
export function createTts({ url = DEFAULT_TTS_URL, fetchFn = (...a) => fetch(...a), maxBytes = MAX_BYTES, maxActive = MAX_ACTIVE, timeoutMs = TIMEOUT_MS, gender = 'male' } = {}) {
  let active = 0
  return {
    /** The read-out of an item cut for speech, at most MAX_CHUNKS pieces. */
    chunksOf: (item) => chunkForSpeech(fullTextFor(item)).slice(0, MAX_CHUNKS),
    /** @returns {Promise<{ ok: true, wav: Buffer } | { ok: false, error: 'busy' | 'too-large' | 'tts-unavailable' }>} */
    async synth(text) {
      if (active >= maxActive) return { ok: false, error: 'busy' }
      active++
      const ac = new AbortController()
      const timer = setTimeout(() => ac.abort(), timeoutMs)
      try {
        const res = await fetchFn(url, { method: 'POST', redirect: 'error', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text, voice_gender: gender }), signal: ac.signal })
        if (!res.ok || !/^audio\//i.test(res.headers.get('content-type') ?? '')) { try { await res.body?.cancel() } catch { /* nothing to cancel */ } return { ok: false, error: 'tts-unavailable' } }
        const wav = await readCapped(res, maxBytes)
        return wav ? { ok: true, wav } : { ok: false, error: 'too-large' }
      } catch { return { ok: false, error: 'tts-unavailable' } } finally { clearTimeout(timer); active-- }
    },
  }
}
