import { createStore } from '../store.js'
import { createReviewQueue } from '../service.js'

// Shared by the follow-up tests: a fake llm service, a fake session controller (list + prompt) and a queue built on them.
export const NOW = 10_000_000

/** A fake llm service in the shape summary.js expects; answer is what the model "says". */
export function fakeLlm({ answer, fail, hang, noModels, seen = {} } = {}) {
  return {
    listProviders: async () => [{ id: 'p1' }],
    listModels: async () => (noModels ? [] : [{ id: 'claude-haiku-x' }]),
    prepareCall: async (cfg) => ({
      config: {},
      stream: async function* (req) {
        seen.cfg = cfg
        seen.req = req
        seen.calls = (seen.calls ?? 0) + 1
        if (hang) await new Promise((_, rej) => req.signal.addEventListener('abort', () => rej(new Error('aborted'))))
        if (fail) throw new Error('llm down')
        yield { type: 'text-delta', text: typeof answer === 'function' ? answer() : answer }
      },
    }),
  }
}

/** Session list entries as the controller gives them (newest = highest updatedAt). */
export const SESSION_ITEMS = [
  { sessionId: 's-old', updatedAt: NOW - 3 * 86_400_000, running: false, blank: false },
  { sessionId: 's-pr', updatedAt: NOW - 600_000, running: true, blank: false },
  { sessionId: 's-orca', updatedAt: NOW - 7_200_000, running: false, blank: false },
]
export const TITLES = { 's-old': 'Fix: login redirect - 25001', 's-pr': 'PR 6556 review', 's-orca': 'Orca engine tuning' }
export const WORKSPACES = [
  { id: 'w-plug', title: 'dsh-plugins', path: 'D:/dev/ai/dsh-plugins', sessionIds: ['s-pr', 's-old'] },
  { id: 'w-orca', title: 'Orca', path: 'D:/dev/ai/orca-engine', sessionIds: ['s-orca'] },
]

export function setupFollowUp({ items = SESSION_ITEMS, titles = TITLES, workspaces = WORKSPACES, llm, promptError, promptGate, listError, noRegistry, snippetsOf, logs = [], archived = [] } = {}) {
  let n = 0
  let t = 1000
  const store = createStore({ now: () => ++t, uuid: () => 'i' + ++n })
  const calls = []
  const controller = {
    list: async (arg, signal) => { calls.push(['list', arg, signal]); if (listError) throw new Error(listError); return { items } },
    prompt: async (req, signal) => {
      calls.push(['prompt', req, signal])
      if (promptGate) await promptGate.promise
      if (promptError) throw Object.assign(new Error(promptError.message ?? promptError), promptError.code ? { code: promptError.code } : {})
      return {}
    },
    create: async (arg) => { calls.push(['create', arg]); return { sessionId: 'NEW' } },
    rename: async (arg) => { calls.push(['rename', arg]) },
    select: async (arg) => { calls.push(['select', arg]) },
    focus: async (arg) => { calls.push(['focus', arg]) },
  }
  const registry = { list: () => workspaces, archivedSessionIds: archived }
  const titlesOf = async (ids) => new Map(ids.filter((id) => titles[id]).map((id) => [id, titles[id]]))
  const queue = createReviewQueue({
    store, capture: {}, controllerOf: () => controller, registryOf: noRegistry ? () => undefined : () => registry,
    llm, titlesOf, snippetsOf, suggestTimeoutMs: 40, now: () => NOW, log: (line) => logs.push(line),
  })
  return { store, queue, calls, controller, logs }
}
export const prompts = (calls) => calls.filter((c) => c[0] === 'prompt')
export const promptOf = (seen) => seen.req.system + '\n' + JSON.stringify(seen.req.messages)
export const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b }); return { promise, resolve, reject } }
