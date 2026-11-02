/**
 * Correction memory for AI triage (the vault note "Review Queue AI Triage Design Spec", section "Learning from reversals").
 * When the user reverses what the AI proposed or did, DSH must not make the same mistake again. Two small banks, kept native in this plugin:
 *  - CASE BANK (Memento-style, case-based reasoning): every comparison of an AI proposal with the user's action is one case (what the item was,
 *    what the AI would have done, what the user did). Kept for similarity recall and for the agreement record. Capped, oldest dropped.
 *  - LESSON BANK (ReasoningBank-style): every overrule distils ONE lesson (title, description, content), keyed by rule + item signature, that
 *    counts how often it was overruled. Lessons are what is recalled the next time.
 * Recall is deterministic code (signature match and token overlap), never the model. A strong match is a code VETO ("past-correction"): the item stays
 * a normal card and says so. A weaker match is handed to the judge as cautionary context only, so it can make the model more careful, never less.
 * A lesson retires when the user later does what the AI would have done on an item the lesson held back (the lesson was too strict), or after
 * LESSON_ACTIVE_MS without being met. Everything stored is redacted first. Best effort: a storage problem never reaches the caller.
 */
import { classOf } from './triage.js'
import { redact, redactDeep } from './triage-log.js'

export const MAX_CASES = 300
export const MAX_LESSONS = 100
export const LESSON_ACTIVE_MS = 180 * 24 * 3600 * 1000
/** Token overlap at or above this (with the same class) is a code veto; at or above CONTEXT_SIMILARITY it is context for the judge. */
export const VETO_SIMILARITY = 0.6
export const CONTEXT_SIMILARITY = 0.3
const MAX_CONTEXT = 3
const MAX_TOKENS = 40
const MAX_EXAMPLE = 300
const VERSION = 1
const STOP = new Set('the a an and or of to in on for with is are was were be been it this that these those at by from as not no yes do does did done have has had will would can could should i you we they he she my your our its into out up down over under then than so if else when while about after before again also just only more most some any all redacted'.split(' '))

/** Lower-case word tokens of a text (stop words and one-letter words dropped), at most MAX_TOKENS distinct. */
export function tokensOf(text) {
  const seen = new Set()
  for (const w of String(text ?? '').toLowerCase().split(/[^\p{L}\p{N}_.-]+/u)) {
    const t = w.replace(/^[.-]+|[.-]+$/g, '')
    if (t.length > 1 && !STOP.has(t)) seen.add(t)
    if (seen.size >= MAX_TOKENS) break
  }
  return [...seen]
}

export function jaccard(a, b) {
  if (!a.length || !b.length) return 0
  const sb = new Set(b)
  let hit = 0
  for (const t of new Set(a)) if (sb.has(t)) hit++
  return hit / (new Set(a).size + sb.size - hit)
}

const oneLine = (v) => String(v ?? '').replace(/\s+/g, ' ').trim()

/** The text of an item that decides what it is about (what recall compares). Redacted here, so no token, signature or example can ever hold a secret. */
export function itemText(item) {
  return redact(rawText(item))
}

function rawText(item) {
  const p = item?.payload ?? {}
  if (item?.type === 'permission') return [p.toolName, p.detail || p.summary, p.reason].filter(Boolean).join(' ')
  if (item?.type === 'completed') return [p.request, String(p.reply ?? '').slice(-600)].filter(Boolean).join(' ')
  if (item?.type === 'question') return (Array.isArray(p.questions) ? p.questions : []).map((q) => q?.question).filter(Boolean).join(' ')
  if (item?.type === 'paused') return [p.reason, p.lastUser].filter(Boolean).join(' ')
  return ''
}

/** A short stable key: for a permission the tool and command (git: and its subcommand); for the rest the class and its leading words. */
export function signatureOf(item) {
  const cls = classOf(item) ?? String(item?.type ?? 'item')
  if (item?.type === 'permission') {
    const p = item.payload ?? {}
    const t = oneLine(p.detail || p.summary).toLowerCase().split(' ')
    const bin = t[0] || ''
    return String(p.toolName ?? '').toLowerCase() + ':' + bin + (bin === 'git' && t[1] ? ' ' + t[1] : '')
  }
  return cls + ':' + tokensOf(itemText(item)).slice(0, 3).sort().join('+')
}

const clipText = (v, n) => { const t = oneLine(v); return t.length > n ? t.slice(0, n) + '…' : t }
const day = (ms) => new Date(ms).toISOString().slice(0, 10)

/**
 * @param {{ io?: { read: () => string | undefined, write: (text: string) => void }, now?: () => number, maxCases?: number, maxLessons?: number }} [opts]
 */
