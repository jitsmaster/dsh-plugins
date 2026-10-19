import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { FILES } from '../mobile.js'

// Wiring of the chat thread on the phone (docs/mobile.md "Chat thread"): source-text checks in the style of mobile-todo-wiring (the repo has
// no DOM harness for the Preact views). The pure logic is tested in mobile-thread, the state and requests in mobile-api-thread; this file makes
// sure the thin views use them, that the old reply box is gone, that polling is started and stopped by the screen, and that nothing sends by Enter.
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const MOBILE = join(ROOT, 'lib', 'mobile')
const read = (name) => readFileSync(join(MOBILE, name), 'utf8')
const views = read('views.js')
const api = read('api.js')
const css = read('style.css')
const page = read('index.html')

/** The source of one top-level function, up to the next top-level function or section comment. */
function body(src, name) {
  const start = src.search(new RegExp('(?:^|\\n)(?:export )?(?:async )?function ' + name + '\\b'))
  assert.notEqual(start, -1, 'defines function ' + name)
  const rest = src.slice(start + 1)
  const next = rest.search(/\n(?:export )?(?:async )?function \w+|\n\/\/ ---- /)
  return next === -1 ? rest : rest.slice(0, next)
}

// ---- served files and the test script ------------------------------------------------------------------------------------------------

test('thread.js is served by the phone router as JavaScript', () => {
  assert.ok(Object.hasOwn(FILES, 'thread.js'))
  assert.match(FILES['thread.js'].type, /javascript/)
  assert.ok(FILES['thread.js'].file.endsWith('thread.js'))
})

test('the new test files are in the package.json test script', () => {
  const listed = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).scripts.test.replace(/^node --test\s+/, '').split(/\s+/)
  for (const f of ['test/thread-cache.test.mjs', 'test/thread-cost.test.mjs', 'test/mobile-thread.test.mjs', 'test/mobile-api-thread.test.mjs', 'test/mobile-thread-wiring.test.mjs', 'test/thread-security.test.mjs', 'test/agent-client-thread.test.mjs']) assert.ok(listed.includes(f), f + ' is listed')
})

test('the viewport lets the on-screen keyboard resize the page (the composer stays above it) and keeps viewport-fit=cover', () => {
  assert.match(page, /name="viewport"[^>]*interactive-widget=resizes-content/)
  assert.match(page, /name="viewport"[^>]*viewport-fit=cover/)
})

// ---- imports ------------------------------------------------------------------------------------------------------------------------

test('views.js uses the pure thread module and the api functions of the chat', () => {
  assert.match(views, /import\s*\{[^}]*\bcanPost\b[^}]*\}\s*from\s*['"]\.\/thread\.js['"]/)
  assert.match(views, /import\s*\{[^}]*\bhasThread\b[^}]*\}\s*from\s*['"]\.\/thread\.js['"]/)
  assert.match(views, /import\s*\{[^}]*\bscrollPlan\b[^}]*\}\s*from\s*['"]\.\/thread\.js['"]/)
  assert.match(views, /import\s*\{[^}]*\bisNearBottom\b[^}]*\}\s*from\s*['"]\.\/thread\.js['"]/)
  for (const fn of ['loadThread', 'loadEarlier', 'postFollowUp', 'startThreadPolling', 'stopThreadPolling']) {
    assert.match(views, new RegExp('import\\s*\\{[^}]*\\b' + fn + '\\b[^}]*\\}\\s*from\\s*[\'"]\\./api\\.js[\'"]'), fn)
  }
})

test('api.js imports the pure module and keeps the threads in state', () => {
  assert.match(api, /from\s*['"]\.\/thread\.js['"]/)
  assert.match(api, /threads:\s*\{\}/)
})

// ---- the item screen ----------------------------------------------------------------------------------------------------------------

test('the item screen shows the conversation for an item that hasThread (a todo has none) and the composer only for one that canPost (a paused one has none)', () => {
  const v = body(views, 'ItemView')
  assert.match(v, /hasThread\(\s*item\s*\)/)
  assert.match(v, /canPost\(\s*item\s*\)/)
  assert.match(v, /<\$\{Conversation\}/)
  assert.match(v, /<\$\{Composer\}/)
  assert.match(v, /chat\s*\?\s*html`<\$\{Conversation\}/, 'the conversation is conditional on hasThread')
  assert.match(v, /writable\s*\?\s*html`<\$\{Composer\}/, 'the composer is conditional on canPost')
  assert.match(v, /const chat = hasThread\(item\)/)
  assert.match(v, /const writable = canPost\(item\)/)
})

test('switching from one item to another in place resets the conversation: the section and its thread polling are keyed by the item id', () => {
  const v = body(views, 'ItemView')
  assert.match(v, /<\$\{Conversation\}\s+key=\$\{item\.id\}/)
})

test('the composer is the last thing of the card, so it can stick to the bottom of the screen', () => {
  const v = body(views, 'ItemView')
  assert.ok(v.indexOf('<${Composer}') > v.indexOf('Back'), 'after the Back row')
  assert.ok(v.indexOf('<${Composer}') > v.indexOf('<${Conversation}'))
  assert.match(v.slice(v.indexOf('<${Composer}')), /^[^]*<\/article>/)
})

test('the conversation sits in a collapsible section below the actions: open for done and resolved items, closed where the buttons matter', () => {
  const c = body(views, 'Conversation')
  assert.match(c, /<details/)
  assert.match(c, /<summary/)
  assert.match(c, /Conversation/)
  assert.match(c, /onToggle=/, 'the open state is kept in the component, so a re-render does not undo the reader')
  const v = body(views, 'ItemView')
  assert.match(v, /defaultOpen=\$\{[^}]*completed[^}]*\}/)
  assert.ok(v.indexOf('<${Conversation}') > v.indexOf('<${Body}'), 'the actions come first')
})

