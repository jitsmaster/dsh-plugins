/**
 * Auto actor for the permission class (rule ro-permission): approves a read-only command once. The runner has already re-checked the card; this
 * re-verifies the command that is stored NOW (the pure parser plus the truncation check) and only then decides. It never denies and never throws.
 */
import { parseReadOnlyCommand } from './triage.js'
import { commandIntact, containedInWorkspace } from './triage-paths.js'
import { AUTO_SHELL_TOOLS } from './risk.js'

/**
 * @param {{ store: { get: (id: string) => object | undefined }, decide: (id: string, resolution: object) => boolean | { ok?: boolean } }} deps
 *   decide approves the pending request with the given resolution; it returns true / { ok: true } only when it did.
 */
export function createPermissionActor({ store, decide }) {
  return async ({ item, resolutionBase } = {}) => {
    try {
      if (item?.type !== 'permission') return { ok: false, reason: 'refused' }
      const current = store.get(item.id)
      if (!current || current.type !== 'permission') return { ok: false, reason: 'refused' }
      if (current.status !== 'open') return { ok: false, reason: 'not-pending' }
      const p = current.payload ?? {}
      // The command judged is the command stored now, whole, and still passes the strict parser.
      if (!commandIntact(p) || p.detail !== item.payload?.detail || p.callId !== item.payload?.callId || p.toolName !== item.payload?.toolName) return { ok: false, reason: 'changed' }
      if (!parseReadOnlyCommand(p.detail, { auto: true }).ok) return { ok: false, reason: 'not-read-only' }
      // Every command is re-checked for containment (rg and grep also refuse a directory); the runner's containment fact is not trusted alone.
      const bin = p.detail.trim().split(/\s+/)[0]
      if (!(await containedInWorkspace(p.detail, current.workspace, undefined, bin))) return { ok: false, reason: 'not-read-only' }
      // Defence in depth: the judgment and fingerprint cover the command only, so a call that carries other arguments, or a tool not named like a shell, is never approved here.
      if (p.extraArgs === true || !AUTO_SHELL_TOOLS.has(String(p.toolName ?? '').toLowerCase())) return { ok: false, reason: 'not-read-only' }
      const res = await decide(item.id, { ...resolutionBase, action: 'approved' })
      return res === true || res?.ok === true ? { ok: true, action: 'approved' } : { ok: false, reason: 'not-pending' }
    } catch { return { ok: false, reason: 'error' } }
  }
}
