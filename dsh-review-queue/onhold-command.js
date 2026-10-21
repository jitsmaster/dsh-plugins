/**
 * Two ways to put the session you are in on hold (onhold.js), besides the Hold button of a card:
 *   - the user types "/onhold <reason>" (the message must start with it; only the last message the user typed counts, and each message once);
 *   - the session prints a marker line "ONHOLD <reason>" on its own line, from a shell or run_code call whose own command or code wrote that marker
 *     (so text read from a file, a ticket or a web page and printed back is never taken as the session's own decision).
 * Subagents never hold the session, and a plugin's own prompt (signals.js isHumanMessage) is not the user typing. The ticket of the session is found
 * by onhold.js from the typed text or the title "Fix: <title> - <number>". The setting onHoldCommands: false turns both off.
 */
import { isHumanMessage } from './signals.js'

const COMMAND = /^\/onhold(?:\s+([\s\S]*))?$/i
const MARKER = /^ONHOLD(?:[ \t]+(.*?))?[ \t\r]*$/gm
const MARKER_TOOLS = /^(bash|pwsh|powershell|shell|run_code)$/i
const textOf = (content) => (typeof content === 'string' ? content : Array.isArray(content) ? content.map((p) => (typeof p === 'string' ? p : p?.type === 'text' && typeof p.text === 'string' ? p.text : '')).join('') : '')
const withoutReminders = (text) => text.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '')
const oneLine = (s) => String(s ?? '').replace(/\s+/g, ' ').trim()

/** { reason } for a message that starts with /onhold (the rest, on one line); undefined otherwise. */
export function parseHoldCommand(text) {
  const m = COMMAND.exec(String(text ?? '').trim())
  return m ? { reason: oneLine(m[1]) } : undefined
}

/** { reason } of the last ONHOLD line standing alone in a tool output; undefined when there is none. */
export function parseHoldMarker(output) {
  let last
  for (const m of String(output ?? '').matchAll(MARKER)) last = { reason: oneLine(m[1]) }
  return last
}

export function installOnHoldCommand(ctx, { onHoldOf, log = () => {}, enabled = () => true } = {}) {
  const children = new Set() // subagent ids: a model, not the user
  const handled = new Map() // agent id -> "<count of human messages>:<text>" of the last command handled (bounded)
  const titleOf = (agent) => { try { return ctx.get?.('sessionTitle')?.get(agent?.session)?.title } catch { return undefined } }

  async function hold(agent, extra) {
    try {
      const onHold = onHoldOf?.()
      if (!onHold) return
      const res = await onHold.hold({ sessionId: agent.id, sessionTitle: titleOf(agent), workspace: agent.session?.header?.cwd, ...extra })
      if (res?.ok) log('onhold-command: session ' + agent.id + ' put on hold' + (res.updated ? ' (already held, reason updated)' : ''))
      else log('onhold-command: hold of ' + agent.id + ' failed: ' + (res?.error ?? 'error'))
    } catch (error) { log('onhold-command: ' + (error?.message ?? error)) }
  }

  ctx.on('subagent/start', (info) => { if (info?.id) children.add(info.id) })
  ctx.on('subagent/end', (info) => { children.delete(info?.id) })
  ctx.on('agent/pre-step', async ({ agent, messages } = {}, next) => {
    try {
      if (enabled() && agent?.id && !children.has(agent.id) && messages?.length) {
        const human = messages.filter(isHumanMessage)
        const last = human[human.length - 1]
        const text = last ? withoutReminders(textOf(last.content)).trim() : ''
        const cmd = text ? parseHoldCommand(text) : undefined
        if (cmd) {
          const key = human.length + ':' + text
          if (handled.get(agent.id) !== key) {
            handled.delete(agent.id)
            handled.set(agent.id, key)
            if (handled.size > 500) handled.delete(handled.keys().next().value)
            void hold(agent, { reason: cmd.reason, text })
          }
        }
      }
    } catch (error) { log('onhold-command: ' + (error?.message ?? error)) }
    return next()
  })
  ctx.on('tools/post-execute', async (exec, result, next) => {
    try {
      const agent = exec?.agent
      if (enabled() && agent?.id && !children.has(agent.id) && MARKER_TOOLS.test(exec?.name ?? '') && !result?.isError) {
        const wrote = JSON.stringify(exec.arguments ?? {}).includes('ONHOLD') // the call itself names the marker: the session chose to print it
        const marker = wrote ? parseHoldMarker(textOf(result?.content)) : undefined
        if (marker) void hold(agent, { reason: marker.reason })
      }
    } catch (error) { log('onhold-command: ' + (error?.message ?? error)) }
    return next()
  })
  ctx.on('agent/disposed', (payload) => { handled.delete(payload?.agent?.id ?? payload?.id) })
}
