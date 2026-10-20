import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'

// The phone header shows "N working / M open" next to the waiting count (same words as the desktop), and never a tip.
const root = join(dirname(fileURLToPath(import.meta.url)), '..')
function loadOverlay() {
  let registered
  const file = join(root, 'lib', 'client.js')
  const sandbox = { window: { __ModuleLoader__: { load: (r) => { registered = r } }, localStorage: { getItem: () => null, setItem() {} } }, console, setTimeout, clearTimeout, setInterval, clearInterval, fetch: () => new Promise(() => {}) }
  vm.runInNewContext(readFileSync(file, 'utf8'), sandbox, { filename: file })
  return registered.factory(() => ({ createElement: () => null, Fragment: Symbol('Fragment'), useState() {}, useEffect() {}, useRef() {}, useSyncExternalStore() {} }))
}
const core = loadOverlay().shared
const views = readFileSync(join(root, 'lib', 'mobile', 'views.js'), 'utf8')
const css = readFileSync(join(root, 'lib', 'mobile', 'style.css'), 'utf8')
const model = () => import('../lib/mobile/model.js')

test('the list model has the sessions text of the desktop, empty while unknown (never 0 working / 0 open by default)', async () => {
  const { listModel } = await model()
  assert.equal(listModel(core, { open: [], resolved: [], sessions: { working: 2, open: 5 } }, { type: 'all' }).sessions, '2 working / 5 open')
  assert.equal(listModel(core, { open: [], resolved: [] }, { type: 'all' }).sessions, '')
  assert.equal(listModel(core, null, { type: 'all' }).sessions, '')
})

test('the header of the app shows the numbers in its own element next to the count, with a title', () => {
  assert.match(views, /<header>[\s\S]*?class="count"[\s\S]*?class="count sessions"/)
  assert.match(views, /model\.sessions/)
  assert.match(views, /title=\$\{core\.sessionsTitle\}|title=\$\{[^}]*sessionsTitle[^}]*\}/)
})

test('the header does not show a tip, and the phone code never asks for one', () => {
  const mobile = ['api.js', 'views.js', 'model.js', 'app.js'].map((f) => readFileSync(join(root, 'lib', 'mobile', f), 'utf8')).join('\n')
  assert.ok(!/read-tip|\.tip\b|TipCard/.test(mobile))
})

test('the numbers do not shift the header: tabular digits, no wrapping, a reserved line, and the counts stack on the right', () => {
  const m = /\.count\.sessions\s*\{([^}]*)\}/.exec(css)
  assert.ok(m, '.count.sessions rule')
  assert.match(m[1], /tabular-nums/)
  assert.match(m[1], /white-space:\s*nowrap/)
  assert.match(m[1], /min-height/)
  assert.match(css, /\.counts\s*\{[^}]*flex-direction:\s*column/)
})
