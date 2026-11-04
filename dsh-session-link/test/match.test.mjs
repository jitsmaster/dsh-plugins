import test from 'node:test'
import assert from 'node:assert/strict'
import { tokensOf, within, matchSessions } from '../match.js'

const S = [
  { sessionId: 'a1', title: 'Fix: AB test update may fail on a stopped experiment - 25883', workspace: 'CTnP-Final', updatedAt: 5 },
  { sessionId: 'b2', title: 'Review Queue tabs redesign', workspace: 'dsh-plugins', updatedAt: 9 },
  { sessionId: 'c3', title: 'PR 6681 comment polling', workspace: 'CTnP-Final', updatedAt: 7 },
  { sessionId: 'd4', title: 'Voice control STT bake-off', workspace: 'STT', updatedAt: 3 },
  { sessionId: 'tests', title: 'Unit tests cleanup', workspace: 'dsh-plugins', updatedAt: 1 },
]
const ids = (r) => r.matches.map((m) => m.session.sessionId)

test('tokensOf splits hyphens, camelCase and punctuation, lowercase', () => {
  assert.deepEqual(tokensOf('dsh-plugins'), ['dsh', 'plugins'])
  assert.deepEqual(tokensOf('sessionController'), ['session', 'controller'])
  assert.deepEqual(tokensOf('  AB#25883 -- Fix! '), ['ab', '25883', 'fix'])
})

test('within allows up to max edits and rejects more', () => {
  assert.equal(within('plugin', 'plugins', 1), true)
  assert.equal(within('pluign', 'plugin', 1), false, 'a swap costs 2 edits')
  assert.equal(within('pluign', 'plugin', 2), true)
  assert.equal(within('abc', 'xyz', 1), false)
})

test('an exact session id in the list is the one match', () => {
  assert.deepEqual(ids(matchSessions('b2', S)), ['b2'])
  assert.equal(matchSessions('b2', S).kind, 'one')
})

test('words that look like an id but are not in the list are ordinary words', () => {
  const r = matchSessions('voice', S)
  assert.equal(r.kind, 'one')
  assert.deepEqual(ids(r), ['d4'])
})

test('an id-shaped word that is also a title word of other sessions is not an id unless listed', () => {
  assert.deepEqual(ids(matchSessions('dsh', S)).sort(), ['b2', 'tests'])
})

test('hyphen, case and word order do not matter; the workspace name counts', () => {
  assert.deepEqual(ids(matchSessions('DSH Plugins redesign', S)), ['b2'])
  assert.deepEqual(ids(matchSessions('redesign plugins dsh', S)), ['b2'])
})

test('prefixes of at least 3 characters match, shorter ones only match exactly', () => {
  assert.deepEqual(ids(matchSessions('polli', S)), ['c3'])
  assert.equal(matchSessions('po', S).kind, 'none')
})

test('typos within tolerance match', () => {
  assert.deepEqual(ids(matchSessions('bakeof', S)), [])
  assert.deepEqual(ids(matchSessions('experimnt stopped', S)), ['a1'])
})

test('keyworded ticket and PR numbers match whole numbers in the title only', () => {
  assert.deepEqual(ids(matchSessions('AB#25883', S)), ['a1'])
  assert.deepEqual(ids(matchSessions('ticket 25883 stopped', S)), ['a1'])
  assert.deepEqual(ids(matchSessions('PR 6681', S)), ['c3'])
  assert.equal(matchSessions('PR 668', S).kind, 'none', '668 is not a whole number of 6681')
  const dated = [{ sessionId: 'x', title: 'Report 2026-10-20 done', updatedAt: 1 }]
  assert.equal(matchSessions('#10', dated).kind, 'none', 'a number glued to a date is not a ticket')
})

test('several matches are many, ranked by score then recency', () => {
  const r = matchSessions('ctnp', S)
  assert.equal(r.kind, 'many')
  assert.deepEqual(ids(r), ['c3', 'a1'])
})

test('no match returns up to three near misses with the most matching words', () => {
  const r = matchSessions('review voice zebra', S)
  assert.equal(r.kind, 'none')
  assert.ok(r.near.length <= 3 && r.near.length >= 1)
  assert.ok(['b2', 'd4'].includes(r.near[0].sessionId))
})

test('an empty or whitespace query is none', () => {
  assert.equal(matchSessions('   ', S).kind, 'none')
  assert.equal(matchSessions(undefined, S).kind, 'none')
})

test('a session without a title does not break matching', () => {
  assert.equal(matchSessions('undefined', [{ sessionId: 'a1', workspace: 'w', updatedAt: 1 }]).kind, 'none')
  assert.equal(matchSessions('PR 12', [{ sessionId: 'a1', workspace: 'w', updatedAt: 1 }]).kind, 'none')
})
