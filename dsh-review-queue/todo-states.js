const MAX = 4000

/** The cards a session created by a link (source.sessionId === senderId): open first, then resolved; optionally only those for one target session. */
export function todoStatesOf(snapshot, { senderId, targetSessionId } = {}) {
  if (typeof senderId !== 'string' || !senderId) return []
  const all = [...(snapshot?.open ?? []), ...(snapshot?.resolved ?? [])]
  return all
    .filter((i) => i && i.type === 'todo' && i.kind === 'followup' && i.source?.sessionId === senderId)
    // A card that still waits for the confirm has neither sessionId nor targetSessionId yet; a one-match card carries its target in suggested.sessionId.
    .filter((i) => targetSessionId === undefined || i.sessionId === targetSessionId || i.targetSessionId === targetSessionId || i.suggested?.sessionId === targetSessionId)
    .map((i) => ({ id: i.id, state: i.state, status: i.status, text: String(i.text ?? '').slice(0, MAX), mode: i.mode === 'steer' ? 'steer' : 'queue', targetSessionId: i.targetSessionId, sessionId: i.sessionId, sessionTitle: i.sessionTitle }))
}
