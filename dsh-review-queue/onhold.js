/**
 * The on-hold queue: a session parked on purpose (item type 'onhold', its own queue, never counted as waiting). A held session that is on an Azure DevOps ticket
 * is watched: every check reads the ticket (ado-ticket.js fetchTicketState) and compares it with the state noted when the session was held. A new comment, a
 * state change, an assignee change or a description change continues the session by prompting it (queued, like a reply), closes the item as 'continued' and
 * notes the new state. The plugin never puts the text of a comment into the prompt: the session reads the ticket itself. When the session finishes, the
 * ordinary Done card of the task list says so. A ticket that cannot be read, or a prompt that fails, leaves the item held with a code on it (checkError,
 * continueError) and is tried again at the next check. Held sessions are skipped by the paused-session scan and the idle check (index.js).
 */
import { randomUUID } from 'node:crypto'
import { DEFAULT_ADO_BASE, diffTicket, findTicket } from './ado-ticket.js'
import { PROMPT_TIMEOUT_MS } from './follow-up-shared.js'

/** A session title "Fix: <ticket title> - <number>" (ticket-session.js) names its ticket; a hold prefix is ignored. */
const TITLE_TICKET_RE = /^(?:\u23f8\ufe0f?\s*)?Fix: .+ - (\d{3,9})(?:\s+-\s+.*)?$/u
const MAX_REASON = 300

const clean = (text, max) => String(text ?? '').replace(/\s+/g, ' ').trim().slice(0, max)
const ticketOf = (text, title) => findTicket(text ?? '') ?? (TITLE_TICKET_RE.exec(String(title ?? ''))?.[1] ? { id: TITLE_TICKET_RE.exec(String(title))[1], base: DEFAULT_ADO_BASE } : undefined)
const ticketUrl = (ref) => ref.base + '/_workitems/edit/' + ref.id

/** The prompt that continues a session whose ticket changed. No ticket text in it: only the fact and the kinds of change. */
export function continuePrompt({ ticket, changes, reason }) {
  return [
    'This session was put on hold' + (reason ? ' (' + reason + ')' : '') + '. Its Azure DevOps ticket ' + ticket.id + ' (' + ticketUrl(ticket) + ') has changed: ' + changes.join('; ') + '.',
    'Read the ticket and its comments, decide whether you can continue the work now, and continue if so. If you cannot, say what you are still waiting for and put the session on hold again: print a line "ONHOLD <what you wait for>" on its own (for example run_code with console.log(\'ONHOLD waiting for the customer\')).',
  ].join('\n')
}

const plainContinue = (reason) => 'This session was on hold' + (reason ? ' (' + reason + ')' : '') + '. The hold has been lifted: continue the work from where it stopped.'

