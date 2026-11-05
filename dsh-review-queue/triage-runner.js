/**
 * AI triage, OBSERVE mode only (phase 2 of the plan in the vault note "Review Queue AI Triage Design Spec"). Listens to the single store.onAdd event,
 * computes the safety facts in code, asks the judge (triage-judge.js) only when no code veto already applies, and turns the answer into a verdict
 * with triageOutcome (triage.js). A "handle" verdict only puts the note "AI would have handled this" on the open card and a line in the triage log;
 * NOTHING is ever done to an item or its session, whatever a rule's mode says (auto comes in a later phase). When the user then resolves such a card,
 * the user's action is compared with the proposal and recorded as matched-user / overruled (automatic observe feedback).
 * Runs async after the raise, never blocks it, never throws; any failure leaves a normal card.
 */
import { createHash } from 'node:crypto'
import { riskOf, AUTO_SHELL_TOOLS } from './risk.js'
import { needsUser, needsUserForTriage } from './actionable.js'
import { RAW_MAX, RAW_PRECLIP, oneLine } from './triage-judge.js'
import { hasActionItem } from './auto-clear.js'
import { classOf, parseReadOnlyCommand, triageOutcome } from './triage.js'
import { redact } from './triage-log.js'
import { commandIntact, containedInWorkspace, plantedBinary } from './triage-paths.js'
import { clipAnswer } from './triage-clip.js'

export { clipAnswer }

/** At most this many judge calls at once; an item arriving beyond that stays a normal card (and is logged), so cost and latency stay bounded. */
export const MAX_IN_FLIGHT = 2
const SHELL_TOOL = /shell|bash|powershell|pwsh|cmd|command|exec/i

export const DEFAULT_RULES = [
  { id: 'ro-permission', name: 'Read-only commands', class: 'permission', enabled: true, mode: 'observe', instruction: 'A read-only command that passes the strict parser, inside the workspace: approve.' },
  { id: 'green-done', name: 'Mechanical done messages', class: 'done', enabled: true, mode: 'observe', instruction: 'A done message that only reports passing tests or a finished mechanical step, with no question or follow-up: handle.' },
  { id: 'straightforward-question', name: 'Straightforward questions', class: 'question', enabled: true, mode: 'observe', instruction: 'A question with one clearly recommended option, where the user already asked for exactly that action earlier in the session: propose that option as the answer. The answer must rest on a quote the user wrote (a user-authored source); never answer a choice of direction, scope or taste.' },
]

/** A hash of the payload fields that matter for acting (never the summary, which arrives later), so a change between judge and act is seen. */
export function payloadFingerprint(item) {
  const p = item?.payload ?? {}
  const fields = item?.type === 'permission' ? [p.toolName, p.detail, p.path, p.callId]
    : item?.type === 'question' ? [(Array.isArray(p.questions) ? p.questions : []).map((q) => [q?.question, (Array.isArray(q?.options) ? q.options : []).map((o) => o?.label)]), p.callId]
      : item?.type === 'completed' ? [p.reply, p.request] : []
  return createHash('sha1').update(JSON.stringify([item?.type, ...fields])).digest('hex')
}

/** A short hash of what a rule says, so every decision records the version of the rule it was made under. */
export const ruleVersion = (rule) => createHash('sha1').update(JSON.stringify([rule.id, rule.class, rule.instruction ?? '', rule.closedSet ?? null, rule.threshold ?? null])).digest('hex').slice(0, 8)

/** An error message for the log: secrets redacted, one line, capped. */
const safeMsg = (e) => oneLine(redact(String(e?.message ?? e))).slice(0, 300)

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
    // Auto only: the stricter parser, an exact shell tool name, and no tool arguments besides the command (the fingerprint and the judgment only cover the command).
    // Auto trusts a shell tool by exact name only; a tool that merely has "exec" or "command" in its name is not trusted to run a plain command.
    const autoCommandOk = AUTO_SHELL_TOOLS.has(String(p.toolName ?? '').toLowerCase()) && p.extraArgs !== true && parseReadOnlyCommand(command, { auto: true }).ok
    return { riskFlags, commandIntact: commandIntact(p), autoCommandOk, safe: parsed.ok && inside && !riskFlags.length, readOnly: parsed.ok, outsideWorkspace: !inside || riskFlags.includes('outside-workspace'), reversible: parsed.ok }
  }
  if (item?.type === 'completed') {
    let continues = false
    try { continues = sessionContinuesOf(item) === true } catch { /* unknown means the session is treated as finished */ }
    return { riskFlags: [], safe: true, needsUser: needsUser(p.reply), needsUserObserve: needsUserForTriage(p.reply), sessionContinues: continues, actionItem: item.actionable === true || hasActionItem(item.summary), summaryPending: item.summarySource === undefined || item.summarySource === 'fallback' }
  }
  // One question only: with several, a single answer cannot be proposed for the card.
  // questionSimple (read by auto only): one question with options, single choice, no presentation intent, still live (not detached), reachable by its call id.
  if (item?.type === 'question') {
    const one = Array.isArray(p.questions) && p.questions.length === 1
    const q = one ? p.questions[0] : undefined
    const questionSimple = one && Array.isArray(q?.options) && q.options.length >= 1 && !q.multiSelect && q.intent === undefined && item.detached !== true && p.callId !== undefined && p.callId !== null && p.callId !== ''
    return { riskFlags: [], safe: one, questionSimple }
  }
  return { riskFlags: [], safe: false }
}

