import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'

// Action items (<u>**...**</u>) on the phone (lib/mobile/views.js): the full reply, the summary, the conversation messages and the
// question / reason text show them as emphasis (bold, a step bigger, NOT underlined) and never show the tags. The card helpers come
// from the overlay bundle (core = exports.shared of lib/client.js), the same ones the desktop uses. The views are Preact + htm: with
// a few browser globals stubbed their components can be called as plain functions (the ones without hooks) and the vnode tree read.
const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const noop = () => {}
globalThis.location = { pathname: '/m/', hash: '', origin: 'http://x', href: 'http://x/m/' }
globalThis.window = globalThis
globalThis.document = { addEventListener: noop, removeEventListener: noop, hidden: false, createElement: () => ({}), head: { append: noop } }
globalThis.addEventListener = noop
globalThis.removeEventListener = noop
globalThis.localStorage = { getItem: () => null, setItem: noop, removeItem: noop }

function loadOverlay() {
  let registered
  const file = join(root, 'lib', 'client.js')
  const sandbox = { window: { __ModuleLoader__: { load: (r) => { registered = r } }, localStorage: { getItem: () => null, setItem() {} } }, console, setTimeout, clearTimeout, setInterval, clearInterval, fetch: () => new Promise(() => {}) }
  vm.runInNewContext(readFileSync(file, 'utf8'), sandbox, { filename: file })
  return registered.factory(() => ({ createElement: () => null, Fragment: Symbol('Fragment'), useState() {}, useEffect() {}, useRef() {}, useSyncExternalStore() {} }))
}
const core = loadOverlay().shared
const api = await import('../lib/mobile/api.js')
api.setCoreForTests(core)
const views = await import('../lib/mobile/views.js')

/** The vnode tree with every function component called. */
function expand(n) {
  if (Array.isArray(n)) return n.map(expand)
  if (!n || typeof n !== 'object') return n
  if (typeof n.type === 'function') return expand(n.type(n.props))
  const kids = n.props && n.props.children
  return { type: n.type, props: n.props, children: [].concat(kids === undefined ? [] : kids).flat(Infinity).filter((c) => c !== null && c !== undefined && c !== false).map(expand) }
}
const walk = (n, out = []) => { if (Array.isArray(n)) n.forEach((c) => walk(c, out)); else if (n && typeof n === 'object') { out.push(n); n.children.forEach((c) => walk(c, out)) } return out }
const texts = (n, out = []) => { if (Array.isArray(n)) n.forEach((c) => texts(c, out)); else if (typeof n === 'string') out.push(n); else if (n && typeof n === 'object') n.children.forEach((c) => texts(c, out)); return out }
const TAG = /<\/?u\b|&lt;\/?u|&gt;/i
const action = (n) => n.type === 'strong' && n.props.class === 'action'
const render = (node) => expand(node)

const REPLY = [
  'Fixed the list.',
  '',
  '<u>**Restart DSH, run `pnpm run dev:web` and refresh the page (the *.js files changed).**</u>',
  '',
  '- <u>**Approve the PR**</u>',
  '- a plain item',
  '',
  '**<u>Reply A or B.</u>**',
  '',
  '<U>**Capitals work too.**</U>',
  '',
  '&lt;u&gt;**Escaped tags.**&lt;/u&gt;',
  '',
  '<u>No bold markers here.</u> and <u><u>**nested**</u></u> and <u>**cut off',
].join('\n')

test('the full reply (Md) shows every action item as emphasis and never a tag', () => {
  const tree = render(views.Md({ text: REPLY }))
  assert.doesNotMatch(texts(tree).join('\n'), TAG)
  assert.deepEqual(walk(tree).filter(action).map((n) => texts(n).join('')), [
    'Restart DSH, run pnpm run dev:web and refresh the page (the *.js files changed).', 'Approve the PR', 'Reply A or B.', 'Capitals work too.', 'Escaped tags.', 'No bold markers here.', 'nested', 'cut off'])
})

