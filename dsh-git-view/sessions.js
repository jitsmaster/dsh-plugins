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
import { escapesRoot, gitStats, listWorktrees, repoInfo } from './git.js'
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
  return rel === '' || (!escapesRoot(rel) && !isAbsolute(rel))
}

/** Hard cap on paths collected from one tool call. */
export const MAX_COLLECTED = 16
/** Only this many leading characters of a `run_code` script are scanned for paths. */
export const MAX_CODE_SCAN = 65_536
/** observe() is best effort and yields to UI reads: it is skipped while more than this many git jobs wait. */
const OBSERVE_MAX_QUEUE = 8
/** How long one session's repo identity + allowed worktree roots are reused by observe(). */
const OBSERVE_CACHE_MS = 3000
/** Directories outside every known worktree root are probed with git at most once per this long, in a small cache. */
const PROBE_CACHE_MS = 30_000
const PROBE_CACHE_MAX = 64
/** A recorded worktree's validity is re-checked (git rev-parse) at most this often when no worktree list is read. */
const RECORDED_CACHE_MS = 5000
const BUSY = { ok: false, busy: true, error: 'busy: too many concurrent git requests' }

/**
 * Collect the paths a call names. Security: UNC / device paths are dropped lexically, both as written and
 * after resolving against the base, so no fs call is ever made on them.
 */
