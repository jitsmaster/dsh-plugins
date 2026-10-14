/** Press-and-hold confirmation (risky approvals): pure timing helpers, so the rule is testable without a browser. */
export const HOLD_MS = 1500

/** Progress 0..1 of a hold that started at `startedAt`; `done` once the full time has passed. */
export function holdState(startedAt, now, ms = HOLD_MS) {
  const progress = Math.min(1, Math.max(0, (now - startedAt) / ms))
  return { progress, done: progress >= 1 }
}
