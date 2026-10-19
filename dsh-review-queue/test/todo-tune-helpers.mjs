// Fakes of the tune tests: an llm service in the shape summary.js / todo.js expect (same as test/todo-suggest.test.mjs).
export function fakeLlm({ answer = '', chunks, fail, failMessage, hang, noModels, models, providersThrow, seen = {} } = {}) {
  seen.calls = 0
  seen.providerCalls = 0
  return {
    listProviders: async () => { seen.providerCalls++; if (providersThrow) throw new Error('providers down'); return [{ id: 'p1' }] },
    listModels: async () => (noModels ? [] : models ?? [{ id: 'claude-haiku-x' }]),
    prepareCall: async (cfg, signal) => ({
      config: {},
      stream: async function* (req) {
        seen.cfg = cfg
        seen.prepareSignal = signal
        seen.req = req
        seen.calls++
        if (hang) await new Promise((_, rej) => req.signal.addEventListener('abort', () => rej(new Error('aborted'))))
        if (fail) throw new Error(failMessage ?? 'llm down')
        for (const c of chunks ?? [answer]) yield typeof c === 'string' ? { type: 'text-delta', text: c } : c
      },
    }),
  }
}
export const systemOf = (seen) => String(seen.req.system)
export const userOf = (seen) => seen.req.messages.map((m) => m.content.map((c) => c.text).join('')).join('\n')