test('a generic error is not drawn twice: a chat item shows its error in the composer', () => {
  const v = body(views, 'ItemView')
  assert.match(v, /st\.errors\[item\.id\]/)
  assert.match(v, /!writable/)
  assert.match(body(views, 'Composer'), /st\.errors\[/)
})

// ---- ThreadView ---------------------------------------------------------------------------------------------------------------------

test('the thread screen is mounted, loads and polls only while the Conversation section is open: never when collapsed', () => {
  const c = body(views, 'Conversation')
  assert.match(c, /open\s*\?\s*html`<\$\{ThreadView\}/, 'ThreadView is rendered under an open check')
  assert.equal([...c.matchAll(/<\$\{ThreadView\}/g)].length, 1)
  const t = body(views, 'ThreadView')
  assert.doesNotMatch(t.split('\n')[0], /\bopen\b/, 'ThreadView has no open prop: being mounted means open')
  assert.doesNotMatch(t, /\[open\]/, 'nothing in ThreadView reacts to the details toggle: the mount does')
})

test('the open state of the section is the details toggle, so polling starts when it opens and stops when it closes', () => {
  const c = body(views, 'Conversation')
  assert.match(c, /useState\(defaultOpen\)/)
  assert.match(c, /onToggle=\$\{\(e\)\s*=>\s*setOpen\(e\.currentTarget\.open\)\}/)
  assert.match(c, /<details[^>]*open=\$\{open\}/)
  const t = body(views, 'ThreadView')
  assert.match(t, /startThreadPolling\(id\)/)
  assert.match(t, /return\s*\(\)\s*=>\s*stopThreadPolling\(\)/, 'unmounting (closing the section) stops the poll')
})

test('the thread screen loads the first page, starts the 5 s refresh and stops it when the screen goes', () => {
  const t = body(views, 'ThreadView')
  assert.match(t, /useEffect\(/)
  assert.match(t, /loadThread\(/)
  assert.match(t, /startThreadPolling\(/)
  assert.match(t, /return\s*\(\)\s*=>\s*(?:\{[^}]*)?stopThreadPolling\(\)/)
})

test('user bubbles are plain pre-wrapped text on the right, assistant bubbles are rendered with Md on the left', () => {
  const b = body(views, 'Bubble')
  assert.match(b, /<\$\{Md\}/)
  assert.match(b, /'bubble '|"bubble "|bubble \$\{/)
  assert.match(b, /utext/)
  assert.match(b, /class="utext">\$\{m\.text\}</, 'the user text goes in as it is, not parsed as markdown')
})

test('a truncated message says so, and a pending one says Sending or Sent', () => {
  const b = body(views, 'Bubble')
  assert.match(b, /truncated/)
  assert.match(b, /…/)
  assert.match(b, /Sending…/)
  assert.match(b, /Sent/)
})

test('the thread has Load earlier (only while hasMore), loading, empty and error states with Retry, and a new-messages pill', () => {
  const t = body(views, 'ThreadView')
  assert.match(t, /Load earlier/)
  assert.match(t, /hasMore/)
  assert.match(t, /loadEarlier\(/)
  assert.match(t, /Loading the conversation…/)
  assert.match(t, /No messages yet/)
  assert.match(t, /Retry/)
  assert.match(t, /pill/)
  assert.match(t, /new message/)
  assert.match(t, /offline|\.error/, 'an error with messages on screen is a small note, not a wipe')
})

test('the transcript follows new messages according to scrollPlan, remembers where the reader was, and keeps the place on Load earlier', () => {
  const t = body(views, 'ThreadView')
  assert.match(t, /scrollPlan\(/)
  assert.match(t, /isNearBottom\(/)
  assert.match(t, /onScroll=/)
  assert.match(t, /scrollHeight/)
  assert.match(t, /scrollTop/)
})

test('a reader at the bottom stays there when the box is resized without a new message (found in the browser: resolving a done item reset the box to the top)', () => {
  const t = body(views, 'ThreadView')
  assert.match(t, /new ResizeObserver\(/)
  assert.match(t, /\.disconnect\(\)/)
})

// ---- Composer -----------------------------------------------------------------------------------------------------------------------

test('the composer has a textarea, the Mic and a Send button; the draft lives in state.replies', () => {
  const c = body(views, 'Composer')
  assert.match(c, /<textarea/)
  assert.match(c, /<\$\{Mic\}/)
  assert.match(c, />\s*\$\{[^}]*Send[^}]*\}\s*<\/button>|>Send<\/button>/)
  assert.match(c, /st\.replies\[/)
  assert.match(c, /replies:\s*\{\s*\.\.\.state\.replies/)
})

test('the Mic fills the draft and nothing else: no send in its props', () => {
  const c = body(views, 'Composer')
  const tags = [...c.matchAll(/<\$\{Mic\}[^>]*>/g)].map((x) => x[0])
  assert.equal(tags.length, 1)
  assert.match(tags[0], /onText=\$\{setDraft\}|onText=\$\{\(t\)\s*=>\s*setDraft\(t\)\}/)
  assert.doesNotMatch(tags[0], /\bact\s*\(|\bsend\s*\(|postFollowUp|\bsubmit/)
})

test('Send posts through postFollowUp, is disabled while posting or empty, and does not leave the screen', () => {
  const c = body(views, 'Composer')
  assert.match(c, /postFollowUp\(/)
  assert.match(c, /disabled=\$\{[^}]*busy[^}]*\}/)
  assert.match(c, /\.trim\(\)/)
  assert.doesNotMatch(c, /\bgo\s*\(/)
  assert.doesNotMatch(c, /\/v1\/reply/)
})

test('the text box is read-only while posting, not disabled: a disabled box would close the phone keyboard', () => {
  const c = body(views, 'Composer')
  const box = c.slice(c.indexOf('<textarea'), c.indexOf('</textarea>'))
  assert.ok(box.length > 0, 'the composer has a textarea')
  assert.match(box, /readOnly=\$\{busy\}/)
  assert.doesNotMatch(box, /\bdisabled\b/)
})

test('a read-only composer box is dimmed like a disabled button, so the wait is visible', () => {
  assert.match(css, /\.composer-input\[readonly\]\s*\{[^}]*opacity:/)
})

test('the card has no "chat" class: no style uses it', () => {
  assert.doesNotMatch(css, /\.card\.chat|\.chat\b/)
  assert.doesNotMatch(body(views, 'ItemView'), /class=\$\{'card'\s*\+|'\s*chat'|card chat/)
})

test('Enter inserts a newline: no key handler sends, the Send button is the only way', () => {
  const c = body(views, 'Composer')
  assert.doesNotMatch(c, /onKeyDown|onKeyPress|onKeyUp|isSendKey|key\s*===\s*['"]Enter['"]/)
  assert.doesNotMatch(c, /<form/)
})

test('the textarea grows with its text, up to about five lines', () => {
  assert.match(body(views, 'Composer'), /autoGrow\(/)
  assert.match(body(views, 'autoGrow'), /scrollHeight/)
  assert.match(css, /\.composer-input\s*\{[^}]*max-height:[^;}]*5/)
})

// ---- the done card: the old reply box is replaced -----------------------------------------------------------------------------------

test('the done card has no reply box of its own any more: no textarea, no Send reply, no /v1/reply; Reviewed and the full reply stay', () => {
  const c = body(views, 'CompletedBody')
  assert.doesNotMatch(c, /<textarea/)
  assert.doesNotMatch(c, /Reply to this session…/)
  assert.doesNotMatch(c, /Send reply/)
  assert.doesNotMatch(c, /\/v1\/reply/)
  assert.doesNotMatch(c, /<\$\{Mic\}/)
  assert.match(c, /Reviewed/)
  assert.match(c, /\/v1\/reviewed/)
  assert.match(c, /Full reply/)
  assert.match(c, /item\.summary/)
})

test('the other bodies keep their action buttons', () => {
  assert.match(body(views, 'QuestionBody'), /Send answer|sendLabel/)
  assert.match(body(views, 'PermissionBody'), /Approve…/)
  assert.match(body(views, 'PermissionBody'), /Deny/)
  assert.match(body(views, 'PrMergedBody'), /Archive session…/)
  assert.match(body(views, 'PrMergedBody'), /Keep session/)
})

// ---- style --------------------------------------------------------------------------------------------------------------------------

test('style.css has the chat classes', () => {
  for (const sel of ['\\.conversation', '\\.thread-scroll', '\\.bubble', '\\.bubble\\.user', '\\.bubble\\.assistant', '\\.bubble\\.pending', '\\.pill', '\\.composer', '\\.composer-input', '\\.thread-more', '\\.thread-note']) {
    assert.match(css, new RegExp('(^|\\n|\\})\\s*' + sel + '\\b[^{]*\\{'), sel)
  }
})

test('user bubbles are on the right and assistant bubbles on the left', () => {
  assert.match(css, /\.bubble\.user\s*\{[^}]*align-self:\s*flex-end/)
  assert.match(css, /\.bubble\.assistant\s*\{[^}]*align-self:\s*flex-start/)
  assert.match(css, /\.bubble \.utext\s*\{[^}]*white-space:\s*pre-wrap/)
})

test('the composer sticks above the tab bar and respects the safe area; the transcript height follows the dynamic viewport', () => {
  const composer = /\.composer\s*\{([^}]*)\}/.exec(css)[1]
  assert.match(composer, /position:\s*sticky/)
  assert.match(composer, /bottom:\s*calc\(var\(--nav\)\s*\+\s*env\(safe-area-inset-bottom\)\)/)
  assert.match(/\.thread-scroll\s*\{([^}]*)\}/.exec(css)[1], /dvh/)
  assert.match(/\.thread-scroll\s*\{([^}]*)\}/.exec(css)[1], /overflow-y:\s*auto/)
})

// ---- dictation vs Send: a running dictation is halted before a post (review finding) ------------------------------------------------------
// A Web Speech recognition that is still listening or finalizing keeps calling onText after Send. Then either the 250 ms draft buffer wrote the
// just-sent text back into state.replies (an unsent draft again, saved, sendable twice), or a final result that differed from the sent interim
// text made postFollowUp keep the draft after success. The Mic can be halted by its owner, halts itself when it gets disabled or removed, and
// the composer halts it before posting and ignores dictated text while a post is running. The pure halt is tested in mobile-dictation.

test('the Mic can be halted by its owner: a halt ref prop it fills with a function that halts the dictation (not just stops it)', () => {
  const mic = body(views, 'Mic')
  assert.match(mic, /function Mic\(\{[^}]*\bhalt\b[^}]*\}\)/, 'a halt prop')
  assert.match(mic, /halt\.current\s*=\s*[^\n]*\.halt\(\)/, 'the ref holds a function that calls dictation.halt()')
})

test('the Mic halts its dictation when it gets disabled (a post or an answer is running)', () => {
  const mic = body(views, 'Mic')
  assert.match(mic, /useEffect\(\s*\(\)\s*=>\s*\{[^}]*\bdisabled\b[^}]*\.halt\(\)[^}]*\}\s*,\s*\[\s*disabled\s*\]\s*\)/)
})

test('the Mic halts (not just stops) its dictation when it is removed: a final result cannot land in a left screen', () => {
  const mic = body(views, 'Mic')
  assert.match(mic, /\(\)\s*=>\s*\(\)\s*=>\s*\{[^}]*\.halt\(\)[^}]*\}\s*,\s*\[\s*\]\s*\)/, 'an unmount cleanup that halts')
  assert.doesNotMatch(mic, /\(\)\s*=>\s*\(\)\s*=>\s*\{[^}]*\.stop\(\)/, 'and does not merely stop')
})

test('the composer gives the Mic a halt ref and calls it before the post, after the draft was last written', () => {
  const c = body(views, 'Composer')
  const tag = [...c.matchAll(/<\$\{Mic\}[^>]*>/g)].map((x) => x[0])[0]
  assert.match(tag, /halt=\$\{(\w+)\}/, 'the Mic gets a halt ref')
  const ref = /halt=\$\{(\w+)\}/.exec(tag)[1]
  assert.match(c, new RegExp('const ' + ref + ' = useRef\\('), 'the ref is a useRef of the composer')
  const send = c.slice(c.indexOf('const send ='))
  const at = (re) => send.search(re)
  assert.ok(at(new RegExp(ref + '\\.current')) !== -1, 'send calls the halt')
  assert.ok(at(new RegExp(ref + '\\.current')) < at(/\.flush\(\)/), 'the dictation is halted before the draft is flushed')
  assert.ok(at(/\.flush\(\)/) < at(/postFollowUp\(/), 'and the draft is flushed before the post')
})

test('the composer ignores dictated text while a post of its item is running', () => {
  const c = body(views, 'Composer')
  const set = c.slice(c.indexOf('const setDraft ='), c.indexOf('const flush ='))
  assert.match(set, /state\.busy\[id\]/, 'it reads the live busy flag (not the render-time constant)')
  assert.ok(set.search(/state\.busy\[id\]/) < set.search(/buffer\.current\.set\(/), 'the guard comes before the draft is written')
})
