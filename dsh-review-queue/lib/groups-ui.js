/**
 * The model behind the group card (spec: Review Queue Grouping And Priority Design Spec, slice 1). Pure: no React, no I/O.
 * The overlay (lib/client.js) renders it; this file only decides what the card says.
 */

const isAiHandled = (it) => !!(it && it.status === 'resolved' && it.resolution
  && (it.resolution.kind === 'ai-resolved' || (it.resolution.kind === 'no-action' && it.resolution.by === 'auto')))

/**
 * Groups a snapshot().open list (items already carry groupId) in first-seen order, items oldest first.
 * Client-side counterpart of groups.js, which the overlay bundle cannot import; an item without groupId stands alone.
 */
export function groupsOfOpen(open) {
  const byId = new Map()
  for (const item of Array.isArray(open) ? open : []) {
    if (!item || typeof item !== 'object') continue
    const id = typeof item.groupId === 'string' && item.groupId ? item.groupId : 'item:' + item.id
    if (!byId.has(id)) byId.set(id, [])
    byId.get(id).push(item)
  }
  const at = (i) => (Number.isFinite(i.createdAt) ? i.createdAt : Infinity)
  // Same order as groups.js: oldest first, missing createdAt last, seq breaks ties.
  const byAge = (a, b) => { const x = at(a); const y = at(b); return x < y ? -1 : x > y ? 1 : (a.seq ?? 0) - (b.seq ?? 0) }
  return [...byId].map(([id, list]) => {
    const items = [...list].sort(byAge)
    const tiers = items.map((i) => i.tier?.tier).filter(Number.isInteger)
    return { id, items, createdAt: at(items[0]), count: items.length, topTier: tiers.length ? tiers.reduce((m, t) => (t < m ? t : m), Infinity) : undefined }
  })
}

const aiTimes = (resolved, sessionId) => resolved.filter((r) => r && r.sessionId === sessionId && isAiHandled(r) && Number.isFinite(r.resolvedAt)).map((r) => r.resolvedAt)

/** One pass over the resolved list: Map of session id -> resolvedAt times of its AI-handled items. */
export function indexResolved(resolved) {
  const by = new Map()
  for (const r of Array.isArray(resolved) ? resolved : []) {
    if (!r || typeof r.sessionId !== 'string' || !isAiHandled(r) || !Number.isFinite(r.resolvedAt)) continue
    if (!by.has(r.sessionId)) by.set(r.sessionId, [])
    by.get(r.sessionId).push(r.resolvedAt)
  }
  return by
}

/** "AI handled N", or nothing when the AI handled none. */
export function aiHandledLine(n) {
  return Number.isInteger(n) && n > 0 ? 'AI handled ' + n : ''
}

/**
 * The card facts of one group from groupOpen(): header (title, workspace, top tier, count, age) and the items oldest first.
 * `aiHandled` counts the AI-handled items of the SAME session resolved since the group's oldest open item was created.
 * A card that stands alone (no session) never has one.
 */
export function groupCardModel(group, resolved) {
  const items = Array.isArray(group?.items) ? group.items : []
  const first = items[0] ?? {}
  const sessionGroup = typeof first.sessionId === 'string' && group.id === first.sessionId
  const since = Number.isFinite(group?.createdAt) ? group.createdAt : Infinity
  // `resolved` is the raw list or an indexResolved() map (session id -> resolvedAt of its AI-handled items): the map avoids a scan per group.
  let aiHandled = 0
  if (sessionGroup) {
    const times = resolved instanceof Map ? resolved.get(first.sessionId) ?? [] : Array.isArray(resolved) ? aiTimes(resolved, first.sessionId) : []
    for (const t of times) if (t >= since) aiHandled++
  }
  return {
    id: group?.id,
    title: first.sessionTitle || 'Session',
    workspace: first.workspace || '',
    topTier: group?.topTier,
    count: items.length,
    createdAt: group?.createdAt,
    items,
    aiHandled,
  }
}
