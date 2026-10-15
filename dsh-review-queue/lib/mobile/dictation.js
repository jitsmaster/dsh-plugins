/**
 * Dictation (speech to text) for the phone's free-text boxes. It FILLS a box and never sends: the only way text leaves this module is
 * the onText callback, which the view uses to edit a draft; the user reviews it and presses the normal Send button.
 *
 * Engine: the Web Speech API (window.SpeechRecognition or the webkit-prefixed one). In Chrome and the TWA on Android that is Google's
 * speech service, the device's own STT. A web page cannot detect or call the Gemini app, and nothing here forwards the text anywhere:
 * plain speech to text. Pure and node-tested with an injected fake recognition class (no DOM, no network, no api.js).
 */

/** The SpeechRecognition constructor of this window (standard first, then webkit-prefixed), or null when there is none. */
export function dictationSupport(win) {
  if (!win) return null
  for (const ctor of [win.SpeechRecognition, win.webkitSpeechRecognition]) if (typeof ctor === 'function') return ctor
  return null
}

/**
 * The box text after dictation: the text that was in the box when dictation started (never lost) plus the transcript, trimmed, with
 * one separating space when the base does not already end in whitespace. Merging into the captured base (not the live box text) is what
 * lets a refined interim result replace the previous one instead of piling up.
 */
export function mergeDictation(base, transcript) {
  const b = base == null ? '' : String(base)
  const t = transcript == null ? '' : String(transcript).trim()
  if (!t) return b
  return !b || /\s$/.test(b) ? b + t : b + ' ' + t
}

const PERMISSION_BLOCKED = "Microphone permission is blocked. Allow it for this site in Chrome's site settings."
// iOS: the microphone prompt is Safari's, and speech recognition also needs Siri & Dictation switched on in the iPhone's Settings.
const IOS_PERMISSION_BLOCKED = 'Allow the microphone in Settings > Safari, and turn on Siri & Dictation in Settings.'
const ERRORS = {
  'not-allowed': PERMISSION_BLOCKED,
  'service-not-allowed': PERMISSION_BLOCKED,
  'no-speech': "Didn't hear anything.",
  'audio-capture': 'No microphone found.',
  network: 'Could not reach the speech service.',
  'language-not-supported': 'This language is not supported for dictation.',
}

/** A short plain message for a recognition error code, or null when nothing should be shown (aborted: we stopped it ourselves). */
export function dictationError(code, { ios } = {}) {
  if (code === 'aborted') return null
  if (ios === true && (code === 'not-allowed' || code === 'service-not-allowed')) return IOS_PERMISSION_BLOCKED
  if (Object.prototype.hasOwnProperty.call(ERRORS, code)) return ERRORS[code]
  return 'Dictation failed (' + code + ').'
}

/** Halts the dictation that is running right now, if any: only one recognition may use the microphone at a time. */
let haltRunning = null

/**
 * One dictation controller (one per Mic button).
 * @param {{ win?: object, onText?: (text: string, isFinal: boolean) => void, onState?: (listening: boolean) => void,
 *   onError?: (message: string | null) => void, lang?: string, ios?: boolean }} opts
 * @returns {{ start: (base?: string) => void, stop: () => void, readonly listening: boolean } | null} null without speech recognition
 */
export function createDictation({ win, onText, onState, onError, lang, ios } = {}) {
  const Recognition = dictationSupport(win)
  if (!Recognition) return null
  let session = null // the recognition in flight: { rec, base, ended }
  let listening = false

  const setListening = (on) => { if (listening === on) return; listening = on; if (onState) onState(on) }
  /** Closes a session once: later events of its recognition (a late result) are ignored. */
  const finish = (s) => {
    if (s.ended) return
    s.ended = true
    if (session === s) session = null
    if (haltRunning === halt) haltRunning = null
    setListening(false)
  }
  /** Stops this dictation for good (another one is starting, or the screen is gone): abort drops what was not recognised yet. */
  function halt() {
    const s = session
    if (!s || s.ended) return
    finish(s)
    try { s.rec.abort() } catch { /* already stopped */ }
  }

  function onResult(s, event) {
    if (s.ended) return
    const list = (event && event.results) || []
    let transcript = ''
    let final = list.length > 0
    for (let i = 0; i < list.length; i++) {
      transcript += (list[i] && list[i][0] && list[i][0].transcript) || ''
      if (!(list[i] && list[i].isFinal)) final = false
    }
    if (onText) onText(mergeDictation(s.base, transcript), final)
  }
  function onFail(s, event) {
    if (s.ended) return
    const message = dictationError(event && event.error, { ios })
    if (message && onError) onError(message)
  }

  function start(base) {
    if (session && !session.ended) return // already running: a second recognition would fight for the microphone
    if (haltRunning && haltRunning !== halt) haltRunning()
    if (onError) onError(null)
    const rec = new Recognition()
    const s = { rec, base: base == null ? '' : String(base), ended: false }
    rec.lang = lang || (win.navigator && win.navigator.language) || 'en-US'
    rec.interimResults = true // the box shows the text live while it refines
    rec.continuous = false // Chrome on Android is unreliable with continuous recognition
    rec.onstart = () => { if (!s.ended) setListening(true) }
    rec.onresult = (event) => onResult(s, event)
    rec.onerror = (event) => onFail(s, event)
    rec.onend = () => finish(s)
    session = s
    haltRunning = halt
    try { rec.start() } catch {
      finish(s)
      if (onError) onError('Could not start dictation.')
    }
  }
  /** Asks the engine to stop: the last result still arrives, and onend turns the listening state off. */
  function stop() {
    if (!session || session.ended) return
    try { session.rec.stop() } catch { /* already stopped */ }
  }

  return { start, stop, get listening() { return listening } }
}