/** @param {{ store: any, controllerOf: () => any, ticketStateOf: (ref: { id: string, base: string }) => Promise<{ ok: boolean, state?: any, error?: string }>, now?: () => number, log?: (line: string) => void }} deps */
export function createOnHold({ store, controllerOf, ticketStateOf, now = Date.now, log = () => {} }) {
  let running // the check in flight: a second caller shares it
  const openHolds = () => store.list({ status: 'open' }).filter((i) => i.type === 'onhold')
  const holdOf = (id) => { const item = store.get(id); return item && item.status === 'open' && item.type === 'onhold' ? item : undefined }
  const patch = (item, fields) => store.update(item.id, { payload: { ...item.payload, ...fields } })

  /** Sends the prompt to the held session: undefined when sent, else { code, gone }. */
  async function prompt(item, text) {
    const controller = controllerOf()
    if (!controller?.prompt) return { code: 'no-controller', gone: false }
    try {
      await controller.prompt({ requestId: 'onhold-' + randomUUID(), sessionId: item.sessionId, mode: 'queue', content: [{ type: 'text', text }] }, AbortSignal.timeout(PROMPT_TIMEOUT_MS))
      return undefined
    } catch (error) {
      const code = String(error?.code ?? error?.name ?? 'error').slice(0, 40)
      return { code, gone: error?.code === 'session/not-found' }
    }
  }

  async function checkOne(item) {
    const ticket = item.payload.ticket
    const read = await ticketStateOf(ticket)
    if (!read?.ok) { patch(item, { checkError: String(read?.error ?? 'unreachable'), lastCheckedAt: now() }); return false }
    const state = read.state
    const baseline = item.payload.baseline
    if (!baseline) { patch(item, { baseline: state, checkError: null, lastCheckedAt: now() }); return false }
    const changes = diffTicket(baseline, state)
    if (!changes.length) { patch(item, { baseline: state, checkError: null, lastCheckedAt: now() }); return false }
    const refused = await prompt(item, continuePrompt({ ticket, changes, reason: item.payload.reason }))
    if (refused?.gone) { store.resolve(item.id, { kind: 'session-ended' }); log('onhold: session of item ' + item.id + ' is gone'); return false }
    if (refused) { patch(item, { checkError: null, lastCheckedAt: now(), continueError: refused.code }); log('onhold: continuing ' + item.id + ' failed: ' + refused.code); return false }
    store.resolve(item.id, { kind: 'continued', by: 'ticket', changes })
    log('onhold: session ' + item.sessionId + ' continued, ticket ' + ticket.id + ': ' + changes.join('; '))
    return true
  }

  return {
    /** Puts a session on hold: { ok: true, id, updated? } | { ok: false, error }. text (optional) is what was typed with the command: a ticket in it wins. */
    async hold({ sessionId, sessionTitle, workspace, reason, text } = {}) {
      if (typeof sessionId !== 'string' || !sessionId) return { ok: false, error: 'no-session' }
      const why = clean(reason, MAX_REASON)
      const existing = openHolds().find((i) => i.sessionId === sessionId)
      if (existing) { patch(existing, { reason: why }); return { ok: true, id: existing.id, updated: true } }
      const ticket = ticketOf(text, sessionTitle) ?? null
      let baseline = null
      let checkError = null
      if (ticket) {
        const read = await ticketStateOf(ticket)
        if (read?.ok) baseline = read.state
        else checkError = String(read?.error ?? 'unreachable')
      }
      const item = store.add({ type: 'onhold', sessionId, sessionTitle: clean(sessionTitle, 200), ...(workspace ? { workspace: String(workspace) } : {}), payload: { reason: why, heldAt: now(), ticket, baseline, lastCheckedAt: null, checkError } })
      return { ok: true, id: item.id }
    },
    /** Takes the session off hold without prompting it. */
    release(id) {
      if (!holdOf(id)) return { ok: false, error: 'not-open' }
      return store.resolve(id, { kind: 'released', by: 'card' }) ? { ok: true } : { ok: false, error: 'not-open' }
    },
    /** Takes the session off hold and prompts it to continue (the card's Continue button). */
    async continueNow(id) {
      const item = holdOf(id)
      if (!item) return { ok: false, error: 'not-open' }
      const refused = await prompt(item, plainContinue(item.payload.reason))
      if (refused?.gone) { store.resolve(id, { kind: 'session-ended' }); return { ok: false, error: 'no-session' } }
      if (refused) return { ok: false, error: refused.code === 'no-controller' ? 'no-controller' : 'post-failed' }
      store.resolve(id, { kind: 'continued', by: 'card' })
      return { ok: true }
    },
    /** One round of ticket checks over the held sessions that have a ticket: { ok, checked, continued }. Callers at the same time share one run. */
    check() {
      if (running) return running
      running = (async () => {
        let checked = 0
        let continued = 0
        for (const item of openHolds()) {
          if (!item.payload?.ticket) continue
          checked++
          try { if (await checkOne(item)) continued++ } catch (error) { log('onhold: check of ' + item.id + ' failed: ' + String(error?.name ?? 'error')) }
        }
        return { ok: true, checked, continued }
      })().finally(() => { running = undefined })
      return running
    },
    /** The ids of the sessions that are on hold now. */
    heldSessionIds: () => new Set(openHolds().map((i) => i.sessionId)),
  }
}
