/**
 * Auto-only safety facts for a permission card (slice 4 of Auto triage): the real-path containment of a command's path arguments, and the check that
 * the command we judged is the whole command. Observe mode never uses these.
 */
import { realpath } from 'node:fs'
import { homedir } from 'node:os'
import { resolve } from 'node:path'

/** The ellipsis risk.js appends when it clips a command at its cap. */
const CLIP_MARK = '…'
const MAX_DETAIL = 3000 // risk.js caps a detail at this many characters (plus the mark)
const PATHISH = /[\\/]|^[.~]|^[a-z]:/i

const real = (p) => new Promise((ok, no) => realpath.native(p, (e, r) => (e ? no(e) : ok(r))))
const slashes = (p) => String(p).replace(/^\\\\\?\\/, '').replace(/\\/g, '/')

/** Whole-segment containment of `target` in `root` (both real paths), separators normalised; case-insensitive when asked (Windows). */
export function isInside(root, target, caseInsensitive = process.platform === 'win32') {
  const fold = (p) => { const s = slashes(p).replace(/\/+$/, ''); return caseInsensitive ? s.toLowerCase() : s }
  if (typeof root !== 'string' || typeof target !== 'string' || !root.trim()) return false
  const r = fold(root)
  const t = fold(target)
  return t === r || t.startsWith(r + '/')
}

/** The command was captured whole: a detail that is not clipped (a missing one would fall back to the summary) and a call id to answer through. */
export function commandIntact(payload) {
  const d = payload?.detail
  if (typeof d !== 'string' || !d.trim() || d.endsWith(CLIP_MARK) || d.length > MAX_DETAIL) return false
  return payload.callId !== undefined && payload.callId !== null && payload.callId !== ''
}

// Safety note: candidates() is lexical (it splits the command on whitespace) and a path can change between the realpath check and the run (TOCTOU).
// Safety therefore rests on the strict command parser (commandIntact) plus the fingerprint re-check in actOn, not on the realpath check alone.
/** The path candidates of a command: the value of a --flag=value, and a plain token that has a path character, or that exists (checked by the caller). */
function candidates(command) {
  const out = []
  for (const t of String(command ?? '').trim().split(/\s+/).slice(1)) {
    if (!t) continue
    if (t.startsWith('-')) { const i = t.indexOf('='); if (i > 0 && i < t.length - 1) out.push({ value: t.slice(i + 1), certain: PATHISH.test(t.slice(i + 1)) }); continue }
    out.push({ value: t, certain: PATHISH.test(t) })
  }
  return out
}

/**
 * Every path-like argument of the command resolves (symlinks, junctions and 8.3 names followed) to a place inside the real workspace.
 * A path-looking argument that does not resolve is a veto; a plain word that does not exist (a subcommand, a pattern, a number) is not a path.
 * Relative paths resolve against the workspace. A missing or unresolvable workspace is a veto. Never throws.
 */
export async function containedInWorkspace(command, workspace) {
  try {
    if (typeof workspace !== 'string' || !workspace.trim()) return false
    const root = await real(workspace)
    for (const { value, certain } of candidates(command)) {
      const expanded = value === '~' || /^~[\\/]/.test(value) ? homedir() + value.slice(1) : value
      let target
      try { target = await real(resolve(root, expanded)) } catch { if (certain) return false; continue }
      if (!isInside(root, target)) return false
    }
    return true
  } catch { return false }
}
