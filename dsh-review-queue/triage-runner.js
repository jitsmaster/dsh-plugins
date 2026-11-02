/**
 * AI triage, OBSERVE mode only (phase 2 of the plan in the vault note "Review Queue AI Triage Design Spec"). Listens to the single store.onAdd event,
 * computes the safety facts in code, asks the judge (triage-judge.js) only when no code veto already applies, and turns the answer into a verdict
 * with triageOutcome (triage.js). A "handle" verdict only puts the note "AI would have handled this" on the open card and a line in the triage log;
 * NOTHING is ever done to an item or its session, whatever a rule's mode says (auto comes in a later phase). When the user then resolves such a card,
 * the user's action is compared with the proposal and recorded as matched-user / overruled (automatic observe feedback).
 * Runs async after the raise, never blocks it, never throws; any failure leaves a normal card.
 */
import { createHash } from 'node:crypto'
import { riskOf } from './risk.js'
import { needsUser } from './actionable.js'
import { classOf, parseReadOnlyCommand, triageOutcome } from './triage.js'

/** At most this many judge calls at once; an item arriving beyond that stays a normal card (and is logged), so cost and latency stay bounded. */
export const MAX_IN_FLIGHT = 2
const SHELL_TOOL = /shell|bash|powershell|pwsh|cmd|command|exec/i

export const DEFAULT_RULES = [
  { id: 'ro-permission', name: 'Read-only commands', class: 'permission', enabled: true, mode: 'observe', instruction: 'A read-only command that passes the strict parser, inside the workspace: approve.' },
  { id: 'green-done', name: 'Mechanical done messages', class: 'done', enabled: true, mode: 'observe', instruction: 'A done message that only reports passing tests or a finished mechanical step, with no question or follow-up, while the session continues or has remaining task items: handle.' },
]

/** A short hash of what a rule says, so every decision records the version of the rule it was made under. */
export const ruleVersion = (rule) => createHash('sha1').update(JSON.stringify([rule.id, rule.class, rule.instruction ?? '', rule.closedSet ?? null, rule.threshold ?? null])).digest('hex').slice(0, 8)

const norm = (p) => String(p).replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()

/** Every absolute or home path argument of a command lies in the workspace (a command with none is fine). Symlink and 8.3 resolution come with the auto phase. */
export function pathsInside(command, workspace) {
  const root = typeof workspace === 'string' && workspace ? norm(workspace) : ''
  for (const t of String(command ?? '').trim().split(/\s+/).slice(1)) {
    if (t.startsWith('-') || !/^([a-z]:|\/|~)/i.test(t)) continue
    const p = norm(t)
    if (!root || !(p === root || p.startsWith(root + '/'))) return false
  }
  return true
}

/** What CODE finds out about an item, never what the model says. */
export function factsOf(item, { sessionContinuesOf = () => false } = {}) {
  const p = item?.payload ?? {}
  if (item?.type === 'permission') {
    const command = typeof p.detail === 'string' && p.detail ? p.detail : p.summary
    const parsed = SHELL_TOOL.test(String(p.toolName ?? '')) ? parseReadOnlyCommand(command) : { ok: false, reason: 'not a shell tool' }
    const riskFlags = riskOf({ toolName: p.toolName, detail: p.detail, path: p.path, workspace: item.workspace }).map((r) => r.code)
    const inside = pathsInside(command, item.workspace)
    return { riskFlags, safe: parsed.ok && inside && !riskFlags.length, readOnly: parsed.ok, outsideWorkspace: !inside || riskFlags.includes('outside-workspace'), reversible: parsed.ok }
  }
  if (item?.type === 'completed') {
    let continues = false
    try { continues = sessionContinuesOf(item) === true } catch { /* unknown means the session is treated as finished */ }
    return { riskFlags: [], safe: true, needsUser: needsUser(p.reply), sessionContinues: continues }
  }
  return { riskFlags: [], safe: false }
}

/** What the card says the AI would have done. */
export function wouldText(item) {
  if (item?.type === 'permission') return 'approve this read-only command'
  if (item?.type === 'completed') return 'clear this done card as handled'
  return 'handle this'
}

/** The user's action compared with the AI's proposal: 'matched-user' | 'overruled' | undefined (no comparison possible). */
export function feedbackOf(item) {
  const t = item?.triage
  if (!t || t.verdict !== 'handle' || item.status !== 'resolved' || t.review) return undefined
  const kind = item.resolution?.kind
  if (item.type === 'permission') return kind === 'approved' ? 'matched-user' : kind === 'denied' ? 'overruled' : undefined
  if (item.type === 'completed') return kind === 'reviewed' || kind === 'no-action' ? 'matched-user' : kind === 'replied' ? 'overruled' : undefined
  return undefined
}

