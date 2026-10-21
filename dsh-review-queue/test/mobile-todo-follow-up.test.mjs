import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'

// Slice D: the phone's "+ New todo" form in Follow up mode (docs/mobile.md "Follow-up todo on the phone"). The same rules as the desktop form
// (lib/client.js: FOLLOWUP_MAX = 300, todoFormProblem) over the same API: POST /v1/todo { text, followUp } (never a workspaceId or sparc).
// Pure part in lib/mobile/todo-form.js:
//   FOLLOWUP_MAX = 300
//   isFollowUpDraft(draft)        -> draft.mode === 'followup'
//   withTodoMode(draft, mode)     -> a new draft: 'followup' sets mode; anything else drops the key (a draft in New session mode never carries one)
//   newTodoPayload(draft)         -> follow-up draft: { ok: true, body: { text, followUp } } or { ok: false, message } with the desktop's wording
//   todoErrorText(core, status, body) -> empty-query / unknown-session / no-session in the desktop's words
// The Preact views cannot run here: source checks of views.js as in mobile-todo-wiring.test.mjs.
const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const load = () => import('../lib/mobile/todo-form.js')
const views = readFileSync(join(root, 'lib', 'mobile', 'views.js'), 'utf8')

function loadOverlay() {
  let registered
  const file = join(root, 'lib', 'client.js')
  const sandbox = { window: { __ModuleLoader__: { load: (r) => { registered = r } }, localStorage: { getItem: () => null, setItem() {} } }, console, setTimeout, clearTimeout, setInterval, clearInterval, fetch: () => new Promise(() => {}) }
  vm.runInNewContext(readFileSync(file, 'utf8'), sandbox, { filename: file })
  return registered.factory(() => ({ createElement: () => null, Fragment: Symbol('Fragment'), useState() {}, useEffect() {}, useRef() {}, useSyncExternalStore() {} }))
}
const core = loadOverlay().shared

/** The source of one top-level function of views.js, up to the next top-level function. */
function body(name) {
  const start = views.search(new RegExp('(?:^|\\n)(?:export )?(?:async )?function ' + name + '\\b'))
  assert.notEqual(start, -1, 'views.js defines function ' + name)
  const rest = views.slice(start + 1)
  const next = rest.search(/\n(?:export )?(?:async )?function \w+|\n\/\/ ---- /)
  return next === -1 ? rest : rest.slice(0, next)
}

const follow = (over = {}) => ({ text: 'Run the tests again', workspaceId: '', sparc: false, mode: 'followup', followUp: 'the login bug session', ...over })

// ---- the pure helpers ----------------------------------------------------------------------------------------------------------------

test('the description limit is 300 characters, like the desktop and the server', async () => {
  const { FOLLOWUP_MAX } = await load()
  assert.equal(FOLLOWUP_MAX, 300)
})

test('isFollowUpDraft is true only for mode "followup"', async () => {
  const { isFollowUpDraft } = await load()
  assert.equal(isFollowUpDraft(follow()), true)
  for (const d of [{ text: 'x' }, { text: 'x', mode: 'new' }, { text: 'x', mode: 'FollowUp' }, {}, undefined, null]) assert.equal(isFollowUpDraft(d), false, JSON.stringify(d))
})

test('withTodoMode sets the mode for a follow-up and drops the key for New session, keeping every other field and never changing its argument', async () => {
  const { withTodoMode } = await load()
  const base = { text: 'a', workspaceId: 'w1', sparc: true, followUp: 'words' }
  const f = withTodoMode(base, 'followup')
  assert.deepEqual(f, { ...base, mode: 'followup' })
  assert.deepEqual(base, { text: 'a', workspaceId: 'w1', sparc: true, followUp: 'words' }, 'not mutated')
  const back = withTodoMode(f, 'new')
  assert.deepEqual(back, base)
  assert.equal('mode' in back, false)
  assert.equal('mode' in withTodoMode(f, 'anything else'), false)
})

test('a follow-up posts only { text, followUp }: trimmed, no workspaceId, no sparc, even when the draft still holds them', async () => {
  const { newTodoPayload } = await load()
  assert.deepEqual(newTodoPayload(follow({ text: '  Run it again\n', followUp: '  the login bug session ', workspaceId: 'aaaa/w1', sparc: true })), { ok: true, body: { text: 'Run it again', followUp: 'the login bug session' } })
})

test('a follow-up keeps the line breaks inside the text', async () => {
  const { newTodoPayload } = await load()
  assert.equal(newTodoPayload(follow({ text: 'one\n\ntwo' })).body.text, 'one\n\ntwo')
})

