import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { FILES } from '../mobile.js'

// Wiring of the phone's "+ New todo" screen, the todo card and the dictation (mic) buttons: source-text checks in the style of
// mobile-view-guard / mobile-style (the repo has no DOM harness for the Preact views). The pure logic is tested in mobile-dictation,
// mobile-todo-form and mobile-todo-card; this file makes sure the thin views actually use it, and that nothing dictated is ever sent.
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const MOBILE = join(ROOT, 'lib', 'mobile')
const read = (name) => readFileSync(join(MOBILE, name), 'utf8')
const views = read('views.js')
const api = read('api.js')
const css = read('style.css')

/** The source of one top-level function, up to the next top-level function. */
function body(src, name) {
  const start = src.search(new RegExp('(?:^|\\n)(?:export )?(?:async )?function ' + name + '\\b'))
  assert.notEqual(start, -1, 'views.js defines function ' + name)
  const rest = src.slice(start + 1)
  const next = rest.search(/\n(?:export )?(?:async )?function \w+|\n\/\/ ---- /)
  return next === -1 ? rest : rest.slice(0, next)
}

// ---- C: served files, test list ---------------------------------------------------------------------------------------------------

test('dictation.js and todo-form.js are served by the phone router as JavaScript', () => {
  for (const name of ['dictation.js', 'todo-form.js']) {
    assert.ok(Object.hasOwn(FILES, name), 'FILES lists ' + name)
    assert.match(FILES[name].type, /javascript/, name)
    assert.ok(FILES[name].file.endsWith(name), name + ' -> ' + FILES[name].file)
  }
})

test('the new test files are in the package.json test script', () => {
  const script = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).scripts.test
  const listed = script.replace(/^node --test\s+/, '').split(/\s+/)
  const added = ['test/mobile-dictation.test.mjs', 'test/mobile-todo-form.test.mjs', 'test/mobile-todo-card.test.mjs', 'test/hub-device-todo.test.mjs', 'test/mobile-todo-wiring.test.mjs']
  for (const f of added) assert.ok(listed.includes(f), f + ' is listed')
})

