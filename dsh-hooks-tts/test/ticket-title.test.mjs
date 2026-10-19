import { test } from 'node:test'
import assert from 'node:assert/strict'
import { prTitleFor, TICKET_TITLE, PR_TITLE } from '../pr.js'
import { continuationTitle } from '../cap.js'

test('prTitleFor: ticket work gets "PR <n> - " in front of the title, everything else stays "PR <n>"', () => {
  assert.equal(prTitleFor('Fix: Login redirect loops - 12345', '42'), 'PR 42 - Fix: Login redirect loops - 12345')
  assert.equal(prTitleFor('Fix: Login redirect loops - 12345 - 2', '42'), 'PR 42 - Fix: Login redirect loops - 12345 - 2')
  assert.equal(prTitleFor('\u23f8\ufe0f Fix: Menu - 777', '9'), 'PR 9 - Fix: Menu - 777')
  assert.equal(prTitleFor('Billing cleanup - 2', '42'), 'PR 42')
  assert.equal(prTitleFor('Fix: no number', '42'), 'PR 42')
  assert.equal(prTitleFor(undefined, '42'), 'PR 42')
  assert.equal(prTitleFor('PR 7 - Fix: x - 12345', '42'), 'PR 42')
})

test('the PR-prefixed ticket title is a PR title, the plain one is not', () => {
  assert.ok(PR_TITLE.test('PR 42 - Fix: Login - 12345'))
  assert.ok(!PR_TITLE.test('Fix: Login - 12345'))
  assert.ok(TICKET_TITLE.test('Fix: Login - 12345'))
})

test('continuationTitle: the ticket number is not a counter', () => {
  assert.equal(continuationTitle('Fix: Login - 12345'), 'Fix: Login - 12345 - 2')
  assert.equal(continuationTitle('Fix: Login - 12345 - 2'), 'Fix: Login - 12345 - 3')
  assert.equal(continuationTitle('Billing cleanup - 2'), 'Billing cleanup - 3')
  assert.equal(continuationTitle('PR 42 - Fix: Login - 12345'), 'Continue PR 42 - Fix: Login - 12345')
})
