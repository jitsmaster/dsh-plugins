import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'

// The phone's todo card (replaces the read-only TodoBody): what it shows and offers, derived with the desktop's own helpers (core =
// exports.shared of lib/client.js) so the phone has no todo rule of its own. Pure: todoCardModel in lib/mobile/model.js.
//   todoCardModel(core, item, workspaces, pick?) -> {
//     text, sparc,             the task and its SPARC flag
//     line,                    the sentence under the task: core.todoLine(item, pick, workspaces)
//     failed,                  the state is failed (the sentence is shown as an error)
//     canAct,                  awaiting-confirm or failed: the card shows the dropdown, Start/Retry and Cancel
//     selected, options, placeholder,  the dropdown: the user's pick, else item.workspaceId, else the suggestion ('' when none)
//     startLabel,              'Retry' when failed, else 'Start'
//     canStart,                canAct and a workspace is selected
//   }
// The dropdown comes from core.todoSelect and core.todoTarget, which the overlay must therefore export in exports.shared.
const root = join(dirname(fileURLToPath(import.meta.url)), '..')
function loadOverlay() {
  let registered
  const file = join(root, 'lib', 'client.js')
  const sandbox = { window: { __ModuleLoader__: { load: (r) => { registered = r } }, localStorage: { getItem: () => null, setItem() {} } }, console, setTimeout, clearTimeout, setInterval, clearInterval, fetch: () => new Promise(() => {}) }
  vm.runInNewContext(readFileSync(file, 'utf8'), sandbox, { filename: file })
  return registered.factory(() => ({ createElement: () => null, Fragment: Symbol('Fragment'), useState() {}, useEffect() {}, useRef() {}, useSyncExternalStore() {} }))
}
const core = loadOverlay().shared
const plain = (x) => JSON.parse(JSON.stringify(x)) // values built inside the overlay's vm context have another Array prototype
const card = async (item, workspaces, pick) => (await import('../lib/mobile/model.js')).todoCardModel(core, item, workspaces, pick)

const todo = (over = {}) => ({ id: 't-1', type: 'todo', text: 'Fix it', sparc: false, state: 'awaiting-confirm', status: 'open', createdAt: 1, ...over })
const WS = [{ id: 'w1', title: 'Alpha' }, { id: 'w2', title: 'Beta' }]
const SUGGEST = { workspaceId: 'w2', title: 'Beta', reason: 'named in the text' }

test('the overlay shares the todo dropdown helpers, so the phone does not copy the preselect rule', () => {
  assert.equal(typeof core.todoSelect, 'function')
  assert.equal(typeof core.todoTarget, 'function')
})

test('a todo awaiting confirmation shows the suggestion line, the dropdown preselected on it, and Start / Cancel', async () => {
  const m = await card(todo({ suggested: SUGGEST }), WS)
  assert.equal(m.text, 'Fix it')
  assert.equal(m.sparc, false)
  assert.equal(m.line, 'Start in Beta — named in the text')
  assert.equal(m.failed, false)
  assert.equal(m.canAct, true)
  assert.equal(m.selected, 'w2')
  assert.deepEqual(plain(m.options), [{ id: 'w1', title: 'Alpha' }, { id: 'w2', title: 'Beta' }])
  assert.equal(m.startLabel, 'Start')
  assert.equal(m.canStart, true)
})

test('the card carries the SPARC flag of the todo', async () => {
  assert.equal((await card(todo({ sparc: true, suggested: SUGGEST }), WS)).sparc, true)
})

test('the user pick beats the suggestion in the dropdown and in the line', async () => {
  const m = await card(todo({ suggested: SUGGEST }), WS, 'w1')
  assert.equal(m.selected, 'w1')
  assert.equal(m.line, 'Start in Alpha')
  assert.equal(m.canStart, true)
})

test('a workspace the todo was given beats the suggestion (the dropdown is preselected like the desktop)', async () => {
  const m = await card(todo({ workspaceId: 'w1', suggested: SUGGEST }), WS)
  assert.equal(m.selected, 'w1')
})

