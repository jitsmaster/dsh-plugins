/**
 * Command queues of the hub (docs/hub.md 6.2): one FIFO per instance, in memory only. enqueue answers when the agent reports a
 * result, or at the timeout of its kind: owner-timeout when no agent had fetched it, unknown-outcome when it was delivered and
 * nothing came back. A command stays in its queue until the agent acknowledges it with poll(after >= seq), so a response that got
 * lost is delivered again (the agent answers a repeated cid from its cache).
 */
import { randomUUID } from 'node:crypto'
import { PROMPT_TIMEOUT_MS } from '../follow-up-shared.js'

// sessions-list stays above SESSIONS_APP_BUDGET_MS (follow-up-shared.js: the one deadline an app has for its answer), and followup-send above PROMPT_TIMEOUT_MS (the app's own limit for the prompt call).
export const TIMEOUT_MS = Object.freeze({
  answer: 10_000, deny: 10_000, approve: 10_000, 'approve-similar': 10_000, 'late-answer': 15_000, reply: 35_000, archive: 35_000,
  'paused-resume': 35_000, 'paused-dismiss': 10_000, hold: 15_000, 'hold-release': 10_000, 'hold-continue': 35_000, 'todo-suggest': 10_000, 'todo-start': 10_000, 'sessions-list': 6_000, 'model-efforts': 6_000, 'followup-suggest': 10_000, 'followup-send': PROMPT_TIMEOUT_MS + 5000, 'todo-cancel': 10_000, 'open-session': 10_000, apply: 10_000, thread: 15_000, post: 35_000,
})
const DEFAULT_TIMEOUT_MS = 10_000

/** @param {{ now?: () => number, timers?: { setTimeout: Function, clearTimeout: Function }, timeoutsMs?: Record<string, number>, uuid?: () => string }} [opts] */
export function createCommands({ now = Date.now, timers = globalThis, timeoutsMs = {}, uuid = randomUUID } = {}) {
  const queues = new Map() // instance id -> { seq, list, wakers }
  const waiting = new Map() // cid -> { instanceId, cmd, delivered, silent, resolve, timer }

  const queueOf = (id) => {
    let q = queues.get(id)
    if (!q) { q = { seq: 0, list: [], wakers: new Set() }; queues.set(id, q) }
    return q
  }
  const unqueue = (q, cid) => { q.list = q.list.filter((c) => c.cid !== cid) }
  const wake = (q) => { for (const waker of [...q.wakers]) waker() }

  function finish(entry, result) {
    timers.clearTimeout(entry.timer)
    waiting.delete(entry.cmd.cid)
    unqueue(queueOf(entry.instanceId), entry.cmd.cid)
    entry.resolve(result)
  }

  /** Remove what the agent has acknowledged; a message without a waiter is finished then. */
  function acknowledge(q, after) {
    for (const cmd of q.list.filter((c) => c.seq <= after)) {
      const entry = waiting.get(cmd.cid)
      if (!entry) { unqueue(q, cmd.cid); continue }
      entry.delivered = true
      if (entry.silent) finish(entry, { ok: true })
      else unqueue(q, cmd.cid)
    }
  }

  return {
    /** Resolves with the agent's result; wait:false only queues (a message for the agent, e.g. apply). */
    enqueue(instanceId, { kind, itemId, args = {}, wait = true }) {
      const q = queueOf(instanceId)
      const timeout = timeoutsMs[kind] ?? TIMEOUT_MS[kind] ?? DEFAULT_TIMEOUT_MS
      const cmd = { cid: uuid(), seq: ++q.seq, kind, itemId, args, deadline: now() + timeout }
      q.list.push(cmd)
      const result = wait ? new Promise((resolve) => {
        const entry = { instanceId, cmd, delivered: false, silent: false, resolve, timer: undefined }
        entry.timer = timers.setTimeout(() => finish(entry, { ok: false, error: entry.delivered ? 'unknown-outcome' : 'owner-timeout' }), timeout)
        entry.timer?.unref?.()
        waiting.set(cmd.cid, entry)
      }) : Promise.resolve({ ok: true, queued: true })
      if (!wait) waiting.set(cmd.cid, { instanceId, cmd, delivered: false, silent: true, resolve() {}, timer: undefined })
      wake(q)
      return result
    },

    /** Long poll: what is queued after the acknowledged seq now, or an empty list at waitMs. */
    poll(instanceId, after, waitMs, signal) {
      const q = queueOf(instanceId)
      const from = Number.isInteger(after) && after >= 0 && after <= q.seq ? after : 0 // an agent ahead of this hub restarts from the start
      acknowledge(q, from)
      const take = () => q.list.filter((c) => c.seq > from).map((cmd) => { const e = waiting.get(cmd.cid); if (e) e.delivered = true; return { ...cmd } })
      if (waitMs <= 0 || q.list.some((c) => c.seq > from)) return Promise.resolve(take())
      return new Promise((resolve) => {
        const done = () => { timers.clearTimeout(timer); q.wakers.delete(done); signal?.removeEventListener('abort', done); resolve(take()) }
        const timer = timers.setTimeout(done, waitMs)
        signal?.addEventListener('abort', done, { once: true })
        timer?.unref?.()
        q.wakers.add(done)
      })
    },

    /** The agent's answer; false when the command is unknown, belongs to someone else or is already finished. */
    complete(instanceId, cid, result) {
      const entry = waiting.get(cid)
      if (!entry || entry.instanceId !== instanceId) return false
      finish(entry, result)
      return true
    },

    /** The owner went away: what waits is answered (queued: owner-offline, delivered: unknown-outcome) and its queue is emptied. */
    failInstance(instanceId) {
      for (const entry of [...waiting.values()].filter((e) => e.instanceId === instanceId)) {
        finish(entry, { ok: false, error: entry.delivered ? 'unknown-outcome' : 'owner-offline' })
      }
      queueOf(instanceId).list = []
    },

    /** Hub shutdown: answer everything and wake every long poll. */
    failAll() {
      for (const entry of [...waiting.values()]) finish(entry, { ok: false, error: entry.delivered ? 'unknown-outcome' : 'shutting-down' })
      for (const q of queues.values()) { q.list = []; wake(q) }
    },

    pending: (instanceId) => [...waiting.values()].filter((e) => e.instanceId === instanceId).length,
  }
}
