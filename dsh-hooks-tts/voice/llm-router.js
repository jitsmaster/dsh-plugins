import { commandCatalog, makeMatch } from './commands.js'

const PREFER = [/haiku/i, /flash|mini|lite|small|fast|nano/i]

const SYSTEM = `You route one spoken utterance (already transcribed, possibly with recognition errors, in English or Chinese) for a voice-controlled coding assistant.
Decide whether the user is giving a CONTROL COMMAND for the app, or DICTATING text meant for the coding agent.
Reply with ONE line of JSON and nothing else: {"id": <command id or "dictation">, "target": <session name the user named, optional>, "text": <string arg>, "number": <int arg>, "preset": <string arg>}.
Rules:
- Use a command only when the user clearly asks the app to do that thing. Instructions about code, files, tests or the task itself are "dictation".
- "target" is only a session name the user actually spoke (match it to the listed sessions' words); omit it otherwise.
- Include only the args the command needs. If a needed arg is missing, answer "dictation".
- When unsure, answer "dictation".
Commands:
${commandCatalog()}`

function pickModel(llm, override) {
  if (override?.provider && override?.model) return Promise.resolve(override)
  return (async () => {
    const all = []
    for (const p of llm.listProviders()) {
      try {
        for (const m of await llm.listModels(p.id)) all.push({ provider: p.id, model: m.id, name: `${m.id} ${m.name ?? ''}` })
      } catch { /* a provider that cannot list is skipped */ }
    }
    for (const re of PREFER) {
      const hit = all.find((m) => re.test(m.name))
      if (hit) return hit
    }
    return all[0]
  })()
}

function parseReply(text) {
  const a = text.indexOf('{')
  const b = text.lastIndexOf('}')
  if (a < 0 || b <= a) return undefined
  try {
    const obj = JSON.parse(text.slice(a, b + 1))
    return obj && typeof obj === 'object' ? obj : undefined
  } catch {
    return undefined
  }
}

/**
 * Classifies an utterance the strict grammar did not match, using a small fast model through DSH's own LLM service.
 * route() resolves to a match (viaLlm), { kind: 'dictation' }, or undefined when no decision could be made.
 */
export function createLlmRouter({ llm, model: override, timeoutMs = 6000, maxTokens = 200, log = () => {}, now = Date.now, backoffMs = 30000 } = {}) {
  let downUntil = 0
  let chosen
  let loggedModel
  return {
    async route(text, { sessions = [] } = {}) {
      if (!llm) return undefined
      if (now() < downUntil) return undefined
      const ac = new AbortController()
      let timer
      const deadline = new Promise((_, reject) => {
        timer = setTimeout(() => { ac.abort(); reject(new Error('router timed out')) }, timeoutMs)
      })
      const work = (async () => {
        chosen ??= pickModel(llm, override)
        const m = await chosen
        if (!m) throw new Error('no model available')
        if (loggedModel !== m.model) { loggedModel = m.model; log(`router: using ${m.provider}/${m.model}`) }
        const call = await llm.prepareCall({ provider: m.provider, model: m.model, maxTokens }, ac.signal)
        const payload = JSON.stringify({ utterance: text, sessions: sessions.map((s) => s.title) })
        let out = ''
        for await (const chunk of call.stream({
          ...call.config,
          system: SYSTEM,
          messages: [{ role: 'user', content: [{ type: 'text', text: payload }] }],
          signal: ac.signal,
        })) {
          if (chunk.type === 'text-delta') out += chunk.text
        }
        return { out, model: m }
      })()
      work.catch(() => {})
      try {
        const { out, model } = await Promise.race([work, deadline])
        const obj = parseReply(out)
        if (!obj) {
          log(`router: unparseable reply from ${model.model}: ${out.slice(0, 120)}`)
          return undefined
        }
        if (obj.id === 'dictation' || typeof obj.id !== 'string') return { kind: 'dictation' }
        const target = typeof obj.target === 'string' && obj.target.trim() ? obj.target.trim() : undefined
        const match = makeMatch(obj.id, { text: obj.text, number: obj.number, preset: obj.preset }, target)
        return match ? { ...match, viaLlm: true } : { kind: 'dictation' }
      } catch (error) {
        chosen = undefined // re-resolve the model next time
        downUntil = now() + backoffMs
        log(`router: ${error?.message ?? error}`)
        return undefined
      } finally {
        clearTimeout(timer)
      }
    },
  }
}
