import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'

// The phone card uses the desktop's helpers (exports.shared of lib/client.js), so the prompt-injection rule of client-todo-follow-up-model.test.mjs holds there too:
// "Model says: <reason>", and a model suggestion for a running session is not preselected (Send stays off until a pick).
const root = join(dirname(fileURLToPath(import.meta.url)), '..')
function loadOverlay() {
  let registered
  const file = join(root, 'lib', 'client.js')
  const sandbox = { window: { __ModuleLoader__: { load: (r) => { registered = r } }, localStorage: { getItem: () => null, setItem() {} } }, console, setTimeout, clearTimeout, setInterval, clearInterval, fetch: () => new Promise(() => {}) }
  vm.runInNewContext(readFileSync(file, 'utf8'), sandbox, { filename: file })
  return registered.factory(() => ({ createElement: () => null, Fragment: Symbol('Fragment'), useState() {}, useEffect() {}, useRef() {}, useSyncExternalStore() {} }))
}
const core = loadOverlay().shared
const plain = (x) => JSON.parse(JSON.stringify(x))
const card = async (item, pick) => plain((await import('../lib/mobile/model.js')).todoCardModel(core, item, undefined, pick))
const CANDS = [{ sessionId: 's1', title: 'Login bug', workspaceTitle: 'Alpha', running: true }, { sessionId: 's2', title: 'Docs' }]
const MODEL = { sessionId: 's1', title: 'Login bug', workspaceTitle: 'Alpha', reason: 'title match', running: true }
const fu = (over = {}) => ({ id: 'f-1', type: 'todo', kind: 'followup', text: 'Run the tests again', query: 'the login bug', state: 'awaiting-confirm', status: 'open', createdAt: 1, candidates: CANDS, suggested: MODEL, ...over })

test('phone: a model suggestion for a running session starts on the placeholder, Send is off, the suggestion is first and named in the line', async () => {
  const m = await card(fu())
  assert.equal(m.selected, '')
  assert.equal(m.placeholder, 'Pick a session…')
  assert.equal(m.canStart, false)
  assert.equal(m.options[0].id, 's1')
  assert.equal(m.line, 'Model suggests: Login bug (Alpha) — Model says: title match')
})

test('phone: picking enables Send; a model suggestion for an idle session is preselected with its reason labelled; a number match is trusted', async () => {
  assert.equal((await card(fu(), 's1')).canStart, true)
  assert.equal((await card(fu(), 's1')).line, 'Session: Login bug (Alpha) — Model says: title match')
  const idle = await card(fu({ suggested: { ...MODEL, running: undefined }, candidates: [{ sessionId: 's1', title: 'Login bug', workspaceTitle: 'Alpha' }, CANDS[1]] }))
  assert.deepEqual([idle.selected, idle.canStart, idle.line], ['s1', true, 'Session: Login bug (Alpha) — Model says: title match'])
  const byRef = await card(fu({ suggested: { ...MODEL, reason: 'ticket or PR number in the words' } }))
  assert.deepEqual([byRef.selected, byRef.canStart, byRef.line], ['s1', true, 'Session: Login bug (Alpha) — ticket or PR number in the words'])
})
