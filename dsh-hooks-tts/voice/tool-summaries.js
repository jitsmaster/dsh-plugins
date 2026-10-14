import { createHash } from 'node:crypto'
import { toolSummaryInfo, withReason } from './headline.js'

/**
 * Security (F6): what each pending tool call will do, for the spoken approve/deny read-back. Entries are keyed by session +
 * tool + call id (call ids alone repeat across sessions, e.g. call_0), carry a hash of the arguments they were made from, and are
 * dropped when the call settles. A request that finds no entry, or whose entry was noted twice with different arguments,
 * gets no summary: the read-back then says "details not available", which voice cannot approve.
 */

/** Stable JSON: object keys sorted, so key order never changes the hash. */
function stable(value) {
  if (Array.isArray(value)) return '[' + value.map(stable).join(',') + ']'
  if (value && typeof value === 'object') return '{' + Object.keys(value).sort().map((k) => JSON.stringify(k) + ':' + stable(value[k])).join(',') + '}'
  return JSON.stringify(value) ?? 'null'
}

const hashOf = (args) => {
  let text
  try { text = stable(args) } catch { text = String(Math.random()) } // unhashable (cyclic) arguments never match anything
  return createHash('sha256').update(text).digest('hex')
}

const keyOf = (agentId, toolName, callId) => (agentId === undefined || toolName === undefined || callId === undefined ? undefined : JSON.stringify([agentId, toolName, callId]))

export function createToolSummaries({ max = 200, summarise = toolSummaryInfo, enabled = () => true } = {}) {
  const entries = new Map() // key -> { hash, info } (info undefined = conflicting arguments)

  return {
    /** tools/pre-execute: remember what the call will do (exec = { agent, name, callId, arguments }). Never throws. */
    note(exec) {
      try {
        // Voice off: nothing will ever read this back, so skip the hashing and summarising on every tool call.
        if (!enabled()) return
        const key = keyOf(exec.agent?.id, exec.name, exec.callId)
        if (key === undefined) return
        const hash = hashOf(exec.arguments)
        const known = entries.get(key)
        entries.delete(key)
        entries.set(key, known && known.hash !== hash ? { hash, info: undefined } : { hash, info: summarise(exec.name, exec.arguments) })
        if (entries.size > max) entries.delete(entries.keys().next().value)
      } catch { /* best effort: the read-back then says the details are not available */ }
    },
    /** approval/request: { text, complete } of the matching call plus the request's reason, or undefined when nothing matches. */
    lookup(req) {
      const entry = entries.get(keyOf(req.agent?.id, req.toolName, req.callId))
      return entry?.info ? withReason(entry.info, req.reason) : undefined
    },
    /** The call settled (post-execute, or the approval was answered/withdrawn); takes an exec or a request. */
    drop(call) {
      const key = keyOf(call.agent?.id, call.name ?? call.toolName, call.callId)
      if (key !== undefined) entries.delete(key)
    },
    size: () => entries.size,
  }
}
