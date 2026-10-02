/**
 * Handoff continuation sessions the host created, newest last. The status endpoint publishes the list so a
 * browser that was viewing the source session can open the continuation.
 */
const MAX_KEPT = 20
const spawned = []

/**
 * Remember one continuation session.
 * @param {string} from - id of the session that wrote the handoff.
 * @param {string} to - id of the new session that resumes it.
 */
export function recordSpawn(from, to) {
  spawned.push({ from, to, at: Date.now() })
  if (spawned.length > MAX_KEPT) spawned.splice(0, spawned.length - MAX_KEPT)
}

/** @returns {{ from: string, to: string, at: number }[]} copy of the recorded continuations. */
export function listSpawned() {
  return spawned.map((entry) => ({ ...entry }))
}
