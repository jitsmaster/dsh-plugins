/**
 * Read-only git access for dsh-git-view. No DSH dependency, so it can be tested against real
 * temporary repositories.
 *
 * Every command runs with GIT_OPTIONAL_LOCKS=0 / --no-optional-locks: the agent in the session is
 * usually running git at the same moment, and a status read must never take (or wait for) the
 * index lock. Commands never throw; failures come back as `{ code !== 0 }`.
 */
import { execFile } from 'node:child_process'
import { existsSync, statSync } from 'node:fs'
import { lstat, readFile, realpath } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { AsyncLocalStorage } from 'node:async_hooks'
import { AbortedError, BusyError, createLimiter } from './limiter.js'
import { gitExecutable, isUncOrDevicePath, setGitPath } from './gitpath.js'

/** Largest patch / blob the plugin will hand to the browser. */
export const MAX_PATCH_BYTES = 4 * 1024 * 1024
export const MAX_BLOB_BYTES = 12 * 1024 * 1024
/** Untracked files larger than this are listed but not line-counted or diffed. */
const MAX_UNTRACKED_BYTES = 2 * 1024 * 1024
/**
 * Performance: counting lines reads file contents, so only the first untracked files (after the status
 * list is truncated) are counted, within a total byte budget. The rest are listed without stats.
 */
export const MAX_COUNTED_UNTRACKED = 200
const MAX_COUNTED_UNTRACKED_BYTES = 16 * 1024 * 1024
const MAX_COMMITS = 200
export const MAX_STATUS_ENTRIES = 1000
/** Never run a textconv program or external diff driver from repository config: this plugin only reads. */
const NO_DRIVERS = ['--no-ext-diff', '--no-textconv']
const GIT_TIMEOUT_MS = 20_000
/** git status lists every path, so it gets a far larger buffer than a diff; past it the repo has too many changes to show. */
const STATUS_MAX_BUFFER = 32 * 1024 * 1024
/** One shared collator: constructing it per comparison (localeCompare with options) is far slower when sorting. */
const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' })

