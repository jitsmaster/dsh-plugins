/**
 * Azure DevOps work item creation for "Find places" (tip-survey.js), the first write from this plugin to Azure DevOps (ado-ticket.js only reads):
 *  - adoBaseOf(workspacePath): the ADO base (https://host/org/project) of a workspace, taken from the `origin` url in <path>/.git/config.
 *    Only that one file is read. A worktree has a .git FILE (no .git/config), which is not followed: such a workspace is "not linked" (undefined).
 *  - createTask(base, { title, description }): one Task through the REST API, unassigned, with the project's default area and iteration.
 *
 * The PAT (AZURE_DEVOPS_EXT_PAT) goes as Basic auth only to dev.azure.com and *.visualstudio.com over https, the same guard as ado-ticket.js; redirects are
 * refused (the PAT must not follow one). The base always comes from the workspace's own git config, never from a model reply. The title and description are
 * plain text (no < > & # and no control characters) and capped. Nothing here throws; the PAT, and its base64 form, are in no log line, error code or result.
 */
import { constants } from 'node:fs'
import { lstat, open } from 'node:fs/promises'
import { FETCH_TIMEOUT_MS, trustedHost } from './ado-ticket.js'

const API_VERSION = '7.0'
export const MAX_TASK_TITLE = 120
export const MAX_TASK_DESCRIPTION = 500
const MAX_CONFIG_CHARS = 200_000
const MAX_LINE_CHARS = 2000 // a config line longer than this is skipped before any pattern sees it

/** An org or project segment of an ADO base: percent-decoded, word characters, dot, dash and space only, never '.' or '..'; returned percent-encoded, else undefined. */
function cleanSegment(raw) {
  let text
  try { text = decodeURIComponent(String(raw)) } catch { return undefined }
  if (text === '.' || text === '..' || !/^[\w.\- ]+$/.test(text)) return undefined
  return encodeURIComponent(text)
}

/**
 * The text of a git config file, bounded: a symbolic link (or junction) is refused by an lstat first (O_NOFOLLOW is undefined on win32), then the file is opened
 * (with O_NOFOLLOW where the platform has it), the open handle must be a regular file of at most MAX_CONFIG_CHARS bytes and is read through a bounded buffer;
 * else undefined. The handle is always closed.
 */
async function readConfigBounded(path) {
  if ((await lstat(path)).isSymbolicLink()) return undefined
  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
  try {
    const info = await handle.stat()
    if (!info.isFile() || info.size > MAX_CONFIG_CHARS) return undefined
    const buffer = Buffer.alloc(MAX_CONFIG_CHARS + 1)
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0)
    return bytesRead > MAX_CONFIG_CHARS ? undefined : buffer.toString('utf8', 0, bytesRead)
  } finally { await handle.close() }
}

/** The url of the `origin` remote in the text of a git config, or undefined. */
function originUrl(config) {
  let inOrigin = false
  for (const line of String(config).split(/\r?\n/)) {
    if (line.length > MAX_LINE_CHARS) continue
    const section = /^\s*\[([^\]]*)\]/.exec(line)
    if (section) { inOrigin = /^remote\s+"origin"$/i.test(section[1].trim()); continue }
    if (!inOrigin) continue
    const url = /^\s*url\s*=\s*(.*)$/i.exec(line)
    if (url && url[1].trim()) return url[1].trim()
  }
  return undefined
}

/** The ADO base for an origin url: https (dev.azure.com, *.visualstudio.com, with or without a user part) or ssh (ssh.dev.azure.com:v3/org/project/repo); else undefined. */
function baseOfUrl(raw) {
  const ssh = /^(?:ssh:\/\/)?[\w.-]+@(?:ssh\.dev\.azure\.com|vs-ssh\.visualstudio\.com)[:/]v3\/([^/]+)\/([^/]+)\/[^/]+\/?$/i.exec(raw)
  if (ssh) {
    const [org, project] = [cleanSegment(ssh[1]), cleanSegment(ssh[2])]
    return org && project ? 'https://dev.azure.com/' + org + '/' + project : undefined
  }
  let url
  try { url = new URL(raw) } catch { return undefined }
  const host = url.hostname.toLowerCase()
  if (url.protocol !== 'https:' || url.port !== '' || !trustedHost(host)) return undefined
  let parts = url.pathname.split('/').filter(Boolean)
  if (host !== 'dev.azure.com' && /^defaultcollection$/i.test(parts[0] ?? '')) parts = parts.slice(1)
  const git = parts.indexOf('_git')
  if (git < 0) return undefined
  const before = parts.slice(0, git)
  const repo = parts[git + 1]
  let path
  if (host === 'dev.azure.com') path = before.length >= 2 ? before.slice(0, 2) : before.length === 1 && repo ? [before[0], repo] : undefined // org/_git/repo: the project is named like the repo
  else path = before.length >= 1 ? before.slice(0, 1) : repo ? [repo] : undefined
  const clean = path?.map(cleanSegment)
  return clean && clean.every(Boolean) ? url.origin + '/' + clean.join('/') : undefined
}

