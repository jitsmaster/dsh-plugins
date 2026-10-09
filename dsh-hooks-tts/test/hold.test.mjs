import { test } from 'node:test'
import assert from 'node:assert/strict'
import { HOLD_PREFIX, stripHold, withHold, parseHoldMarker, installHoldTitles } from '../hold.js'
import { isPrSession } from '../pr.js'
import { continuationTitle } from '../cap.js'

test('withHold: prefixes once, strips on release, leaves untitled sessions alone', () => {
  assert.equal(HOLD_PREFIX, '\u23f8\ufe0f ')
  assert.equal(withHold('Fix menu', true), '\u23f8\ufe0f Fix menu')
  assert.equal(withHold('\u23f8\ufe0f Fix menu', true), '\u23f8\ufe0f Fix menu')
  assert.equal(withHold('\u23f8\ufe0f Fix menu', false), 'Fix menu')
  assert.equal(withHold('Fix menu', false), 'Fix menu')
  assert.equal(withHold('\u23f8 Fix menu', false), 'Fix menu') // without the emoji variation selector
  assert.equal(withHold(undefined, true), undefined)
  assert.equal(withHold('   ', true), undefined)
})

test('stripHold: removes every leading hold emoji and nothing else', () => {
  assert.equal(stripHold('\u23f8\ufe0f \u23f8\ufe0f PR 12'), 'PR 12')
  assert.equal(stripHold('Plan \u23f8\ufe0f later'), 'Plan \u23f8\ufe0f later')
  assert.equal(stripHold(undefined), undefined)
})

test('parseHoldMarker: a marker alone on a line, the last one wins', () => {
  assert.equal(parseHoldMarker('HOLD-ON'), 'on')
  assert.equal(parseHoldMarker('ok\r\nHOLD-OFF\r\n'), 'off')
  assert.equal(parseHoldMarker('HOLD-ON\nHOLD-OFF'), 'off')
  assert.equal(parseHoldMarker('HOLD-OFF\nHOLD-ON'), 'on')
  assert.equal(parseHoldMarker('echo HOLD-ON'), undefined)
  assert.equal(parseHoldMarker('x HOLD-OFF y'), undefined)
  assert.equal(parseHoldMarker(undefined), undefined)
})

function fakeCtx(title) {
  const handlers = {}
  const renames = []
  const sessionTitle = { get: () => (title.value === undefined ? undefined : { title: title.value }) }
  const sessionController = { rename: async (r) => { renames.push(r); title.value = r.title } }
  return {
    renames, handlers,
    ctx: { on: (event, fn) => { handlers[event] = fn }, get: (n) => ({ sessionTitle, sessionController })[n] },
  }
}
const agent = { id: 'a1', session: {} }
const exec = (name) => ({ agent, name, arguments: {} })
const out = (text) => ({ content: [{ type: 'text', text }] })

test('install: HOLD-ON from a shell prefixes the title, HOLD-OFF removes it', async () => {
  const title = { value: 'Fix menu' }
  const { ctx, handlers, renames } = fakeCtx(title)
  installHoldTitles(ctx, { skip: () => false })
  let nexted = 0
  await handlers['tools/post-execute'](exec('pwsh'), out('saved\nHOLD-ON\n'), () => { nexted++ })
  assert.deepEqual(renames, [{ sessionId: 'a1', title: '\u23f8\ufe0f Fix menu' }])
  await handlers['tools/post-execute'](exec('pwsh'), out('HOLD-ON'), () => {})
  assert.equal(renames.length, 1) // already held: no second rename
  await handlers['tools/post-execute'](exec('run_code'), out('HOLD-OFF'), () => {})
  assert.deepEqual(renames[1], { sessionId: 'a1', title: 'Fix menu' })
  assert.equal(nexted, 1)
})

test('install: ignores non-shell tools, errors, skipped agents and untitled sessions', async () => {
  const title = { value: 'Fix menu' }
  const { ctx, handlers, renames } = fakeCtx(title)
  installHoldTitles(ctx, { skip: (a) => a.id === 'sub' })
  await handlers['tools/post-execute'](exec('read'), out('HOLD-ON'), () => {})
  await handlers['tools/post-execute'](exec('pwsh'), { ...out('HOLD-ON'), isError: true }, () => {})
  await handlers['tools/post-execute']({ agent: { id: 'sub', session: {} }, name: 'pwsh' }, out('HOLD-ON'), () => {})
  assert.deepEqual(renames, [])
  title.value = undefined
  await handlers['tools/post-execute'](exec('pwsh'), out('HOLD-ON'), () => {})
  assert.deepEqual(renames, [])
})

test('a rename failure never breaks the tool call', async () => {
  const ctx = { on: (e, fn) => { ctx.h = fn }, get: (n) => n === 'sessionTitle' ? { get: () => ({ title: 'x' }) } : { rename: async () => { throw new Error('boom') } } }
  installHoldTitles(ctx, { skip: () => false })
  let nexted = false
  await ctx.h(exec('pwsh'), out('HOLD-ON'), () => { nexted = true })
  assert.equal(nexted, true)
})

test('other plugin logic sees the title without the hold emoji', () => {
  const ctx = { get: () => ({ get: () => ({ title: '\u23f8\ufe0f PR 12' }) }) }
  assert.equal(isPrSession(ctx, agent), true)
  assert.equal(continuationTitle('\u23f8\ufe0f Fix menu'), 'Fix menu - 2')
})