// --literal-pathspecs: every pathspec is a plain path, so `:(top)`, `:/`, globs etc. in a browser-supplied
// path can never widen a query. log.showSignature=false: never spawn gpg from a repo-influenced log/show.
const BASE_ARGS = ['--no-optional-locks', '--literal-pathspecs', '-c', 'core.quotepath=false', '-c', 'core.fsmonitor=false', '-c', 'color.ui=never', '-c', 'log.showSignature=false']
// NoDefaultCurrentDirectoryInExePath: Windows must not search the cwd for helper executables git spawns.
const ENV = { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0', GIT_PAGER: 'cat', NoDefaultCurrentDirectoryInExePath: '1' }
/** At most 4 git processes at once; 64 more may queue, the rest are refused (DoS guard). */
const limiter = createLimiter(4, 64)
export const gitSaturated = () => limiter.saturated()
export const gitStats = () => limiter.stats()
export { BusyError, setGitPath }

/** Request-scoped abort signal: every git() call made inside `withGitSignal` is cancelled with it. */
const signalStore = new AsyncLocalStorage()
export const withGitSignal = (signal, fn) => signalStore.run({ signal }, fn)

/**
 * Run git. Resolves `{ code, stdout, stderr }`; `stdout` is a Buffer when `buffer` is set.
 * When the limiter is full the result is `{ code: -1, busy: true }`; when the request was cancelled `{ code: -1, aborted: true }`.
 * @param {string} cwd
 * @param {string[]} args
 * @param {{ buffer?: boolean, maxBuffer?: number, timeout?: number, signal?: AbortSignal }} [opts]
 */
export async function git(cwd, args, opts = {}) {
  const signal = opts.signal ?? signalStore.getStore()?.signal
  try {
    return await limiter.run(() => runGit(cwd, args, opts, signal), signal)
  } catch (error) {
    const empty = { code: -1, stdout: opts.buffer ? Buffer.alloc(0) : '', stderr: error?.message ?? '', overflow: false }
    if (error instanceof BusyError) return { ...empty, busy: true }
    if (error instanceof AbortedError) return { ...empty, aborted: true }
    throw error
  }
}

function runGit(cwd, args, opts, signal) {
  return new Promise((done) => {
    // Security: absolute git path, never a bare name that Windows would resolve against `cwd` first.
    execFile(gitExecutable(), [...BASE_ARGS, ...args], {
      cwd,
      env: ENV,
      timeout: opts.timeout ?? GIT_TIMEOUT_MS,
      maxBuffer: opts.maxBuffer ?? MAX_PATCH_BYTES + 1024,
      windowsHide: true,
      encoding: opts.buffer ? 'buffer' : 'utf8',
      signal, // the child is killed when the client disconnects
    }, (error, stdout, stderr) => {
      const code = error ? (typeof error.code === 'number' ? error.code : -1) : 0
      done({ code, stdout: stdout ?? (opts.buffer ? Buffer.alloc(0) : ''), stderr: String(stderr ?? ''), overflow: error?.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' })
    })
  })
}

const text = async (cwd, args) => {
  const r = await git(cwd, args)
  return r.code === 0 ? r.stdout.trim() : undefined
}

// ---------------------------------------------------------------------------------------------
// Repository identity
// ---------------------------------------------------------------------------------------------

/**
 * Locate the repository for a directory.
 * @returns {Promise<{ root: string, gitDir: string, commonDir: string, linked: boolean, bare: boolean } | undefined>}
 */
export async function repoInfo(dir) {
  if (!dir || typeof dir !== 'string' || isUncOrDevicePath(dir) || !existsSync(dir)) return undefined
  const cwd = statSync(dir).isDirectory() ? dir : resolve(dir, '..')
  const r = await git(cwd, ['rev-parse', '--show-toplevel', '--path-format=absolute', '--git-dir', '--git-common-dir', '--is-bare-repository'])
  if (r.code !== 0) return undefined
  const [top, gitDir, commonDir, bare] = r.stdout.split('\n').map(s => s.trim())
  if (!top || !gitDir || !commonDir) return undefined
  return { root: resolve(top), gitDir: resolve(gitDir), commonDir: resolve(commonDir), linked: resolve(gitDir) !== resolve(commonDir), bare: bare === 'true' }
}

/** `git worktree list --porcelain`, newest git format. The first entry is the main working tree. */
export async function listWorktrees(root) {
  const r = await git(root, ['worktree', 'list', '--porcelain'])
  if (r.code !== 0) return []
  const out = []
  for (const block of r.stdout.split(/\r?\n\r?\n/)) {
    const wt = { path: '', head: undefined, branch: undefined, detached: false, bare: false, locked: false, prunable: false, main: out.length === 0 }
    for (const line of block.split(/\r?\n/)) {
      if (line.startsWith('worktree ')) wt.path = resolve(line.slice(9))
      else if (line.startsWith('HEAD ')) wt.head = line.slice(5)
      else if (line.startsWith('branch ')) wt.branch = line.slice(7).replace(/^refs\/heads\//, '')
      else if (line === 'detached') wt.detached = true
      else if (line === 'bare') wt.bare = true
      else if (line.startsWith('locked')) wt.locked = true
      else if (line.startsWith('prunable')) wt.prunable = true
    }
    if (wt.path) out.push(wt)
  }
  return out
}

/** Which multi-step operation (if any) the working tree is in the middle of. */
export function inProgressOperation(info) {
  const has = (name) => existsSync(join(info.gitDir, name))
  if (has('rebase-merge') || has('rebase-apply')) return 'rebase'
  if (has('MERGE_HEAD')) return 'merge'
  if (has('CHERRY_PICK_HEAD')) return 'cherry-pick'
  if (has('REVERT_HEAD')) return 'revert'
  if (has('BISECT_LOG')) return 'bisect'
  return undefined
}

// ---------------------------------------------------------------------------------------------
// Status
// ---------------------------------------------------------------------------------------------

/** Two-letter porcelain code -> a single display status. */
function letter(code) {
  if (code === '.' || code === ' ') return ''
  return code
}

/**
 * Parse `git status --porcelain=v2 --branch -z`.
 * @returns {{ branch: object, entries: object[] }}
 */
export function parseStatusV2(raw) {
  const branch = { oid: undefined, head: undefined, upstream: undefined, ahead: 0, behind: 0, hasAb: false }
  const entries = []
  const parts = raw.split('\0')
  for (let i = 0; i < parts.length; i++) {
    const line = parts[i]
    if (!line) continue
    if (line.startsWith('# ')) {
      const [key, ...rest] = line.slice(2).split(' ')
      const value = rest.join(' ')
      if (key === 'branch.oid') branch.oid = value === '(initial)' ? undefined : value
      else if (key === 'branch.head') branch.head = value === '(detached)' ? undefined : value
      else if (key === 'branch.upstream') branch.upstream = value
      else if (key === 'branch.ab') {
        const m = /^\+(\d+) -(\d+)$/.exec(value)
        if (m) { branch.ahead = Number(m[1]); branch.behind = Number(m[2]); branch.hasAb = true }
      }
    } else if (line[0] === '1') {
      // 1 XY sub mH mI mW hH hI path
      const f = line.split(' ')
      const xy = f[1]
      entries.push({ path: f.slice(8).join(' '), index: letter(xy[0]), worktree: letter(xy[1]), submodule: f[2] !== 'N...' })
    } else if (line[0] === '2') {
      // 2 XY sub mH mI mW hH hI Xscore path \0 origPath
      const f = line.split(' ')
      const xy = f[1]
      const orig = parts[++i]
      entries.push({ path: f.slice(9).join(' '), origPath: orig, index: letter(xy[0]), worktree: letter(xy[1]), submodule: f[2] !== 'N...' })
    } else if (line[0] === 'u') {
      // u XY sub m1 m2 m3 mW h1 h2 h3 path
      const f = line.split(' ')
      entries.push({ path: f.slice(10).join(' '), index: 'U', worktree: 'U', conflict: f[1], submodule: f[2] !== 'N...' })
    } else if (line[0] === '?') {
      entries.push({ path: line.slice(2), index: '', worktree: '?', untracked: true })
    }
    // '!' (ignored) is never requested.
  }
  return { branch, entries }
}

/** Parse `--numstat -z` output into path -> { added, deleted, binary }. */
export function parseNumstat(raw) {
  const stats = new Map()
  const parts = raw.split('\0')
  for (let i = 0; i < parts.length; i++) {
    const head = parts[i]
    if (!head) continue
    const m = /^(-|\d+)\t(-|\d+)\t(.*)$/.exec(head)
    if (!m) continue
    let path = m[3]
    if (path === '') { // rename/copy: next two NUL fields are old, new
      path = parts[i + 2]
      i += 2
    }
    const binary = m[1] === '-'
    stats.set(path, { added: binary ? 0 : Number(m[1]), deleted: binary ? 0 : Number(m[2]), binary })
  }
  return stats
}

const looksBinary = (buf) => buf.subarray(0, 8000).includes(0)

/**
 * Line count of an untracked file, or `undefined` when it is binary / too large / unreadable.
 * lstat (not stat): a symlink is never followed, so a link to a file outside the repository is not read.
 * @returns {Promise<{ stats: object | undefined, bytes: number }>}
 */
async function countUntrackedLines(root, realRoot, path, budget) {
  try {
    if (!await parentInsideRoot(root, path, realRoot)) return { stats: undefined, bytes: 0 }
    const full = join(root, path)
    const st = await lstat(full)
    // nlink > 1: a hard link may alias a file outside the repository, which lstat cannot reveal.
    if (!st.isFile() || st.nlink > 1 || st.size > MAX_UNTRACKED_BYTES || st.size > budget) return { stats: undefined, bytes: 0 }
    const buf = await readFile(full)
    if (looksBinary(buf)) return { stats: { added: 0, deleted: 0, binary: true }, bytes: buf.length }
    if (buf.length === 0) return { stats: { added: 0, deleted: 0, binary: false }, bytes: 0 }
    // Performance: native indexOf scan instead of a per-byte JS loop.
    let n = 0
    for (let i = buf.indexOf(10); i !== -1; i = buf.indexOf(10, i + 1)) n++
    if (buf[buf.length - 1] !== 10) n++
    return { stats: { added: n, deleted: 0, binary: false }, bytes: buf.length }
  } catch { return { stats: undefined, bytes: 0 } }
}

/** Attach line stats to the first `MAX_COUNTED_UNTRACKED` files, stopping when the byte budget is spent. */
async function countUntracked(root, list) {
  let budget = MAX_COUNTED_UNTRACKED_BYTES
  // Performance: resolve the repository's real root once, not once per file.
  let realRoot
  try { realRoot = await realpath(root) } catch { return }
  for (const f of list.slice(0, MAX_COUNTED_UNTRACKED)) {
    if (budget <= 0) break
    const r = await countUntrackedLines(root, realRoot, f.path, budget)
    f.stats = r.stats
    budget -= r.bytes
  }
}

const CONFLICT_LABEL = {
  DD: 'both deleted', AU: 'added by us', UD: 'deleted by them', UA: 'added by them',
  DU: 'deleted by us', AA: 'both added', UU: 'both modified',
}

/**
 * Current uncommitted state of one working tree.
 * @param {string} root
 * @param {{ maxBuffer?: number }} [opts] `maxBuffer` overrides the status output limit (tests).
 * @returns {Promise<object>} `{ ok:false, error }` or the full status snapshot.
 */
export async function readStatus(root, opts = {}) {
  const info = await repoInfo(root)
  if (!info) return { ok: false, error: 'not a git repository' }
  const [st, staged, unstaged, stashes] = await Promise.all([
    git(root, ['status', '--porcelain=v2', '--branch', '-z', '--untracked-files=all', '--find-renames'], { maxBuffer: opts.maxBuffer ?? STATUS_MAX_BUFFER }),
    git(root, ['diff', ...NO_DRIVERS, '--cached', '--numstat', '-z', '--find-renames']),
    git(root, ['diff', ...NO_DRIVERS, '--numstat', '-z', '--find-renames']),
    git(root, ['stash', 'list', '--format=%gd']),
  ])
  if (st.overflow) return { ok: false, error: 'too many changes to list (git status output is too large)' }
  if (st.code !== 0) return { ok: false, error: st.stderr.trim() || 'git status failed' }
  const { branch, entries } = parseStatusV2(st.stdout)
  const stagedStats = staged.code === 0 ? parseNumstat(staged.stdout) : new Map()
  const unstagedStats = unstaged.code === 0 ? parseNumstat(unstaged.stdout) : new Map()

  const conflicts = []
  const stagedFiles = []
  const changes = []
  const untracked = []
  for (const e of entries) {
    if (e.conflict) {
      conflicts.push({ path: e.path, code: e.conflict, label: CONFLICT_LABEL[e.conflict] ?? 'conflict' })
      continue
    }
    if (e.untracked) {
      untracked.push({ path: e.path, status: '?', stats: undefined })
      continue
    }
    if (e.index) stagedFiles.push({ path: e.path, origPath: e.origPath, status: e.index, stats: stagedStats.get(e.path), submodule: e.submodule || undefined })
    if (e.worktree) changes.push({ path: e.path, status: e.worktree, stats: unstagedStats.get(e.path), submodule: e.submodule || undefined })
  }
  const byPath = (a, b) => collator.compare(a.path, b.path)
  conflicts.sort(byPath); stagedFiles.sort(byPath); changes.sort(byPath); untracked.sort(byPath)
  // Orca stops at 1000 entries; a huge status would otherwise stall both git and the browser.
  const total = conflicts.length + stagedFiles.length + changes.length + untracked.length
  let truncated = false
  if (total > MAX_STATUS_ENTRIES) {
    truncated = true
    let room = MAX_STATUS_ENTRIES
    for (const list of [conflicts, stagedFiles, changes, untracked]) {
      if (list.length > room) list.length = room
      room -= list.length
    }
  }
  // Counted only after truncation so a huge untracked tree never costs a read per file.
  await countUntracked(info.root, untracked)

  return {
    ok: true,
    root: info.root,
    linked: info.linked,
    operation: inProgressOperation(info),
    branch: {
      name: branch.head,
      detached: branch.head === undefined && branch.oid !== undefined,
      unborn: branch.oid === undefined,
      oid: branch.oid,
      upstream: branch.upstream,
      ahead: branch.ahead,
      behind: branch.behind,
      gone: Boolean(branch.upstream) && !branch.hasAb,
    },
    stashCount: stashes.code === 0 ? stashes.stdout.split('\n').filter(Boolean).length : 0,
    truncated,
    total,
    conflicts,
    staged: stagedFiles,
    changes,
    untracked,
  }
}

// ---------------------------------------------------------------------------------------------
// Branch compare ("committed on this branch")
// ---------------------------------------------------------------------------------------------

const verify = async (root, ref) => (await text(root, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`])) !== undefined

/** Best guess at the branch this work will be merged into. */
export async function defaultBaseRef(root, currentBranch) {
  const origin = await text(root, ['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD'])
  const candidates = [origin, 'origin/main', 'origin/master', 'main', 'master', 'develop'].filter(Boolean)
  for (const ref of candidates) {
    if (ref === currentBranch) continue
    if (await verify(root, ref)) return ref
  }
  return undefined
}

/** Reject anything that could be read as an option or a revision range. */
export function safeRef(ref) {
  return typeof ref === 'string' && ref.length > 0 && ref.length < 256 && !ref.startsWith('-') && !/[\s\0~^:?*[\\]|\.\./.test(ref)
}

/**
 * Commits and files that are on HEAD but not on the detected default base branch.
 * @param {string} root
 */
export async function readBranchCompare(root, currentBranch) {
  const baseRef = await defaultBaseRef(root, currentBranch)
  if (!baseRef) return { ok: false, error: 'no base branch found' }
  const mergeBase = await text(root, ['merge-base', baseRef, 'HEAD'])
  if (!mergeBase) return { ok: false, baseRef, error: `no common ancestor with ${baseRef}` }
  const [names, nums, log, counts] = await Promise.all([
    git(root, ['diff', ...NO_DRIVERS, '--name-status', '-z', '--find-renames', mergeBase, 'HEAD']),
    git(root, ['diff', ...NO_DRIVERS, '--numstat', '-z', '--find-renames', mergeBase, 'HEAD']),
    git(root, ['log', `--max-count=${MAX_COMMITS}`, '--format=%H%x1f%h%x1f%an%x1f%at%x1f%s', `${mergeBase}..HEAD`]),
    git(root, ['rev-list', '--left-right', '--count', `${baseRef}...HEAD`]),
  ])
  // A diff too large for the buffer is reported, not shown as an empty (clean-looking) branch.
  if (names.overflow || nums.overflow) return { ok: false, baseRef, mergeBase, error: 'too many changed files to list on this branch' }
  const stats = nums.code === 0 ? parseNumstat(nums.stdout) : new Map()
  const allFiles = names.code === 0 ? parseNameStatus(names.stdout) : []
  const truncated = allFiles.length > MAX_STATUS_ENTRIES
  const files = allFiles.slice(0, MAX_STATUS_ENTRIES).map(f => ({ ...f, stats: stats.get(f.path) }))
  const commits = log.code === 0 ? log.stdout.split('\n').filter(Boolean).map((l) => {
    const [sha, short, author, at, subject] = l.split('\x1f')
    return { sha, short, author, at: Number(at) * 1000, subject }
  }) : []
  const [behind, ahead] = counts.code === 0 ? counts.stdout.trim().split(/\s+/).map(Number) : [0, 0]
  return { ok: true, baseRef, mergeBase, ahead, behind, files, truncated, commits }
}

/**
 * Recent commits reachable from HEAD, newest first, with decorations and parents.
 * `outgoing` marks commits not yet on the upstream, `incoming` counts commits only on the upstream.
 */
export async function readHistory(root, limit = 50) {
  const n = Number.isInteger(limit) ? Math.max(1, Math.min(limit, MAX_COMMITS)) : 50
  const [log, up] = await Promise.all([
    git(root, ['log', '--topo-order', '--decorate=short', `--max-count=${n + 1}`, '--format=%H%x1f%h%x1f%an%x1f%at%x1f%P%x1f%D%x1f%s%x1e']),
    text(root, ['rev-parse', '--verify', '--quiet', '@{upstream}']),
  ])
  if (log.code !== 0) return { ok: false, error: log.stderr.trim() || 'no commits' }
  let outgoing = new Set()
  let incoming = 0
  if (up) {
    const [out, inc] = await Promise.all([
      git(root, ['rev-list', `${up}..HEAD`, `--max-count=${MAX_COMMITS}`]),
      git(root, ['rev-list', '--count', `HEAD..${up}`]),
    ])
    if (out.code === 0) outgoing = new Set(out.stdout.split('\n').filter(Boolean))
    if (inc.code === 0) incoming = Number(inc.stdout.trim()) || 0
  }
  const rows = log.stdout.split('\x1e').map(s => s.replace(/^\n/, '')).filter(Boolean).map((rec) => {
    const [sha, short, author, at, parents, refs, subject] = rec.split('\x1f')
    return {
      sha, short, author, at: Number(at) * 1000, subject,
      parents: parents ? parents.split(' ') : [],
      refs: refs ? refs.split(', ').filter(Boolean).map(r => r.replace(/^HEAD -> /, '')) : [],
      head: /(^|, )HEAD/.test(refs ?? ''),
      outgoing: outgoing.has(sha),
    }
  })
  const hasMore = rows.length > n
  return { ok: true, commits: rows.slice(0, n), hasMore, hasUpstream: Boolean(up), incoming }
}

/** Parse `--name-status -z`. */
export function parseNameStatus(raw) {
  const parts = raw.split('\0')
  const files = []
  for (let i = 0; i < parts.length; i++) {
    const code = parts[i]
    if (!code) continue
    const status = code[0]
    if (status === 'R' || status === 'C') {
      files.push({ status, origPath: parts[i + 1], path: parts[i + 2] })
      i += 2
    } else {
      files.push({ status, path: parts[i + 1] })
      i += 1
    }
  }
  return files.filter(f => f.path)
}

/** Files one commit touched. */
export async function readCommit(root, sha) {
  if (!/^[0-9a-f]{4,64}$/i.test(sha)) return { ok: false, error: 'bad commit id' }
  // A blob/tree/tag id must not be shown as a commit.
  const kind = await text(root, ['cat-file', '-t', sha])
  if (kind !== 'commit') return { ok: false, error: 'unknown commit' }
  const [meta, names, nums] = await Promise.all([
    git(root, ['show', '--no-patch', '--format=%H%x1f%an%x1f%at%x1f%B', sha]),
    git(root, ['show', ...NO_DRIVERS, '--format=', '--name-status', '-z', '--find-renames', '--first-parent', sha]),
    git(root, ['show', ...NO_DRIVERS, '--format=', '--numstat', '-z', '--find-renames', '--first-parent', sha]),
  ])
  if (meta.code !== 0) return { ok: false, error: 'unknown commit' }
  const [full, author, at, ...body] = meta.stdout.split('\x1f')
  const stats = nums.code === 0 ? parseNumstat(nums.stdout) : new Map()
  const files = names.code === 0 ? parseNameStatus(names.stdout.replace(/^\0/, '')).map(f => ({ ...f, stats: stats.get(f.path) })) : []
  return { ok: true, sha: full, author, at: Number(at) * 1000, message: body.join('\x1f').trim(), files }
}

// ---------------------------------------------------------------------------------------------
// Diffs
// ---------------------------------------------------------------------------------------------

/**
 * Validate a repo-relative path from the browser. Returns the normalised path or undefined.
 * The path is only ever passed to git after `--`, but we still refuse anything that escapes.
 */
export function safeRelPath(root, p) {
  if (typeof p !== 'string' || !p || p.includes('\0') || isAbsolute(p)) return undefined
  const full = resolve(root, p)
  const rel = relative(root, full)
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) return undefined
  const norm = rel.split(sep).join('/')
  // Repository metadata is never a diff target (a segment named .git, on any filesystem casing).
  if (norm.split('/').some(s => s.toLowerCase() === '.git')) return undefined
  return norm
}

/**
 * Security: the untracked-file read goes to the working tree directly (git has no diff form for it), so it
 * is restricted to what git itself lists as untracked and not ignored. This refuses ignored files such
 * as `.env`, tracked files, directories and anything under `.git`.
 */
async function isListedUntracked(root, rawPath, path) {
  if (/(^|[\\/])\.\.([\\/]|$)/.test(rawPath) || rawPath.split(/[\\/]/).some(s => s.toLowerCase() === '.git')) return false
  const r = await git(root, ['ls-files', '--others', '--exclude-standard', '-z', '--', path])
  return r.code === 0 && r.stdout.split('\0').includes(path)
}

/**
 * Security: the real location of a path's parent directory must stay inside the repository's real root.
 * lstat on the file alone does not notice a directory symlink / junction in the middle of the path
 * (`lnk/secret.png` where `lnk` points outside), so the parent is resolved through every link.
 */
async function parentInsideRoot(root, path, knownRealRoot) {
  try {
    const [realRoot, realParent] = await Promise.all([knownRealRoot ?? realpath(root), realpath(dirname(join(root, path)))])
    const rel = relative(realRoot, realParent)
    return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
  } catch { return false }
}

/** Security: worktree-side reads only serve what git knows: a tracked path or one it lists as untracked (never ignored). */
async function isTrackedOrUntracked(root, rawPath, path) {
  const r = await git(root, ['ls-files', '-z', '--', path])
  if (r.code === 0 && r.stdout.split('\0').includes(path)) return true
  return isListedUntracked(root, rawPath, path)
}

/** Synthesize an all-added patch for an untracked file (git has no pathspec form for this). */
async function untrackedPatch(root, path) {
  if (!await parentInsideRoot(root, path)) return { patch: '', binary: false, symlink: true }
  const full = join(root, path)
  const st = await lstat(full)
  // Security: lstat, never follow a link — it could point at any file the host user can read.
  if (st.isSymbolicLink()) return { patch: '', binary: false, symlink: true }
  if (!st.isFile()) return { patch: '', binary: false }
  if (st.nlink > 1) return { patch: '', binary: false, hardlink: true } // hard link: may alias an outside file
  if (st.size > MAX_UNTRACKED_BYTES) return { patch: '', binary: false, tooLarge: true }
  const buf = await readFile(full)
  if (looksBinary(buf)) return { patch: '', binary: true }
  const body = buf.toString('utf8')
  if (body === '') return { patch: `diff --git a/${path} b/${path}\nnew file mode 100644\n`, binary: false }
  const lines = body.split('\n')
  const endsNl = body.endsWith('\n')
  if (endsNl) lines.pop()
  const out = [`diff --git a/${path} b/${path}`, 'new file mode 100644', '--- /dev/null', `+++ b/${path}`, `@@ -0,0 +1,${lines.length} @@`]
  for (const l of lines) out.push('+' + l)
  if (!endsNl) out.push('\\ No newline at end of file')
  return { patch: out.join('\n') + '\n', binary: false }
}

/**
 * Unified diff for one scope.
 * @param {string} root
 * @param {{ scope: 'unstaged'|'staged'|'untracked'|'branch'|'commit'|'all', path?: string, base?: string, sha?: string, context?: number }} q
 * @returns {Promise<{ ok: boolean, patch?: string, binary?: boolean, truncated?: boolean, error?: string }>}
 */
export async function readDiff(root, q) {
  const path = q.path === undefined ? undefined : safeRelPath(root, q.path)
  if (q.path !== undefined && path === undefined) return { ok: false, error: 'invalid path' }
  const context = Number.isInteger(q.context) && q.context >= 0 ? Math.min(q.context, 100_000) : 3
  const ws = q.ignoreWs ? ['--ignore-all-space'] : []
  const common = ['diff', '--no-color', ...NO_DRIVERS, '--find-renames', `-U${context}`, ...ws]
  // A rename is only shown as one when git is given both names; without the old name it is a whole-file add.
  let origPath
  if (q.origPath !== undefined && q.origPath !== '') {
    origPath = safeRelPath(root, q.origPath)
    if (!origPath) return { ok: false, error: 'invalid path' }
  }
  const tail = path ? (origPath && origPath !== path ? ['--', origPath, path] : ['--', path]) : []
  let args
  switch (q.scope) {
    case 'untracked': {
      if (!path) return { ok: false, error: 'path required' }
      if (!await isListedUntracked(root, q.path, path)) return { ok: false, error: 'not an untracked file' }
      try { return { ok: true, ...await untrackedPatch(root, path) } } catch (error) { return { ok: false, error: String(error?.message ?? error) } }
    }
    case 'unstaged': args = [...common, ...tail]; break
    case 'staged': args = [...common, '--cached', ...tail]; break
    case 'all': args = [...common, 'HEAD', ...tail]; break
    case 'branch': {
      const base = q.base && safeRef(q.base) ? q.base : undefined
      if (!base) return { ok: false, error: 'base ref required' }
      const mb = await text(root, ['merge-base', base, 'HEAD'])
      if (!mb) return { ok: false, error: 'no common ancestor' }
      args = [...common, mb, 'HEAD', ...tail]
      break
    }
    case 'commit': {
      if (!/^[0-9a-f]{4,64}$/i.test(q.sha ?? '')) return { ok: false, error: 'bad commit id' }
      args = ['show', '--format=', '--no-color', ...NO_DRIVERS, '--find-renames', '--first-parent', `-U${context}`, ...ws, q.sha, ...tail]
      break
    }
    default: return { ok: false, error: 'unknown scope' }
  }
  const r = await git(root, args)
  if (r.overflow) return { ok: true, patch: '', binary: false, truncated: true }
  if (r.busy) return { ok: false, busy: true, error: r.stderr }
  if (r.code !== 0) return { ok: false, error: r.stderr.trim() || 'git diff failed' }
  return { ok: true, patch: r.stdout, binary: false }
}

// ---------------------------------------------------------------------------------------------
// Blobs (images)
// ---------------------------------------------------------------------------------------------

export const IMAGE_MIME = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp',
  bmp: 'image/bmp', ico: 'image/x-icon', avif: 'image/avif', svg: 'image/svg+xml',
}
export const mimeFor = (p) => IMAGE_MIME[p.split('.').pop()?.toLowerCase() ?? '']

/**
 * One side of a file diff as raw bytes: old side for `side=old`, new side for `side=new`.
 * @returns {Promise<{ ok: boolean, data?: Buffer, mime?: string, missing?: boolean, error?: string }>}
 */
export async function readSide(root, q) {
  const path = safeRelPath(root, q.path)
  if (!path) return { ok: false, error: 'invalid path' }
  const mime = mimeFor(path)
  if (!mime) return { ok: false, error: 'not a previewable image' }
  let spec
  switch (q.scope) {
    case 'unstaged': spec = q.side === 'old' ? `:0:${path}` : 'worktree'; break
    case 'untracked':
      if (q.side === 'old') return { ok: true, missing: true, mime }
      if (!await isListedUntracked(root, q.path, path)) return { ok: false, error: 'not an untracked file' }
      spec = 'worktree'
      break
    case 'staged': spec = q.side === 'old' ? `HEAD:${path}` : `:0:${path}`; break
    case 'all': spec = q.side === 'old' ? `HEAD:${path}` : 'worktree'; break
    case 'branch': {
      if (!q.base || !safeRef(q.base)) return { ok: false, error: 'base ref required' }
      const mb = q.side === 'old' ? await text(root, ['merge-base', q.base, 'HEAD']) : 'HEAD'
      if (!mb) return { ok: false, error: 'no common ancestor' }
      spec = `${mb}:${path}`
      break
    }
    case 'commit':
      if (!/^[0-9a-f]{4,64}$/i.test(q.sha ?? '')) return { ok: false, error: 'bad commit id' }
      spec = q.side === 'old' ? `${q.sha}^:${path}` : `${q.sha}:${path}`
      break
    default: return { ok: false, error: 'unknown scope' }
  }
  if (spec === 'worktree') {
    try {
      if (q.scope !== 'untracked' && !await isTrackedOrUntracked(root, q.path, path)) return { ok: false, error: 'not a tracked or untracked file' }
      if (!await parentInsideRoot(root, path)) return { ok: false, error: 'path leaves the repository' }
      const full = join(root, path)
      // Security: lstat, never follow a link out of the repository.
      const st = await lstat(full)
      if (st.isSymbolicLink()) return { ok: false, error: 'symlink: not followed' }
      if (!st.isFile()) return { ok: true, missing: true, mime }
      if (st.nlink > 1) return { ok: false, error: 'hard link: not read' }
      if (st.size > MAX_BLOB_BYTES) return { ok: false, error: 'too large to preview' }
      return { ok: true, data: await readFile(full), mime }
    } catch { return { ok: true, missing: true, mime } }
  }
  const r = await git(root, ['cat-file', 'blob', spec], { buffer: true, maxBuffer: MAX_BLOB_BYTES })
  if (r.overflow) return { ok: false, error: 'too large to preview' }
  if (r.code !== 0) return { ok: true, missing: true, mime }
  return { ok: true, data: r.stdout, mime }
}