/** What the card says the AI would have done; a question proposal quotes the answer (capped, it is model text). */
export function wouldText(item, { answer } = {}) {
  if (item?.type === 'question') return 'answer \"' + String(answer ?? '').slice(0, 120) + '\"'
  if (item?.type === 'permission') return 'approve this read-only command'
  if (item?.type === 'completed') return 'clear this done card as handled'
  return 'handle this'
}

/** The answer the user gave to a one-question item: the chosen labels joined, or the typed text. */
const givenAnswer = (a) => (Array.isArray(a?.selected) && a.selected.length ? a.selected.join(', ') : String(a?.custom ?? ''))
const same = (a, b) => String(a).trim().toLowerCase() === String(b).trim().toLowerCase()

/** A question item: did the user answer what the AI proposed? undefined unless the user answered or confirmed it. */
function answeredAsProposed(item) {
  const { kind, answers } = item.resolution ?? {}
  if ((kind !== 'answered' && kind !== 'confirmed') || typeof item.triage?.answer !== 'string' || !Array.isArray(answers) || !answers.length) return undefined
  return same(givenAnswer(answers[0]), item.triage.answer)
}

/** Did the user do what the AI would have done? true | false | undefined (no comparison possible: cancelled, expired, a type triage does not judge). */
export function userDidWhatAiWould(item) {
  const kind = item?.resolution?.kind
  if (item?.type === 'permission') return kind === 'approved' ? true : kind === 'denied' ? false : undefined
  if (item?.type === 'completed') return kind === 'reviewed' || kind === 'no-action' ? true : kind === 'replied' ? false : undefined
  if (item?.type === 'question') return answeredAsProposed(item)
  return undefined
}

/** The user's action compared with the AI's proposal: 'matched-user' | 'overruled' | undefined (no comparison possible). */
export function feedbackOf(item) {
  const t = item?.triage
  if (!t || t.verdict !== 'handle' || item.status !== 'resolved' || t.review) return undefined
  const same = userDidWhatAiWould(item)
  return same === undefined ? undefined : same ? 'matched-user' : 'overruled'
}

/**
 * A card the AI held back because of a past correction, compared with what the user then did: 'lesson-confirmed' (the user did NOT do what the AI
 * would have: the lesson was right) | 'lesson-too-strict' (the user did what the AI would have: the lesson held back something fine) | undefined.
 */
export function lessonFeedbackOf(item) {
  const t = item?.triage
  if (!t || t.reason !== 'past-correction' || item.status !== 'resolved' || t.review) return undefined
  const same = userDidWhatAiWould(item)
  return same === undefined ? undefined : same ? 'lesson-too-strict' : 'lesson-confirmed'
}


/**
 * @param {{ store: any, judge: { judge: Function }, triageLog?: { append: Function }, rules?: object[], marksOf?: (item: object) => object,
 *   sourcesOf?: (item: object) => object[] | Promise<object[]>, sessionContinuesOf?: (item: object) => boolean, enabled?: () => boolean, log?: (line: string) => void,
 *   now?: () => number, maxInFlight?: number, memory?: ReturnType<import('./triage-memory.js').createTriageMemory> }} deps
 *   memory: the correction memory. A strong match with a past reversal is a code veto before any model call; weaker matches go to the judge as cautionary context.
 */