test('the summary line (inlineNodes) shows the action, bold with no inline underline', () => {
  const tree = render({ type: 'div', props: { children: views.inlineNodes('Fixed it.\n\n<u>**Restart the service *now*.**</u>') } })
  const el = walk(tree).find(action)
  assert.ok(el, 'an action element')
  assert.equal(texts(el).join(''), 'Restart the service now.')
  assert.equal(el.props.style, undefined)
  assert.doesNotMatch(JSON.stringify(tree), /underline/)
})

test('other tags stay plain text children', () => {
  const tree = render(views.Md({ text: '<script>alert(1)</script> <img src=x onerror=alert(1)> <u>**ok**</u>' }))
  assert.match(texts(tree).join(''), /<script>alert\(1\)<\/script> <img src=x onerror=alert\(1\)>/)
  assert.ok(!walk(tree).some((n) => n.type === 'script' || n.type === 'img'))
})

test('ActionText shows the action items of a plain text as emphasis and keeps everything else as it is', () => {
  assert.equal(typeof views.ActionText, 'function', 'views.js exports ActionText')
  const tree = render({ type: 'div', props: { children: views.ActionText({ text: 'Deploy *.js now? <u>**Only after the backup.**</u>' }) } })
  assert.equal(texts(tree).join(''), 'Deploy *.js now? Only after the backup.')
  assert.deepEqual(walk(tree).filter(action).map((n) => texts(n).join('')), ['Only after the backup.'])
  assert.equal(texts(render({ type: 'div', props: { children: views.ActionText({ text: undefined }) } })).join(''), '')
})

test('a conversation bubble renders the assistant text with the action; the user\'s own text stays exactly as typed', () => {
  assert.equal(typeof views.Bubble, 'function', 'views.js exports Bubble')
  const bot = render(views.Bubble({ m: { id: 'a1', role: 'assistant', text: 'Done.\n\n<u>**Restart it.**</u>', time: 0 } }))
  assert.doesNotMatch(texts(bot).join('\n'), TAG)
  assert.deepEqual(walk(bot).filter(action).map((n) => texts(n).join('')), ['Restart it.'])
  const user = render(views.Bubble({ m: { id: 'u1', role: 'user', text: 'I typed <u>this</u> *as is*', time: 0 } }))
  assert.equal(texts(user).join(''), 'I typed <u>this</u> *as is*')
})

// The bodies use hooks (a store subscription), so they cannot be called outside a render: their wiring is checked in the source.
const views_src = readFileSync(join(root, 'lib', 'mobile', 'views.js'), 'utf8')
test('the question, option and reason text go through ActionText; nothing sets HTML', () => {
  assert.match(views_src, /<div class="qtext"><\$\{ActionText\} text=\$\{q\.question\} \/><\/div>/)
  assert.match(views_src, /\$\{o\.description \? html`<div class="d"><\$\{ActionText\} text=\$\{o\.description\} \/><\/div>`/)
  assert.match(views_src, /<div class="sub"><\$\{ActionText\} text=\$\{p\.reason\} \/><\/div>/)
  assert.match(views_src, /<div class="sub"><\$\{ActionText\} text=\$\{q\.header\} \/><\/div>/)
  assert.doesNotMatch(views_src, /innerHTML|dangerouslySetInnerHTML/)
})

// ---------- the look ----------

const css = readFileSync(join(root, 'lib', 'mobile', 'style.css'), 'utf8')
test('the action text is bold, one step bigger and not underlined (phone CSS)', () => {
  const rule = /(?:^|\n)\s*(?:\.md )?\.action\s*\{([^}]*)\}/.exec(css)
  assert.ok(rule, '.action has a rule in style.css')
  assert.match(rule[1], /font-weight:\s*700/)
  assert.match(rule[1], /font-size:\s*1\.15em/)
  assert.match(rule[1], /text-decoration:\s*none/)
  assert.match(rule[1], /line-height:\s*1\.\d+/)
  assert.doesNotMatch(css, /underline/)
  assert.doesNotMatch(views_src, /underline/)
})
