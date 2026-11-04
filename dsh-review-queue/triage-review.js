// The review-queue methods behind "Resolved by AI": the rule list with its record, mode changes, forgetting a lesson, and the user's review of one
// AI-resolved item (seen / looks right / mark wrong / overrule the rule). Every method validates its input and answers { ok, error? }; none throws.
import { wouldText } from './triage-runner.js'
import { MODES } from './triage-rules.js'

const OFF = { ok: false, error: 'triage-off' }
const REVIEWS = new Set(['seen', 'agreed', 'mark-wrong', 'overrule-rule'])
const rank = (mode) => MODES.indexOf(mode)

/** The cases grouped by rule id in one pass (entries without a rule id are dropped). */
function byRule(cases) {
  const groups = new Map()
  for (const c of cases) {
    if (c?.ruleId === undefined || c?.ruleId === null) continue
    const list = groups.get(c.ruleId)
    if (list) list.push(c)
    else groups.set(c.ruleId, [c])
  }
  return groups
}

/** Agreed / overruled counts of the cases recorded for one rule, split into its current version and older ones. */
function recordOf(rule, ruleCases = []) {
  const record = { current: { agreed: 0, overruled: 0 }, older: { agreed: 0, overruled: 0 } }
  for (const c of ruleCases) {
    const bucket = c.ruleVersion === rule.version ? record.current : record.older
    if (c.review === 'overruled') bucket.overruled++
    else if (c.review === 'agreed' || c.review === 'matched-user') bucket.agreed++
  }
  return record
}