export function createTriageRunner({ store, judge, triageLog, memory, rules = DEFAULT_RULES, marksOf = () => ({}), sourcesOf = () => [], sessionContinuesOf, actors = {}, enabled = () => true, log = () => {}, now = Date.now, maxInFlight = MAX_IN_FLIGHT }) {
  const rulesNow = () => (typeof rules === 'function' ? rules() : rules) // a function is read at each use, so a mode change applies without a restart
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
    const mine = rulesNow().filter((r) => r.class === cls && r.enabled !== false && r.mode !== 'off')
    if (!mine.length) return
    const judgedPrint = payloadFingerprint(item)
    const facts = factsOf(item, { sessionContinuesOf })
    // Step 1, code only: a veto that no model answer can lift means no model call at all.
    const pre = triageOutcome({ item, judgment: { needs_decision: false, attention: 0, matched_rule: mine[0].id, answer_basis: 'none' }, rule: mine[0], facts, marks: marksOf(item), relax: { sessionFinished: true } })
    // The log says what the verdict that entry records was based on: the raise-time facts for the pre-check, the verdict's own facts after the judge.
    const doneExtraOf = (f) => (cls === 'done' ? { sessionContinues: f.sessionContinues === true } : {})
    // For a question the pre-check judgment has no answer yet, so its missing basis is no veto.
    // The auto-only summary vetoes are judged after the model call: the summary usually arrives later than the card.
    // Fail-safe: pre is judged against mine[0] only. If another rule would not carry that veto, a wasted model call is the worst case;
    // an auto-only veto dropped here is judged again, with the real rule and judgment, before anything is acted on.
    // An item that is itself marked actionable keeps the action-item veto here (no model call can lift it); the summary-derived part waits for the summary.
    const hard = pre.reasons.filter((r) => r !== 'no-rule' && r !== 'outside-workspace-real' && !(r === 'action-item' && item.actionable !== true) && r !== 'summary-pending' && !(cls === 'question' && r === 'no-basis'))
    if (hard.length) { record({ itemId: item.id, type: item.type, stage: 'code-veto', verdict: 'ask', reasons: hard, ...doneExtraOf(facts) }); return }
    // Learning from reversals: the user reversed a similar AI proposal before. Code decides, not the model: the card stays a normal card and says why.
    let recalled = { context: [] }
    try { recalled = memory?.recall(item, mine.map((r) => r.id)) ?? recalled } catch { /* memory is best effort */ }
    if (recalled.veto) {
      const lesson = { id: recalled.veto.id, title: recalled.veto.title, count: recalled.veto.count, lastAt: recalled.veto.lastAt }
      if (stillOpen(item.id)) store.update(item.id, { triage: { mode: 'observe', verdict: 'ask', reason: 'past-correction', lesson, at: now() } })
      watching.add(item.id)
      record({ itemId: item.id, type: item.type, stage: 'memory-veto', verdict: 'ask', reasons: ['past-correction'], lessonId: lesson.id, similarity: recalled.veto.similarity })
      log('triage: held back ' + item.type + ' ' + item.id + ' (past correction ' + lesson.id + ')')
      return
    }
    if (inFlight >= maxInFlight) { record({ itemId: item.id, type: item.type, stage: 'skipped', verdict: 'ask', reasons: ['busy'] }); return }
    inFlight++
    let result
    let sources = []
    let switchedOff = false
    // The slot is released in this finally whatever happens inside (a throwing switch included); nothing after the model call holds it.
    try {
      try { sources = (await sourcesOf(item)) ?? [] } catch { /* no sources means no admissible quote */ }
      // The switch may have gone off while the run waited: no model call then. A check that throws counts as off.
      let on = false
      try { on = enabled() } catch { /* fail closed */ }
      if (!on) switchedOff = true
      else try { result = await judge.judge({ item, rules: mine, sources, lessons: recalled.context }) } catch (error) { result = { note: String(error?.message ?? error) } }
    } finally { inFlight-- }
    if (switchedOff) { record({ itemId: item.id, type: item.type, stage: 'skipped', verdict: 'ask', reasons: ['off'] }); return }
    if (!result?.judgment) {
      const raw = oneLine(redact(String(result?.raw ?? '').slice(0, RAW_PRECLIP))).slice(0, RAW_MAX)
      record({ itemId: item.id, type: item.type, stage: 'judge', verdict: 'ask', reasons: ['no-judgment'], note: result?.note, ...(raw ? { raw } : {}) })
      return
    }
    const rule = mine.find((r) => r.id === result.judgment.matched_rule)
    // An auto verdict reads the card as it is after the judge (its summary and session state may have arrived meanwhile); observe keeps the facts of the raise.
    const latest = store.get(item.id)
    let verdictFacts = rule?.mode === 'auto' && latest ? factsOf(latest, { sessionContinuesOf }) : facts
    // Auto, permission: the real-path containment is async I/O, so it is computed here as one more fact (never for observe).
    if (rule?.mode === 'auto' && latest && cls === 'permission') {
      const p = latest.payload ?? {}
      const cmdText = typeof p.detail === 'string' && p.detail ? p.detail : p.summary
      const bin = String(cmdText ?? '').trim().split(/\s+/)[0]
      // A workspace file named like the binary (cmd.exe runs the current directory first) fails the same fact as a path outside the workspace.
      verdictFacts = { ...verdictFacts, pathsContained: verdictFacts.readOnly === true && await containedInWorkspace(cmdText, latest.workspace, undefined, bin) && !(await plantedBinary(latest.workspace, bin)) }
    }
    const outcome = triageOutcome({ item, judgment: result.judgment, rule, facts: verdictFacts, sources, marks: marksOf(item), relax: { sessionFinished: true } })
    const entry = { itemId: item.id, type: item.type, stage: 'judge', verdict: outcome.verdict, mode: rule?.mode ?? 'observe', score: outcome.score, threshold: outcome.threshold, reasons: outcome.reasons, ruleId: rule?.id, ...(rule ? { ruleVersion: ruleVersion(rule) } : {}), judgment: result.judgment, ...doneExtraOf(verdictFacts) }
    // Re-checked after the wait: the item may have been resolved, put on hold or its rule switched off meanwhile.
    const fresh = store.get(item.id) // the item as it is now, not as it was when it was raised
    const marks = fresh ? marksOf(fresh) : {}
    if (outcome.verdict !== 'handle' || fresh?.status !== 'open' || !enabled() || rule.mode === 'off' || marks.onHold || marks.neverAuto) { record(outcome.verdict === 'handle' ? { ...entry, verdict: 'ask', reasons: ['changed-meanwhile'] } : entry); return }
    if (outcome.act === true && rule.mode === 'auto' && typeof actors[cls] === 'function') { record(entry); await actOn({ item, cls, rule, outcome, judgment: result.judgment, sources, judgedPrint }); return }
    store.update(item.id, { triage: { mode: 'observe', verdict: 'handle', ruleId: rule.id, ruleName: rule.name, ruleVersion: ruleVersion(rule), score: outcome.score, threshold: outcome.threshold, would: wouldText(item, { answer: result.judgment.answer }), ...(cls === 'question' ? { answer: clipAnswer(result.judgment.answer) } : {}), at: now(), ...(recalled.context.length ? { considered: recalled.context.map((l) => ({ id: l.id, title: l.title, count: l.count, lastAt: l.lastAt })) } : {}) } })
    watching.add(item.id)
    record(entry)
    log('triage: would handle ' + item.type + ' ' + item.id + ' (rule ' + rule.id + ', score ' + outcome.score + ')')
  }

  /** The act step: every check is repeated in one synchronous stretch right before the actor is called; whatever goes wrong leaves an ordinary open card. */
  async function actOn({ item, cls, rule, outcome, judgment, sources, judgedPrint }) {
    const base = { itemId: item.id, type: item.type, stage: 'act', mode: 'auto', ruleId: rule.id, ruleVersion: ruleVersion(rule), score: outcome.score, threshold: outcome.threshold }
    const refuse = (reason, result = 'refused') => record({ ...base, result, reason })
    const fresh = store.get(item.id)
    const marks = fresh ? marksOf(fresh) : {}
    const live = rulesNow().find((r) => r.id === rule.id)
    if (fresh?.status !== 'open' || payloadFingerprint(fresh) !== judgedPrint || !enabled() || live?.mode !== 'auto' || live.enabled === false || marks.onHold || marks.neverAuto) return refuse('changed-meanwhile')
    // The same live getters, read again by an actor right before it decides (after its own awaits): open, switch on, rule still auto, no user marks. Throws count as no.
    const stillAllowed = () => {
      try {
        const now2 = store.get(item.id)
        const m = now2 ? marksOf(now2) : {}
        const l = rulesNow().find((r) => r.id === rule.id)
        return now2?.status === 'open' && enabled() === true && l?.mode === 'auto' && l.enabled !== false && !m.onHold && !m.neverAuto
      } catch { return false }
    }
    const str = (v, cap) => (typeof v === 'string' ? v.slice(0, cap) : undefined)
    const basis = judgment.answer_basis
    const quoted = basis !== 'recommended-option' // the recommended-option basis rests on no quote, so none is recorded even if the model sent one
    const resolutionBase = { kind: 'ai-resolved', by: 'ai', ruleId: rule.id, ruleVersion: base.ruleVersion, threshold: outcome.threshold, score: outcome.score, decidedAt: now(), basis, ...(quoted && str(judgment.evidence_source, 100) ? { evidenceSource: judgment.evidence_source.slice(0, 100) } : {}), ...(quoted && str(judgment.evidence_quote, 300) ? { quote: redact(judgment.evidence_quote.slice(0, 300)) } : {}) }
    const p = fresh.payload ?? {}
    let res
    try { res = await actors[cls]({ item: fresh, rule, outcome, judgment, sources, resolutionBase, stillAllowed }) } catch (error) { log('triage: actor ' + cls + ' ' + item.id + ' failed: ' + safeMsg(error)); return refuse('error') }
    if (res?.ok !== true) { const reason = typeof res?.reason === 'string' ? res.reason.slice(0, 100) : 'refused'; return refuse(reason, reason === 'not-pending' || reason === 'lost-race' ? 'lost-race' : 'refused') }
    const answer = typeof res.answer === 'string' ? clipAnswer(res.answer) : undefined
    const preState = { type: fresh.type, ...(fresh.sessionId ? { sessionId: fresh.sessionId } : {}), ...(p.toolName ? { toolName: p.toolName } : {}), ...(typeof p.detail === 'string' ? { command: redact(p.detail).slice(0, 500) } : {}), ...(typeof p.questions?.[0]?.question === 'string' ? { question: redact(p.questions[0].question).slice(0, 300) } : {}), ...(answer ? { answer: redact(answer).slice(0, 200) } : {}), summaryHead: redact(String(p.summary ?? '')).slice(0, 200) }
    record({ ...base, result: 'done', action: res.action, basis: res.basis ?? basis, preState })
    log('triage: ' + (res.action ?? 'handled') + ' ' + item.type + ' ' + item.id + ' (rule ' + rule.id + ')')
  }

  function checkFeedback() {
    for (const id of [...watching]) {
      const item = store.get(id)
      if (!item) { watching.delete(id); continue }
      if (item.status !== 'resolved') continue
      watching.delete(id)
      const lessonReview = lessonFeedbackOf(item)
      if (lessonReview) {
        // The AI held this back because of a past correction: what the user did says whether that lesson was right.
        try { if (lessonReview === 'lesson-confirmed') memory?.confirm(item.triage.lesson?.id); else memory?.agree(item.triage.lesson?.id) } catch { /* best effort */ }
        store.update(id, { triage: { ...item.triage, review: lessonReview } })
        record({ itemId: id, type: item.type, stage: 'feedback', lessonId: item.triage.lesson?.id, review: lessonReview, resolution: item.resolution?.kind })
        continue
      }
      const review = feedbackOf(item)
      if (!review) continue
      // Every comparison is a case; an overrule also distils a lesson, so the same mistake is not proposed again.
      let learned
      try { learned = memory?.record({ item, review, source: 'observe' }) } catch { /* best effort */ }
      store.update(id, { triage: { ...item.triage, review, ...(learned?.lesson ? { learned: learned.lesson } : {}) } })
      record({ itemId: id, type: item.type, stage: 'feedback', ruleId: item.triage.ruleId, ruleVersion: item.triage.ruleVersion, review, resolution: item.resolution?.kind, ...(learned?.lesson ? { lessonId: learned.lesson.id } : {}) })
    }
  }

  return {
    /** Starts listening (a store without onAdd, such as the hub's read-only mirror, is left alone). */
    start() {
      if (typeof store.onAdd !== 'function') return false
      // A proposal made before a restart still gets its feedback: seed the watch list from the open items that carry one.
      try { for (const i of store.list({ status: 'open' })) if ((i.triage?.verdict === 'handle' || i.triage?.reason === 'past-correction') && !i.triage.review) watching.add(i.id) } catch { /* nothing to seed */ }
      off = store.onAdd((item) => {
        if (!enabled()) return
        const p = Promise.resolve().then(() => run(item)).catch((error) => log('triage: ' + safeMsg(error)))
        running.add(p)
        p.finally(() => running.delete(p))
      })
      offChange = store.onChange(() => { try { checkFeedback() } catch (error) { log('triage: feedback ' + safeMsg(error)) } })
      return true
    },
    stop() { off(); offChange() },
    /** Resolves when no triage call is running (tests). */
    async idle() { while (running.size) await Promise.allSettled([...running]) },
  }
}
