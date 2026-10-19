/**
 * Runtime settings, editable at any time without restarting the host.
 *
 * Values live in `<stateDir>/settings.json` and are re-read (mtime-checked) on every
 * `get()`, so consumers such as the context cap always see the latest value. The plugin
 * config (cordis.patch.yml) only supplies the defaults used until a value is saved.
 * Edit the file directly, or use the Usage page in the sidebar.
 */
import { readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const MAX_CAP = 100_000_000

/** Validate/normalize a partial settings object; throws on bad input. */
function validate(partial) {
  const out = {}
  if (partial.contextCapTokens !== undefined) {
    const n = Number(partial.contextCapTokens)
    if (!Number.isFinite(n) || n < 0 || n > MAX_CAP) throw new Error('contextCapTokens must be 0 (off) to 100,000,000')
    out.contextCapTokens = Math.round(n)
  }
  if (partial.warnPercent !== undefined) {
    const n = Number(partial.warnPercent)
    if (!Number.isFinite(n) || n < 0 || n > 99) throw new Error('warnPercent must be 0 (off) to 99')
    out.warnPercent = Math.round(n)
  }
  for (const key of ['ttsEnabled', 'autoResumeHandoff', 'handoffAhead', 'alwaysFullAccess', 'pollPrComments', 'voiceControl', 'decideChime']) {
    if (partial[key] !== undefined) {
      if (typeof partial[key] !== 'boolean') throw new Error(`${key} must be true or false`)
      out[key] = partial[key]
    }
  }
  return out
}

/**
 * @param {string} stateDir
 * @param {object} [defaults]
 * @param {(error: unknown) => void} [onError] - told about a subscriber that threw (unless the subscriber has its own).
 */
export function createSettings(stateDir, defaults, onError = () => {}) {
  const path = join(stateDir, 'settings.json')
  const base = { contextCapTokens: 400_000, warnPercent: 85, ttsEnabled: true, autoResumeHandoff: true, handoffAhead: true, alwaysFullAccess: false, pollPrComments: true, voiceControl: false, decideChime: true, ...validate(defaults) }
  let cached = { ...base }
  let mtime = -1

  function get() {
    try {
      const m = statSync(path).mtimeMs
      if (m !== mtime) {
        mtime = m
        let file = {}
        try { file = validate(JSON.parse(readFileSync(path, 'utf8'))) } catch { /* ignore a bad file; keep defaults */ }
        cached = { ...base, ...file }
      }
    } catch {
      // No file yet: defaults apply.
      mtime = -1
      cached = { ...base }
    }
    return cached
  }

  /** Listeners told about every set() that changed a value: (next, previous) -> their optional onError. */
  const listeners = new Map()

  function set(partial) {
    const previous = get()
    const next = { ...previous, ...validate(partial) }
    writeFileSync(path, JSON.stringify(next, null, 2))
    mtime = -1 // force re-read on next get()
    const saved = get()
    if (Object.keys(saved).some((key) => saved[key] !== previous[key])) notify(saved, previous)
    return saved
  }

  // A listener's failure never breaks set() or the other listeners; it is reported, and a failing report is ignored.
  function notify(next, previous) {
    for (const [listener, listenerOnError] of [...listeners]) {
      try { listener(next, previous) } catch (error) {
        try { (listenerOnError ?? onError)(error) } catch { /* the error sink itself failed: nothing left to tell */ }
      }
    }
  }

  /** Subscribe to changes made through set(); returns the unsubscribe function. `subscriberOnError` receives what the listener throws. */
  function subscribe(listener, subscriberOnError) {
    listeners.set(listener, subscriberOnError)
    return () => { listeners.delete(listener) }
  }

  return { get, set, subscribe, path }
}