/** @param {{ store: any, triageApi?: { rules: any, memory: any }, promptSession: (item: object, text: string) => Promise<{ ok: false, error: string } | undefined>, posting?: Set<string>, log?: (line: string) => void }} deps */
export function createTriageReview({ store, triageApi, promptSession, posting = new Set(), log, onEnabled }) {
  const rules = triageApi?.rules
  const memory = triageApi?.memory
  const sending = new Set() // ids of items whose mark-wrong correction is in flight (the check of r.review and its mark are an await apart)
  /** Logs only a sanitized code of the error (its code or name, never the message); a throwing log never changes the answer. */
  const logFailure = (e) => {
    try { log?.('triage-review: ' + (String(e?.code ?? e?.name ?? 'error').replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 60) || 'error')) } catch { /* logging never breaks an answer */ }
  }
  const guard = (fn) => {
    if (!rules) return OFF
    try { return fn() } catch (e) { logFailure(e); return { ok: false, error: 'failed' } }
  }

  /** The item as the memory wants it: the resolution carries what the rule decided, so the case is built from it. */
  const caseItem = (item) => {
    const r = item.resolution
    return { ...item, triage: { mode: 'auto', verdict: 'handle', ruleId: r.ruleId, ruleVersion: r.ruleVersion, score: r.score, threshold: r.threshold, would: wouldText(item) || String(r.action ?? 'handle this'), at: r.decidedAt } }
  }
  const learn = (item, review, source) => {
    try { memory?.record({ item: caseItem(item), review, source }) } catch { /* a memory failure never breaks the review */ }
  }
  const mark = (item, review) => store.update(item.id, { resolution: { ...item.resolution, seen: true, ...(review ? { review } : {}) } })

  /** An overrule only ever lowers the mode of the rule (auto -> observe or off, observe -> off); it never raises one. */
  const lower = (ruleId, mode) => {
    const current = rules.get(ruleId)?.mode
    if (rank(mode) < rank(current)) rules.setMode(ruleId, mode)
  }

  const apply = async (item, { review, text, mode }) => {
    const r = item.resolution
    if (review === 'seen') {
      if (r.seen === true) return { ok: true }
      mark(item)
      return { ok: true }
    }
    if (review === 'agreed') {
      if (r.review === 'agreed') return { ok: true }
      if (r.review === 'overruled') return { ok: false, error: 'already-reviewed' }
      mark(item, 'agreed'); learn(item, 'matched-user', 'looks-right')
      return { ok: true }
    }
    if (review === 'mark-wrong') {
      if (r.review === 'overruled') return { ok: true }
      if (r.review === 'agreed') return { ok: false, error: 'already-reviewed' }
      if (!text.trim()) return { ok: false, error: 'empty' }
      if (sending.has(item.id)) return { ok: true } // the same correction is already on its way: a duplicate is a no-op
      if (typeof item.sessionId !== 'string' || item.sessionId === '') return { ok: false, error: 'not-a-session' } // same guards as the reply path (service.post)
      if (item.type === 'paused') return { ok: false, error: 'paused' }
      if (posting.has(item.sessionId)) return { ok: false, error: 'busy' } // the reply path has a prompt to this session in flight
      sending.add(item.id); posting.add(item.sessionId)
      try {
        const refused = await promptSession(item, text)
        if (refused) return refused
        // the item may have been reopened during the send: the correction went out, but only a still AI-resolved item is marked and learned from
        const current = store.get(item.id)
        // a concurrent review during the send wins (agreed, or overruled by overrule-rule, which already learned): the correction went out, but nothing more is marked or learned
        if (current?.status === 'resolved' && current.resolution?.kind === 'ai-resolved' && !current.resolution.review) { mark(current, 'overruled'); learn(current, 'overruled', 'mark-wrong') }
        return { ok: true }
      } finally { sending.delete(item.id); posting.delete(item.sessionId) }
    }
    lower(r.ruleId, mode)
    if (r.review !== 'overruled') { mark(item, 'overruled'); learn(item, 'overruled', 'overrule-rule') }
    return { ok: true }
  }

  return {
    triageRules: () => guard(() => {
      const grouped = byRule(memory?.cases?.() ?? [])
      return { ok: true, enabled: rules.enabled?.() ?? true, rules: rules.list().map((rule) => ({ ...rule, record: recordOf(rule, grouped.get(rule.id)) })), lessons: memory?.lessons?.() ?? [] }
    }),
    /** Raising a rule to auto is the one change that needs the caller's explicit confirmed: true; lowering or keeping a mode never does. */
    triageRuleMode: (ruleId, mode, opts) => guard(() => {
      if (!MODES.includes(mode)) return { ok: false, error: 'bad-mode' }
      const old = rules.get(ruleId)?.mode
      if (old === undefined) return { ok: false, error: 'bad-rule' }
      if (mode === 'auto' && old !== 'auto' && opts?.confirmed !== true) return { ok: false, error: 'needs-confirm' }
      if (!rules.setMode(ruleId, mode)) return { ok: false, error: 'bad-rule' }
      try { log?.('triage: rule ' + String(ruleId).replace(/[^A-Za-z0-9_-]/g, '?').slice(0, 60) + ' mode ' + old + ' -> ' + mode) } catch { /* logging never breaks a change */ }
      return { ok: true }
    }),
    /** The global switch: turning it on needs no confirm. A non-boolean is bad input. */
    triageEnabled: (value) => guard(() => {
      if (typeof value !== 'boolean' || typeof rules?.setEnabled !== 'function') return { ok: false, error: 'bad-input' }
      if (!rules.setEnabled(value)) return { ok: false, error: 'bad-input' }
      try { log?.('triage: switched ' + (value ? 'on' : 'off')) } catch { /* logging never breaks a change */ }
      onEnabled?.()
      return { ok: true }
    }),
    triageForget: (lessonId) => guard(() => (memory?.forget?.(lessonId) ? { ok: true } : { ok: false, error: 'not-found' })),
    async triageReview(id, opts) {
      if (!rules) return OFF
      try {
        const { review, text, mode } = opts && typeof opts === 'object' ? opts : {}
        if (!REVIEWS.has(review)) return { ok: false, error: 'bad-review' }
        const item = store.get(id)
        if (!item) return { ok: false, error: 'not-found' }
        if (item.status !== 'resolved' || item.resolution?.kind !== 'ai-resolved') return { ok: false, error: 'not-ai-resolved' }
        const chosen = mode === undefined ? 'observe' : mode
        if (review === 'overrule-rule' && chosen !== 'observe' && chosen !== 'off') return { ok: false, error: 'bad-mode' }
        if (review === 'overrule-rule' && !rules.get(item.resolution.ruleId)) return { ok: false, error: 'bad-rule' }
        return await apply(item, { review, text: typeof text === 'string' ? text : '', mode: chosen })
      } catch (e) { logFailure(e); return { ok: false, error: 'failed' } }
    },
  }
}
