/**
 * Stage two of the voice flow: turns ONE confirmed utterance into ONE raw action object using a small fast model
 * through DSH's own LLM service. The result is still unvalidated (see actions.js validateAction).
 * decide() resolves { ok:true, raw, model } or { ok:false, error:'timeout'|'llm'|'unparseable', model? } and never rejects;
 * model is the model that answered (logged by the flow as decide.end, spec §6).
 */

const PREFER = [/haiku/i, /flash|mini|lite|small|fast|nano/i]
const MAX_SLASH = 30

const SYSTEM = `You turn ONE spoken request (speech-recognised, maybe misheard, English or Chinese) from a blind user into exactly ONE action for a coding-assistant app. Reply with ONE line of JSON, no prose.
Actions (pick exactly one):
{"action":"switch","session":"s2"} - talk to that session from now on.
{"action":"prompt","session":"s1","text":"..."} - send the user's instruction to the coding agent in that session.
{"action":"new","text":"..."} - start a new session; text is an optional first prompt.
{"action":"approve","session":"s1"} - allow the pending permission request in that session.
{"action":"deny","session":"s1"} - reject the pending permission request in that session.
{"action":"cancel","session":"s1"} - stop the run in progress in that session.
{"action":"slash","session":"s1","name":"compact","args":"..."} - run a slash command; args are optional.
{"action":"clarify","question":"..."} - ask the user ONE short question.
Rules:
- Instructions about code, files, tests or the task itself are "prompt": keep the user's wording (light clean-up only) and do not answer or do the task yourself.
- Use the session handle ("s1", "s2", ...) of the session the user names; otherwise omit "session" and the app picks the default.
- Use "approve" or "deny" only when the user clearly asks for it and that session has a pending request.
- Use "slash" only with a name from the slash list.
- If the target or the intent is genuinely unclear, use "clarify" with a short yes/no or either/or question. "history" holds earlier questions and the user's utterances.
- Never invent sessions, commands or requests.`

/** A preferred fast model (haiku, then flash/mini/...), else the first model any provider lists. */
async function pickModel(llm, override) {
  if (override?.provider && override?.model) return override
  const all = []
  for (const p of llm.listProviders()) {
    try {
      for (const m of await llm.listModels(p.id)) all.push({ provider: p.id, model: m.id, name: m.id + ' ' + (m.name ?? '') })
    } catch { /* a provider that cannot list its models is skipped */ }
  }
  for (const re of PREFER) {
    const hit = all.find((m) => re.test(m.name))
    if (hit) return hit
  }
  return all[0]
}

/** The JSON object between the first '{' and the last '}' of a reply (prose or code fences around it are ignored). */
export function parseReply(text) {
  const a = text.indexOf('{')
  const b = text.lastIndexOf('}')
  if (a < 0 || b <= a) return undefined
  try {
    const obj = JSON.parse(text.slice(a, b + 1))
    return obj && typeof obj === 'object' && !Array.isArray(obj) ? obj : undefined
  } catch {
    return undefined
  }
}

/** The user message: utterance, clarify history, session handles (never raw ids) and the target's slash list. */
function payload(utterance, history, ctx = {}) {
  return JSON.stringify({
    utterance,
    history: Array.isArray(history) ? history : [],
    sessions: (ctx.sessions ?? []).map((s) => ({
      handle: s.handle,
      title: s.title,
      selected: Boolean(s.selected),
      lastAlerted: Boolean(s.lastAlerted),
      pending: s.pending ?? null,
    })),
    slash: (ctx.slash ?? []).slice(0, MAX_SLASH),
  })
}

export function createDecider({ llm, model: override, timeoutMs = 8000, maxTokens = 1500, log = () => {}, now = Date.now, context = () => ({}) } = {}) {
  let chosen

  /** Streams the model's whole reply text; throws on any failure to call it. */
  async function call(utterance, history, signal) {
    if (!llm) throw new Error('no LLM service')
    chosen ??= pickModel(llm, override)
    const m = await chosen
    if (!m) throw new Error('no model available')
    const prepared = await llm.prepareCall({ provider: m.provider, model: m.model, maxTokens }, signal)
    let out = ''
    for await (const chunk of prepared.stream({
      ...prepared.config,
      system: SYSTEM,
      messages: [{ role: 'user', content: [{ type: 'text', text: payload(utterance, history, context()) }] }],
      signal,
    })) {
      if (chunk.type === 'text-delta') out += chunk.text
    }
    return { out, model: m.model }
  }

  return {
    async decide(utterance, { history = [] } = {}) {
      const started = now()
      const ac = new AbortController()
      let timer
      // The global setTimeout is looked up per call so test mock timers drive it; firing aborts the model call.
      const deadline = new Promise((resolve) => {
        timer = setTimeout(() => { ac.abort(); resolve({ timedOut: true }) }, timeoutMs)
      })
      const work = call(utterance, history, ac.signal).then((r) => r, (error) => ({ error }))
      try {
        const r = await Promise.race([work, deadline])
        if (r.timedOut) return done({ ok: false, error: 'timeout' }, started)
        if (r.error) {
          // No backoff: the next request re-resolves the model and really calls it again.
          chosen = undefined
          log('decider: ' + (r.error?.message ?? r.error))
          return done({ ok: false, error: 'llm' }, started)
        }
        const raw = parseReply(r.out)
        if (!raw) log('decider: unparseable reply from ' + r.model + ': ' + r.out.slice(0, 120))
        return done(raw ? { ok: true, raw } : { ok: false, error: 'unparseable' }, started, r.model)
      } finally {
        clearTimeout(timer)
      }
    },
  }

  function done(result, started, model) {
    log('decider: ' + (result.ok ? 'ok' : result.error) + ' in ' + (now() - started) + ' ms' + (model ? ' (' + model + ')' : ''))
    return model ? { ...result, model } : result
  }
}
