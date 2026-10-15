import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

// The Todo UI helpers of lib/client.js: card state, confirm rules, the form, keys, labels. Kept apart from client.test.mjs.
const file = join(dirname(fileURLToPath(import.meta.url)), '..', 'lib', 'client.js')
const source = readFileSync(file, 'utf8')

function load({ fetchImpl, stored = {} } = {}) {
  let registered
  const sandbox = {
    window: { __ModuleLoader__: { load: (r) => { registered = r } }, localStorage: { getItem: (k) => stored[k] ?? null, setItem: (k, v) => { stored[k] = v } } },
    console, setTimeout, clearTimeout, setInterval, clearInterval,
    fetch: fetchImpl ?? (() => new Promise(() => {})),
  }
  vm.runInNewContext(source, sandbox, { filename: file })
  const stubReact = { createElement: () => null, Fragment: Symbol('Fragment'), useState() {}, useEffect() {}, useRef() {}, useSyncExternalStore() {} }
  const mod = registered.factory(() => stubReact)
  return { mod, T: mod.__test }
}
const todo = (over = {}) => ({ id: 't1', type: 'todo', text: 'Fix it', sparc: false, state: 'awaiting-confirm', status: 'open', suggested: { workspaceId: 'w1', title: 'Alpha', reason: 'named in the text' }, ...over })

test('todoCardState: which card the item shows', () => {
  const { T } = load()
  assert.equal(T.todoCardState(todo()), 'confirm')
  assert.equal(T.todoCardState(todo({ suggested: undefined })), 'pick')
  assert.equal(T.todoCardState(todo({ suggested: undefined, suggesting: true })), 'suggesting')
  assert.equal(T.todoCardState(todo({ state: 'starting' })), 'starting')
  assert.equal(T.todoCardState(todo({ state: 'started', status: 'resolved' })), 'started')
  assert.equal(T.todoCardState(todo({ state: 'failed', error: 'x' })), 'failed')
  assert.equal(T.todoCardState(todo({ state: 'cancelled', status: 'resolved' })), 'cancelled')
  assert.equal(T.todoCardState(todo({ state: 'weird' })), 'unknown')
  assert.equal(T.todoCardState(undefined), 'unknown')
})

test('canConfirm: needs a state that can start and a workspace (the pick, else the suggestion, else the one given)', () => {
  const { T } = load()
  assert.equal(T.canConfirm(todo()), true)
  assert.equal(T.canConfirm(todo({ suggested: undefined })), false)
  assert.equal(T.canConfirm(todo({ suggested: undefined }), 'w2'), true)
  assert.equal(T.canConfirm(todo({ suggested: undefined, workspaceId: 'w3', state: 'failed' })), true)
  assert.equal(T.canConfirm(todo({ state: 'starting' })), false)
  assert.equal(T.canConfirm(todo({ state: 'started' })), false)
  assert.equal(T.canConfirm(todo({ suggested: undefined, suggesting: true })), false)
  assert.equal(T.canConfirm({ type: 'completed' }), false)
})

test('todoTarget and todoLine: the workspace that would be used and the sentence shown on the card', () => {
  const { T } = load()
  const ws = [{ id: 'w1', title: 'Alpha' }, { id: 'w2', title: 'Beta' }]
  assert.equal(T.todoTarget(todo(), '', ws), 'w1')
  assert.equal(T.todoTarget(todo(), 'w2', ws), 'w2')
  assert.equal(T.todoTarget(todo({ suggested: undefined }), '', ws), undefined)
  assert.equal(T.todoLine(todo(), '', ws), 'Start in Alpha — named in the text')
  assert.equal(T.todoLine(todo(), 'w2', ws), 'Start in Beta')
  assert.equal(T.todoLine(todo({ suggested: undefined }), '', ws), 'Pick a workspace')
  assert.equal(T.todoLine(todo({ suggested: undefined, suggesting: true }), '', ws), 'Looking for a workspace…')
  assert.equal(T.todoLine(todo({ state: 'starting', workspaceTitle: 'Alpha' }), '', ws), 'Starting in Alpha…')
  assert.equal(T.todoLine(todo({ state: 'failed', error: 'boom' }), '', ws), 'Could not start: boom')
})

