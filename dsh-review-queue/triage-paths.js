/**
 * Auto-only safety facts for a permission card (slice 4 of Auto triage): the real-path containment of a command's path arguments, and the check that
 * the command we judged is the whole command. Observe mode never uses these.
 */
import { realpath } from 'node:fs'
import { stat as fsStat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { resolve } from 'node:path'

/** The ellipsis risk.js appends when it clips a command at its cap. */
const CLIP_MARK = '…'
const MAX_DETAIL = 3000 // risk.js caps a detail at this many characters (plus the mark)
// Protected names (reading one counts as touching it). Shared with the read-only parser in triage.js; Auto adds more, observe keeps PROTECTED as it was.
export const PROTECTED = [/(^|\/)\.env/i, /(^|\/)\.git(\/|$)/i, /^~/, /(^|\/)\.(ssh|aws|dsh|claude|gnupg)(\/|$)/i, /id_(rsa|ed25519|ecdsa|dsa)/i, /\.(pem|key|p12|pfx)$/i, /(credentials|secrets?)(\.|$|\/)/i]
// Auto only: more secret-bearing files, `.git.` (Windows drops trailing dots and spaces) and any 8.3 short name segment (`ENV~1`).
export const PROTECTED_AUTO = [...PROTECTED, /(^|\/)\.(npmrc|netrc|pypirc|kube|docker|git-credentials)(\/|$)/i, /(^|\/)appsettings[^/]*\.json$/i, /\.tfvars$/i, /\.kdbx$/i, /(^|\/)\.git[. ]*(\/|$)/i]
/** An NTFS 8.3 short name segment (`ENV~1`): it can stand for a protected name. A git revision such as `HEAD~1` is not a path, so the parser skips this for git. */
export const SHORT_NAME = /~\d/
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
  const out = new Map() // deduplicated by value
  const add = (value, certain) => { if (!out.has(value)) out.set(value, { value, certain }) }
  for (const t of String(command ?? '').trim().split(/\s+/).slice(1)) {
    if (!t) continue
    if (t.startsWith('-')) {
      const i = t.indexOf('=')
      if (i > 0 && i < t.length - 1) add(t.slice(i + 1), PATHISH.test(t.slice(i + 1)))
      else if (i < 0 && /^-[^-]/.test(t) && t.length > 2 && PATHISH.test(t.slice(2))) add(t.slice(2), true) // a short option with its value glued on: -f/abs/file
      continue
    }
    add(t, PATHISH.test(t))
  }
  return [...out.values()]
}

/** At most this many distinct path candidates are checked; a command with more is vetoed (fail closed). */
export const MAX_CANDIDATES = 64

/** A UNC / device / NT-namespace path: reaching it would open a network or device handle (an SMB connection leaks NTLM credentials). Never touched. */
const UNSAFE_PATH = /^[\\/]{2}|^[\\/]\?\?[\\/]/

const stat = (p) => fsStat(p)
const defaultIo = { real, stat }
/** rg and grep recurse into a directory and read secret-named files the argument does not show, so Auto refuses a directory for them. */
const SEARCH_BINS = new Set(['rg', 'grep'])

/**
 * Every path-like argument of the command resolves (symlinks, junctions and 8.3 names followed) to a place inside the real workspace.
 * A path-looking argument that does not resolve is a veto; a plain word that does not exist (a subcommand, a pattern, a number) is not a path.
 * Relative paths resolve against the workspace. A missing or unresolvable workspace is a veto. Never throws.
 * Before ANY file-system call: a UNC / device candidate is a veto (no I/O at all), and so is any candidate that lexically lies outside the workspace
 * (it is never resolved). More than MAX_CANDIDATES distinct candidates is a veto. `io.real` is the resolver and `io.stat` the stat (injectable for tests).
 * For rg and grep (`name`, default the command's first word) a candidate that resolves to a directory is a veto, and so is a stat that fails.
 */
export async function containedInWorkspace(command, workspace, io = defaultIo, name = String(command ?? '').trim().split(/\s+/)[0]) {
  try {
    const noDirs = SEARCH_BINS.has(name)
    const statOf = io.stat ?? defaultIo.stat
    if (typeof workspace !== 'string' || !workspace.trim()) return false
    const list = candidates(command)
    if (list.length > MAX_CANDIDATES || list.some(({ value }) => UNSAFE_PATH.test(value))) return false
    const root = await io.real(workspace)
    for (const { value, certain } of list) {
      const expanded = value === '~' || /^~[\\/]/.test(value) ? homedir() + value.slice(1) : value
      const lexical = resolve(root, expanded)
      if (!isInside(root, lexical) && !isInside(workspace, lexical)) return false // lexically outside: never resolved
      let target
      try { target = await io.real(lexical) } catch { if (certain) return false; continue }
      if (!isInside(root, target)) return false
      if (noDirs && (await statOf(target)).isDirectory()) return false // a stat error throws to the outer catch: fail closed
      // The resolved real path is tested again: a link to `.env` or an 8.3 name that expands to it only shows its protected name after resolution.
      const rel = slashes(target).slice(slashes(root).replace(/\/+$/, '').length).replace(/^\/+/, '')
      if (SHORT_NAME.test(rel) || PROTECTED_AUTO.some((re) => re.test(rel))) return false
    }
    return true
  } catch { return false }
}
