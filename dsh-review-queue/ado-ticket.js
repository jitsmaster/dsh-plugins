/**
 * Azure DevOps ticket in a todo: when the task text mentions a work item, the session it starts is titled
 * "Fix: <title of the ticket> - <number of the ticket>" instead of the first line of the text. (dsh-hooks-tts adds "PR <n> - " in
 * front of such a title when the PR for this work is created.)
 *
 * A mention is, first one wins:
 *   - a work item URL: https://dev.azure.com/<org>/<project>/_workitems/edit/<n> or https://<org>.visualstudio.com/<project>/_workitems/edit/<n>
 *     (also a board URL with ?workitem=<n>); the organisation and project come from the URL
 *   - AB#<n>
 *   - "ADO ticket 123", "work item #123", "ticket 123" ... (a number of 3 or more digits right after the word; the default organisation and project)
 *
 * The title is read with the Azure DevOps REST API and the PAT of the environment (AZURE_DEVOPS_EXT_PAT, the same one the az boards
 * commands use), sent as Basic auth and only to dev.azure.com and *.visualstudio.com over https: the URL comes from the user's text.
 * When the title cannot be read (no PAT, offline, no such ticket) the title is made from the text itself: the number is always right.
 * Never throws; the PAT is never logged.
 */
import { cleanText } from './speech.js'

/** Where a bare number ("AB#123", "ticket 123") is looked up: the CTnP project. */
export const DEFAULT_ADO_BASE = 'https://dev.azure.com/ingeniuxdev/Ingeniux'
export const FETCH_TIMEOUT_MS = 10_000
const MAX_TICKET_TITLE = 120
const API_VERSION = '7.0'
const URL_RE = /https?:\/\/[^\s<>"'`)\]]+/gi
const AB_RE = /(?<![\p{L}\p{N}_])AB#(\d+)/iu
const WORD_RE = /(?<![\p{L}\p{N}_])(?:(?:ADO|Azure DevOps|DevOps)\s+)?(?:ticket|work[ -]?item|PBI|user story|bug|task)s?\s*(?:number|no\.?|id)?\s*[:#]?\s*#?(\d{3,9})(?!\d)/iu

const trustedHost = (host) => host === 'dev.azure.com' || host.endsWith('.visualstudio.com')

/** { id, base } for a work item URL (base = origin + the path before _workitems), else undefined. */
function refOfUrl(raw) {
  let url
  try { url = new URL(raw.replace(/[.,;:!?]+$/, '')) } catch { return undefined }
  const at = url.pathname.search(/\/_(?:workitems|boards|backlogs)\b/i)
  if (at < 0) return undefined
  const edit = /\/_workitems\/edit\/(\d+)/i.exec(url.pathname)?.[1]
  const id = edit ?? url.searchParams.get('workitem') ?? undefined
  if (!id || !/^\d{1,9}$/.test(id)) return undefined
  return { id, base: url.origin + url.pathname.slice(0, at).replace(/\/+$/, '') }
}

/** The first ticket the text mentions: { id: '12345', base: 'https://host/org/project' }, or undefined. */
export function findTicket(text, { defaultBase = DEFAULT_ADO_BASE } = {}) {
  const body = String(text ?? '')
  for (const raw of body.match(URL_RE) ?? []) { const ref = refOfUrl(raw); if (ref) return ref }
  const ab = AB_RE.exec(body)?.[1]
  if (ab) return { id: String(Number(ab)), base: defaultBase }
  const word = WORD_RE.exec(body)?.[1]
  if (word) return { id: String(Number(word)), base: defaultBase }
  return undefined
}

/** The ticket's title from Azure DevOps; undefined when it cannot be read. Never throws. */
export async function fetchTicketTitle(ref, { env = process.env, fetchImpl = globalThis.fetch, timeoutMs = FETCH_TIMEOUT_MS, log = () => {} } = {}) {
  const pat = env?.AZURE_DEVOPS_EXT_PAT
  if (!pat) { log('ado-ticket: AZURE_DEVOPS_EXT_PAT is not set; the title of ticket ' + ref.id + ' is not looked up'); return undefined }
  let url
  try { url = new URL(ref.base + '/_apis/wit/workitems/' + ref.id + '?fields=System.Title&api-version=' + API_VERSION) } catch { return undefined }
  if (url.protocol !== 'https:' || !trustedHost(url.hostname.toLowerCase())) { log('ado-ticket: not asking ' + url.hostname + ' (the PAT only goes to dev.azure.com and visualstudio.com)'); return undefined }
  const scrub = (value) => String(value?.message ?? value).split(pat).join('***').split(Buffer.from(':' + pat).toString('base64')).join('***')
  try {
    const res = await fetchImpl(url, { headers: { Authorization: 'Basic ' + Buffer.from(':' + pat).toString('base64'), Accept: 'application/json' }, redirect: 'error', signal: AbortSignal.timeout(timeoutMs) })
    if (!res.ok) { log('ado-ticket: ticket ' + ref.id + ' answered HTTP ' + res.status); return undefined }
    const title = (await res.json())?.fields?.['System.Title']
    const clean = typeof title === 'string' ? cleanText(title, { maxChars: MAX_TICKET_TITLE }) : ''
    return clean || undefined
  } catch (error) { log('ado-ticket: ticket ' + ref.id + ' lookup failed: ' + scrub(error)); return undefined }
}

/** The task text without its URLs and ticket words, first line only: the fallback wording when the ticket title is unknown. */
function fallbackTitle(text) {
  const line = String(text ?? '').split(/\r?\n/).map((l) => cleanText(l.replace(URL_RE, ' ').replace(AB_RE, ' '))).find(Boolean) ?? ''
  return line.length > MAX_TICKET_TITLE ? cleanText(line, { maxChars: MAX_TICKET_TITLE }) : line
}

/** "Fix: <title> - <number>". */
export const ticketSessionTitle = (title, id) => 'Fix: ' + title + ' - ' + id

/**
 * The session title for a text that mentions an ADO ticket ("Fix: <ticket title> - <number>"), or undefined when it mentions none.
 * @param {string} text
 * @param {{ env?: object, fetchImpl?: typeof fetch, timeoutMs?: number, defaultBase?: string, log?: (line: string) => void }} [deps]
 */
export async function ticketTitleFor(text, deps = {}) {
  const ref = findTicket(text, deps)
  if (!ref) return undefined
  const title = (await fetchTicketTitle(ref, deps)) ?? (fallbackTitle(text) || 'ticket ' + ref.id)
  return ticketSessionTitle(title, ref.id)
}
