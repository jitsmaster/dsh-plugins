/**
 * Priority tiers for review-queue items (spec: Review Queue Grouping And Priority Design Spec).
 *
 * Severity = risk if the AI or the user gets the item wrong; urgency = is an agent blocked on it. An ITIL-style lookup matrix turns the
 * pair into a tier P0 (0) .. P4 (4). Everything here is pure code: the model's severity is optional input that can only RAISE a severity above
 * the code floor, never lower it, and text in the item is never read. Aging changes the sort tier only, never the AI gate.
 * The AI gate (autoGateOk): Low or Housekeeping only; the question class may also act at Medium (its own floor).
 */

export const SEVERITIES = ['low', 'medium', 'high']
const RANK = { low: 0, medium: 1, high: 2 }

/** Housekeeping cards: never judged, never blocking. */
const HOUSEKEEPING = new Set(['paused', 'todo', 'archive', 'pr-merged', 'onhold'])
/** Cards a session is waiting on: a pending permission or question blocks the agent. */
const BLOCKING = new Set(['permission', 'question'])

/** Tier by severity, then urgency. The housekeeping/blocked cell is unreachable today and kept so the table is total. */
export const MATRIX = {
  high: { blocked: 0, free: 1 },
  medium: { blocked: 1, free: 2 },
  low: { blocked: 2, free: 3 },
  housekeeping: { blocked: 3, free: 4 },
}

/** Aging: a group waiting this long moves up one tier (never above P1: aging alone cannot create a P0). */
export const AGING_STEP_MS = 60 * 60 * 1000

const raise = (a, b) => (RANK[b] > RANK[a] ? b : a)

/**
 * The severity of an item. `facts` are what code found out (riskFlags[], safe); `judgment` is the model's output (severity, needs_decision),
 * advisory only. Floors the model can never lower: a permission is High unless code proves it safe; any risk flag is High;
 * needs_decision is at least Medium.
 */
export function severityOf({ item, facts, judgment } = {}) {
  if (Array.isArray(facts?.riskFlags) && facts.riskFlags.length) return 'high'
  const type = item?.type
  if (HOUSEKEEPING.has(type)) return 'housekeeping'
  let floor
  if (type === 'permission') floor = facts?.safe === true ? 'low' : 'high'
  else if (type === 'completed') floor = facts?.needsUser === true || facts?.needsUserObserve === true || facts?.actionItem === true ? 'medium' : 'low' // a done card that asks or hands work back is not routine
  else if (type === 'question') floor = 'medium' // the judge can never lower a question (decided 2026-11-12)
  else floor = 'medium' // an unknown type is ranked conservatively
  if (judgment?.needs_decision === true) floor = raise(floor, 'medium')
  let result = floor
  if (SEVERITIES.includes(judgment?.severity)) result = raise(result, judgment.severity)
  const fromScore = severityFromAttention(judgment?.attention)
  if (fromScore) result = raise(result, fromScore)
  return result
}

/** Bands for the model's attention score (decided 2026-11-12): 0-29 low, 30-69 medium, 70-100 high; anything else is ignored. */
export function severityFromAttention(score) {
  if (typeof score !== 'number' || !Number.isFinite(score) || score < 0 || score > 100) return undefined
  return score >= 70 ? 'high' : score >= 30 ? 'medium' : 'low'
}

/** 'blocked' when the item is a pending permission or question (by card type: no new DSH signal), else 'free'. */
export const urgencyOf = (item) => (BLOCKING.has(item?.type) ? 'blocked' : 'free')

/** The matrix lookup; an unknown severity is treated as Medium and an unknown urgency as free. */
export function tierOf(severity, urgency) {
  const row = Object.hasOwn(MATRIX, severity) ? MATRIX[severity] : MATRIX.medium
  return urgency === 'blocked' ? row.blocked : row.free
}

export const tierOfItem = (input = {}) => tierOf(severityOf(input), urgencyOf(input.item))

/** A well-formed stored tier: closed sets, and `tier` equal to the matrix cell of its severity and urgency. */
export function validTier(t) {
  return !!t && typeof t === 'object' && !Array.isArray(t) && Object.hasOwn(MATRIX, t.severity) && (t.urgency === 'blocked' || t.urgency === 'free') && Number.isInteger(t.tier) && t.tier === tierOf(t.severity, t.urgency)
}

/** The stored tier object of an item: `{ severity, urgency, tier, at }`. One place builds it (store and runner). */
export function buildTier(input = {}, at) {
  const severity = severityOf(input)
  const urgency = urgencyOf(input.item)
  return { severity, urgency, tier: tierOf(severity, urgency), at }
}

/** The sort tier after aging: one tier per AGING_STEP_MS of group age, capped at P1; P0 and P1 never move; a bad age changes nothing. */
export function effectiveTier(tier, ageMs) {
  if (!Number.isFinite(tier) || tier <= 1) return tier
  if (!Number.isFinite(ageMs) || ageMs <= 0) return tier
  return Math.max(1, tier - Math.floor(ageMs / AGING_STEP_MS))
}

/** The AI gate: only a code-proven Low or Housekeeping severity may be acted on, whatever the urgency; the question class, whose own floor is Medium, may also act at Medium. Reads severity, never the aged tier. */
export const isAutoSafeSeverity = (severity, ruleClass) => severity === 'low' || severity === 'housekeeping' || (ruleClass === 'question' && severity === 'medium')

/**
 * The gate for one auto rule: severity of the item as the rule's class sees it. Done class: needs-user / action-item facts already have their own
 * vetoes in triageOutcome, so they are ignored here (no double reason).
 */
export function autoGateOk({ item, facts, judgment, ruleClass }) {
  const f = ruleClass === 'done' && facts ? { ...facts, needsUser: false, needsUserObserve: false, actionItem: false } : facts
  return isAutoSafeSeverity(severityOf({ item, facts: f, judgment }), ruleClass)
}