/**
 * The ADO base ('https://host/org/project') of a workspace, from `origin` in <workspacePath>/.git/config; undefined when it has none, it is not Azure DevOps,
 * the file cannot be read (also a worktree, whose .git is a file) or is oversized. Never throws.
 * @param {string} workspacePath
 * @param {{ readFile?: (path: string) => Promise<string | Buffer> }} [io]
 */
export async function adoBaseOf(workspacePath, { readFile: read = readConfigBounded } = {}) {
  try {
    if (typeof workspacePath !== 'string' || !workspacePath.trim()) return undefined
    let end = workspacePath.length
    while (end > 0 && (workspacePath[end - 1] === '/' || workspacePath[end - 1] === '\\')) end--
    const config = await read(workspacePath.slice(0, end) + '/.git/config')
    if (config === undefined || config === null) return undefined
    const text = String(config)
    if (text.length > MAX_CONFIG_CHARS) return undefined
    const url = originUrl(text)
    return url ? baseOfUrl(url) : undefined
  } catch { return undefined }
}

/** Plain text for a work item field: no < > & (so no markup), no # (so no AB#<n> auto-link), no control characters, one line, at most max characters. */
export const plainField = (text, max) => String(text ?? '').replace(/[\u0000-\u001f\u007f-\u009f<>&#]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max).trim()

/**
 * One Task in the project of base: { ok: true, id, url } | { ok: false, error } with a short code: no-pat, untrusted-host, bad-task, http-<status> (http-error without a usable status), unreachable, bad-answer.
 * @param {string} base https://host/org/project
 * @param {{ title: string, description?: string }} task
 * @param {{ env?: object, fetchImpl?: typeof fetch, timeoutMs?: number, log?: (line: string) => void }} [deps]
 */
export async function createTask(base, task, { env = process.env, fetchImpl = globalThis.fetch, timeoutMs = FETCH_TIMEOUT_MS, log = () => {} } = {}) {
  const pat = typeof env?.AZURE_DEVOPS_EXT_PAT === 'string' ? env.AZURE_DEVOPS_EXT_PAT : ''
  const b64 = pat ? Buffer.from(':' + pat).toString('base64') : ''
  const say = (line) => { try { log(pat ? line.split(pat).join('***').split(b64).join('***') : line) } catch { /* a log is a bonus */ } }
  try {
    if (!pat) return { ok: false, error: 'no-pat' }
    let root
    try {
      const url = new URL(String(base))
      if (url.protocol !== 'https:' || url.port !== '' || !trustedHost(url.hostname.toLowerCase()) || url.username || url.password || url.search || url.hash) throw new Error('untrusted')
      root = url.origin + url.pathname.replace(/\/+$/, '')
    } catch { say('ado-create: not sending anything to that base (the PAT only goes to dev.azure.com and visualstudio.com)'); return { ok: false, error: 'untrusted-host' } }
    const title = typeof task?.title === 'string' ? plainField(task.title, MAX_TASK_TITLE) : ''
    if (!title) return { ok: false, error: 'bad-task' }
    const description = typeof task?.description === 'string' ? plainField(task.description, MAX_TASK_DESCRIPTION) : ''
    const ops = [{ op: 'add', path: '/fields/System.Title', value: title }, ...(description ? [{ op: 'add', path: '/fields/System.Description', value: description }] : [])]
    const auth = 'Basic ' + b64
    let res
    try {
      res = await fetchImpl(root + '/_apis/wit/workitems/$Task?api-version=' + API_VERSION, {
        method: 'POST', headers: { Authorization: auth, 'Content-Type': 'application/json-patch+json', Accept: 'application/json' }, body: JSON.stringify(ops), redirect: 'error', signal: AbortSignal.timeout(timeoutMs),
      })
    } catch (error) { say('ado-create: the request failed: ' + String(error?.name ?? 'error')); return { ok: false, error: 'unreachable' } }
    if (!res?.ok) { say('ado-create: Azure DevOps answered HTTP ' + res?.status); return { ok: false, error: Number.isInteger(res?.status) && res.status >= 100 && res.status <= 599 ? 'http-' + res.status : 'http-error' } }
    let id
    try { id = (await res.json())?.id } catch { id = undefined }
    if (!Number.isSafeInteger(id) || id <= 0) return { ok: false, error: 'bad-answer' }
    return { ok: true, id, url: root + '/_workitems/edit/' + id }
  } catch { return { ok: false, error: 'unreachable' } }
}