test('with no suggestion and no pick nothing is selected: a placeholder, the reason in the line, and Start stays off', async () => {
  const m = await card(todo({ suggested: undefined, suggestNote: 'timed out after 30 s' }), WS)
  assert.equal(m.selected, '')
  assert.equal(m.placeholder, 'Pick a workspace…')
  assert.equal(m.line, 'Pick a workspace (no suggestion: timed out after 30 s)')
  assert.equal(m.canAct, true)
  assert.equal(m.canStart, false)
  assert.equal(m.startLabel, 'Start')
})

test('while the suggestion is still being looked for the card says so and can already be acted on once a workspace is picked', async () => {
  const waiting = await card(todo({ suggested: undefined, suggesting: true }), WS)
  assert.equal(waiting.line, 'Looking for a workspace…')
  assert.equal(waiting.canStart, false)
  assert.equal((await card(todo({ suggested: undefined, suggesting: true }), WS, 'w1')).canStart, true)
})

test('a suggested workspace that is not in the loaded list is still an option, so the preselect shows (nothing loaded yet)', async () => {
  for (const loaded of [undefined, null, []]) {
    const m = await card(todo({ suggested: SUGGEST }), loaded)
    assert.equal(m.selected, 'w2')
    assert.deepEqual(plain(m.options), [{ id: 'w2', title: 'Beta' }])
  }
})

test('a failed todo shows the error as such and offers Retry, with the workspace it was started in selected', async () => {
  const m = await card(todo({ state: 'failed', error: 'boom', workspaceId: 'w1', workspaceTitle: 'Alpha', suggested: SUGGEST }), WS)
  assert.equal(m.line, 'Could not start: boom')
  assert.equal(m.failed, true)
  assert.equal(m.canAct, true)
  assert.equal(m.startLabel, 'Retry')
  assert.equal(m.selected, 'w1')
  assert.equal(m.canStart, true)
})

test('starting, started and cancelled are read-only text: no dropdown, no buttons, the desktop sentence', async () => {
  const cases = [
    [todo({ state: 'starting', workspaceTitle: 'Beta' }), 'Starting in Beta…'],
    [todo({ state: 'started', workspaceTitle: 'Beta', status: 'resolved', sessionId: 's1' }), 'Started in Beta'],
    [todo({ state: 'cancelled', status: 'resolved' }), ''],
  ]
  for (const [item, line] of cases) {
    const m = await card(item, WS)
    assert.equal(m.canAct, false, item.state)
    assert.equal(m.canStart, false, item.state)
    assert.equal(m.failed, false, item.state)
    assert.equal(m.line, line, item.state)
    assert.equal(m.text, 'Fix it', item.state)
  }
})

test('the card model never changes the item or the workspace list it was given', async () => {
  const item = todo({ suggested: { ...SUGGEST } })
  const list = WS.map((w) => ({ ...w }))
  const before = JSON.stringify([item, list])
  const m = await card(item, list, 'w1')
  m.options.push({ id: 'x', title: 'x' })
  assert.equal(JSON.stringify([item, list]), before)
})

// ---- the existing read-only helper is not what the phone card uses any more ---------------------------------------------------------------

test('the item view renders the todo through the card model, with Start / Retry and Cancel posting to the same routes as the desktop', () => {
  const views = readFileSync(join(root, 'lib', 'mobile', 'views.js'), 'utf8')
  const api = readFileSync(join(root, 'lib', 'mobile', 'api.js'), 'utf8')
  assert.match(views, /import\s*\{[^}]*\btodoCardModel\b[^}]*\}\s*from\s*['"]\.\/model\.js['"]/)
  assert.match(views, /todoCardModel\(/)
  assert.match(views + api, /['"]\/v1\/todo-confirm['"]/)
  assert.match(views + api, /['"]\/v1\/todo-cancel['"]/)
  assert.doesNotMatch(views, /from the task list on the desktop/, 'the "start it on the desktop" hint is gone')
})
