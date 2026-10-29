/**
 * A session that works on an Azure DevOps ticket must say so in its title. When the user types a prompt that mentions a ticket (ado-ticket.js
 * findTicket: a work item URL, AB#<n>, "ADO ticket <n>") into a session, the session is renamed "Fix: <title of the ticket> - <number>", whatever it was
 * called before. The first ticket wins: a session that already carries a ticket title is left alone (a later mention of another ticket does not
 * rename it again), and so is a PR session ("PR <n>...", managed by dsh-hooks-tts, whose title already carries the ticket for ticket work).
 * Only a message the user typed counts (not a plugin's own prompt, a reminder or a subagent's brief). The lookup of the title runs in the
 * background: the step is never delayed. One attempt per session and ticket, so a failing rename is not retried at every step.
 */
import { findTicket, ticketTitleFor } from './ado-ticket.js'
import { isHumanMessage } from './signals.js'

const HOLD_PREFIX_RE = /^\u23f8\ufe0f?\s*/
const PR_TITLE_RE = /^(?:Continue )?PR \d+/
/** "<Fix|Task|Feat>: <title> - <number>" with anything after the number ("- 2", "- after PR 5"); also behind a "PR <n> - " prefix. */
const TICKET_TITLE_RE = /^(?:Fix|Task|Feat): .+ - \d{3,9}(?:\s+-\s+.*)?$/

const textOf = (content) => (typeof content === 'string' ? content : Array.isArray(content) ? content.map((p) => (typeof p === 'string' ? p : p?.type === 'text' && typeof p.text === 'string' ? p.text : '')).join('') : '')
const withoutReminders = (text) => text.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '')

/** True for a title that must not be replaced: a PR title, or one that already refers to a ticket. */
export const keepsTitle = (title) => { const t = String(title ?? '').replace(HOLD_PREFIX_RE, '').trim(); return PR_TITLE_RE.test(t) || TICKET_TITLE_RE.test(t) }

export function installTicketSessions(ctx, { controllerOf, ticketTitleOf = (text) => ticketTitleFor(text, { log }), log = () => {}, enabled = () => true } = {}) {
  const children = new Set() // subagent ids: their prompts come from a model, not from the user
  const attempted = new Map() // agent id -> the ticket ids already tried (bounded)
  const titleOf = (agent) => { try { return ctx.get?.('sessionTitle')?.get(agent?.session)?.title } catch { return undefined } }

  async function rename(agent, text, ref) {
    try {
      const title = await ticketTitleOf(text)
      if (!title) return
      const current = titleOf(agent)
      if (keepsTitle(current)) return // renamed (or made a PR session) while the lookup ran
      const sc = controllerOf?.()
      if (typeof sc?.rename !== 'function') throw new Error('the session controller is not available')
      const held = HOLD_PREFIX_RE.exec(String(current ?? ''))?.[0] ?? '' // a session on hold stays on hold
      await sc.rename({ sessionId: agent.id, title: held + title })
      log('ticket-session: session ' + agent.id + ' renamed to "' + held + title + '" (ticket ' + ref.id + ')')
    } catch (error) { log('ticket-session: rename of ' + agent?.id + ' failed: ' + (error?.message ?? error)) }
  }

  ctx.on('subagent/start', (info) => { if (info?.id) children.add(info.id) })
  ctx.on('subagent/end', (info) => { children.delete(info?.id) })
  ctx.on('agent/pre-step', async ({ agent, messages } = {}, next) => {
    try {
      if (enabled() && agent?.id && !children.has(agent.id) && messages?.length) {
        const text = withoutReminders(messages.filter(isHumanMessage).map((m) => textOf(m?.content)).join('\n')).trim()
        const ref = text ? findTicket(text) : undefined
        if (ref && !keepsTitle(titleOf(agent))) {
          const tried = attempted.get(agent.id) ?? new Set()
          if (!tried.has(ref.id)) {
            tried.add(ref.id)
            attempted.delete(agent.id)
            attempted.set(agent.id, tried)
            if (attempted.size > 500) attempted.delete(attempted.keys().next().value)
            void rename(agent, text, ref)
          }
        }
      }
    } catch (error) { log('ticket-session: ' + (error?.message ?? error)) }
    return next()
  })
  ctx.on('agent/disposed', (payload) => { attempted.delete(payload?.agent?.id ?? payload?.id) })
}