test('todoLine: with no suggestion the card says why (the model pass note), never while still looking and never next to a suggestion', () => {
  const { T } = load()
  const ws = [{ id: 'w1', title: 'Alpha' }, { id: 'w2', title: 'Beta' }]
  const none = todo({ suggested: undefined, suggesting: false, suggestNote: 'timed out after 15 s' })
  assert.equal(T.todoCardState(none), 'pick')
  assert.equal(T.todoLine(none, '', ws), 'Pick a workspace (no suggestion: timed out after 15 s)')
  assert.equal(T.todoLine(todo({ suggested: undefined, suggestNote: 'the model found no clear fit' }), '', ws), 'Pick a workspace (no suggestion: the model found no clear fit)')
  assert.equal(T.todoLine(todo({ suggested: undefined, suggestNote: '' }), '', ws), 'Pick a workspace')
  assert.equal(T.todoLine(todo({ suggested: undefined, suggesting: true, suggestNote: 'old' }), '', ws), 'Looking for a workspace…')
  assert.equal(T.todoLine(todo({ suggestNote: 'stale' }), '', ws), 'Start in Alpha — named in the text')
  assert.equal(T.todoLine(none, 'w2', ws), 'Start in Beta')
  assert.equal(T.todoLine(todo({ suggested: undefined, suggestNote: 42 }), '', ws), 'Pick a workspace')
})

test('waitingCount: a todo that is starting is not waiting on the user', () => {
  const { T } = load()
  assert.equal(T.waitingCount([todo(), todo({ state: 'starting' }), todo({ state: 'failed' }), { type: 'completed' }]), 3)
  assert.equal(T.waitingCount(undefined), 0)
})

test('labels: Todo chip, resolution lines, error texts', () => {
  const { T } = load()
  assert.equal(T.typeLabel('todo'), 'Todo')
  assert.equal(T.resolutionText({ type: 'todo', workspaceTitle: 'Alpha', resolution: { kind: 'started', sessionId: 's' } }), 'Started in Alpha (in the background)')
  assert.equal(T.resolutionText({ type: 'todo', resolution: { kind: 'started', sessionId: 's' } }), 'Started (in the background)')
  assert.equal(T.resolutionText({ type: 'todo', resolution: { kind: 'cancelled', by: 'card' } }), 'Cancelled')
  assert.match(T.errorText(400, { error: 'no-workspace' }), /workspace/i)
  assert.match(T.errorText(400, { error: 'unknown-workspace' }), /no longer exists|unknown|workspace/i)
  assert.match(T.errorText(409, { error: 'not-confirmable' }), /already/i)
  assert.match(T.errorText(409, { error: 'not-todo' }), /todo/i)
  assert.equal(T.errorText(400, { error: 'too-long' }), 'That is too long.')
})

test('keys: Shift+A, Shift+D and e do nothing on a todo; Enter is not bound; the other cards are unchanged', () => {
  const { T } = load()
  const t = todo()
  assert.equal(T.keyRoute('approve', t), undefined)
  assert.equal(T.keyRoute('deny', t), undefined)
  assert.equal(T.keyRoute('reviewed', t), undefined)
  assert.equal(T.keyRoute('approve', { type: 'permission' }), '/v1/approve')
  assert.equal(T.keyRoute('deny', { type: 'permission' }), '/v1/deny')
  assert.equal(T.keyRoute('reviewed', { type: 'completed' }), '/v1/reviewed')
  assert.equal(T.keyRoute('reviewed', { type: 'permission' }), undefined)
  assert.equal(T.keyRoute('approve', { type: 'completed' }), undefined)
  assert.equal(T.keyRoute(undefined, t), undefined)
  const key = (o) => ({ key: 'x', ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, isComposing: false, target: { tagName: 'DIV' }, ...o })
  assert.equal(T.keyAction(key({ key: 'Enter' })), undefined)
  assert.equal(T.keyAction(key({ key: 'j' })), 'next')
  assert.equal(T.keyAction(key({ key: 'k' })), 'prev')
  assert.equal(T.keyAction(key({ key: 'A', shiftKey: true })), 'approve')
  assert.match(source, /keyRoute\(action, cur\)/, 'the overlay key handler goes through keyRoute')
})

test('isSubmitKey: Ctrl+Enter or Cmd+Enter submits; Enter alone is a new line; not during IME composition', () => {
  const { T } = load()
  assert.equal(T.isSubmitKey({ key: 'Enter', ctrlKey: true }), true)
  assert.equal(T.isSubmitKey({ key: 'Enter', metaKey: true }), true)
  assert.equal(T.isSubmitKey({ key: 'Enter' }), false)
  assert.equal(T.isSubmitKey({ key: 'Enter', ctrlKey: true, isComposing: true }), false)
  assert.equal(T.isSubmitKey({ key: 'a', ctrlKey: true }), false)
  assert.equal(T.isSubmitKey(undefined), false)
})

test('todoFormProblem: empty and too long text are caught before the request', () => {
  const { T } = load()
  assert.equal(T.todoFormProblem(''), 'Type the task first.')
  assert.equal(T.todoFormProblem('  \n '), 'Type the task first.')
  assert.equal(T.todoFormProblem('x'.repeat(4001)), 'That is too long.')
  assert.equal(T.todoFormProblem('x'.repeat(4000)), undefined)
})

