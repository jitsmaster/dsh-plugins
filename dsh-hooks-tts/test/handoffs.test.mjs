import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { applyFollowUp, createHandoffTracker, handoffMentions, handoffWrites } from '../handoffs.js'

const tmp = () => mkdtempSync(join(tmpdir(), 'handoffs-'))

test('handoffWrites: write/edit of a *-handoff.md path counts; reads and other files do not', () => {
  assert.deepEqual(handoffWrites('write', { file_path: 'C:/v/x-ph-1-spec-handoff.md' }), ['C:/v/x-ph-1-spec-handoff.md'])
  assert.deepEqual(handoffWrites('edit', { file_path: 'C:/v/x-mid-handoff.md' }), ['C:/v/x-mid-handoff.md'])
  assert.deepEqual(handoffWrites('Write', { file_path: 'C:/v/X-HANDOFF.MD' }), ['C:/v/X-HANDOFF.MD'])
  assert.deepEqual(handoffWrites('read', { file_path: 'C:/v/x-handoff.md' }), [])
  assert.deepEqual(handoffWrites('write', { file_path: 'C:/v/notes.md' }), [])
  assert.deepEqual(handoffWrites('write', { file_path: 'C:/v/x-secrets.json' }), [])
  assert.deepEqual(handoffWrites('write', undefined), [])
})

test('handoffWrites: a relative path is resolved against the session cwd', () => {
  assert.deepEqual(handoffWrites('write', { file_path: 'docs/a-handoff.md' }, 'C:/proj'), [join('C:/proj', 'docs/a-handoff.md')])
})

test('handoffWrites: run_code programs count only tools.write / tools.edit calls, with JS escapes undone', () => {
  const code = [
    'const n = await tools.read({ file_path: "C:\\\\v\\\\old-handoff.md" })',
    'await tools.write({ file_path: "C:\\\\v\\\\new-ph-2-handoff.md", content: "# x" })',
    "await tools.edit({file_path:'D:/v/other-handoff.md', old_string: 'a', new_string: 'b'})",
  ].join('\n')
  assert.deepEqual(handoffWrites('run_code', { code }), ['C:\\v\\new-ph-2-handoff.md', 'D:/v/other-handoff.md'])
  // A template literal with interpolation cannot be resolved statically.
  assert.deepEqual(handoffWrites('run_code', { code: 'await tools.write({ file_path: `${dir}/a-handoff.md`, content: "" })' }), [])
  // Arguments as a JSON string (as stored in a message's tool-call block).
  assert.deepEqual(handoffWrites('write', JSON.stringify({ file_path: 'C:/v/s-handoff.md' })), ['C:/v/s-handoff.md'])
})

test('latest: the newest recorded handoff that still exists on disk', () => {
  const dir = tmp()
  const a = join(dir, 'a-handoff.md'), b = join(dir, 'b-handoff.md')
  writeFileSync(a, '# a'); writeFileSync(b, '# b')
  let t = 0
  const tr = createHandoffTracker(dir, { now: () => ++t })
  assert.equal(tr.latest('s1'), undefined)
  tr.observe('s1', 'write', { file_path: a })
  tr.observe('s1', 'write', { file_path: b })
  assert.equal(tr.latest('s1'), b)
  // Rewriting an older note makes it the newest again.
  tr.observe('s1', 'edit', { file_path: a })
  assert.equal(tr.latest('s1'), a)
  // A consumed (deleted) note is skipped; with none left the session has no handoff.
  rmSync(a)
  assert.equal(tr.latest('s1'), b)
  rmSync(b)
  assert.equal(tr.latest('s1'), undefined)
  assert.deepEqual(tr.withHandoff(), [])
})

test('withHandoff lists only sessions whose handoff note still exists', () => {
  const dir = tmp()
  const a = join(dir, 'a-handoff.md')
  writeFileSync(a, '# a')
  const tr = createHandoffTracker(dir)
  tr.observe('s1', 'write', { file_path: a })
  tr.observe('s2', 'write', { file_path: join(dir, 'never-written-handoff.md') })
  assert.deepEqual(tr.withHandoff(), ['s1'])
})

test('records persist across restarts', () => {
  const dir = tmp()
  const a = join(dir, 'a-handoff.md')
  writeFileSync(a, '# a')
  createHandoffTracker(dir).record('s1', a)
  assert.equal(createHandoffTracker(dir).latest('s1'), a)
})

test('scan: picks up handoffs a session wrote before the tracker watched it, once per session', () => {
  const dir = tmp()
  const a = join(dir, 'a-handoff.md'), b = join(dir, 'b-handoff.md')
  writeFileSync(a, '# a'); writeFileSync(b, '# b')
  const tr = createHandoffTracker(dir)
  const messages = [
    { role: 'user', content: 'hi' },
    { role: 'assistant', content: [{ type: 'tool-call', id: '1', name: 'write', arguments: JSON.stringify({ file_path: a }) }] },
    { role: 'assistant', content: [{ type: 'text', text: 'x' }, { type: 'tool-call', id: '2', name: 'run_code', arguments: { code: 'await tools.write({ file_path: ' + JSON.stringify(b) + ', content: "" })' } }] },
  ]
  let reads = 0
  tr.scan('s1', () => { reads++; return messages })
  assert.equal(tr.latest('s1'), b)
  tr.scan('s1', () => { reads++; return [] })
  assert.equal(reads, 1)
})

