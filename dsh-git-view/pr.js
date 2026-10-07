/**
 * Which pull request (if any) belongs to a branch. Read-only: asks 'gh' (GitHub remotes) or 'az' (Azure DevOps
 * remotes) to LIST PRs for the branch; nothing is created or changed. A missing CLI, no login, a network
 * failure or an unknown remote all mean "no PR to show", never an error in the Git tab.
 *
 * Security: executables are looked up on PATH only (never the cwd), children get an allow-listed environment,
 * and every value placed on a command line is validated first. On Windows 'az' is a .cmd wrapper that needs
 * cmd.exe, so values given to it are restricted to a charset with no shell metacharacters.
 */
import { execFile } from 'node:child_process'
import { accessSync, constants, statSync } from 'node:fs'
import { delimiter, isAbsolute, join } from 'node:path'
import { git, safeRef } from './git.js'

const win = process.platform === 'win32'
const PR_TIMEOUT_MS = 15_000
/** A found answer is reused this long; "no PR" for a shorter time so a freshly created PR shows up soon. */
export const PR_TTL_MS = 60_000
export const PR_NONE_TTL_MS = 20_000
const PR_CACHE_MAX = 100
const ENV_ALLOW = /^(PATH|SystemRoot|windir|HOME|USERPROFILE|APPDATA|LOCALAPPDATA|TEMP|TMP|LANG|LC_.*|ProgramData|ProgramFiles.*|PATHEXT|ComSpec|XDG_CONFIG_HOME|GH_TOKEN|GITHUB_TOKEN|GH_HOST|GH_CONFIG_DIR|AZURE_CONFIG_DIR|AZURE_DEVOPS_EXT_PAT|HTTPS?_PROXY|NO_PROXY)$/i
const SAFE_NAME = /^[A-Za-z0-9._-]+$/
/** Branch names handed to cmd.exe: no whitespace, quotes, & | ^ % ! < > ( ) ; or similar. */
const SAFE_SHELL_BRANCH = /^[A-Za-z0-9._/-]+$/

const isFile = (p) => { try { return statSync(p).isFile() } catch { return false } }
const isExec = (p) => { try { if (!isFile(p)) return false; if (!win) accessSync(p, constants.X_OK); return true } catch { return false } }

/** Absolute path of a CLI found on PATH (absolute entries only), or undefined. Windows: .exe, else .cmd. */
export function findCli(name, path = process.env.PATH ?? process.env.Path ?? '', isWin = win) {
  const exts = isWin ? ['.exe', '.cmd'] : ['']
  for (const raw of path.split(isWin ? ';' : delimiter)) {
    const dir = raw.trim().replace(/^"|"$/g, '')
    if (!dir || !isAbsolute(dir)) continue
    for (const ext of exts) {
      const full = join(dir, name + ext)
      if (isExec(full)) return full
    }
  }
  return undefined
}

/**
 * Classify a remote URL.
 * @returns {{ kind: 'github', slug: string } | { kind: 'ado', org: string, project: string, repo: string } | undefined}
 */
