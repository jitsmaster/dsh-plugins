/**
 * Releases the Playwright queue lease (dsh-playwright-queue) a session holds when that session stops.
 *
 * The wrapper MCP server hands out a lease through `queue_acquire` and takes it back on `queue_release`. A session that
 * ends without releasing would block everyone else until the idle timeout, so this watches the tool results
 * (tools/post-execute: the calling agent, subagents included, plus the granted token) and releases whatever an agent still
 * holds when its turn stops, it is disposed or its subagent ends. It calls the queue library directly, not the wrapper.
 *
 * Tool names: DSH names an MCP tool `mcp__<serverName>__<rawName>` (mcp-client/src/tools.ts publicToolName). A call made
 * through PTC `run_code` still dispatches each inner tool with that same name and the calling agent through the normal
 * pre/post-execute pipeline (core/tool-executor-ptc/src/ptc.ts), so the same matching covers both paths.
 *
 * Everything degrades quietly: a missing queue package or any queue error is logged and never thrown.
 */
import { homedir } from 'node:os'
import { join } from 'node:path'

const SERVER = 'playwright'

/** Default factory: load the sibling queue package lazily and open the shared state dir. */
export function defaultQueueFactory(dir) {
  return async () => {
    const { createQueue } = await import(new URL('../dsh-playwright-queue/lib/index.js', import.meta.url).href)
    return createQueue({ dir: dir || process.env.DSH_PWQ_DIR || join(homedir(), '.dsh', 'playwright-queue') })
  }
}

// Local copy: index.js's textOf takes message content (not a tool result) and is not exported; other modules keep their own too.
function textOf(result) {
  const blocks = Array.isArray(result?.content) ? result.content : Array.isArray(result?.value?.content) ? result.value.content : []
  return blocks.filter((b) => b?.type === 'text' && typeof b.text === 'string').map((b) => b.text).join('')
}

function parseJson(text) {
  try {
    const v = JSON.parse(text)
    return v && typeof v === 'object' && !Array.isArray(v) ? v : undefined
  } catch { return undefined }
}

const MAX_DISPOSED = 1000 // bound on the ended/disposed id tombstones
const MAX_RESULT_CHARS = 4096 // longer tool results are never JSON-parsed
const MAX_ID_CHARS = 256 // longer tokens/tickets are not recorded
const MAX_PER_AGENT = 64 // tokens and tickets recorded per agent
const MAX_HELD = 500 // agents tracked at once

