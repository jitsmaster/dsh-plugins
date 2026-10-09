/**
 * Per-session handoff notes. Every handoff note (cap handoff, PR hand-over notes, a SPARC phase handoff) ends in
 * "handoff.md", so a session "has a handoff" when it wrote such a file that still exists. A resuming session deletes
 * the note it picked up, so a consumed note drops out on its own.
 *
 * Sources: every finished write/edit tool call (nested run_code calls included), the run_code program text, and a
 * one-time scan of a session's history for notes written before the plugin watched it. Records persist to
 * <stateDir>/handoffs.json (session id -> [{ path, at }], newest last).
 */
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { isAbsolute, join, resolve } from 'node:path'

const HANDOFF_FILE = /handoff\.md$/i
const WRITE_TOOLS = new Set(['write', 'edit', 'multi_edit'])
/** tools.write({ file_path: "..." }) / tools.edit(...) inside a run_code program; group 2 is the quote, 3 the literal. */
const PTC_WRITE = /tools\s*(?:\.\s*|\[\s*["'])(write|edit)(?:["']\s*\])?\s*\(\s*\{[^}]*?\bfile_path\s*:\s*(["'`])((?:\\.|(?!\2)[^\\\n])*?)\2/g
/** Shell write targets ending in handoff.md: a quoted path (may hold spaces) or a bare one after the write verb or a redirect. */
const SHELL_WRITE = /(?:\b(?:Set-Content|Add-Content|Out-File|WriteAllText|New-Item)\b[^\n|;>]*?|>>?\s*)(?:(["'])([^"'\n]*?handoff\.md)\1|((?:[A-Za-z]:[\\/]|\/)[^\s"'|;<>()]*?handoff\.md))/gi
/** A handoff path in assistant text: in backticks (may hold spaces) or a bare absolute path. A bare path may not start mid-word, so "Dev Tasks/Handoffs/x" is not read as "/Handoffs/x". */
const TEXT_PATH = /`([^`\n]*?handoff\.md)`|((?<![\w.~-])(?:[A-Za-z]:[\\/]|\/)[^\s`"'<>|]*?handoff\.md)/gi
const WRITE_WORD = /\b(?:written|wrote|write|writing|saved|created)\b/i
const MAX_PER_SESSION = 10
const MAX_SESSIONS = 500

const parseArgs = (args) => {
  if (typeof args !== 'string') return args && typeof args === 'object' ? args : undefined
  try { return JSON.parse(args) } catch { return undefined }
}
const absolute = (p, baseCwd) => (isAbsolute(p) || !baseCwd ? p : resolve(baseCwd, p))

/**
 * The handoff-note paths one tool call writes.
 * @param {string} name - tool name.
 * @param {unknown} args - tool arguments (object, or the JSON string stored in a tool-call block).
 * @param {string} [baseCwd] - session cwd, for relative paths.
 * @returns {string[]}
 */
export function handoffWrites(name, args, baseCwd) {
  const a = parseArgs(args)
  if (!a) return []
  const tool = String(name ?? '').toLowerCase()
  if (WRITE_TOOLS.has(tool)) {
    const p = a.file_path
    return typeof p === 'string' && HANDOFF_FILE.test(p.trim()) ? [absolute(p.trim(), baseCwd)] : []
  }
  if ((tool === 'pwsh' || tool === 'bash' || tool === 'powershell') && typeof a.command === 'string') {
    const out = []
    for (const m of a.command.matchAll(SHELL_WRITE)) {
      const p = (m[2] ?? m[3] ?? '').trim()
      if (p) out.push(absolute(p, baseCwd))
    }
    return out
  }
  if (tool === 'run_code' && typeof a.code === 'string') {
    const out = []
    for (const m of a.code.matchAll(PTC_WRITE)) {
      if (m[2] === '`' && m[3].includes('${')) continue // interpolated: not resolvable from the text
      const p = m[3].replace(/\\(.)/g, '$1').trim()
      if (HANDOFF_FILE.test(p)) out.push(absolute(p, baseCwd))
    }
    return out
  }
  return []
}

/**
 * Handoff notes an assistant reply says it wrote ("Handoff written to \`<path>\`"): the SPARC stop message and the
 * cap instruction both print the path. Only absolute paths on a line with a write verb count, so resuming from or
 * deleting a note is not a write.
 * @param {unknown} text
 * @returns {string[]}
 */
export function handoffMentions(text) {
  if (typeof text !== 'string' || !text) return []
  const out = []
  for (const line of text.split(/\r?\n/)) {
    if (!WRITE_WORD.test(line)) continue
    for (const m of line.matchAll(TEXT_PATH)) {
      const p = (m[1] ?? m[2] ?? '').trim()
      if (p && isAbsolute(p)) out.push(p)
    }
  }
  return out
}

const textOfContent = (content) => (typeof content === 'string' ? content : Array.isArray(content) ? content.map((b) => (b?.type === 'text' ? b.text ?? '' : '')).join('\n') : '')

/**
 * One "Follow-up from handoff" request from the web page: `{ sessionId }`.
 * @param {unknown} body - parsed JSON body.
 * @param {((sessionId: string) => Promise<{ status: number, sessionId?: string, error?: string }>) | undefined} followUp
 * @returns {Promise<{ status: number, body: { sessionId?: string, error?: string } }>}
 */
export async function applyFollowUp(body, followUp) {
  if (!followUp) return { status: 503, body: { error: 'follow-up is unavailable (restart dsh web to load the latest plugin code)' } }
  const sessionId = body && typeof body === 'object' ? body.sessionId : undefined
  if (typeof sessionId !== 'string' || !sessionId || sessionId.length > 200) return { status: 400, body: { error: 'sessionId is required' } }
  try {
    const out = await followUp(sessionId)
    return { status: out.status, body: out.error ? { error: out.error } : { sessionId: out.sessionId } }
  } catch (error) {
    return { status: 500, body: { error: String(error?.message ?? error) } }
  }
}

/**
 * @param {string} stateDir
 * @param {{ now?: () => number, exists?: (path: string) => boolean }} [options]
 */
export function createHandoffTracker(stateDir, { now = Date.now, exists = existsSync } = {}) {
  const path = join(stateDir, 'handoffs.json')
  /** @type {Record<string, { path: string, at: number }[]>} */
  let sessions = {}
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'))
    for (const [id, list] of Object.entries(parsed?.sessions ?? {})) {
      const clean = Array.isArray(list) ? list.filter((e) => typeof e?.path === 'string' && typeof e.at === 'number') : []
      if (clean.length) sessions[id] = clean
    }
  } catch { /* first run or unreadable: start empty */ }
  const scanned = new Set()

  const save = () => {
    try {
      const ids = Object.keys(sessions)
      if (ids.length > MAX_SESSIONS) {
        const newest = (id) => sessions[id].at(-1)?.at ?? 0
        for (const id of ids.sort((x, y) => newest(x) - newest(y)).slice(0, ids.length - MAX_SESSIONS)) delete sessions[id]
      }
      writeFileSync(`${path}.tmp`, JSON.stringify({ v: 1, sessions }, null, 2))
      renameSync(`${path}.tmp`, path)
    } catch { /* non-fatal: the in-memory record still serves this run */ }
  }

  /** Remember that `sessionId` wrote the handoff note `notePath` (now the newest one). */
  function record(sessionId, notePath, persist = true) {
    if (!sessionId || !notePath) return
    const list = (sessions[sessionId] ?? []).filter((e) => e.path !== notePath)
    list.push({ path: notePath, at: now() })
    sessions[sessionId] = list.slice(-MAX_PER_SESSION)
    if (persist) save()
  }

  /** One finished tool call. Never throws. */
  function observe(sessionId, name, args, baseCwd) {
    try {
      const paths = handoffWrites(name, args, baseCwd)
      for (const p of paths) record(sessionId, p, false)
      if (paths.length) save()
    } catch { /* best effort */ }
  }

  /** An assistant reply: remembers the handoff notes it says it wrote. Never throws. */
  function observeText(sessionId, text) {
    try {
      const paths = handoffMentions(text)
      for (const p of paths) record(sessionId, p, false)
      if (paths.length) save()
    } catch { /* best effort */ }
  }

  /**
   * Once per session: notes written before the tracker watched it, from the session's messages.
   * @param {string} sessionId
   * @param {() => unknown[]} messages - lazily read (only on the first scan of a session).
   */
  function scan(sessionId, messages, baseCwd) {
    if (!sessionId || scanned.has(sessionId)) return
    scanned.add(sessionId)
    try {
      const found = []
      for (const message of messages() ?? []) {
        if (message?.role !== 'assistant') continue
        found.push(...handoffMentions(textOfContent(message.content)))
        if (!Array.isArray(message.content)) continue
        for (const block of message.content) {
          if (block?.type === 'tool-call') found.push(...handoffWrites(block.name, block.arguments, baseCwd))
        }
      }
      // Older history must not outrank a note the live hook already recorded.
      const known = new Set((sessions[sessionId] ?? []).map((e) => e.path))
      const fresh = found.filter((p) => !known.has(p))
      if (!fresh.length) return
      const at = (sessions[sessionId]?.[0]?.at ?? now()) - 1
      const unique = [...new Set(fresh.reverse())].reverse() // last write of each path wins the order
      sessions[sessionId] = [...unique.map((p, i) => ({ path: p, at: at - (unique.length - 1 - i) })), ...(sessions[sessionId] ?? [])].slice(-MAX_PER_SESSION)
      save()
    } catch { /* best effort */ }
  }

  /** The newest handoff note of the session that still exists, or undefined. */
  function latest(sessionId) {
    const list = sessions[sessionId] ?? []
    for (let i = list.length - 1; i >= 0; i--) if (exists(list[i].path)) return list[i].path
    return undefined
  }

  /** Session ids with a handoff note that still exists. */
  const withHandoff = () => Object.keys(sessions).filter((id) => latest(id) !== undefined)

  return { record, observe, observeText, scan, latest, withHandoff, path }
}