export function collect(args, baseCwd, keys, withMentions) {
  const out = new Set()
  // Returns false once the cap is reached so every scan below stops (a huge command costs no further regex work).
  const add = (p) => {
    // Performance: a command with many paths must not make observe() probe (and spawn git for) all of them.
    if (out.size >= MAX_COLLECTED) return false
    if (typeof p !== 'string' || !p.trim()) return true
    const clean = p.trim().replace(/^["']|["']$/g, '')
    if (isUncOrDevicePath(clean)) return true
    const full = isAbsolute(clean) ? clean : baseCwd ? resolve(baseCwd, clean) : clean
    if (!isUncOrDevicePath(full)) out.add(full)
    return out.size < MAX_COLLECTED
  }
  const cmd = typeof args?.command === 'string' ? args.command : ''
  const scan = (re, group) => { for (const m of cmd.matchAll(re)) if (!add(m[group])) return false; return true }
  for (const k of keys) if (!add(args?.[k])) return out
  if (!scan(/(?:\bcd|Set-Location|\bpushd)\s+(?:-[A-Za-z]+\s+)?["']?([^\s"';|&]+)/gi, 1)) return out
  if (!scan(/\bgit\s+-C\s+["']?([^\s"';|&]+)/gi, 1)) return out
  if (withMentions) {
    const mention = /[A-Za-z]:[\\/][^\s"'`;|&)]*/g
    if (!scan(mention, 0)) return out
    // A `run_code` call has only a `code` argument that names its worktree inside the script (`cwd: 'D:/...'`).
    // Scanned like a command, as mentions only; capped so a huge script costs a bounded amount of regex work.
    if (typeof args?.code === 'string') for (const m of args.code.slice(0, MAX_CODE_SCAN).matchAll(mention)) if (!add(m[0])) return out
  }
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
 * @param {{ stateDir?: string, workspacePaths?: () => string[], persist?: boolean }} opts
 *   `persist: false` keeps sessions in memory only: nothing is read from or written to disk.
 */
export function createSessionRegistry({ stateDir, workspacePaths = () => [], deps = {}, persist = true }) {
  const { repoInfo: repoInfoFn = repoInfo, listWorktrees: listWorktreesFn = listWorktrees, busy = () => gitStats().queued > OBSERVE_MAX_QUEUE } = deps
  const file = persist && typeof stateDir === 'string' ? join(stateDir, 'sessions.json') : undefined
  if (file) try { mkdirSync(stateDir, { recursive: true }) } catch { /* unusable stateDir: sessions stay in memory (save() is non-fatal too) */ }
  /**
   * session id -> { cwd, worktree?: { root, at } } — survives a host restart. Insertion order = recency.
   * A Map, not an object: ids are client-influenced strings, and `__proto__` / `constructor` must stay plain keys.
   */
  const known = new Map()
  if (file) try {
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
    if (!file) return // in-memory registry
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

  /**
   * Worktrees of the session's repository as `{ path, linked }`. Without a usable list, the home tree alone.
   * Performance: observe() classifies a candidate path lexically against these, so no git runs per path.
   */
  const knownTrees = async (home) => {
    const wts = await listWorktreesFn(home.root)
    return wts?.length ? wts.map(w => ({ path: w.path, linked: !w.main })) : [{ path: home.root, linked: home.linked }]
  }

  /** session id -> { cwd, at, home, roots, trees } reused for OBSERVE_CACHE_MS so a burst of tool calls costs one probe. */
  const ctxCache = new Map()
  /** session id -> { pending } while an observe() for that session runs. */
  const inflight = new Map()
  async function observeContext(id, cwd) {
    const hit = ctxCache.get(id)
    if (hit && hit.cwd === cwd && Date.now() - hit.at < OBSERVE_CACHE_MS) return hit
    const home = await repoInfoFn(cwd)
    if (!home || home.busy || home.missing) return { home: undefined, roots: [], trees: [] } // not cached: a busy answer must not stick
    const trees = await knownTrees(home)
    // Directories observe() may look at: workspaces, the session's cwd, and every tree of its repository.
    const entry = { cwd, at: Date.now(), home, trees, roots: [...workspacePaths().filter(validCwd), cwd, ...trees.map(t => t.path)] }
    if (ctxCache.size >= MAX_STORED_SESSIONS) ctxCache.delete(ctxCache.keys().next().value)
    ctxCache.set(id, entry)
    return entry
  }

  /** Longest known worktree root containing `p` (nested worktrees win over their parent), lexically. */
  const treeOf = (p, trees) => trees.reduce((best, t) => (isInside(p, t.path) && (!best || resolve(t.path).length > resolve(best.path).length) ? t : best), undefined)

  /** recorded worktree root -> { at, home commonDir, root } so the no-list path costs one rev-parse per few seconds. */
  const recordedCache = new Map()
  /** The recorded worktree as `{ root }` if it is still a tree of `home`'s repository, `{ busy: true }`, or undefined. */
  async function recordedValid(recordedRoot, home) {
    const key = `${home.commonDir}\0${recordedRoot}`
    const hit = recordedCache.get(key)
    if (hit && Date.now() - hit.at < RECORDED_CACHE_MS) return hit.v
    const info = await repoInfoFn(recordedRoot)
    if (info?.busy) return { busy: true } // never cached
    const v = info?.commonDir && sameDir(info.commonDir, home.commonDir) ? { root: info.root } : undefined
    if (recordedCache.size >= PROBE_CACHE_MAX) recordedCache.delete(recordedCache.keys().next().value)
    recordedCache.set(key, { at: Date.now(), v })
    return v
  }

  /** dir -> { at, info } for directories no known worktree contains; bounded, 30 s, never holds busy answers. */
  const probeCache = new Map()
  async function probe(dir) {
    const hit = probeCache.get(dir)
    if (hit && Date.now() - hit.at < PROBE_CACHE_MS) return hit.info
    const info = await repoInfoFn(dir)
    if (info?.busy || info?.missing) return undefined
    if (probeCache.size >= PROBE_CACHE_MAX) probeCache.delete(probeCache.keys().next().value)
    probeCache.set(dir, { at: Date.now(), info })
    return info
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
      const { home, roots, trees } = await observeContext(id, cwd)
      if (!home) return
      const dirs = workingDirectories(args, cwd)
      for (const p of paths) {
        // Security: lexical checks first, then only look at paths inside a known root (no fs/git call on arbitrary dirs).
        if (isUncOrDevicePath(p) || !roots.some(r => isInside(p, r))) continue
        if (!existsSync(p)) continue
        // Performance: a path inside a known worktree is classified without git; only unmatched dirs are probed (cached).
        // The lexical shortcut is only trusted for linked trees. A path under the main tree may sit in a
        // submodule / nested repository, so it is verified with the (cached) probe before it can clear the recording.
        const tree = treeOf(p, trees)
        // The home root itself is already known (observeContext's rev-parse), so it needs no probe.
        const info = tree?.linked ? { root: resolve(tree.path), linked: true, commonDir: home.commonDir }
          : sameDir(resolve(p), resolve(home.root)) ? home : await probe(p)
        if (!info?.commonDir || !sameDir(info.commonDir, home.commonDir)) continue
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
     * @param {{ cwdHint?: string, worktrees?: boolean }} [opts] `cwdHint` is only honoured when it is a known workspace.
     *   `worktrees: false` skips `git worktree list` (the result then has `worktrees: []`); the recorded worktree is then
     *   validated with rev-parse instead (same repository as the session's home, cached a few seconds).
     * @returns {Promise<{ ok: true, cwd: string, home: object, root: string, source: string, worktrees: object[] } | { ok: false, error: string, busy?: true }>}
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
      const home = await repoInfoFn(cwd)
      // Busy / aborted git is not "not a repository": surface it so the server answers 429 and never caches it.
      if (home?.busy) return BUSY
      // A missing git executable is its own error, not "not a git repository".
      if (home?.missing) return { ok: false, error: 'git executable not found', cwd }
      if (!home) return { ok: false, error: 'not a git repository', cwd }
      const withList = opts.worktrees !== false
      const worktrees = withList ? await listWorktreesFn(home.root) : []
      if (!worktrees) return BUSY
      const recordedRoot = known.get(id)?.worktree?.root
      let recorded
      if (!recordedRoot || isUncOrDevicePath(recordedRoot)) recorded = undefined
      else if (withList) recorded = worktrees.map(w => w.path).find(x => sameDir(x, resolve(recordedRoot)))
      else {
        // No list: still validate (not just "exists on disk") so every route agrees with the snapshot, which does use the list.
        const v = await recordedValid(recordedRoot, home)
        if (v?.busy) return BUSY
        recorded = v?.root
      }
      return { ok: true, cwd, home, root: recorded ?? home.root, source: recorded ? 'recorded' : 'cwd', worktrees }
    },
  }
}