/**
 * Two ways for a session to ask the user to archive it, which puts an "archive" card (Archive session / Keep session, desktop and phone) in the list:
 *   - the user types "/archive-offer <reason>" in it (the message must start with it; only the last message typed counts, each once);
 *   - the session prints a marker line "ARCHIVE-OFFER <reason>" on its own line, from a shell or run_code call whose own command or code wrote that marker
 *     (text read from a file or a web page and printed back is never taken as the session's own decision).
 * Nothing is archived by the offer: the user presses the button. Subagents never offer, and a plugin's own prompt (signals.js isHumanMessage) is not the user typing.
 * The setting archiveOfferCommands: false turns both off.
 */
import { isHumanMessage } from './signals.js'

const COMMAND = /^\/archive-offer(?:\s+([\s\S]*))?$/i
const MARKER = /^ARCHIVE-OFFER(?:[ \t]+(.*?))?[ \t\r]*$/gm
const MARKER_TOOLS = /^(bash|pwsh|powershell|shell|run_code)$/i
const textOf = (content) => (typeof content === 'string' ? content : Array.isArray(content) ? content.map((p) => (typeof p === 'string' ? p : p?.type === 'text' && typeof p.text === 'string' ? p.text : '')).join('') : '')
const withoutReminders = (text) => text.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '')
const oneLine = (s) => String(s ?? '').replace(/\s+/g, ' ').trim()

/** { reason } for a message that starts with /archive-offer (the rest, on one line); undefined otherwise. */
export function parseArchiveCommand(text) {
  const m = COMMAND.exec(String(text ?? '').trim())
  return m ? { reason: oneLine(m[1]) } : undefined
}

/** { reason } of the last ARCHIVE-OFFER line standing alone in a tool output; undefined when there is none. */
export function parseArchiveMarker(output) {
  let last
  for (const m of String(output ?? '').matchAll(MARKER)) last = { reason: oneLine(m[1]) }
  return last
}

export function installArchiveOffer(ctx, { queueOf, log = () => {}, enabled = () => true } = {}) {
  const children = new Set() // subagent ids: a model, not the user
  const handled = new Map() // agent id -> "<count of human messages>:<text>" of the last command handled (bounded)
  const titleOf = (agent) => { try { return ctx.get?.('sessionTitle')?.get(agent?.session)?.title } catch { return undefined } }

  function offer(agent, reason) {
    try {
      const queue = queueOf?.()
      if (typeof queue?.offerArchive !== 'function') return
      const res = queue.offerArchive({ sessionId: agent.id, sessionTitle: titleOf(agent), workspace: agent.session?.header?.cwd, reason })
      if (res?.ok) log('archive-offer: session ' + agent.id + (res.updated ? ' already has an archive card (reason updated)' : ' offered for archiving'))
      else log('archive-offer: offer of ' + agent.id + ' failed: ' + (res?.error ?? 'error'))
    } catch (error) { log('archive-offer: ' + (error?.message ?? error)) }
  }

  ctx.on('subagent/start', (info) => { if (info?.id) children.add(info.id) })
  ctx.on('subagent/end', (info) => { children.delete(info?.id) })
  ctx.on('agent/pre-step', async ({ agent, messages } = {}, next) => {
    try {
      if (enabled() && agent?.id && !children.has(agent.id) && messages?.length) {
        const human = messages.filter(isHumanMessage)
        const last = human[human.length - 1]
        const text = last ? withoutReminders(textOf(last.content)).trim() : ''
        const cmd = text ? parseArchiveCommand(text) : undefined
        if (cmd) {
          const key = human.length + ':' + text
          if (handled.get(agent.id) !== key) {
            handled.delete(agent.id)
            handled.set(agent.id, key)
            if (handled.size > 500) handled.delete(handled.keys().next().value)
            offer(agent, cmd.reason)
          }
        }
      }
    } catch (error) { log('archive-offer: ' + (error?.message ?? error)) }
    return next()
  })
  ctx.on('tools/post-execute', async (exec, result, next) => {
    try {
      const agent = exec?.agent
      if (enabled() && agent?.id && !children.has(agent.id) && MARKER_TOOLS.test(exec?.name ?? '') && !result?.isError) {
        const wrote = JSON.stringify(exec.arguments ?? {}).includes('ARCHIVE-OFFER') // the call itself names the marker: the session chose to print it
        const marker = wrote ? parseArchiveMarker(textOf(result?.content)) : undefined
        if (marker) offer(agent, marker.reason)
      }
    } catch (error) { log('archive-offer: ' + (error?.message ?? error)) }
    return next()
  })
  ctx.on('agent/disposed', (payload) => { handled.delete(payload?.agent?.id ?? payload?.id) })
}
