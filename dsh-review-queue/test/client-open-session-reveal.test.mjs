import { test } from 'node:test'
import assert from 'node:assert/strict'
import { loadClient, need, tick } from './client-todo-helpers.mjs'

// Opening a session from the Task list also scrolls the left panel (the session tree of DSH) to that session's row, so it is visible once selected.
// The row is the element with data-row-key="session:<id>"; a row hidden inside a collapsed session group (dsh-hooks-tts) is revealed by clicking
// that group's header; the row may not be rendered yet when the host call returns, so the lookup is retried a few times.
function fakeDoc(rows = {}, headers = {}) {
  const clicks = []
  const doc = {
    clicks,
    querySelector(sel) {
      let m = /^\[data-row-key="session:(.*)"\]$/.exec(sel)
      if (m) return rows[m[1].replace(/\\(["\\])/g, '$1')] ?? null
      m = /^\[data-hooks-group-header="(.*)"\]$/.exec(sel)
      if (m) return headers[m[1]] ?? null
      return null
    },
  }
  return doc
}
const row = (over = {}) => {
  const scrolls = []
  return { scrolls, offsetParent: {}, getAttribute: () => null, scrollIntoView: (o) => scrolls.push(o), ...over }
}
const timers = () => {
  const q = []
  return { q, later: (fn, ms) => { q.push({ fn, ms }); return q.length }, run: () => { const t = q.shift(); if (t) t.fn(); return !!t } }
}

test('revealSessionRow scrolls the row of the session into the middle of the panel', () => {
  const { T } = loadClient()
  need(T, 'revealSessionRow')
  const r = row()
  const t = timers()
  T.revealSessionRow('s1', { doc: fakeDoc({ s1: r }), later: t.later })
  while (t.run());
  assert.equal(r.scrolls.length, 1)
  assert.equal(r.scrolls[0].block, 'center')
})

test('the row is looked for again when it is not rendered yet, and the lookup gives up after a few tries', () => {
  const { T } = loadClient()
  need(T, 'revealSessionRow')
  const rows = {}
  const doc = fakeDoc(rows)
  const t = timers()
  T.revealSessionRow('s9', { doc, later: t.later })
  assert.ok(t.q.length >= 1, 'a retry is scheduled')
  const late = row()
  rows.s9 = late
  while (t.run());
  assert.equal(late.scrolls.length, 1)
  const t2 = timers()
  T.revealSessionRow('never', { doc: fakeDoc({}), later: t2.later })
  let n = 0
  while (t2.run()) n++
  assert.ok(n >= 2 && n <= 10, 'bounded retries, got ' + n)
})

test('a row hidden in a collapsed group opens that group by its header, then scrolls', () => {
  const { T } = loadClient()
  need(T, 'revealSessionRow')
  const clicks = []
  const hidden = row({ offsetParent: null, getAttribute: (n) => (n === 'data-hooks-gt-group' ? 'g1' : null) })
  const header = { click: () => { clicks.push('g1'); hidden.offsetParent = {} } }
  const t = timers()
  T.revealSessionRow('s1', { doc: fakeDoc({ s1: hidden }, { g1: header }), later: t.later })
  while (t.run());
  assert.deepEqual(clicks, ['g1'])
  assert.equal(hidden.scrolls.length, 1)
})

test('a session id with quotes cannot break out of the selector', () => {
  const { T } = loadClient()
  need(T, 'revealSessionRow')
  const seen = []
  const doc = { querySelector: (sel) => { seen.push(sel); return null } }
  const t = timers()
  T.revealSessionRow('a"]x', { doc, later: t.later })
  assert.ok(seen[0].includes('\\"'), seen[0])
})

test('without a document nothing happens and nothing throws', () => {
  const { T } = loadClient()
  need(T, 'revealSessionRow')
  assert.doesNotThrow(() => T.revealSessionRow('s1', { doc: undefined, later: () => {} }))
})

test('Open session from a card reveals the session row once the host opened it', async () => {
  const r = row()
  const doc = fakeDoc({ S1: r })
  const { T } = loadClient({ globals: { document: doc } })
  need(T, 'revealSessionRow')
  T.setHostOpen?.(async () => {})
  assert.equal(typeof T.setHostOpen, 'function', 'a test hook sets the host openSession')
  T.openSession({ id: 'i1', sessionId: 'S1' })
  await tick(); await tick()
  assert.equal(r.scrolls.length, 1)
})

test('a refused open does not scroll anywhere', async () => {
  const r = row()
  const { T } = loadClient({ globals: { document: fakeDoc({ S1: r }) } })
  need(T, 'setHostOpen')
  T.setHostOpen(async () => { throw new Error('gone') })
  T.openSession({ id: 'i1', sessionId: 'S1' })
  await tick(); await tick()
  assert.equal(r.scrolls.length, 0)
})
