/**
 * AI usage audit wiring: feeds session events to the tracker, persists every record to a ledger,
 * links handoff continuations into chains, and writes the vault notes (AI usage/<month>/<day>.md
 * and CTnP/AI Usage by Ticket/AB#<id>.md) on turn stop and dispose.
 */
import { join } from 'node:path'
import { listSpawned } from '../spawned.js'
import { createUsageTracker } from './tracker.js'
import { createLedger } from './ledger.js'
import { writeNotes } from './render.js'

const DEFAULT_VAULT = 'D:\\dev\\Notes\\Dev Tasks'

export function installAiUsage(ctx, config = {}, stateDir) {
  const tracker = createUsageTracker()
  const ledger = createLedger(join(stateDir, 'ai-usage', 'ledger.jsonl'))
  try { ledger.replay(tracker) } catch { /* corrupt ledger never blocks startup */ }
  tracker.onRecord = ledger.append
  const vault = config.aiUsageVaultDir ?? DEFAULT_VAULT
  const ids = new WeakMap()
  const linked = new Set()

  const syncLinks = () => {
    try {
      for (const { from, to } of listSpawned()) {
        const key = `${from}>${to}`
        if (!linked.has(key)) { linked.add(key); tracker.link(from, to) }
      }
    } catch { /* never throws */ }
  }

  const flush = () => {
    try {
      const days = new Set()
      for (const s of tracker.sessions()) if (s.kind !== 'untracked') for (const d of Object.keys(s.byDay)) days.add(d)
      if (days.size) writeNotes(tracker, vault, [...days])
    } catch (error) { try { ctx.logger?.warn?.(`ai-usage: could not write notes: ${error?.message ?? error}`) } catch { /* ignore */ } }
  }

  const register = (agent) => {
    try {
      if (!agent?.id || !agent.session) return
      ids.set(agent.session, agent.id)
      let title = ''
      try { title = ctx.get?.('sessionTitle')?.get(agent.session)?.title ?? '' } catch { /* optional */ }
      tracker.meta(agent.id, { cwd: agent.session?.header?.cwd ?? '', title })
    } catch { /* never throws */ }
  }

  ctx.on('agent/created', ({ agent }) => register(agent))
  ctx.on('session/event', (session, event) => {
    try {
      const id = session && ids.get(session)
      if (!id) return
      syncLinks()
      tracker.observe(id, event)
    } catch { /* an odd event must never reach the host */ }
  })
  ctx.on('agent/turn-stopping', () => { syncLinks(); flush() })
  ctx.on('agent/disposed', () => { syncLinks(); flush() })

  return { tracker, ledger, flush }
}