test('a follow-up needs text (desktop wording) and a description (desktop wording)', async () => {
  const { newTodoPayload } = await load()
  for (const text of ['', '  \n', undefined, null, 7]) assert.deepEqual(newTodoPayload(follow({ text })), { ok: false, message: 'Type the task first.' }, String(text))
  for (const followUp of ['', '   ', undefined, null, 7]) assert.deepEqual(newTodoPayload(follow({ followUp })), { ok: false, message: 'Say which session this is for.' }, String(followUp))
  assert.deepEqual(newTodoPayload(follow({ text: '', followUp: '' })), { ok: false, message: 'Type the task first.' }, 'the text is checked first, as on the desktop')
})

test('the description may be 300 characters (after trimming) and not 301; the text limit stays 4000', async () => {
  const { newTodoPayload } = await load()
  assert.equal(newTodoPayload(follow({ followUp: 'x'.repeat(300) })).ok, true)
  assert.equal(newTodoPayload(follow({ followUp: '  ' + 'x'.repeat(300) + '  ' })).ok, true)
  assert.deepEqual(newTodoPayload(follow({ followUp: 'x'.repeat(301) })), { ok: false, message: 'Describe the session in 300 characters or fewer.' })
  assert.equal(newTodoPayload(follow({ text: 'x'.repeat(4000) })).ok, true)
  assert.deepEqual(newTodoPayload(follow({ text: 'x'.repeat(4001) })), { ok: false, message: 'That is too long.' })
})

test('the phone form still takes the session in words (the desktop form picks it in a dropdown), so its own validation messages say so', () => {
  const src = readFileSync(join(root, 'lib', 'mobile', 'todo-form.js'), 'utf8')
  assert.match(src, /'Say which session this is for\.'/)
  assert.match(src, /'Describe the session in ' \+ FOLLOWUP_MAX \+ ' characters or fewer\.'/)
})

test('a New session draft is unchanged by the follow-up work: same body as before, a stray followUp in the draft is ignored', async () => {
  const { newTodoPayload } = await load()
  assert.deepEqual(newTodoPayload({ text: 'Fix it', workspaceId: 'aaaa/w1', sparc: true }), { ok: true, body: { text: 'Fix it', sparc: true, workspaceId: 'aaaa/w1' } })
  assert.deepEqual(newTodoPayload({ text: 'Fix it', workspaceId: '', sparc: false, followUp: 'left over words' }), { ok: true, body: { text: 'Fix it', sparc: false } })
  assert.deepEqual(newTodoPayload({ text: 'Fix it', mode: 'new', followUp: '' }), { ok: true, body: { text: 'Fix it', sparc: false } })
})

test('the form wording constants are the desktop\'s', async () => {
  const t = await load()
  assert.equal(t.FOLLOWUP_TEXT_PLACEHOLDER, 'What should the existing session do next?')
  assert.equal(t.FOLLOWUP_QUERY_PLACEHOLDER, 'Which session? Describe it in your own words')
  assert.equal(t.FOLLOWUP_HINT, 'Nothing is sent until you confirm the session.')
})

// ---- error texts (POST /v1/todo and todo-confirm), the desktop's words through the shared core ----------------------------------------------

test('todoErrorText: empty-query, unknown-session and no-session read like the desktop, with the real shared core', async () => {
  const { todoErrorText } = await load()
  assert.equal(todoErrorText(core, 400, { error: 'empty-query' }), 'Say which session this is for.')
  assert.equal(todoErrorText(core, 409, { error: 'unknown-session' }), 'That session is not in the list any more. Pick another one.')
  assert.equal(todoErrorText(core, 409, { error: 'no-session' }), core.errorText(409, { error: 'no-session' }))
  assert.notEqual(todoErrorText(core, 409, { error: 'no-session' }), '', 'a sentence, not an empty string')
  for (const error of ['empty-query', 'unknown-session', 'no-session']) assert.equal(todoErrorText(core, 400, { error }), core.errorText(400, { error }), error)
})

test('todoErrorText: too-many-follow-ups has the same words on the phone form (with an unhelpful core too) and through the shared core', async () => {
  const { todoErrorText } = await load()
  assert.equal(todoErrorText({ errorText: () => 'CORE' }, 409, { error: 'too-many-follow-ups' }), 'Too many follow-ups are waiting: confirm or cancel one first.')
  assert.equal(todoErrorText(core, 409, { error: 'too-many-follow-ups' }), 'Too many follow-ups are waiting: confirm or cancel one first.')
  assert.equal(core.errorText(409, { error: 'too-many-follow-ups' }), 'Too many follow-ups are waiting: confirm or cancel one first.', 'a card action (act) uses the core')
})

test('todoErrorText: the old friendly codes are untouched', async () => {
  const { todoErrorText } = await load()
  assert.match(todoErrorText({ errorText: () => 'CORE' }, 400, { error: 'empty' }), /Type the task/)
  assert.match(todoErrorText({ errorText: () => 'CORE' }, 409, { error: 'owner-offline' }), /not running/i)
})