test('submitTodo posts the form to /v1/todo, closes it and clears it on success', async () => {
  const seen = []
  const { T } = load({ fetchImpl: async (url, opts) => { seen.push([url, JSON.parse(opts.body), opts.method]); return { ok: true, status: 200, json: async () => ({ ok: true, id: 'n1', state: 'starting' }) } } })
  T.set({ todoForm: { open: true, text: '  Fix it  ', workspaceId: 'w1', sparc: true, busy: false, error: undefined } })
  assert.equal(await T.submitTodo(), true)
  assert.deepEqual(seen, [['/review-queue/v1/todo', { text: 'Fix it', workspaceId: 'w1', sparc: true }, 'POST']])
  assert.equal(T.state.todoForm.open, false)
  assert.equal(T.state.todoForm.text, '')
  assert.equal(T.state.todoForm.busy, false)
  assert.equal(T.state.todoForm.sparc, false, 'SPARC is off again for the next one')
})

test('submitTodo with "Choose for me" sends no workspace; a refused request keeps the form and shows the reason', async () => {
  const seen = []
  let status = 200
  const { T } = load({ fetchImpl: async (url, opts) => { seen.push(JSON.parse(opts.body)); return { ok: status === 200, status, json: async () => (status === 200 ? { ok: true } : { ok: false, error: 'unknown-workspace' }) } } })
  T.set({ todoForm: { open: true, text: 'Fix it', workspaceId: '', sparc: false, busy: false, error: undefined } })
  await T.submitTodo()
  assert.deepEqual(seen[0], { text: 'Fix it', sparc: false })
  status = 400
  T.set({ todoForm: { open: true, text: 'Fix it', workspaceId: 'gone', sparc: false, busy: false, error: undefined } })
  assert.equal(await T.submitTodo(), false)
  assert.equal(T.state.todoForm.open, true)
  assert.equal(T.state.todoForm.text, 'Fix it')
  assert.match(T.state.todoForm.error, /workspace/i)
  assert.equal(T.state.todoForm.busy, false)
})

test('submitTodo does nothing for an empty text and does not post twice while busy', async () => {
  let posts = 0
  const { T } = load({ fetchImpl: async () => { posts++; return { ok: true, status: 200, json: async () => ({ ok: true }) } } })
  T.set({ todoForm: { open: true, text: '   ', workspaceId: '', sparc: false, busy: false, error: undefined } })
  assert.equal(await T.submitTodo(), false)
  assert.equal(posts, 0)
  assert.match(T.state.todoForm.error, /first/)
  T.set({ todoForm: { open: true, text: 'Fix', workspaceId: '', sparc: false, busy: true, error: undefined } })
  assert.equal(await T.submitTodo(), false)
  assert.equal(posts, 0)
})

test('confirmTodo and cancelTodo post to their routes with the picked workspace', async () => {
  const seen = []
  const { T } = load({ fetchImpl: async (url, opts) => { seen.push([url, JSON.parse(opts.body)]); return { ok: true, status: 200, json: async () => ({ ok: true }) } } })
  assert.equal(await T.confirmTodo(todo(), 'w2'), true)
  assert.equal(await T.confirmTodo(todo(), ''), true)
  assert.equal(await T.cancelTodo(todo()), true)
  assert.deepEqual(seen, [
    ['/review-queue/v1/todo-confirm', { id: 't1', workspaceId: 'w2' }],
    ['/review-queue/v1/todo-confirm', { id: 't1', workspaceId: 'w1' }],
    ['/review-queue/v1/todo-cancel', { id: 't1' }],
  ])
})

test('openControl: a started todo gets an Open session BUTTON; other resolved items keep the link; nothing without a session or host', () => {
  const { T } = load()
  assert.equal(T.openControl({ type: 'todo', sessionId: 's1' }, true), 'button')
  assert.equal(T.openControl({ type: 'todo' }, true), 'none')
  assert.equal(T.openControl({ type: 'todo', sessionId: 's1' }, false), 'none')
  assert.equal(T.openControl({ type: 'completed', sessionId: 's1' }, true), 'link')
  assert.equal(T.openControl({ type: 'completed' }, true), 'none')
})

test('loadWorkspaces fills the dropdown list from GET /v1/workspaces', async () => {
  const seen = []
  const { T } = load({ fetchImpl: async (url) => { seen.push(url); return { ok: true, status: 200, json: async () => ({ workspaces: [{ id: 'w1', title: 'Alpha' }] }) } } })
  await T.loadWorkspaces()
  assert.deepEqual(seen, ['/review-queue/v1/workspaces'])
  assert.deepEqual(T.state.workspaces, [{ id: 'w1', title: 'Alpha' }])
})

