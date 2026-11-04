import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { loadClient, el, findAll, textOf, okJson, tick } from './client-todo-helpers.mjs'

// The "Follow handoff" button on a done card whose reply says a handoff note was written: desktop overlay (lib/client.js) and phone page (lib/mobile).
// It POSTs /v1/follow-handoff { id } (the server re-checks); the card then shows "Followed the handoff in a new session". The check (handoffFollowable) lives in
// lib/client.js and is shared with the phone through exports.shared, so the phone has no rule of its own.
const REPLY = 'Done.\nHandoff written to `D:\\x\\a-handoff.md`'
const done = (over = {}) => ({ id: 'c1', type: 'completed', status: 'open', sessionId: 's1', sessionTitle: 'T', summary: 'Done', createdAt: 1, payload: { reply: REPLY }, ...over })
const TITLE = 'Open a new session that resumes this handoff (SPARC)'

function render() {
  const calls = []
  const c = loadClient({
    react: { createElement: el, useEffect() {}, useState: () => [0, () => {}] },
    fetchImpl: async (url, opts) => { calls.push([url.replace(/^.*(\/v1\/[a-z-]+).*$/, '$1'), opts?.body ? JSON.parse(opts.body) : undefined]); return okJson({ ok: true, sessionId: 'n1' }) },
  })
  return { ...c, calls }
}
const follow = (tree) => findAll(tree, (n) => n.type === 'button').find((b) => textOf(b) === 'Follow handoff')
const must = (tree) => { const b = follow(tree); assert.ok(b, 'the Follow handoff button is on the card'); return b }

test('the overlay shares handoffFollowable (the same table as the server check) with the phone', () => {
  const { mod } = render()
  assert.equal(typeof mod.shared.handoffFollowable, 'function', 'exports.shared.handoffFollowable')
  const f = mod.shared.handoffFollowable
  assert.equal(f(done()), true)
  assert.equal(f(done({ payload: { reply: 'Handoff written to `notes/a-handoff.md`' } })), false, 'relative path')
  assert.equal(f(done({ payload: { reply: 'resuming from D:/x/a-handoff.md' } })), false, 'no write verb')
  assert.equal(f(done({ type: 'question' })), false)
  assert.equal(f(done({ status: 'resolved' })), false)
  assert.equal(f(done({ sessionId: undefined })), false)
  assert.equal(f(done({ payload: {} })), false)
  assert.equal(f(undefined), false)
})

test('a followable done card shows a Follow handoff button with the SPARC title; others do not', () => {
  const { T } = render()
  const tree = T.CompletedBody({ item: done(), full: true })
  const b = follow(tree)
  assert.ok(b, 'the button is on the card')
  assert.equal(b.props.title, TITLE)
  assert.notEqual(b.props.disabled, true)
  for (const item of [done({ payload: { reply: 'All done, nothing to hand off.' } }), done({ sessionId: undefined }), done({ status: 'resolved' })]) {
    assert.equal(follow(T.CompletedBody({ item, full: true })), undefined)
  }
})

test('the button posts /v1/follow-handoff with the item id', async () => {
  const { T, calls } = render()
  must(T.CompletedBody({ item: done(), full: true })).props.onClick()
  await tick()
  assert.deepEqual(calls, [['/v1/follow-handoff', { id: 'c1' }]])
})

test('while the card is busy the button is disabled', () => {
  const { T } = render()
  T.set({ busy: { c1: true } })
  assert.equal(must(T.CompletedBody({ item: done(), full: true })).props.disabled, true)
})

test('resolutionText: a followed handoff reads "Followed the handoff in a new session"', () => {
  const { T, mod } = render()
  const item = { resolution: { kind: 'handoff-followed', by: 'card', sessionId: 'n1' } }
  assert.equal(T.resolutionText(item), 'Followed the handoff in a new session')
  assert.equal(mod.shared.resolutionText(item), 'Followed the handoff in a new session')
})

test('errorText has words for every follow-handoff refusal (not the generic "Could not do that")', () => {
  const { mod } = render()
  for (const code of ['no-handoff', 'not-followable', 'unavailable', 'follow-busy', 'failed']) {
    const text = mod.shared.errorText(409, { ok: false, error: code })
    assert.doesNotMatch(text, /^Could not do that \(/, code + ': ' + text)
    assert.match(text, /\S/)
  }
  assert.match(mod.shared.errorText(409, { error: 'no-handoff' }), /handoff/i)
  assert.match(mod.shared.errorText(409, { error: 'follow-busy' }), /follow-up is already in progress/i)
})

// ---- the phone page: source checks, like mobile-done-archive.test.mjs (the page needs a browser) ----------------------------------------

const views = readFileSync(new URL('../lib/mobile/views.js', import.meta.url), 'utf8')
const between = (from, to) => views.slice(views.indexOf(from), views.indexOf(to))

test('phone CompletedBody: a Follow handoff button, only when core.handoffFollowable(item), that posts /v1/follow-handoff through the phone act helper', () => {
  const body = between('function CompletedBody', 'function ArchiveBody')
  assert.match(body, /handoffFollowable\(item\)/, 'the shared check')
  assert.match(body, /Follow handoff/)
  assert.match(body, /Open a new session that resumes this handoff \(SPARC\)/)
  assert.match(body, /act\('\/v1\/follow-handoff', \{ id: item\.id, confirmed: true \}, item\.id\)/, 'posted only from the confirm sheet')
  assert.match(body, /<div class="row">[\s\S]*Reviewed[\s\S]*Follow handoff[\s\S]*<\/div>/, 'in the action row')
})
