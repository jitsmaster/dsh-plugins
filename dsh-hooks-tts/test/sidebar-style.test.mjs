import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

// The sidebar of the session tree (lib/client.js, browser bundle):
//  - a group header has a fixed 16px arrow slot and its own title element, so the label starts at the same x whether the group is open (down arrow) or closed,
//    and it has a faded green background (also on hover);
//  - the selected session row has a stronger accent than the mouse-over color (which DSH uses for both), with a left bar.
const file = join(dirname(fileURLToPath(import.meta.url)), '..', 'lib', 'client.js')
const source = readFileSync(file, 'utf8')

class El {
  constructor(tag) { this.tag = tag; this.children = []; this.attrs = {}; this.style = {}; this.className = ''; this.listeners = {}; this.parent = null; this._text = '' }
  get textContent() { return this.children.length ? this.children.map((c) => c.textContent).join('') : this._text }
  set textContent(v) { this.children = []; this._text = String(v) }
  setAttribute(k, v) { this.attrs[k] = String(v) }
  getAttribute(k) { return k in this.attrs ? this.attrs[k] : null }
  hasAttribute(k) { return k in this.attrs }
  removeAttribute(k) { delete this.attrs[k] }
  appendChild(c) { c.parent = this; this.children.push(c); return c }
  addEventListener(n, f) { this.listeners[n] = f }
  remove() { if (this.parent) this.parent.children = this.parent.children.filter((c) => c !== this) }
  get firstElementChild() { return this.children[0] ?? null }
}

function load() {
  let registered
  const head = new El('head')
  const document = {
    createElement: (t) => new El(t), head, body: new El('body'), getElementById: (id) => head.children.find((c) => c.id === id) ?? null,
    querySelectorAll: () => [], querySelector: () => null, addEventListener() {}, removeEventListener() {},
  }
  const sandbox = { window: { __ModuleLoader__: { load: (r) => { registered = r } } }, document, localStorage: { getItem: () => null, setItem() {} }, console, setInterval, clearInterval, setTimeout, clearTimeout }
  vm.runInNewContext(source, sandbox, { filename: file })
  const stub = { createElement: () => null, Fragment: Symbol('F'), useState() {}, useEffect() {}, useRef() {}, useSyncExternalStore() {}, useMemo() {}, useCallback() {} }
  const mod = registered.factory(() => stub)
  return { T: mod.__test, document, head }
}

const group = (over = {}) => ({ id: 'g1', name: 'Backend', count: 3, collapsed: false, order: 10000, ...over })
function applyGroup(T, g) {
  const sec = new El('div')
  const wsRow = new El('div'); wsRow.className = 'wsrow-hash'
  T.gtApply(sec, wsRow, 'w1', [], { groups: [g], rows: {} })
  return sec.children[0]
}

test('a group header has a 16px arrow slot and a separate title; collapsing changes only the arrow', () => {
  const { T } = load()
  const open = applyGroup(T, group())
  assert.equal(open.className, 'wsrow-hash')
  assert.equal(open.children.length, 2)
  const [arrow, title] = open.children
  assert.equal(arrow.textContent, '\u25BE')
  assert.equal(arrow.style.width, '16px')
  assert.equal(arrow.style.flex, 'none')
  assert.equal(title.textContent, 'Backend (3)')
  const closed = applyGroup(T, group({ collapsed: true }))
  assert.equal(closed.children[0].textContent, '\u25B8')
  assert.equal(closed.children[1].textContent, 'Backend (3)', 'the label is the same whether the group is open or closed')
  assert.equal(closed.children[0].style.width, open.children[0].style.width)
})

test('the title is one line with an ellipsis and can shrink; the header keeps its marker, order, cursor and aria-expanded', () => {
  const { T } = load()
  const el = applyGroup(T, group({ collapsed: true, order: 20000 }))
  const title = el.children[1]
  assert.deepEqual([title.style.overflow, title.style.textOverflow, title.style.whiteSpace, title.style.minWidth], ['hidden', 'ellipsis', 'nowrap', '0'])
  assert.equal(el.getAttribute('data-hooks-group-header'), 'g1')
  assert.equal(el.getAttribute('aria-expanded'), 'false')
  assert.equal(el.style.order, '20000')
  assert.equal(el.style.cursor, 'pointer')
})

test('a second pass updates the same header in place (no second header, no new child nodes)', () => {
  const { T } = load()
  const sec = new El('div')
  const wsRow = new El('div'); wsRow.className = 'r'
  T.gtApply(sec, wsRow, 'w1', [], { groups: [group()], rows: {} })
  const header = sec.children[0]
  const [arrow, title] = header.children
  T.gtApply(sec, wsRow, 'w1', [], { groups: [group({ count: 4, collapsed: true })], rows: {} })
  assert.equal(sec.children.length, 1)
  assert.equal(sec.children[0], header)
  assert.deepEqual(header.children, [arrow, title])
  assert.deepEqual([arrow.textContent, title.textContent], ['\u25B8', 'Backend (4)'])
})

test('the style: faded green group headers (stronger on hover), a selected session stronger than hover with a left bar', () => {
  const { T } = load()
  const css = T.sidebarStyleText()
  const rule = (sel) => { const at = css.indexOf(sel + '{'); assert.ok(at >= 0, sel + ' in ' + css); return css.slice(at, css.indexOf('}', at)) }
  const header = rule('[data-hooks-group-header]')
  assert.match(header, /background(-color)?:\s*rgba\(46,\s*160,\s*67,\s*0?\.1\d*\)\s*!important/)
  assert.match(rule('[data-hooks-group-header]:hover'), /rgba\(46,\s*160,\s*67,\s*0?\.2\d*\)\s*!important/)
  const selected = rule("[data-row-key^='session:'][aria-selected='true']")
  assert.match(selected, /background(-color)?:[^;]*!important/)
  assert.match(selected, /box-shadow:\s*inset 3px 0 0/)
  assert.match(selected, /--dsw-alias-state-business-primary/)
  assert.match(selected, /2[5-9]%|3\d%/, 'a clearly visible share of the accent color')
  const selectedHover = rule("[data-row-key^='session:'][aria-selected='true']:hover")
  assert.match(selectedHover, /background(-color)?:[^;]*!important/)
  const pct = (r) => Number(/(\d+)%/.exec(r)[1])
  assert.ok(pct(selectedHover) > pct(selected), 'hovering the selected row makes it a bit stronger')
})

test('ensureSidebarStyle adds one style element once, and removeGroupTree takes it away', () => {
  const { T, head } = load()
  T.ensureSidebarStyle()
  T.ensureSidebarStyle()
  const styles = head.children.filter((c) => c.id === 'hooks-sidebar-style')
  assert.equal(styles.length, 1)
  assert.equal(styles[0].textContent, T.sidebarStyleText())
  T.removeGroupTree()
  assert.equal(head.children.filter((c) => c.id === 'hooks-sidebar-style').length, 0)
})