test('the new CSS classes exist in style.css: .mic, .mic.on (listening) and .newtodo', () => {
  assert.match(css, /(^|\n|\})\s*\.mic\s*\{/)
  assert.match(css, /(^|\n|\})\s*\.mic\.on\s*\{/)
  assert.match(css, /(^|\n|\})\s*\.newtodo\b[^{]*\{/)
})

// ---- views.js imports and routing -------------------------------------------------------------------------------------------------

test('views.js imports the dictation and todo-form modules and uses them', () => {
  assert.match(views, /import\s*\{[^}]*\bcreateDictation\b[^}]*\}\s*from\s*['"]\.\/dictation\.js['"]/)
  assert.match(views, /import\s*\{[^}]*\bnewTodoPayload\b[^}]*\}\s*from\s*['"]\.\/todo-form\.js['"]/)
  assert.match(views, /import\s*\{[^}]*\bworkspaceChoices\b[^}]*\}\s*from\s*['"]\.\/todo-form\.js['"]/)
  assert.match(views, /import\s*\{[^}]*\btodoErrorText\b[^}]*\}\s*from\s*['"]\.\/todo-form\.js['"]/)
  assert.match(views, /import\s*\{[^}]*\bloadWorkspaces\b[^}]*\}\s*from\s*['"]\.\/api\.js['"]/)
})

test('the Waiting screen has a "+ New todo" link to #/new', () => {
  const waiting = body(views, 'WaitingList')
  assert.match(waiting, /href="#\/new"/)
  assert.match(waiting, /\+ New todo/)
})

test('the App handles the #/new route with the new-todo screen, and keeps Waiting highlighted in the nav', () => {
  const app = body(views, 'App')
  assert.match(app, /route\s*===\s*['"]\/new['"]/)
  assert.match(app, /<\$\{NewTodoView\}/)
  assert.match(views, /(?:^|\n)(?:export )?function NewTodoView\b/)
})

// ---- NewTodoView -----------------------------------------------------------------------------------------------------------------

test('the new-todo form has the textarea (max 4000), the workspace select, the SPARC checkbox, the mic and the Start todo button', () => {
  const v = body(views, 'NewTodoView')
  assert.match(v, /<textarea/)
  assert.match(v, /maxlength=\$\{TODO_MAX\}|maxLength=\$\{TODO_MAX\}|maxlength="4000"/i)
  assert.match(v, /<select/)
  assert.match(v, /workspaceChoices\(/)
  assert.match(v, /type="checkbox"/)
  assert.match(v, /Use SPARC/)
  assert.match(v, /<\$\{Mic\}/)
  assert.match(v, /Start todo/)
})

test('the Start todo button is disabled while the text is empty or the request is busy, and submits through newTodoPayload', () => {
  const v = body(views, 'NewTodoView')
  assert.match(v, /disabled=\$\{[^}]*busy[^}]*\}/)
  assert.match(v, /disabled=\$\{[^}]*\.trim\(\)[^}]*\}|disabled=\$\{[^}]*!\s*draft\.text/)
  assert.match(v, /newTodoPayload\(/)
})

test('a started todo posts to /v1/todo, shows todoErrorText on failure and goes back to the list on success', () => {
  const v = body(views, 'NewTodoView')
  assert.match(views + api, /['"]\/v1\/todo['"]/)
  assert.match(v, /todoErrorText\(/)
  assert.match(v, /go\(\s*['"]\/['"]\s*\)/)
})

test('the new-todo form reloads the workspaces on a failure and says why when none are listed', () => {
  const v = body(views, 'NewTodoView')
  assert.match(v, /loadWorkspaces\(/)
  assert.match(v, /workspacesNote\(/)
  assert.match(views, /import\s*\{[^}]*\bworkspacesNote\b[^}]*\}\s*from\s*['"]\.\/todo-form\.js['"]/)
  assert.match(v, /Reload|Try again/i, 'a reload control')
})

// ---- api.js ----------------------------------------------------------------------------------------------------------------------

test('api.js keeps the todo draft in state across screens and clears it after a successful start', () => {
  assert.match(api, /import\s*\{[^}]*\bemptyTodoDraft\b[^}]*\}\s*from\s*['"]\.\/todo-form\.js['"]/)
  assert.match(api, /todoDraft:\s*loadTodoDraft\(storage\)/, 'initial state: the saved draft (an empty one when nothing was saved, see mobile-todo-draft.test.mjs)')
  assert.match(api, /todoDraft:\s*emptyTodoDraft\(\)/, 'reset to an empty draft after a successful start')
  assert.match(views, /todoDraft/)
})

test('api.js loads the workspaces with the device token, keeps the list and the failure in state, and handles an auth failure', () => {
  assert.match(api, /workspaces:\s*null/)
  assert.match(api, /workspacesError/)
  const fn = body(api, 'loadWorkspaces')
  assert.match(fn, /call\(\s*API\s*\+\s*['"]\/v1\/workspaces['"]/, 'through call(), which carries the token')
  assert.match(fn, /handleAuthFailure\(/)
  assert.match(fn, /workspaces/)
})

// ---- the todo card ---------------------------------------------------------------------------------------------------------------

test('the todo card has a workspace dropdown, Start / Retry and Cancel, and no Open session (open-session is desktop only)', () => {
  const v = body(views, 'TodoBody')
  assert.match(v, /todoCardModel\(/)
  assert.match(v, /<select/)
  assert.match(v, /startLabel/)
  assert.match(v, /Cancel/)
  assert.doesNotMatch(views, /Open session/i)
  assert.doesNotMatch(views, /open-session/)
})

test('the todo card is read-only text when the todo is starting, started or cancelled (the buttons depend on canAct)', () => {
  const v = body(views, 'TodoBody')
  assert.match(v, /canAct/)
})

// ---- dictation: Mic --------------------------------------------------------------------------------------------------------------

test('there is one Mic component, hidden when the browser has no speech recognition', () => {
  const mic = body(views, 'Mic')
  assert.match(mic, /dictationSupport\(|createDictation\(/)
  assert.match(mic, /return null/)
})

test('the Mic button shows a listening state: aria-pressed, the .mic and .mic on classes', () => {
  const mic = body(views, 'Mic')
  assert.match(mic, /aria-pressed=/)
  assert.match(mic, /['"]mic['"]|['"]mic |\bmic\b/)
  assert.match(mic, /['"]mic on['"]|' on'|\bon\b/)
  assert.match(mic, /<button/)
})

test('the Mic stops listening when it is removed (unmount), so a left screen never keeps the microphone (halt: abort, no late result)', () => {
  const mic = body(views, 'Mic')
  assert.match(mic, /useEffect\(/)
  assert.match(mic, /return\s*\(\)\s*=>\s*[^;\n]*(?:stop|halt)\(\)|=>\s*\{[^}]*\.(?:stop|halt)\(\)/)
})

test('the Mic starts dictation from the current text and hands the recognised text to the box, and nothing else', () => {
  const mic = body(views, 'Mic')
  assert.match(mic, /\.start\(/)
  assert.match(mic, /onText/)
  assert.match(mic, /createDictation\(\s*\{[^}]*onText/, 'the recognised text goes to the onText callback prop')
})

test('dictation never sends: the Mic has no act/fetch/go/send, no endpoint and no Send handler', () => {
  const mic = body(views, 'Mic')
  assert.doesNotMatch(mic, /\bact\s*\(/)
  assert.doesNotMatch(mic, /\bfetch\s*\(/)
  assert.doesNotMatch(mic, /\bgo\s*\(/)
  assert.doesNotMatch(mic, /\bsend\w*\s*\(/i)
  assert.doesNotMatch(mic, /\/v1\//)
  assert.doesNotMatch(mic, /\bsubmit\w*\s*\(/i)
})

test('the three free-text boxes each have a Mic: the todo text, the session composer and every "Other answer…" input', () => {
  assert.match(body(views, 'NewTodoView'), /<\$\{Mic\}/)
  const reply = body(views, 'Composer')
  assert.match(reply, /<\$\{Mic\}/)
  assert.match(reply, /Message this session…/)
  const question = body(views, 'QuestionBody')
  assert.match(question, /<\$\{Mic\}/)
  assert.match(question, /Other answer…/)
  assert.ok((views.match(/<\$\{Mic\}/g) || []).length >= 3, 'at least three uses')
})

test('a Mic callback only edits the draft: in the composer and answer boxes it uses the same setters as typing', () => {
  const reply = body(views, 'Composer')
  assert.match(reply, /<\$\{Mic\}[^>]*onText=\$\{setDraft\}/, 'the composer is filled through the same draft setter as typing')
  const question = body(views, 'QuestionBody')
  assert.match(question, /<\$\{Mic\}[^>]*onText=\$\{[^}]*(?:setDraft|custom)[^}]*\}/, 'an answer box is filled through setDraft')
  for (const src of [reply, question, body(views, 'NewTodoView')]) {
    const m = [...src.matchAll(/<\$\{Mic\}[^>]*>/g)].map((x) => x[0])
    for (const tag of m) assert.doesNotMatch(tag, /\bact\s*\(|\bsend\s*\(|\bsubmit\w*\s*\(/, 'Mic props never call the send path')
  }
})