export function parseRemote(url) {
  if (typeof url !== 'string') return undefined
  const u = url.trim()
  let m = /^(?:https?:\/\/(?:[^@/]+@)?github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/.exec(u)
  if (m) return { kind: 'github', slug: m[1] + '/' + m[2] }
  // https://[user@]dev.azure.com/<org>/<project>/_git/<repo>
  m = /^https?:\/\/(?:[^@/]+@)?dev\.azure\.com\/([^/]+)\/([^/]+)\/_git\/([^/?#]+)\/?$/.exec(u)
  if (m) return ado(m[1], m[2], m[3])
  // https://[user@]<org>.visualstudio.com/[DefaultCollection/]<project>/_git/<repo>
  m = /^https?:\/\/(?:[^@/]+@)?([A-Za-z0-9-]+)\.visualstudio\.com\/(?:DefaultCollection\/)?([^/]+)\/_git\/([^/?#]+)\/?$/.exec(u)
  if (m) return ado(m[1], m[2], m[3])
  // <org>@vs-ssh.visualstudio.com:v3/<org>/<project>/<repo>
  m = /^[^@]+@vs-ssh\.visualstudio\.com:v3\/([^/]+)\/([^/]+)\/([^/]+)\/?$/.exec(u)
  if (m) return ado(m[1], m[2], m[3])
  // git@ssh.dev.azure.com:v3/<org>/<project>/<repo>
  m = /^git@ssh\.dev\.azure\.com:v3\/([^/]+)\/([^/]+)\/([^/]+)\/?$/.exec(u)
  if (m) return ado(m[1], m[2], m[3])
  return undefined
}
function ado(org, project, repo) {
  const dec = (s) => { try { return decodeURIComponent(s) } catch { return undefined } }
  const [o, p, r] = [dec(org), dec(project), dec(repo)]
  // Spaces and other characters are not supported: they would need quoting through cmd.exe.
  if (![o, p, r].every((x) => typeof x === 'string' && SAFE_NAME.test(x))) return undefined
  return { kind: 'ado', org: o, project: p, repo: r }
}

const rank = (s) => (s === 'open' ? 0 : s === 'merged' ? 1 : 2)

/** Prefer an open PR, then the most recent of the others. 'list' is already newest-first (stable sort). */
export function pickPr(list) {
  if (!Array.isArray(list) || list.length === 0) return undefined
  return [...list].sort((a, b) => rank(a.state) - rank(b.state))[0]
}

export function normalizeGithub(json) {
  let rows
  try { rows = JSON.parse(json) } catch { return undefined }
  if (!Array.isArray(rows)) return undefined
  return pickPr(rows.filter((r) => Number.isInteger(r?.number) && typeof r.url === 'string' && /^https:\/\//.test(r.url)).map((r) => ({
    number: r.number, url: r.url, title: String(r.title ?? ''), source: 'github',
    state: r.state === 'OPEN' ? 'open' : r.state === 'MERGED' ? 'merged' : 'closed',
  })))
}

export function normalizeAdo(json, remote) {
  let rows
  try { rows = JSON.parse(json) } catch { return undefined }
  if (!Array.isArray(rows)) return undefined
  const base = 'https://dev.azure.com/' + encodeURIComponent(remote.org) + '/' + encodeURIComponent(remote.project) + '/_git/' + encodeURIComponent(remote.repo) + '/pullrequest'
  return pickPr(rows.filter((r) => Number.isInteger(r?.pullRequestId)).map((r) => ({
    number: r.pullRequestId, url: base + '/' + r.pullRequestId, title: String(r.title ?? ''), source: 'ado',
    state: r.status === 'active' ? 'open' : r.status === 'completed' ? 'merged' : 'closed',
  })))
}

const childEnv = () => {
  const env = {}
  for (const [k, v] of Object.entries(process.env)) if (ENV_ALLOW.test(k) && typeof v === 'string') env[k] = v
  return { ...env, GH_PROMPT_DISABLED: '1', GIT_TERMINAL_PROMPT: '0', NoDefaultCurrentDirectoryInExePath: '1' }
}

/** Run a CLI; resolves stdout, or undefined on any failure. .cmd wrappers go through cmd.exe (args are pre-validated: no spaces or metacharacters; the extra outer quotes are what /s strips, so a path with spaces survives). */
function run(exe, args, cwd) {
  return new Promise((done) => {
    const viaCmd = /\.cmd$/i.test(exe)
    const [file, argv] = viaCmd ? [process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', '""' + exe + '" ' + args.join(' ') + '"']] : [exe, args]
    execFile(file, argv, { cwd, env: childEnv(), timeout: PR_TIMEOUT_MS, maxBuffer: 2 * 1024 * 1024, windowsHide: true, windowsVerbatimArguments: viaCmd, encoding: 'utf8' },
      (error, stdout) => done(error ? undefined : String(stdout)))
  })
}

/**
 * The PR for 'branch' in the repository at 'root'.
 * @returns {Promise<{ ok: true, pr: object | null } | { busy: true }>}
 */
export async function readPr(root, branch, deps = {}) {
  const none = { ok: true, pr: null }
  if (!branch || !safeRef(branch)) return none
  const { gitFn = git, find = findCli, exec = run, fetchFn = globalThis.fetch, env = process.env } = deps
  const r = await gitFn(root, ['remote', 'get-url', 'origin'])
  if (r.busy || r.aborted) return { busy: true }
  if (r.code !== 0) return none
  const remote = parseRemote(String(r.stdout).trim())
  if (!remote) return none
  if (remote.kind === 'github') {
    const gh = find('gh')
    if (!gh) return none
    const out = await exec(gh, ['pr', 'list', '--repo', remote.slug, '--head', branch, '--state', 'all', '--limit', '10', '--json', 'number,url,state,title'], root)
    return { ok: true, pr: (out && normalizeGithub(out)) || null }
  }
  // Same credential the PR poller uses: a PAT in the host environment. No cmd.exe, no az login needed.
  const pat = env.AZURE_DEVOPS_EXT_PAT
  if (pat) {
    const url = 'https://dev.azure.com/' + encodeURIComponent(remote.org) + '/' + encodeURIComponent(remote.project) + '/_apis/git/repositories/' + encodeURIComponent(remote.repo)
      + '/pullrequests?searchCriteria.sourceRefName=' + encodeURIComponent('refs/heads/' + branch) + '&searchCriteria.status=all&$top=10&api-version=7.1'
    try {
      const res = await fetchFn(url, { headers: { Authorization: 'Basic ' + Buffer.from(':' + pat).toString('base64'), Accept: 'application/json' }, signal: AbortSignal.timeout(PR_TIMEOUT_MS) })
      if (res.ok) { const body = await res.json(); return { ok: true, pr: normalizeAdo(JSON.stringify(body?.value ?? []), remote) || null } }
    } catch { /* fall through to az, then to "no PR" */ }
  }
  if (!SAFE_SHELL_BRANCH.test(branch)) return none
  const az = find('az')
  if (!az) return none
  const out = await exec(az, ['repos', 'pr', 'list', '--organization', 'https://dev.azure.com/' + remote.org, '--project', remote.project, '--repository', remote.repo,
    '--source-branch', branch, '--status', 'all', '--top', '10', '--output', 'json'], root)
  return { ok: true, pr: (out && normalizeAdo(out, remote)) || null }
}

/** readPr behind a small cache: concurrent callers share one lookup; answers live PR_TTL_MS (PR_NONE_TTL_MS when empty). */
export function createPrLookup(deps = {}, now = Date.now) {
  const cache = new Map()
  return (root, branch) => {
    const key = root + '\0' + (branch ?? '')
    const hit = cache.get(key)
    if (hit && (hit.at === undefined || now() - hit.at < hit.ttl)) return hit.promise
    const entry = { at: undefined, ttl: PR_NONE_TTL_MS, promise: undefined }
    entry.promise = readPr(root, branch, deps)
    cache.delete(key)
    while (cache.size >= PR_CACHE_MAX) cache.delete(cache.keys().next().value)
    cache.set(key, entry)
    entry.promise.then((v) => {
      if (v?.busy) { if (cache.get(key) === entry) cache.delete(key); return }
      entry.at = now(); entry.ttl = v?.pr ? PR_TTL_MS : PR_NONE_TTL_MS
    }, () => { if (cache.get(key) === entry) cache.delete(key) })
    return entry.promise
  }
}
