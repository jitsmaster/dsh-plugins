/**
 * Pinning a session pins its whole group.
 *
 * DSH keeps one registry-global pin set and has no notion of a pinned group, so the group is pinned the plain way:
 * when a session newly appears in the pin set (the registry's `domain/changed` for the workspace domain), every
 * other member of its group that is not pinned yet is pinned too. Only pinning is followed: unpinning a session
 * leaves the rest of its group as it is, and sessions pinned before the plugin started are not touched.
 */

/**
 * @param {{ groups: { groupOf: (id: string) => ({ sessionIds: string[] } | undefined) },
 *           registry: () => ({ pinnedSessionIds?: readonly string[], archivedSessionIds?: readonly string[], pinSession: (id: string) => Promise<void> } | undefined),
 *           trace?: (line: string) => void }} deps
 */
export function createGroupPinner({ groups, registry, trace = () => {} }) {
  const current = () => { try { return registry() } catch { return undefined } }
  /** Pin set seen at the last change; undefined until known, so the first change never pins retroactively. */
  let seen
  try {
    const start = current()?.pinnedSessionIds
    if (Array.isArray(start)) seen = new Set(start.map(String))
  } catch { /* registry not ready or not a registry: learn the pin set from the first change */ }
  // One change at a time: pinning is a read-modify-write on the registry, and our own pins echo back as changes.
  let chain = Promise.resolve()

  async function handle(change) {
    if (change?.domain !== 'workspace' || change.table !== '' || change.operation !== 'put') return
    const list = change.value?.pinnedSessionIds
    if (!Array.isArray(list)) return
    const reg = current()
    if (!reg) return
    const next = new Set(list.map(String))
    if (typeof reg.pinSession !== 'function') return
    const before = seen
    seen = next
    if (!before) return
    for (const id of next) {
      if (before.has(id)) continue
      const members = groups.groupOf(id)?.sessionIds ?? []
      // Reverse: each pin goes to the front, so the group ends up in its own order.
      for (const other of [...members].reverse()) {
        if (other === id) continue
        const pinned = new Set((reg.pinnedSessionIds ?? []).map(String))
        const archived = new Set((reg.archivedSessionIds ?? []).map(String))
        if (pinned.has(other) || archived.has(other)) continue
        try { await reg.pinSession(other) } catch (error) { trace(`could not pin ${other} with its group: ${error?.message ?? error}`) }
      }
    }
    // Our own pins come back as changes: they are already counted.
    for (const id of reg.pinnedSessionIds ?? []) seen.add(String(id))
  }

  return { onChange: (change) => (chain = chain.then(() => handle(change)).catch((error) => trace(`group pinning failed: ${error?.message ?? error}`))) }
}