export function createTriageMemory({ io, now = Date.now, maxCases = MAX_CASES, maxLessons = MAX_LESSONS } = {}) {
  let data = { v: VERSION, seq: 0, cases: [], lessons: [] }
  try {
    const text = io?.read()
    const parsed = text ? JSON.parse(text) : undefined
    if (parsed && parsed.v === VERSION && Array.isArray(parsed.cases) && Array.isArray(parsed.lessons)) data = { seq: 0, ...parsed }
  } catch { /* a missing or garbled file starts an empty memory */ }

  const save = () => { try { io?.write(JSON.stringify(data)) } catch { /* best effort */ } }
  const active = (l) => l.overruled > l.agreed && now() - l.lastAt < LESSON_ACTIVE_MS
  const summary = (l, similarity) => ({ id: l.id, title: l.title, content: l.content, count: l.overruled, lastAt: l.lastAt, ruleId: l.ruleId, similarity })

  function lessonFor(item, ruleId, signature, example, tokens) {
    const sig = signature
    const what = item.type === 'permission' ? 'the command "' + sig.split(':').slice(1).join(':') + '"' : 'a ' + (classOf(item) ?? item.type) + ' item like "' + clipText(example, 80) + '"'
    return {
      id: 'l' + (++data.seq), ruleId, signature: sig, class: classOf(item), tokens: [...tokens],
      title: 'Keep ' + what + ' for the user',
      description: 'The AI proposed to handle ' + what + ' under rule ' + ruleId + ' and the user reversed it.',
      content: 'When an item matches ' + what + ' (rule ' + ruleId + '), ask the user instead of proposing to handle it.',
      examples: [], overruled: 0, agreed: 0, confirmed: 0, firstAt: now(), lastAt: now(),
    }
  }

  return {
    /**
     * Records one comparison of an AI proposal with the user's action. item carries triage { ruleId, ruleVersion, would, score } and resolution.
     * review: 'overruled' (the user did something else: a lesson is learned) | 'matched-user' (the user agreed: a case only, and an agreement on a matching lesson).
     * source: 'observe' (automatic) | 'mark-wrong' | 'overrule-rule' (the Resolved by AI buttons of phase 3 use the same entry).
     * @returns {{ case: object, lesson?: { id: string, title: string } } | undefined}
     */
    record({ item, review, source = 'observe' }) {
      try {
        const t = item?.triage
        if (!t || (review !== 'overruled' && review !== 'matched-user')) return undefined
        const text = redactDeep(clipText(itemText(item), 600))
        const tokens = tokensOf(itemText(item))
        const signature = signatureOf(item)
        const c = {
          id: 'c' + (++data.seq), at: now(), source, review, class: classOf(item), type: item.type, ruleId: t.ruleId, ruleVersion: t.ruleVersion, signature, tokens,
          text: clipText(text, MAX_EXAMPLE), proposal: t.would, score: t.score, userAction: item.resolution?.kind,
        }
        data.cases.push(c)
        while (data.cases.length > maxCases) data.cases.shift()
        let lesson = data.lessons.find((l) => l.ruleId === t.ruleId && l.signature === signature)
        if (review === 'overruled') {
          if (!lesson) {
            lesson = lessonFor(item, t.ruleId, signature, text, tokens)
            data.lessons.push(lesson)
            while (data.lessons.length > maxLessons) data.lessons.sort((a, b) => b.lastAt - a.lastAt).pop()
          }
          lesson.overruled++
          lesson.lastAt = now()
          lesson.tokens = [...new Set([...lesson.tokens, ...tokens])].slice(0, MAX_TOKENS)
          lesson.examples = [...lesson.examples, { at: now(), text: clipText(text, MAX_EXAMPLE), userAction: item.resolution?.kind, source }].slice(-3)
        } else if (lesson) lesson.agreed++
        save()
        return { case: c, ...(lesson && review === 'overruled' ? { lesson: { id: lesson.id, title: lesson.title } } : {}) }
      } catch { return undefined }
    },
    /**
     * What the memory says about a new item: { veto?, context[] }. veto = the strongest ACTIVE lesson of one of the given rules whose signature equals the
     * item's or whose tokens overlap at VETO_SIMILARITY or more; context = up to three weaker matches for the judge (cautionary data only).
     */
    recall(item, ruleIds) {
      try {
        const cls = classOf(item)
        const sig = signatureOf(item)
        const tokens = tokensOf(itemText(item))
        const scored = data.lessons
          .filter((l) => active(l) && l.class === cls && (!ruleIds || ruleIds.includes(l.ruleId)))
          .map((l) => ({ l, sim: l.signature === sig ? 1 : jaccard(tokens, l.tokens) }))
          .filter((x) => x.sim >= CONTEXT_SIMILARITY)
          .sort((a, b) => b.sim - a.sim || b.l.lastAt - a.l.lastAt)
        const top = scored[0]
        const veto = top && top.sim >= VETO_SIMILARITY ? summary(top.l, top.sim) : undefined
        const context = scored.filter((x) => !veto || x.l.id !== veto.id).slice(0, MAX_CONTEXT).map((x) => summary(x.l, x.sim))
        return { ...(veto ? { veto } : {}), context }
      } catch { return { context: [] } }
    },
    /** The user did what the AI would have done on an item this lesson held back: the lesson was too strict (it retires when agreed catches up with overruled). */
    agree(lessonId) {
      const l = data.lessons.find((x) => x.id === lessonId)
      if (!l) return false
      l.agreed++
      save()
      return true
    },
    /** The user did something else than the AI would have on an item this lesson held back: the lesson was right. */
    confirm(lessonId) {
      const l = data.lessons.find((x) => x.id === lessonId)
      if (!l) return false
      l.confirmed++
      l.lastAt = now()
      save()
      return true
    },
    /** Deletes a lesson (the user says it is wrong); true when it existed. */
    forget(lessonId) {
      const n = data.lessons.length
      data.lessons = data.lessons.filter((l) => l.id !== lessonId)
      if (data.lessons.length === n) return false
      save()
      return true
    },
    lessons: () => data.lessons.map((l) => ({ ...summary(l, undefined), description: l.description, agreed: l.agreed, confirmed: l.confirmed, active: active(l), since: day(l.firstAt) })),
    cases: () => data.cases.map((c) => ({ ...c })),
  }
}
