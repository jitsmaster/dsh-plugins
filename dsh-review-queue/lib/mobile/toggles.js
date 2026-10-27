/**
 * The open/closed choice of the phone's <details> sections (the conversation of an item, "Full reply", "Answer now (late)"), remembered per item and per
 * section across screens, reloads and app restarts. Pure helpers, node-tested; api.js keeps them in state and on disk, views.js stays thin.
 * Saved shape: { details: { "<itemId>|<kind>": boolean } }. Without a choice the section shows its own default.
 */

/** The localStorage key of the choices (the other phone keys are rq-m.saved, rq-m.filter, rq-m.todoDraft). */
export const TOGGLES_KEY = 'rq-m.toggles'

/** The sections that remember their state. */
const KINDS = ['conversation', 'reply', 'late']

const keyOf = (itemId, kind) => itemId + '|' + kind
/** The id of the item a saved key belongs to, and whether its kind is one of ours. */
const split = (key) => { const i = key.lastIndexOf('|'); return { id: key.slice(0, i), kind: key.slice(i + 1), valid: i > 0 } }
const detailsOf = (toggles) => (toggles && toggles.details && typeof toggles.details === 'object' && !Array.isArray(toggles.details) ? toggles.details : {})

/** Writes the choices (nothing else) at once. storage is { get, set }; a storage that throws (private mode, quota) is ignored. */
export function saveToggles(storage, toggles) {
  try { storage.set(TOGGLES_KEY, JSON.stringify({ details: detailsOf(toggles) })) } catch { /* the choices stay in memory */ }
}

/** The saved choices: nothing, corrupt, non-object or wrong-type data gives empty ones; only booleans of known sections are kept. */
export function loadToggles(storage) {
  let j
  try { j = JSON.parse(storage.get(TOGGLES_KEY) || 'null') } catch { j = null }
  const details = {}
  for (const [key, v] of Object.entries(detailsOf(j))) {
    const { valid, kind } = split(key)
    if (valid && KINDS.includes(kind) && typeof v === 'boolean') details[key] = v
  }
  return { details }
}

/** The choices of items that are still in the queue (open or resolved); the same object when nothing has to go. */
export function pruneToggles(toggles, snap) {
  const live = new Set([...(snap && Array.isArray(snap.open) ? snap.open : []), ...(snap && Array.isArray(snap.resolved) ? snap.resolved : [])].map((i) => i.id))
  const details = detailsOf(toggles)
  const keep = Object.entries(details).filter(([key]) => live.has(split(key).id))
  if (toggles && toggles.details === details && keep.length === Object.keys(details).length) return toggles
  return { details: Object.fromEntries(keep) }
}

/** Whether a section is open: the user's last choice, else the fallback (the section's own default). */
export function detailOpen(toggles, itemId, kind, fallback) {
  const v = detailsOf(toggles)[keyOf(itemId, kind)]
  return typeof v === 'boolean' ? v : !!fallback
}

/** The choices with this section's choice set; the same object for an unknown kind. */
export function setDetail(toggles, itemId, kind, open) {
  if (!KINDS.includes(kind)) return toggles
  return { details: { ...detailsOf(toggles), [keyOf(itemId, kind)]: !!open } }
}