test('scan never throws on odd message shapes', () => {
  const tr = createHandoffTracker(tmp())
  tr.scan('s1', () => { throw new Error('boom') })
  tr.scan('s2', () => [null, { role: 'assistant', content: 'plain text' }, { role: 'assistant', content: [null, { type: 'tool-call' }] }])
  assert.equal(tr.latest('s1'), undefined)
})

test('the store stays bounded per session', () => {
  const dir = tmp()
  const tr = createHandoffTracker(dir)
  for (let i = 0; i < 30; i++) tr.record('s1', join(dir, `n${i}-handoff.md`))
  const kept = JSON.parse(readFileSync(join(dir, 'handoffs.json'), 'utf8')).sessions.s1
  assert.ok(kept.length <= 10)
})

test('applyFollowUp: validates the body and maps the follow-up result', async () => {
  assert.equal((await applyFollowUp({ sessionId: 'a' }, undefined)).status, 503)
  assert.equal((await applyFollowUp({}, async () => ({ status: 200 }))).status, 400)
  assert.equal((await applyFollowUp({ sessionId: 7 }, async () => ({ status: 200 }))).status, 400)
  assert.equal((await applyFollowUp({ sessionId: 'x'.repeat(201) }, async () => ({ status: 200 }))).status, 400)
  assert.deepEqual(await applyFollowUp({ sessionId: 'a' }, async (id) => ({ status: 200, sessionId: id + '2' })), { status: 200, body: { sessionId: 'a2' } })
  assert.deepEqual(await applyFollowUp({ sessionId: 'a' }, async () => ({ status: 404, error: 'none' })), { status: 404, body: { error: 'none' } })
  assert.deepEqual(await applyFollowUp({ sessionId: 'a' }, async () => { throw new Error('boom') }), { status: 500, body: { error: 'boom' } })
})
test('handoffWrites: shell writes count, reads and deletes do not', () => {
  const p = 'D:\\v\\a-ph-1-handoff.md'
  assert.deepEqual(handoffWrites('pwsh', { command: `Set-Content -Path '${p}' -Value $text` }), [p])
  assert.deepEqual(handoffWrites('pwsh', { command: `$t | Out-File "${p}" -Encoding utf8` }), [p])
  assert.deepEqual(handoffWrites('pwsh', { command: `[IO.File]::WriteAllText('${p}', $t)` }), [p])
  assert.deepEqual(handoffWrites('bash', { command: `cat <<EOF > ${p}` }), [p])
  assert.deepEqual(handoffWrites('pwsh', { command: `Get-Content '${p}'` }), [])
  assert.deepEqual(handoffWrites('pwsh', { command: `Remove-Item -Force '${p}'` }), [])
  assert.deepEqual(handoffWrites('pwsh', { command: `Get-Content '${p}' | Set-Content 'D:\\v\\other.txt'` }), [])
})

test('handoffMentions: an unquoted path with spaces is not cut at a later separator', () => {
  // "Dev Tasks/Handoffs/x-handoff.md" must not yield "/Handoffs/x-handoff.md" (a bare match starting mid-path)
  assert.deepEqual(handoffMentions('Handoff written to D:/dev/Notes/Dev Tasks/Handoffs/x-handoff.md for the next session'), [])
  assert.deepEqual(handoffMentions('Handoff written to D:\\dev\\Notes\\Dev Tasks\\Handoffs\\x-handoff.md'), [])
  assert.deepEqual(handoffMentions('Handoff written to `D:/dev/Notes/Dev Tasks/Handoffs/x-handoff.md`'), ['D:/dev/Notes/Dev Tasks/Handoffs/x-handoff.md'])
})

test('handoffMentions: "handoff written to <path>" lines in assistant text', () => {
  const p = 'D:\\dev\\Notes\\CTnP\\Handoffs\\x-ph-4-final-review-handoff.md'
  assert.deepEqual(handoffMentions(`**Phase 3 complete.** Handoff written to \`${p}\`. The new session will open.`), [p])
  assert.deepEqual(handoffMentions(`Wrote the note to ${p} and stopped.`), [p])
  assert.deepEqual(handoffMentions('Handoff note saved: /home/u/notes/y-handoff.md'), ['/home/u/notes/y-handoff.md'])
  // Reading / resuming / deleting is not writing.
  assert.deepEqual(handoffMentions(`Resuming from ${p}`), [])
  assert.deepEqual(handoffMentions(`Deleted the previous handoff ${p}`), [])
  assert.deepEqual(handoffMentions('no paths here, handoff written'), [])
  assert.deepEqual(handoffMentions(undefined), [])
})

test('observeText records mentioned handoff notes; scan reads assistant text blocks too', () => {
  const dir = tmp()
  const a = join(dir, 'a-handoff.md'), b = join(dir, 'b-handoff.md')
  writeFileSync(a, '# a'); writeFileSync(b, '# b')
  const tr = createHandoffTracker(dir)
  tr.observeText('s1', 'Handoff written to `' + a + '`.')
  assert.equal(tr.latest('s1'), a)
  const tr2 = createHandoffTracker(tmp())
  tr2.scan('s2', () => [
    { role: 'assistant', content: [{ type: 'text', text: 'Handoff written to ' + b }] },
    { role: 'assistant', content: 'plain string reply' },
  ])
  assert.equal(tr2.latest('s2'), b)
})
