import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'
import { listModel, todoView, pollWaitMs } from '../lib/mobile/model.js'
import { FILES } from '../mobile.js'
import { startDevServer } from '../scripts/dev-server.mjs'

// The phone's lists must be what the desktop Task list shows: the same pure helpers (exports.shared of lib/client.js) and no rule of its own.
const file = join(dirname(fileURLToPath(import.meta.url)), '..', 'lib', 'client.js')
function loadOverlay() {
  let registered
  const sandbox = { window: { __ModuleLoader__: { load: (r) => { registered = r } }, localStorage: { getItem: () => null, setItem() {} } }, console, setTimeout, clearTimeout, setInterval, clearInterval, fetch: () => new Promise(() => {}) }
  vm.runInNewContext(readFileSync(file, 'utf8'), sandbox, { filename: file })
  return registered.factory(() => ({ createElement: () => null, Fragment: Symbol('Fragment'), useState() {}, useEffect() {}, useRef() {}, useSyncExternalStore() {} }))
}
const overlay = loadOverlay()
const core = overlay.shared

const todo = (over = {}) => ({ id: 't-' + Math.random(), type: 'todo', text: 'Fix it', sparc: false, state: 'awaiting-confirm', status: 'open', createdAt: 1, ...over })
const item = (type, over = {}) => ({ id: type + '-' + Math.random(), type, status: 'open', title: type + ' title', createdAt: 1, payload: {}, ...over })

test('the shared helpers carry what the phone list needs, so the phone has no rule of its own', () => {
  assert.equal(typeof core.waitingCount, 'function')
  assert.equal(typeof core.filterBarVisible, 'function')
  assert.equal(typeof core.todoLine, 'function')
  assert.equal(typeof core.todoCardState, 'function')
  assert.deepEqual(Array.from(core.FILTER_TYPES), ['all', 'completed', 'question', 'permission', 'pr-merged', 'todo'])
})

test('the waiting count leaves out a todo that is starting, exactly like the desktop header', () => {
  const open = [item('permission'), todo({ state: 'starting' }), todo(), todo({ state: 'failed', error: 'boom' })]
  const m = listModel(core, { open, resolved: [] }, { type: 'all', query: '' })
  assert.equal(m.waiting, 3)
  assert.equal(m.waiting, overlay.__test.waitingCount(open))
  assert.equal(m.open.length, 4, 'the starting todo is still listed')
})

test('chips are the desktop filter chips (including Todo) with the same labels, and the active one is marked', () => {
  const m = listModel(core, { open: [], resolved: [] }, { type: 'todo', query: '' })
  assert.deepEqual(Array.from(m.chips, (c) => c.label), ['All', 'Done', 'Question', 'Permission', 'PR merged', 'Todo'])
  assert.deepEqual(Array.from(m.chips.filter((c) => c.on), (c) => c.type), ['todo'])
})

test('the Todo filter lists todos of every state, in the list order, and nothing else', () => {
  const states = ['awaiting-confirm', 'starting', 'failed']
  const open = [item('completed'), ...states.map((state) => todo({ state })), item('question')]
  const resolved = [todo({ state: 'started', status: 'resolved', resolution: { kind: 'started' } }), todo({ state: 'cancelled', status: 'resolved', resolution: { kind: 'cancelled' } }), item('completed')]
  const m = listModel(core, { open, resolved }, { type: 'todo', query: '' })
  assert.deepEqual(m.open.map((i) => i.state), states)
  assert.deepEqual(m.resolved.map((i) => i.state), ['started', 'cancelled'])
  assert.equal(m.resolvedCount, 3, 'the Resolved count is the whole list, like the desktop "Resolved (n)"')
})

test('the filter bar is shown by the desktop rule: from four items in all, or while a filter is active', () => {
  const some = (n) => Array.from({ length: n }, () => item('completed'))
  assert.equal(listModel(core, { open: some(2), resolved: some(1) }, { type: 'all', query: '' }).barVisible, false)
  assert.equal(listModel(core, { open: some(2), resolved: some(2) }, { type: 'all', query: '' }).barVisible, true)
  assert.equal(listModel(core, { open: some(1), resolved: [] }, { type: 'question', query: '' }).barVisible, true)
  assert.equal(listModel(core, { open: some(1), resolved: [] }, { type: 'all', query: 'x' }).barVisible, true)
  assert.equal(listModel(core, null, { type: 'all', query: '' }).waiting, 0)
})

test('a todo card shows the text, SPARC and the desktop sentence for each state', () => {
  const cases = [
    [todo({ suggested: { workspaceId: 'w', title: 'Alpha', reason: 'named in the text' } }), 'Start in Alpha — named in the text'],
    [todo({ suggested: undefined }), 'Pick a workspace'],
    [todo({ suggested: undefined, suggestNote: 'timed out after 30 s' }), 'Pick a workspace (no suggestion: timed out after 30 s)'],
    [todo({ suggested: undefined, suggesting: true }), 'Looking for a workspace…'],
    [todo({ state: 'starting', workspaceTitle: 'Beta' }), 'Starting in Beta…'],
    [todo({ state: 'started', workspaceTitle: 'Beta', status: 'resolved' }), 'Started in Beta'],
    [todo({ state: 'failed', error: 'boom' }), 'Could not start: boom'],
  ]
  for (const [t, line] of cases) {
    const v = todoView(core, { ...t, sparc: true })
    assert.equal(v.text, 'Fix it')
    assert.equal(v.sparc, true)
    assert.equal(v.line, line)
  }
  assert.equal(todoView(core, todo({ state: 'failed', error: 'boom' })).failed, true)
  assert.equal(todoView(core, todo()).failed, false)
})

test('the model file is served to the phone', () => {
  assert.ok(FILES['model.js'], 'model.js is in the served file list')
})

// ---- parity with the desktop on a real plugin instance (the demo seed has every card type) -----------------------------------------
let dev
let dir
before(async () => { dir = mkdtempSync(join(tmpdir(), 'rq-model-')); dev = await startDevServer({ port: 0, stateDir: dir, quiet: true }) })
after(async () => { await dev?.stop(); rmSync(dir, { recursive: true, force: true }) })

test('for every filter chip and a search the phone list is the desktop list: same ids, same order, same counts', async () => {
  const snap = await (await fetch(dev.url + '/review-queue/v1/snapshot')).json()
  assert.ok(snap.open.length > 5 && snap.resolved.length > 3)
  const filters = [...core.FILTER_TYPES].map((type) => ({ type, query: '' })).concat([{ type: 'all', query: 'session' }, { type: 'permission', query: 'npm' }])
  for (const f of filters) {
    const desktopOpen = overlay.__test.filterItems(snap.open, f).map((i) => i.id)
    const desktopResolved = overlay.__test.filterItems(snap.resolved, f).map((i) => i.id)
    const m = listModel(core, snap, f)
    assert.deepEqual(m.open.map((i) => i.id), desktopOpen, JSON.stringify(f) + ' open')
    assert.deepEqual(m.resolved.map((i) => i.id), desktopResolved, JSON.stringify(f) + ' resolved')
    assert.equal(m.waiting, overlay.__test.waitingCount(snap.open))
  }
})

test('after a failed or unauthorised poll the next request does not long-wait, so the banner clears as soon as the link is back', () => {
  assert.equal(pollWaitMs({ error: null, auth: false }, 20000), 20000)
  assert.equal(pollWaitMs({ error: 'Task list unreachable', auth: false }, 20000), 0)
  assert.equal(pollWaitMs({ error: null, auth: true }, 20000), 0)
})
