// Helpers of the todo draft / tune tests of lib/client.js: the bundle in a vm with a fake window.localStorage that logs every write,
// timers that never fire (a save that waits for a timer is a bug here: the draft is written synchronously), and small fixtures.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

export const file = join(dirname(fileURLToPath(import.meta.url)), '..', 'lib', 'client.js')
export const source = readFileSync(file, 'utf8')
/** The localStorage key of the todo form draft (LS.todoDraft). */
export const KEY = 'dsh-review-queue.todoDraft'

export function loadClient({ stored = {}, fetchImpl, setItem, react, globals } = {}) {
  let registered
  const store = { ...stored }
  const writes = []
  const timers = []
  const sandbox = {
    window: {
      __ModuleLoader__: { load: (r) => { registered = r } },
      localStorage: { getItem: (k) => store[k] ?? null, setItem: (k, v) => { if (setItem) setItem(k, v); store[k] = String(v); writes.push([k, String(v)]) } },
    },
    console, setInterval, clearInterval,
    setTimeout: (fn, ms) => { timers.push({ fn, ms }); return timers.length },
    clearTimeout: () => {},
    fetch: fetchImpl ?? (() => new Promise(() => {})),
  }
  if (globals) Object.assign(sandbox, globals)
  vm.runInNewContext(source, sandbox, { filename: file })
  const stubReact = { createElement: () => null, Fragment: Symbol('Fragment'), useState() {}, useEffect() {}, useRef() {}, useSyncExternalStore() {}, ...react }
  const mod = registered.factory(() => stubReact)
  return { mod, T: mod.__test, store, writes, timers }
}

/** The saved draft as an object; null when nothing was saved. */
export function savedDraft(store) {
  const raw = store[KEY]
  if (raw === undefined || raw === null || raw === '') return null
  return JSON.parse(raw)
}
/** "Cleared" = nothing saved, or a saved draft with no text, no original and a closed form. */
export const isCleared = (store) => { const d = savedDraft(store); return d === null || (typeof d === 'object' && !d.text && !d.original && !d.open) }
/** A plain copy of the live form (the vm objects have another prototype, so deepEqual needs plain data). */
export const formOf = (T) => JSON.parse(JSON.stringify(T.state.todoForm))
export const FORM = (over = {}) => ({ open: true, text: '', workspaceId: '', sparc: false, busy: false, error: undefined, ...over })
export const need = (T, name) => assert.equal(typeof T[name], 'function', name + ' is exported through exports.__test')
export const okJson = (body, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => body })
export const deferred = () => { let resolve; const promise = new Promise((r) => { resolve = r }); return { promise, resolve } }
export const tick = () => new Promise((r) => setImmediate(r))

/** A createElement that builds plain { type, props, children } nodes, so a test can render a component and look at what it made. */
export const el = (type, props, ...children) => ({ type, props: props ?? {}, children: children.flat(Infinity).filter((c) => c !== null && c !== undefined && c !== false) })
export const findAll = (node, pred) => (node && typeof node === 'object' ? [...(pred(node) ? [node] : []), ...(node.children ?? []).flatMap((c) => findAll(c, pred))] : [])
export const textOf = (node) => (typeof node === 'string' ? node : (node?.children ?? []).map(textOf).join(''))
