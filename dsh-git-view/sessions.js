/**
 * Maps a DSH session to the git working tree it is working in.
 *
 * DSH has no worktree concept: a session's `cwd` stays at its launch directory even when the agent
 * moves into a linked worktree. So, as dsh-hooks-tts does, the plugin watches every finished tool
 * call: any directory a call works in (workdir, file paths, `cd`, absolute paths in a command) that is
 * inside a linked worktree of the session's own repository becomes the session's recorded worktree.
 *
 * The browser never names a directory. It names a session (and optionally one of that repository's
 * worktrees), and this module decides what that means, so the HTTP API cannot be pointed at an
 * arbitrary folder.
 */
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { isAbsolute, join, relative, resolve } from 'node:path'
import { gitStats, listWorktrees, repoInfo } from './git.js'
import { isUncOrDevicePath } from './gitpath.js'

/** Session ids are client-influenced: bounded length and a conservative charset. */
export const MAX_SESSION_ID = 128
export const MAX_STORED_SESSIONS = 500
const SESSION_ID_RE = /^[A-Za-z0-9_.:@-]+$/
export const validSessionId = (id) => typeof id === 'string' && id.length > 0 && id.length <= MAX_SESSION_ID && SESSION_ID_RE.test(id)
/** A cwd worth remembering: an absolute, non-UNC, NUL-free string (checked lexically, no fs access). */
const validCwd = (cwd) => typeof cwd === 'string' && cwd.length > 0 && cwd.length < 4096 && !cwd.includes('\0') && !isUncOrDevicePath(cwd) && isAbsolute(cwd)

