// The mutable rule set of AI triage. Only the mode of each rule is persisted ({ v: 1, modes: { ruleId: mode } }); the text, class and id of a
// rule always come from the defaults, so a stored or tampered file can never rewrite what a rule says.
import { ruleVersion } from './triage-runner.js'

export const MODES = ['off', 'observe', 'auto']
const MODE_SET = new Set(MODES)

/** @param {{ io?: { read: () => string | undefined, write: (text: string) => void }, defaults: object[] }} opts */
export function createTriageRules({ io, defaults, log }) {
  const live = defaults.map((r) => ({ ...r, mode: MODE_SET.has(r.mode) ? r.mode : 'observe' }))
  try {
    const parsed = JSON.parse(io?.read() ?? 'null')
    const modes = parsed && parsed.v === 1 && parsed.modes && typeof parsed.modes === 'object' ? parsed.modes : {}
    for (const rule of live) if (Object.hasOwn(modes, rule.id) && MODE_SET.has(modes[rule.id])) rule.mode = modes[rule.id]
  } catch { /* unreadable or garbled: the defaults stand */ }

  const persist = () => {
    try { io?.write(JSON.stringify({ v: 1, modes: Object.fromEntries(live.map((r) => [r.id, r.mode])) })) } catch (e) {
      // the live value still applies; the next change retries. Log only a sanitized code, never the message.
      try { log?.('triage-rules: ' + String(e?.code ?? e?.name ?? 'error').replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 60)) } catch { /* a throwing log never changes the result */ }
    }
  }
  const find = (id) => live.find((r) => r.id === id)
  return {
    list: () => live.map((r) => ({ ...r, version: ruleVersion(r) })),
    get: (id) => { const r = find(id); return r ? { ...r, version: ruleVersion(r) } : undefined },
    setMode(id, mode) {
      const rule = find(id)
      if (!rule || !MODE_SET.has(mode)) return false
      rule.mode = mode
      persist()
      return true
    },
    /** The live array itself (the runner reads it at each use, so a mode change applies at once). */
    current: () => live,
  }
}
