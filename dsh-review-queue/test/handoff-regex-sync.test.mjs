import { test } from 'node:test'
import assert from 'node:assert/strict'
import { handoffFollowable as serverFollowable } from '../handoff-follow.js'
import { handoffMentions } from '../../dsh-hooks-tts/handoffs.js'
import { loadClient } from './client-todo-helpers.mjs'

// The handoff-path rule lives in three copies: dsh-hooks-tts/handoffs.js (source of truth), handoff-follow.js (server) and lib/client.js (browser, no lookbehind).
// One fixture table runs through all three so any drift between them fails here.
const CASES = [
  ['backticked Windows path', 'Done.\nHandoff written to `D:\\x\\a-handoff.md`', true],
  ['backticked path with spaces', 'Saved the note to `D:\\Dev Tasks\\a-handoff.md`', true],
  ['plain forward-slash Windows path', 'Handoff written to D:/x/a-handoff.md now', true],
  ['POSIX path', 'Wrote the handoff to /home/me/notes/a-handoff.md', true],
  ['POSIX path at line start', '/home/me/a-handoff.md was created', true],
  ['relative path', 'Handoff written to `notes/a-handoff.md`', false],
  ['bare relative path', 'Handoff written to notes/a-handoff.md', false],
  ['mid-word slash (Dev Tasks/Handoffs/x)', 'Handoff written to Dev Tasks/a-handoff.md', false],
  ['no write verb', 'See D:/x/a-handoff.md for details', false],
  ['non-handoff name', 'Notes written to D:/x/notes.md', false],
  ['resuming-from line', 'resuming from D:/x/a-handoff.md', false],
  ['multiple lines, verb and path on different lines', 'Handoff written.\nIt is at D:/x/a-handoff.md', false],
  ['multiple lines, one matching line', 'Summary of work.\nresuming from D:/old/a-handoff.md\nHandoff written to D:/x/b-handoff.md', true],
  ['multiple lines, CRLF', 'Done.\r\nHandoff saved to `C:\\x\\a-handoff.md`\r\n', true],
]

const { mod } = loadClient({})
const browserFollowable = mod.shared.handoffFollowable
const item = (reply) => ({ id: 'c1', type: 'completed', status: 'open', sessionId: 's1', payload: { reply } })

for (const [name, reply, expected] of CASES) {
  test(`handoff path rule, all three copies agree: ${name}`, () => {
    assert.equal(serverFollowable(item(reply)), expected, 'server (handoff-follow.js)')
    assert.equal(browserFollowable(item(reply)), expected, 'browser (lib/client.js)')
    assert.equal(handoffMentions(reply).length > 0, expected, 'source of truth (dsh-hooks-tts/handoffs.js)')
  })
}

// An assistant reply is uncapped text: a very long run of slashes must not make the path regex quadratic (both copies cap what they scan).
test('a 50 000-character line of slashes is rejected fast in both copies', () => {
  const reply = 'Handoff written to ' + '/'.repeat(50_000)
  for (const [name, fn] of [['server', serverFollowable], ['browser', browserFollowable]]) {
    const t0 = performance.now()
    assert.equal(fn(item(reply)), false, name)
    assert.ok(performance.now() - t0 < 200, name + ' took ' + Math.round(performance.now() - t0) + ' ms')
  }
})

test('a real handoff line still counts when a huge junk line precedes it, and a junk line alone does not', () => {
  const reply = 'x'.repeat(50_000) + '\nHandoff written to D:/x/a-handoff.md'
  assert.equal(serverFollowable(item(reply)), true)
  assert.equal(browserFollowable(item(reply)), true)
})
