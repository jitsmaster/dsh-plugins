/**
 * Held ideas (the hold-until skill): a session that parked an idea carries a pause emoji in front of its title,
 * and loses it once the idea is started or dropped. The skill prints a marker on its own line of shell output:
 *   HOLD-ON   the session now holds at least one idea  -> prefix the title
 *   HOLD-OFF  the session holds none any more          -> remove the prefix
 * Every other plugin reads titles through stripHold, so a prefixed "PR <n>" or numbered title still behaves.
 */
import { appendFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

export const HOLD_PREFIX = '\u23f8\ufe0f '
const LEADING_HOLD = /^(?:\u23f8\ufe0f?\s*)+/u
// run_code programs print the marker as program output.
const MARKER_TOOLS = /^(bash|pwsh|powershell|shell|run_code)$/i
const MARKER = /^HOLD-(ON|OFF)[ \t\r]*$/gm

const textOf = (content) => (typeof content === 'string' ? content : (content ?? []).filter((b) => b?.type === 'text').map((b) => b.text).join(''))

/** The title without the hold emoji (undefined stays undefined). */
export function stripHold(title) {
  return typeof title === 'string' ? title.replace(LEADING_HOLD, '') : title
}

/** Title with the hold emoji added or removed; undefined when there is no title to decorate. */
export function withHold(title, held) {
  const base = stripHold(title)
  if (typeof base !== 'string' || !base.trim()) return undefined
  return held ? HOLD_PREFIX + base : base
}

/** 'on' | 'off' from the last HOLD-ON / HOLD-OFF line standing alone in the output; undefined when none. */
export function parseHoldMarker(output) {
  let last
  for (const m of String(output ?? '').matchAll(MARKER)) last = m[1].toLowerCase()
  return last
}

export function installHoldTitles(ctx, { skip = () => false, stateDir } = {}) {
  const trace = (line) => {
    if (!stateDir) return
    try { appendFileSync(join(stateDir, 'spawn.log'), `${new Date().toISOString()} hold ${line}\n`) } catch { /* best effort */ }
  }
  ctx.on('tools/post-execute', async (exec, result, next) => {
    const agent = exec?.agent
    if (agent && !skip(agent) && MARKER_TOOLS.test(exec.name ?? '') && !result?.isError) {
      const state = parseHoldMarker(textOf(result?.content))
      if (state) {
        try {
          const current = ctx.get('sessionTitle')?.get(agent.session)?.title
          const next = withHold(current, state === 'on')
          if (next === undefined) trace(`${agent.id}: no title to mark`)
          else if (next !== current) {
            const sc = ctx.get('sessionController') ?? ctx.sessionController
            await sc.rename({ sessionId: agent.id, title: next })
            trace(`${agent.id}: title ${JSON.stringify(current)} -> ${JSON.stringify(next)}`)
          }
        } catch (error) { trace(`rename failed: ${error?.message ?? error}`) }
      }
    }
    return next()
  })
}