// ---- the view: the switch, the fields, the hint, the submit label ---------------------------------------------------------------------------

test('views.js imports the follow-up helpers from todo-form.js', () => {
  for (const name of ['FOLLOWUP_MAX', 'FOLLOWUP_TEXT_PLACEHOLDER', 'FOLLOWUP_QUERY_PLACEHOLDER', 'FOLLOWUP_HINT', 'isFollowUpDraft', 'withTodoMode']) {
    assert.match(views, new RegExp('import\\s*\\{[^}]*\\b' + name + '\\b[^}]*\\}\\s*from\\s*[\'"]\\./todo-form\\.js[\'"]'), name)
  }
})

test('the form has a New session | Follow up switch of two toggle buttons (aria-pressed), changing the mode through the draft', () => {
  const v = body('NewTodoView')
  assert.match(v, /New session/)
  assert.match(v, /Follow up/)
  assert.match(v, /role="group"/)
  assert.match(v, /aria-pressed=/)
  assert.match(v, /withTodoMode\(/)
  assert.match(v, /isFollowUpDraft\(/)
})

test('in Follow up mode the textarea has the follow-up placeholder and the description input has its own (max 300, saved in the draft)', () => {
  const v = body('NewTodoView')
  assert.match(v, /FOLLOWUP_TEXT_PLACEHOLDER/)
  assert.match(v, /FOLLOWUP_QUERY_PLACEHOLDER/)
  assert.match(v, /maxlength=\$\{FOLLOWUP_MAX\}/)
  assert.match(v, /value=\$\{draft\.followUp/)
  assert.match(v, /edit\(\{\s*followUp:/)
})

test('the description input is dictation-capable like the text box: its own Mic filling draft.followUp, never sending', () => {
  const v = body('NewTodoView')
  const mics = [...v.matchAll(/<\$\{Mic\}[^]*?\/>/g)].map((x) => x[0])
  assert.equal(mics.length, 2, 'the task text and the description each have a Mic')
  assert.ok(mics.some((t) => /text=\$\{draft\.followUp/.test(t) && /onText=\$\{[^}]*followUp/.test(t)), 'one fills followUp')
  assert.ok(mics.some((t) => /text=\$\{draft\.text\}/.test(t) && /onText=\$\{[^}]*\btext:/.test(t)), 'one still fills the text')
  for (const tag of mics) assert.doesNotMatch(tag, /\bact\s*\(|\bsend\w*\s*\(|\bsubmit\w*\s*\(|\bstartTodo\s*\(/)
})

test('Follow up mode hides the workspace dropdown and the SPARC switch (and its reload control), and shows the hint', () => {
  const v = body('NewTodoView')
  assert.match(v, /FOLLOWUP_HINT/)
  assert.match(v, /follow\s*\?\s*null\s*:[^]*Workspace/, 'the workspace field is conditional on follow')
  assert.match(v, /!follow[^\n]*workspaceChoices|follow\s*\?\s*null\s*:[^\n]*workspaceChoices|workspaceChoices[^]*follow/, 'workspaceChoices is inside the New session branch')
  assert.match(v, /!follow\s*&&[^\n]*Use SPARC|follow\s*\?\s*null\s*:[^\n]*Use SPARC/, 'SPARC is conditional on follow')
})

test('the submit button reads "Add follow-up" in Follow up mode and keeps "Start todo" otherwise; it still posts through newTodoPayload', () => {
  const v = body('NewTodoView')
  assert.match(v, /Add follow-up/)
  assert.match(v, /Start todo/)
  assert.match(v, /newTodoPayload\(draft\)/)
  assert.match(v, /startTodo\(payload\.body\)/)
  assert.match(v, /disabled=\$\{[^}]*\.trim\(\)/, 'still disabled on an empty text')
})

test('the workspaces are asked for only in New session mode (a follow-up never needs them)', () => {
  const v = body('NewTodoView')
  const effect = v.split('\n').find((l) => /loadWorkspaces\(\)/.test(l) && /useEffect/.test(l))
  assert.ok(effect, 'the useEffect that loads the workspaces')
  assert.match(effect, /follow|isFollowUpDraft/, 'guarded by the mode')
  assert.match(effect, /\[[^\]]*(?:follow|isFollowUpDraft)[^\]]*\]/, 'rerun when the mode changes, so switching back to New session loads them')
})

test('the heading and nothing else of the New session form changed: the text box keeps maxlength 4000 and the workspace select keeps its draft binding', () => {
  const v = body('NewTodoView')
  assert.match(v, /maxlength=\$\{TODO_MAX\}/)
  assert.match(v, /value=\$\{draft\.workspaceId\}/)
  assert.match(v, /checked=\$\{draft\.sparc\}/)
})
