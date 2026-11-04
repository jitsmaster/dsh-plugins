/**
 * Auto actor for the done class (rule green-done): clears a done card as handled. The runner has already re-checked everything; this only
 * resolves the card if it is still an open done card.
 */

/**
 * @param {{ store: { resolveIf: (id: string, test: (item: object) => boolean, resolution: object) => boolean | object | undefined } }} deps
 */
export function createDoneActor({ store }) {
  return async ({ item, resolutionBase }) => {
    if (!item?.id || item.type !== 'completed') return { ok: false, reason: 'refused' }
    const resolved = store.resolveIf(item.id, (it) => it.type === 'completed', { ...resolutionBase, action: 'cleared' })
    return resolved ? { ok: true, action: 'cleared' } : { ok: false, reason: 'lost-race' }
  }
}