export function createQueueReleaser({
  queueFactory = defaultQueueFactory(), logger, enabled = true,
  serverName = 'playwright', releaseGraceMs = 5000, retryMs = 30000, now = Date.now,
} = {}) {
  const server = typeof serverName === 'string' && serverName ? serverName : SERVER
  const ACQUIRE_NAMES = new Set([`mcp__${server}__queue_acquire`])
  const RELEASE_NAMES = new Set([`mcp__${server}__queue_release`])
  const graceMs = Number.isFinite(releaseGraceMs) && releaseGraceMs > 0 ? releaseGraceMs : 0
  /** agentId -> { tokens:Set, tickets:Set } */
  const held = new Map()
  /** agentId -> pending grace timer */
  const pending = new Map()
  /** tombstones, oldest first (bounded): id -> 'disposed' (cleared by noteCreated) | 'ended' (subagent, permanent) */
  const disposedIds = new Map()
  let inflight
  let queueNow // the queue once resolved, so dispose() can use it synchronously
  let failedAt // timestamp of the last open failure; undefined when healthy
  let warned = false // warn once per failure streak
  const warn = (msg) => { try { logger?.warn?.(`hooks-tts: playwright-queue: ${msg}`) } catch { /* logging must not throw */ } }

  const slot = (id) => {
    let s = held.get(id)
    if (!s) {
      if (held.size >= MAX_HELD) return undefined
      held.set(id, s = { tokens: new Set(), tickets: new Set() })
    }
    return s
  }
  const cancelPending = (id) => {
    const t = pending.get(id)
    if (t === undefined) return
    clearTimeout(t)
    pending.delete(id)
  }
  const getQueue = () => {
    if (queueNow) return Promise.resolve(queueNow)
    if (failedAt !== undefined && now() - failedAt < retryMs) return Promise.resolve(undefined)
    inflight ??= Promise.resolve().then(queueFactory).then((q) => {
      queueNow = q
      failedAt = undefined
      warned = false
      return q
    }, (error) => {
      failedAt = now()
      if (!warned) { warned = true; warn(`queue unavailable, will retry: ${String(error)}`) }
      return undefined
    }).finally(() => { inflight = undefined })
    return inflight
  }

  const api = {
    /** Turn stopped: release after the grace period unless the agent shows new activity first. */
    scheduleRelease(agentId) {
      try {
        if (!agentId || pending.has(agentId) || !held.has(agentId)) return
        if (!graceMs) { void api.releaseAgent(agentId); return }
        const timer = setTimeout(() => { pending.delete(agentId); void api.releaseAgent(agentId) }, graceMs)
        timer.unref?.()
        pending.set(agentId, timer)
      } catch (error) { warn(`scheduleRelease failed: ${String(error)}`) }
    },

    /** The agent started a new step: its pending release (if any) is cancelled. */
    noteActive(agentId) {
      try { if (agentId) cancelPending(agentId) } catch { /* never throws */ }
    },

    /** A session id was (re-)created: a disposed tombstone is lifted; subagent nded ones stay. */
    noteCreated(agentId) {
      try { if (agentId && disposedIds.get(agentId) === 'disposed') disposedIds.delete(agentId) } catch { /* never throws */ }
    },

    async observe(agentId, toolName, args, result) {
      try {
        if (!agentId) return
        cancelPending(agentId)
        if (!enabled || disposedIds.has(agentId) || result?.isError) return
        if (ACQUIRE_NAMES.has(toolName)) {
          const raw = textOf(result)
          const body = raw.length > MAX_RESULT_CHARS ? undefined : parseJson(raw)
          if (body?.status === 'granted' && typeof body.token === 'string' && body.token && body.token.length <= MAX_ID_CHARS) {
            const s = slot(agentId)
            if (s && (s.tokens.size < MAX_PER_AGENT || s.tokens.has(body.token))) s.tokens.add(body.token)
            if (s && typeof args?.ticket === 'string') s.tickets.delete(args.ticket)
          } else if (body?.status === 'waiting' && typeof body.ticket === 'string' && body.ticket && body.ticket.length <= MAX_ID_CHARS) {
            const s = slot(agentId)
            if (s) {
              s.tickets.add(body.ticket)
              if (s.tickets.size > MAX_PER_AGENT) s.tickets.delete(s.tickets.values().next().value)
            }
          }
        } else if (RELEASE_NAMES.has(toolName) && typeof args?.queueToken === 'string') {
          held.get(agentId)?.tokens.delete(args.queueToken)
        }
      } catch (error) { warn(`observe failed: ${String(error)}`) }
    },

    async releaseAgent(agentId, { disposed = false, ended = false } = {}) {
      try {
        cancelPending(agentId)
        if ((disposed || ended) && agentId) {
          disposedIds.delete(agentId) // re-insert: newest last
          disposedIds.set(agentId, ended ? 'ended' : 'disposed')
          if (disposedIds.size > MAX_DISPOSED) disposedIds.delete(disposedIds.keys().next().value)
        }
        if (!held.get(agentId)) return
        if (!enabled || (!held.get(agentId).tokens.size && !held.get(agentId).tickets.size)) { held.delete(agentId); return }
        const queue = await getQueue()
        if (!queue) {
          if (disposed || ended) held.delete(agentId) // gone for good: do not keep it for a retry that never comes
          return
        }
        // keep the record: a later release retries once the queue is available
        const s = held.get(agentId)
        if (!s) return
        held.delete(agentId)
        for (const token of s.tokens) {
          try { queue.release(token) } catch (error) { warn(`release failed: ${String(error)}`) }
        }
        for (const ticket of s.tickets) {
          try { queue.cancel(ticket) } catch (error) { warn(`cancel failed: ${String(error)}`) }
        }
      } catch (error) { warn(`releaseAgent failed: ${String(error)}`) }
    },

    /** Best-effort, synchronous: release/cancel whatever is still recorded, only if the queue already exists. */
    dispose() {
      for (const t of pending.values()) clearTimeout(t)
      pending.clear()
      const queue = queueNow
      if (queue && enabled) {
        for (const s of held.values()) {
          for (const token of s.tokens) { try { queue.release(token) } catch (error) { warn(`release failed: ${String(error)}`) } }
          for (const ticket of s.tickets) { try { queue.cancel(ticket) } catch (error) { warn(`cancel failed: ${String(error)}`) } }
        }
      }
      held.clear()
    },
  }
  return api
}