const sameDir = (a, b) => process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b
/** Whether `child` is `parent` or lies inside it. */
const isInside = (child, parent) => {
  const rel = relative(resolve(parent), resolve(child))
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

/** Hard cap on paths collected from one tool call. */
const MAX_COLLECTED = 16
/** observe() is best effort and yields to UI reads: it is skipped while more than this many git jobs wait. */
const OBSERVE_MAX_QUEUE = 8
/** How long one session's repo identity + allowed worktree roots are reused by observe(). */
const OBSERVE_CACHE_MS = 3000

/**
 * Collect the paths a call names. Security: UNC / device paths are dropped lexically, both as written and
 * after resolving against the base, so no fs call is ever made on them.
 */
function collect(args, baseCwd, keys, withMentions) {
  const out = new Set()
  const add = (p) => {
    // Performance: a command with many paths must not make observe() probe (and spawn git for) all of them.
    if (out.size >= MAX_COLLECTED) return
    if (typeof p !== 'string' || !p.trim()) return
    const clean = p.trim().replace(/^["']|["']$/g, '')
    if (isUncOrDevicePath(clean)) return
    const full = isAbsolute(clean) ? clean : baseCwd ? resolve(baseCwd, clean) : clean
    if (!isUncOrDevicePath(full)) out.add(full)
  }
  for (const k of keys) add(args?.[k])
  const cmd = typeof args?.command === 'string' ? args.command : ''
  for (const m of cmd.matchAll(/(?:\bcd|Set-Location|\bpushd)\s+(?:-[A-Za-z]+\s+)?["']?([^\s"';|&]+)/gi)) add(m[1])
  for (const m of cmd.matchAll(/\bgit\s+-C\s+["']?([^\s"';|&]+)/gi)) add(m[1])
  if (withMentions) for (const m of cmd.matchAll(/[A-Za-z]:[\\/][^\s"'`;|&)]*/g)) add(m[0])
  return out
}

/** Candidate paths mentioned by one tool call's arguments. */
export function candidatePaths(args, baseCwd) {
  return [...collect(args, baseCwd, ['workdir', 'cwd', 'file_path', 'path', 'notebook_path'], true)].slice(0, 8)
}

/**
 * Directories a tool call actually works in (workdir/cwd, `cd`, `git -C`), as opposed to paths it merely
 * mentions. Only these may *clear* a recorded worktree; a mentioned path says nothing about where the agent is.
 */
export function workingDirectories(args, baseCwd) {
  return collect(args, baseCwd, ['workdir', 'cwd'], false)
}

/**
 * @param {{ stateDir: string, workspacePaths?: () => string[] }} opts
 */
export function createSessionRegistry({ stateDir, workspacePaths = () => [], deps = {} }) {
  const { repoInfo: repoInfoFn = repoInfo, listWorktrees: listWorktreesFn = listWorktrees, busy = () => gitStats().queued > OBSERVE_MAX_QUEUE } = deps
  mkdirSync(stateDir, { recursive: true })
  const file = join(stateDir, 'sessions.json')
  /**
   * session id -> { cwd, worktree?: { root, at } } — survives a host restart. Insertion order = recency.
   * A Map, not an object: ids are client-influenced strings, and `__proto__` / `constructor` must stay plain keys.
   */
  const known = new Map()
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'))
    // Tolerate a hand-edited or corrupt file: only an object of objects is accepted.
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      for (const [id, rec] of Object.entries(parsed)) {
        if (validSessionId(id) && rec && typeof rec === 'object' && !Array.isArray(rec)) known.set(id, rec)
      }
      // Memory/disk bound: keep only the newest entries.
      while (known.size > MAX_STORED_SESSIONS) known.delete(known.keys().next().value)
    }
  } catch { /* first run */ }
  const live = new Map() // session id -> live cwd from the running agent
  let saveTimer
  const save = () => {
    clearTimeout(saveTimer)
    // Object.fromEntries defines own properties, so a `__proto__` id round-trips as data.
    saveTimer = setTimeout(() => { try { writeFileSync(file, JSON.stringify(Object.fromEntries(known), null, 2)) } catch { /* non-fatal */ } }, 200)
    saveTimer.unref?.()
  }

  const remember = (id, patch) => {
    const next = { ...known.get(id), ...patch }
    known.delete(id) // re-insert so the most recently used id is the newest
    known.set(id, next)
    // Bounded store: evict the oldest ids.
    while (known.size > MAX_STORED_SESSIONS) known.delete(known.keys().next().value)
    save()
  }

  /** Directories observe() may probe: workspaces, the session's repo + its worktrees, and its cwd. */
  const allowedRoots = async (cwd, home) => {
    const wts = await listWorktreesFn(home.root)
    return [...workspacePaths().filter(validCwd), cwd, home.root, ...wts.map(w => w.path)]
  }

  /** session id -> { cwd, at, home, roots } reused for OBSERVE_CACHE_MS so a burst of tool calls costs one probe. */
  const ctxCache = new Map()
  /** session id -> { pending } while an observe() for that session runs. */
  const inflight = new Map()
  async function observeContext(id, cwd) {
    const hit = ctxCache.get(id)
    if (hit && hit.cwd === cwd && Date.now() - hit.at < OBSERVE_CACHE_MS) return hit
    const home = await repoInfoFn(cwd)
    const entry = { cwd, at: Date.now(), home, roots: home ? await allowedRoots(cwd, home) : [] }
    if (ctxCache.size >= MAX_STORED_SESSIONS) ctxCache.delete(ctxCache.keys().next().value)
    ctxCache.set(id, entry)
    return entry
  }

  async function observeOnce(id, args) {
    try {
      const cwd = live.get(id) ?? known.get(id)?.cwd
      if (!cwd || !validCwd(cwd)) return
      // Cheapest check first: a call that names no paths needs no git at all.
      const paths = candidatePaths(args, cwd)
      if (paths.length === 0) return
      // Low priority: UI reads must not queue behind a best-effort observation.
      if (busy()) return
      const { home, roots } = await observeContext(id, cwd)
      if (!home) return
      const dirs = workingDirectories(args, cwd)
      for (const p of paths) {
        // Security: lexical checks first, then only probe paths inside a known root (no fs/git call on arbitrary dirs).
        if (isUncOrDevicePath(p) || !roots.some(r => isInside(p, r))) continue
        if (!existsSync(p)) continue
        const info = await repoInfoFn(p)
        if (!info || !sameDir(info.commonDir, home.commonDir)) continue
        if (!info.linked) {
          // The call works in the repository's own main tree: the agent has left the linked worktree.
          if (dirs.has(p) && known.get(id)?.worktree) remember(id, { worktree: undefined })
          if (dirs.has(p)) return
          continue
        }
        const prev = known.get(id)?.worktree
        if (!prev || !sameDir(prev.root, info.root)) {
          remember(id, { worktree: { root: info.root, at: new Date().toISOString() } })
        }
        return
      }
    } catch { /* best effort */ }
  }

  return {
    /** An agent for `id` exists and works in `cwd`. Only ids and cwds that pass lexical validation are kept. */
    seen(id, cwd) {
      if (!validSessionId(id) || !validCwd(cwd)) return
      live.set(id, cwd)
      if (known.get(id)?.cwd !== cwd) remember(id, { cwd })
    },
    gone(id) { live.delete(id); ctxCache.delete(id) },

    /** Inspect one finished tool call; records the worktree if it touched another tree of the same repo. */
    async observe(id, args) {
      // Performance: observe() runs after every tool call. Calls for one session are coalesced: while one runs,
      // only the newest later call is kept and handled once the first finishes.
      const slot = inflight.get(id)
      if (slot) { slot.pending = { args }; return }
      const mine = { pending: undefined }
      inflight.set(id, mine)
      try {
        await observeOnce(id, args)
        while (mine.pending) { const { args: next } = mine.pending; mine.pending = undefined; await observeOnce(id, next) }
      } finally { inflight.delete(id) }
    },

    /**
     * Decide which working tree to show for a session.
     * @param {string} id session id
     * @param {{ cwdHint?: string, worktree?: string, worktrees?: boolean }} [opts] `cwdHint` is only honoured when it is a known workspace.
     *   `worktrees: false` skips `git worktree list` (the result then has `worktrees: []`); a recorded worktree is trusted
     *   if its folder still exists, an explicit `worktree` choice needs the list and is ignored.
     * @returns {Promise<{ ok: true, cwd: string, home: object, root: string, source: string, worktrees: object[], recorded?: string } | { ok: false, error: string }>}
     */
    async resolve(id, opts = {}) {
      if (!validSessionId(id)) return { ok: false, error: 'missing session' }
      let cwd = live.get(id) ?? known.get(id)?.cwd
      // Security: reject UNC/device hints before any fs call.
      if (!cwd && validCwd(opts.cwdHint) && existsSync(opts.cwdHint)) {
        // Sessions the host has not met yet (e.g. right after a restart): trust the browser's cwd only
        // when it lies inside a workspace DSH itself registered.
        const hint = resolve(opts.cwdHint)
        if (workspacePaths().some(w => isInside(hint, w))) { cwd = hint; remember(id, { cwd }) }
      }
      if (!cwd) return { ok: false, error: 'unknown session — send a message in it once so the plugin can see its folder' }
      if (!validCwd(cwd)) return { ok: false, error: 'invalid session folder' }
      if (!existsSync(cwd) || !statSync(cwd).isDirectory()) return { ok: false, error: `session folder no longer exists: ${cwd}` }
      const home = await repoInfo(cwd)
      if (!home) return { ok: false, error: 'not a git repository', cwd }
      const withList = opts.worktrees !== false
      const worktrees = withList ? await listWorktrees(home.root) : []
      const paths = worktrees.map(w => w.path)
      const find = (p) => p ? paths.find(x => sameDir(x, resolve(p))) : undefined

      const recordedRoot = known.get(id)?.worktree?.root
      // Without the list the recorded folder is checked on disk only (it was validated when it was recorded).
      const recorded = withList ? find(recordedRoot)
        : (recordedRoot && !isUncOrDevicePath(recordedRoot) && existsSync(recordedRoot) && statSync(recordedRoot).isDirectory() ? resolve(recordedRoot) : undefined)
      const selected = find(opts.worktree)
      let root, source
      if (selected) { root = selected; source = 'selected' }
      else if (recorded) { root = recorded; source = 'recorded' }
      else { root = home.root; source = 'cwd' }
      return { ok: true, cwd, home, root, source, worktrees, recorded, cwdRoot: home.root }
    },
  }
}