test('source: the header has "+ New todo" next to Resolved, the form and the card are wired, the Open session control is not automatic', () => {
  const head = source.slice(source.indexOf('function Head('), source.indexOf('function Panel('))
  assert.match(head, /\+ New todo/)
  assert.ok(head.indexOf('Resolved (') < head.indexOf('+ New todo') || head.indexOf('+ New todo') < head.indexOf('Resolved ('))
  assert.match(source, /function TodoForm/)
  assert.match(source, /function TodoBody/)
  assert.match(source, /Use SPARC/)
  assert.match(source, /Choose for me/)
  assert.match(source, /Change workspace/)
  assert.match(source, /isSubmitKey\(e\.nativeEvent \|\| e\)/)
  const body = source.slice(source.indexOf('function TodoBody'), source.indexOf('function Card('))
  assert.match(body, /Open session/)
  assert.match(body, /onClick: \(\) => openSession\(item\)/)
  assert.ok(!/useEffect\([^)]*openSession/.test(body), 'the session is never opened by itself')
  assert.match(source, /"pr-merged", "todo"\]/, 'the filter bar knows the todo type')
})

test('todoSelect: the dropdown shows the suggested workspace selected, the user pick wins, and there is a placeholder only when nothing is chosen', () => {
  const { T } = load()
  const ws = [{ id: 'w1', title: 'Alpha' }, { id: 'w2', title: 'Beta' }]
  const sel = T.todoSelect(todo(), '', ws)
  assert.equal(sel.value, 'w1', 'the suggestion is preselected')
  assert.equal(sel.placeholder, undefined, 'nothing to pick, so no placeholder')
  assert.deepEqual(JSON.parse(JSON.stringify(sel.options)), [{ id: 'w1', title: 'Alpha' }, { id: 'w2', title: 'Beta' }])
  assert.equal(T.todoSelect(todo(), 'w2', ws).value, 'w2', 'a pick wins over the suggestion')
  const none = T.todoSelect(todo({ suggested: undefined }), '', ws)
  assert.equal(none.value, '')
  assert.equal(none.placeholder, 'Pick a workspace…')
  assert.equal(T.todoSelect(todo({ suggested: undefined, workspaceId: 'w2', state: 'failed' }), '', ws).value, 'w2', 'a failed todo keeps the workspace it had')
})

test('todoSelect: a suggested workspace that is not (yet) in the loaded list is still an option, so the select can show it', () => {
  const { T } = load()
  assert.deepEqual(JSON.parse(JSON.stringify(T.todoSelect(todo(), '', null).options)), [{ id: 'w1', title: 'Alpha' }])
  assert.deepEqual(JSON.parse(JSON.stringify(T.todoSelect(todo(), '', [{ id: 'w2', title: 'Beta' }]).options)), [{ id: 'w1', title: 'Alpha' }, { id: 'w2', title: 'Beta' }])
  assert.deepEqual(JSON.parse(JSON.stringify(T.todoSelect(todo({ suggested: undefined }), '', undefined).options)), [])
})

test('ensureWorkspaces loads the list when none was loaded or the loaded one is empty, and leaves a list that has entries alone', async () => {
  const seen = []
  let answer = []
  const { T } = load({ fetchImpl: async (url) => { seen.push(url); return { ok: true, status: 200, json: async () => ({ workspaces: answer }) } } })
  await T.ensureWorkspaces()
  assert.equal(seen.length, 1, 'never loaded: loads')
  assert.deepEqual(T.state.workspaces, [])
  answer = [{ id: 'w1', title: 'Alpha' }]
  await T.ensureWorkspaces()
  assert.equal(seen.length, 2, 'an empty list is asked again')
  assert.deepEqual(T.state.workspaces, [{ id: 'w1', title: 'Alpha' }])
  await T.ensureWorkspaces()
  assert.equal(seen.length, 2, 'a list with entries is kept')
})

test('source: a todo card that waits for the user asks for the workspaces when it has none, and the form says when there are none', () => {
  const body = source.slice(source.indexOf('function TodoBody'), source.indexOf('function Card('))
  assert.match(body, /useEffect\(\(\) => \{ if \(waiting\) ensureWorkspaces\(\);/)
  const form = source.slice(source.indexOf('function TodoForm'), source.indexOf('function Head('))
  assert.match(form, /workspacesNote\(st\.workspaces\)/)
})

test('workspacesNote: nothing before the list is loaded or while it has entries; a loaded empty list is explained', () => {
  const { T } = load()
  assert.equal(T.workspacesNote(null), undefined)
  assert.equal(T.workspacesNote([{ id: 'w1', title: 'A' }]), undefined)
  assert.match(T.workspacesNote([]), /No workspace is listed yet.*Choose for me/)
})