/**
 * @param {{ store: any, judge: { judge: Function }, triageLog?: { append: Function }, rules?: object[], marksOf?: (item: object) => object,
 *   sourcesOf?: (item: object) => object[], sessionContinuesOf?: (item: object) => boolean, enabled?: () => boolean, log?: (line: string) => void,
 *   now?: () => number, maxInFlight?: number }} deps
 */
export function createTriageRunner({ store, judge, triageLog, rules = DEFAULT_RULES, marksOf = () => ({}), sourcesOf = () => [], sessionContinuesOf, enabled = () => true, log = () => {}, now = Date.now, maxInFlight = MAX_IN_FLIGHT }) {
  const running = new Set()
  let inFlight = 0
  let off = () => {}
  let offChange = () => {}
  const watching = new Set() // ids of open items that carry a "would handle" proposal

  const record = (entry) => { try { triageLog?.append(entry) } catch { /* the log is best effort */ } }
  const stillOpen = (id) => store.get(id)?.status === 'open'

  async function run(item) {
    const cls = classOf(item)
    if (!cls) return
    const mine = rules.filter((r) => r.class === cls && r.enabled !== false && r.mode !== 'off')
    if (!mine.length) return
    const facts = factsOf(item, { sessionContinuesOf })
    // Step 1, code only: a veto that no model answer can lift means no model call at all.
    const pre = triageOutcome({ item, judgment: { needs_decision: false, attention: 0, matched_rule: mine[0].id, answer_basis: 'none' }, rule: mine[0], facts, marks: marksOf(item) })
    const hard = pre.reasons.filter((r) => r !== 'no-rule')
    if (hard.length) { record({ itemId: item.id, type: item.type, stage: 'code-veto', verdict: 'ask', reasons: hard }); return }
    if (inFlight >= maxInFlight) { record({ itemId: item.id, type: item.type, stage: 'skipped', verdict: 'ask', reasons: ['busy'] }); return }
    inFlight++
    let result
    try { result = await judge.judge({ item, rules: mine, sources: sourcesOf(item) }) } catch (error) { result = { note: String(error?.message ?? error) } } finally { inFlight-- }
    if (!result?.judgment) { record({ itemId: item.id, type: item.type, stage: 'judge', verdict: 'ask', reasons: ['no-judgment'], note: result?.note }); return }
    const rule = mine.find((r) => r.id === result.judgment.matched_rule)
    const outcome = triageOutcome({ item, judgment: result.judgment, rule, facts, sources: sourcesOf(item), marks: marksOf(item) })
    const entry = { itemId: item.id, type: item.type, stage: 'judge', verdict: outcome.verdict, mode: 'observe', score: outcome.score, threshold: outcome.threshold, reasons: outcome.reasons, ruleId: rule?.id, ...(rule ? { ruleVersion: ruleVersion(rule) } : {}), judgment: result.judgment }
    // Re-checked after the wait: the item may have been resolved, put on hold or its rule switched off meanwhile.
    if (outcome.verdict !== 'handle' || !stillOpen(item.id) || !enabled() || rule.mode === 'off' || marksOf(item).onHold || marksOf(item).neverAuto) { record(outcome.verdict === 'handle' ? { ...entry, verdict: 'ask', reasons: ['changed-meanwhile'] } : entry); return }
    store.update(item.id, { triage: { mode: 'observe', verdict: 'handle', ruleId: rule.id, ruleName: rule.name, ruleVersion: ruleVersion(rule), score: outcome.score, threshold: outcome.threshold, would: wouldText(item), at: now() } })
    watching.add(item.id)
    record(entry)
    log('triage: would handle ' + item.type + ' ' + item.id + ' (rule ' + rule.id + ', score ' + outcome.score + ')')
  }

  function checkFeedback() {
    for (const id of [...watching]) {
      const item = store.get(id)
      if (!item) { watching.delete(id); continue }
      if (item.status !== 'resolved') continue
      watching.delete(id)
      const review = feedbackOf(item)
      if (!review) continue
      store.update(id, { triage: { ...item.triage, review } })
      record({ itemId: id, type: item.type, stage: 'feedback', ruleId: item.triage.ruleId, ruleVersion: item.triage.ruleVersion, review, resolution: item.resolution?.kind })
    }
  }

  return {
    /** Starts listening (a store without onAdd, such as the hub's read-only mirror, is left alone). */
    start() {
      if (typeof store.onAdd !== 'function') return false
      off = store.onAdd((item) => {
        if (!enabled()) return
        const p = Promise.resolve().then(() => run(item)).catch((error) => log('triage: ' + (error?.message ?? error)))
        running.add(p)
        p.finally(() => running.delete(p))
      })
      offChange = store.onChange(() => { try { checkFeedback() } catch (error) { log('triage: feedback ' + (error?.message ?? error)) } })
      return true
    },
    stop() { off(); offChange() },
    /** Resolves when no triage call is running (tests). */
    async idle() { while (running.size) await Promise.allSettled([...running]) },
  }
}
