// Slice 1: the group header drawn above the cards of one session in the overlay list.
import test from 'node:test'
import assert from 'node:assert/strict'
import { loadClient } from './client-todo-helpers.mjs'

const el = (type, props, ...children) => ({ type, props: props || {}, children: children.flat() })
const text = (n) => (n == null ? '' : typeof n === 'string' ? n : [n.children.map(text).join('')].join(''))
const { T } = loadClient({ react: { createElement: el } })

const model = { id: 's1', title: 'Work', workspace: 'ws', topTier: 1, count: 3, createdAt: 0, aiHandled: 2 }

test('groupHead shows title, workspace, top tier, count and AI handled', () => {
  const n = T.groupHead(model, 60_000 * 5)
  assert.equal(n.props['data-group'], 's1')
  assert.equal(n.props.key, 'gh:s1')
  const t = text(n)
  assert.match(t, /Work/)
  assert.match(t, /ws/)
  assert.match(t, /P1/)
  assert.match(t, /3 items/)
  assert.match(t, /AI handled 2/)
})

test('a single-item group draws no header', () => {
  assert.equal(T.groupHead({ ...model, count: 1 }, 0), null)
})

test('no tier and no AI handled leave those parts out', () => {
  const t = text(T.groupHead({ ...model, topTier: undefined, aiHandled: 0 }, 0))
  assert.doesNotMatch(t, /P\d/)
  assert.doesNotMatch(t, /AI handled/)
})
