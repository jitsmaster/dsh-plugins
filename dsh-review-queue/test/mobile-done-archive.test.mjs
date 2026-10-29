import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

// The phone's open Done card has its own Archive session button in the action row (next to Reviewed and Hold), so the user does not have to open
// the Conversation section to archive. It is the same button as the conversation's: confirm sheet, POST /v1/archive-session, only while the
// server flags the item archivable. The conversation does not repeat it for an open Done card.
const views = readFileSync(new URL('../lib/mobile/views.js', import.meta.url), 'utf8')
const between = (from, to) => views.slice(views.indexOf(from), views.indexOf(to))

test('CompletedBody: the action row has the Archive session button inline, and going back to the list afterwards', () => {
  const body = between('function CompletedBody', 'function ArchiveBody')
  assert.match(body, /<div class="row">[\s\S]*Reviewed[\s\S]*<\$\{ArchiveSessionButton\} item=\$\{item\} inline onDone=\$\{\(\) => go\('\/'\)\} \/>[\s\S]*<\$\{OnHoldButton\}[\s\S]*<\/div>/)
})

test('ArchiveSessionButton: inline renders no row of its own; the gate and the confirm sheet are unchanged', () => {
  const fn = between('function ArchiveSessionButton', 'function autoGrow')
  assert.match(fn, /\binline\b/)
  assert.match(fn, /item\.archivable !== true/)
  assert.match(fn, /<\$\{Sheet\}/)
  assert.match(fn, /act\('\/v1\/archive-session'/)
})

test('Conversation: no second Archive button for an open Done card (it has one in its row); resolved and other open items keep it', () => {
  const fn = between('function Conversation', 'function ArchiveSessionButton')
  assert.match(fn, /item\.status === 'open' && item\.type === 'completed'/)
  assert.match(fn, /<\$\{ArchiveSessionButton\} item=\$\{item\} onDone=/)
})
