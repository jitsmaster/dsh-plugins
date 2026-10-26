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

/**
 * The engine ends a recognition on its own after a few seconds of silence (Chrome: about 5-8 s), which cut the text off while the user was thinking.
 * So an ended recognition is started again with the text so far as its base, until the user presses stop, a real error happens, or nothing was
 * heard for this long (the microphone does not stay open for ever).
 */
export const KEEP_LISTENING_MS = 30_000

/** Halts the dictation that is running right now, if any: only one recognition may use the microphone at a time. */
let haltRunning = null

/**
 * One dictation controller (one per Mic button).
 * @param {{ win?: object, onText?: (text: string, isFinal: boolean) => void, onState?: (listening: boolean) => void,
 *   onError?: (message: string | null) => void, lang?: string, ios?: boolean }} opts
 * @returns {{ start: (base?: string) => void, stop: () => void, halt: () => void, readonly listening: boolean } | null} null without speech recognition
 */
export function createDictation({ win, onText, onState, onError, lang, ios, keepListeningMs = KEEP_LISTENING_MS, now = Date.now } = {}) {
  const Recognition = dictationSupport(win)
  if (!Recognition) return null
  let session = null // the recognition in flight: { rec, base, ended }
  let listening = false
  let startedAt = 0
  let wantOn = false // the user has not pressed stop (nor halted): an ended recognition is restarted

  const setListening = (on) => { if (listening === on) return; listening = on; if (onState) onState(on) }
  /** Closes a session once: later events of its recognition (a late result) are ignored. */
  const finish = (s) => {
    if (s.ended) return
    s.ended = true
    if (session === s) session = null
    if (haltRunning === halt) haltRunning = null
    setListening(false)
  }
  /**
   * Stops this dictation for good (another one is starting, a send is about to happen, the box is disabled or the screen is gone): abort drops
   * what was not recognised yet, and nothing the engine reports afterwards (a late result, an error, onend) reaches onText or onError.
   */
  function halt() {
    wantOn = false
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
    const text = mergeDictation(s.base, transcript)
    if (String(transcript).trim()) { s.last = text; s.heardAt = now() }
    if (onText) onText(text, final)
  }
  function onFail(s, event) {
    if (s.ended) return
    const code = event && event.error
    if (wantOn && (code === 'aborted' || (code === 'no-speech' && now() - s.heardAt < keepListeningMs))) return // silence: onend restarts it
    s.fatal = true
    const message = dictationError(code, { ios })
    if (message && onError) onError(message)
  }

  function start(base, again) {
    if (session && !session.ended) return // already running: a second recognition would fight for the microphone
    if (!again) {
      if (haltRunning && haltRunning !== halt) haltRunning()
      if (onError) onError(null)
      wantOn = true
      startedAt = now()
    }
    const rec = new Recognition()
    const s = { rec, base: base == null ? '' : String(base), ended: false, last: base == null ? '' : String(base), heardAt: again ? again.heardAt : now() }
    rec.lang = lang || (win.navigator && win.navigator.language) || 'en-US'
    rec.interimResults = true // the box shows the text live while it refines
    rec.continuous = false // Chrome on Android is unreliable with continuous recognition
    rec.onstart = () => { if (!s.ended) setListening(true) }
    rec.onresult = (event) => onResult(s, event)
    rec.onerror = (event) => onFail(s, event)
    rec.onend = () => {
      if (s.ended) return
      // The engine gave up on silence while the user did not press stop: listen again, keeping the text, unless it was a real error or nobody has spoken for too long.
      if (wantOn && !s.fatal && now() - s.heardAt < keepListeningMs) {
        s.ended = true
        if (session === s) session = null
        start(s.last, { heardAt: s.heardAt })
        return
      }
      wantOn = false
      finish(s)
    }
    session = s
    haltRunning = halt
    try { rec.start() } catch {
      wantOn = false
      finish(s)
      if (onError) onError('Could not start dictation.')
    }
  }
  /** Asks the engine to stop: the last result still arrives, and onend turns the listening state off (halt() is the one that drops it). */
  function stop() {
    wantOn = false
    if (!session || session.ended) return
    try { session.rec.stop() } catch { /* already stopped */ }
  }

  return { start, stop, halt, get listening() { return listening } }
}
