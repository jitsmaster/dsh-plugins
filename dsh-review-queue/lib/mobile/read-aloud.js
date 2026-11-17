/**
 * The phone's Read aloud (docs/mobile.md "Read aloud"): the PC's local TTS first (WAV chunks from the hub, GET /v1/tts, played one after the other,
 * the next chunk fetched while the current one plays), the phone's own speech engine when the PC cannot be reached or the browser refuses the audio.
 * The player is pure: fetch, playback and the local engine are injected, so it is unit-tested without a DOM (test/mobile-read-aloud.test.mjs).
 * Written without ?. and ||= on purpose (old Safari must still parse every phone file).
 */

/** The hub URL of one chunk of an item's read-out. `api` is the plugin prefix ("/review-queue"). */
export const ttsPath = (api, id, n) => String(api) + '/v1/tts?id=' + encodeURIComponent(id) + '&n=' + n

/** Whether the Read aloud button is drawn: never on iOS, and only when something can speak (PC audio or the phone's own engine) and there is text. */
export const readAloudVisible = ({ ios, hasLocalEngine, hasAudio, hasText }) => !ios && !!hasText && (!!hasLocalEngine || !!hasAudio)

// The chunk count comes from the hub's X-TTS-Chunks header (already capped in hub/tts.js), so no second cap lives here.
/**
 * @param {{ fetchChunk: (id: string, n: number) => Promise<{ ok: boolean, status?: number, blob?: any, chunks?: number }>, playBlob: (blob: any) => Promise<void>,
 *   speakLocal?: (text: string) => Promise<void>, stopAudio?: () => void, stopLocal?: () => void, prime?: () => void, onChange?: (state: string) => void }} deps
 */
export function createReadAloud({ fetchChunk, playBlob, speakLocal, stopAudio, stopLocal, prime, onChange, retryDelayMs = 300, firstChunkTimeoutMs = 8000 }) {
  let token = 0
  let state = 'idle' // idle | loading | playing
  const setState = (s) => { if (s === state) return; state = s; try { if (onChange) onChange(s) } catch { /* a listener must not break the player */ } }
  let controller = null // aborts the chunk requests of the read in progress
  const safeFetch = async (id, n) => { try { return await fetchChunk(id, n, controller && controller.signal) } catch { return { ok: false, status: 0 } } }

  /** The whole text with the phone's own engine (nothing was played from the PC yet). */
  async function local(item) {
    const text = item && item.spoken && item.spoken.full
    if (!speakLocal || !text) return
    setState('playing')
    try { await speakLocal(text) } catch { /* the read ends */ }
  }

  async function run(item, mine) {
    const alive = () => token === mine
    try {
      // A PC that is slow or hung must not keep the phone silent: after firstChunkTimeoutMs the request is abandoned and the phone voice takes over.
      let timer
      let cur
      try { cur = await Promise.race([safeFetch(item.id, 0), new Promise((r) => { timer = setTimeout(() => r({ ok: false, status: 0, timedOut: true }), firstChunkTimeoutMs) })]) } finally { clearTimeout(timer) }
      if (cur.timedOut && controller) { try { controller.abort() } catch { /* already aborted */ } }
      if (!alive()) return
      // Busy (503): the PC's TTS is serving something else; one more try after a short wait keeps the PC voice.
      if (!cur.ok && cur.status === 503) {
        await new Promise((r) => setTimeout(r, retryDelayMs))
        if (!alive()) return
        cur = await safeFetch(item.id, 0)
        if (!alive()) return
      }
      // A 401 is a pairing problem the caller already reported: another voice would hide it.
      if (!cur.ok) { if (cur.status !== 401) await local(item); return }
      const total = Math.max(1, Number(cur.chunks) || 1)
      for (let n = 0; n < total; n++) {
        const next = n + 1 < total ? safeFetch(item.id, n + 1) : null
        setState('playing')
        try { await playBlob(cur.blob) } catch { if (controller) { try { controller.abort() } catch { /* already aborted */ } } if (alive() && n === 0) await local(item); return } // refused audio: the own engine, but only before anything was heard
        if (!alive() || !next) return
        cur = await next
        if (!alive()) return
        // A later chunk that fails (not a 401) is fetched once more: a brief hub or Kokoro hiccup must not cut the message short.
        if (!cur.ok && cur.status !== 401) {
          if (cur.status === 503) { await new Promise((r) => setTimeout(r, retryDelayMs)); if (!alive()) return }
          cur = await safeFetch(item.id, n + 1)
          if (!alive()) return
        }
        if (!cur.ok) return // still failing ends the read: the rest is not repeated in another voice
      }
    } finally { if (token === mine) setState('idle') }
  }

  const stopAll = () => {
    token++
    if (controller) { try { controller.abort() } catch { /* already aborted */ } controller = null }
    try { if (stopAudio) stopAudio() } catch { /* already stopped */ }
    try { if (stopLocal) stopLocal() } catch { /* already stopped */ }
    setState('idle')
  }
  return {
    state: () => state,
    /** Called from the tap: starts at the first chunk, replacing any read in progress. */
    start(item) {
      stopAll()
      const mine = token
      controller = typeof AbortController === 'function' ? new AbortController() : null
      setState('loading')
      try { if (prime) prime() } catch { /* best effort */ }
      void run(item, mine)
    },
    stop: stopAll,
  }
}

// A silent 8-bit mono WAV with no samples: playing it inside the tap unlocks the audio element for the chunks that arrive later.
const SILENT = 'data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQAAAAA='

/** One reusable <audio> element: play(blob) resolves when it ends (or is stopped) and rejects when the browser cannot play it. `env` is the window (injected for tests). */
export function createAudioPlayer(env = globalThis) {
  let audio = null
  let pending = null
  const element = () => { if (!audio) audio = new env.Audio(); return audio }
  const release = (url) => { try { env.URL.revokeObjectURL(url) } catch { /* gone */ } }
  return {
    prime() {
      const a = element()
      a.src = SILENT
      const r = a.play()
      if (r && r.catch) r.catch(() => {})
    },
    play(blob) {
      return new Promise((resolve, reject) => {
        const a = element()
        const url = env.URL.createObjectURL(blob)
        const mine = {}
        const end = (error) => { if (pending !== mine) return; pending = null; a.onended = null; a.onerror = null; release(url); if (error) reject(error); else resolve() }
        pending = mine
        mine.end = end
        a.onended = () => end()
        a.onerror = () => end(new Error('audio-error'))
        a.src = url
        const r = a.play()
        if (r && r.catch) r.catch((e) => end(e || new Error('audio-refused')))
      })
    },
    stop() {
      if (audio) { try { audio.pause() } catch { /* nothing playing */ } }
      const p = pending
      if (p && p.end) p.end()
    },
  }
}

/** The player with the browser's audio element and speech engine. */
export function createBrowserReadAloud({ fetchChunk, onChange, env = globalThis }) {
  const audio = createAudioPlayer(env)
  const synth = env.speechSynthesis
  const canSpeak = !!synth && !!env.SpeechSynthesisUtterance
  return createReadAloud({
    fetchChunk, onChange,
    prime: audio.prime, playBlob: audio.play, stopAudio: audio.stop,
    speakLocal: canSpeak ? (text) => new Promise((resolve) => { const u = new env.SpeechSynthesisUtterance(text); u.onend = u.onerror = () => resolve(); synth.cancel(); synth.speak(u) }) : undefined,
    stopLocal: synth ? () => { synth.cancel() } : undefined,
  })
}
