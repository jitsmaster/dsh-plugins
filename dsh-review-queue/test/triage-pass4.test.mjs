// Auto triage pass 4: glob brackets, a wider risk scan, exactly one recommended option, and the permission actor's containment re-check. Observe is unchanged.
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseReadOnlyCommand, isRiskyOption, recommendedOptionRefusal, autoAnswerRefusal } from '../triage.js'
import { createStore } from '../store.js'
import { createPermissionActor } from '../triage-act-permission.js'

const auto = (c) => parseReadOnlyCommand(c, { auto: true })

test('P1: glob brackets are shell syntax in Auto (PowerShell expands [.]env as a wildcard)', () => {
  for (const c of ['cat [.]env', 'cat id_[r]sa', 'cat se[c]rets.txt', 'rg foo [.]env', 'cat a].txt', 'cat @x', 'cat #x']) {
    assert.deepEqual(auto(c), { ok: false, reason: 'shell syntax' }, c)
  }
  for (const c of ['cat top.txt', 'git status', 'git log --oneline -5', 'rg foo src/a.js', 'ls -la src', 'head top.txt']) assert.equal(auto(c).ok, true, c)
})

test('P1: observe still accepts brackets (unchanged)', () => {
  assert.equal(parseReadOnlyCommand('cat a[1].txt').ok, true)
})

test('P2: new risky stems and combining marks are caught; benign cards pass', () => {
  for (const t of ['Replace the file', 'Rewrite history', 'Apply the patch', 'Applied it', 'Run the script', 'Execute it', 'Restart the server', 'Stop the job', 'Rebase onto main', 'Amend the commit',
    'Squash them', 'Enable the flag', 'Grant access', 'Approve it', 'Share the link', 'Expose the port', 'Upgrade the package', 'Downgrade it', 'Override the setting', 'Unlock it', 'Lock the file',
    'Ignore the error', 'Skip the check', 'Bypass the hook', 'Force it', 'deléte it', 'dèlete everything', 'r̃un it']) assert.equal(isRiskyOption(t), true, t)
  for (const t of ['Use the Paused tab Resume all (Recommended)', 'Yes, continue (Recommended)', 'Keep the current behaviour (Recommended)', 'Add the check in the UI, then you verify (Recommended)']) assert.equal(isRiskyOption(t), false, t)
})

const q = (...labels) => ({ question: 'Which?', options: labels.map((label) => ({ label })) })

test('P3: two or more (Recommended) options are refused in Auto; exactly one passes', () => {
  const two = q('A (Recommended)', 'B (recommended)', 'C')
  assert.equal(autoAnswerRefusal('A (Recommended)', two), 'ambiguous-recommended')
  const j = { answer: 'A (Recommended)', needs_decision: false, reversible: true, touches_outside_workspace: false }
  assert.equal(recommendedOptionRefusal(j, two), 'ambiguous-recommended')
  const one = q('A (Recommended)', 'B')
  assert.equal(autoAnswerRefusal('A (Recommended)', one), undefined)
  assert.equal(recommendedOptionRefusal(j, one), undefined)
  assert.equal(autoAnswerRefusal('A (Recommended)', q('A', 'B')), 'no-recommended-option')
})

test('P4: the permission actor re-checks containment for every command it approves', async () => {
  const base = mkdtempSync(join(tmpdir(), 'rq-p4-'))
  const ws = join(base, 'ws')
  mkdirSync(ws)
  writeFileSync(join(ws, 'a.txt'), 'a')
  try {
    for (const [detail, workspace, ok] of [['cat a.txt', ws, true], ['cat a.txt', undefined, false], ['cat a.txt', join(base, 'missing'), false], ['cat sub/missing.txt', ws, false]]) {
      const store = createStore({ now: () => 1, uuid: () => 'i1' })
      const item = store.add({ type: 'permission', sessionId: 's1', workspace, payload: { toolName: 'shell', detail, summary: detail, callId: 'c1' } })
      let decided = 0
      const res = await createPermissionActor({ store, decide: () => { decided++; return true } })({ item, resolutionBase: {}, stillAllowed: () => true })
      assert.equal(res.ok, ok, detail + ' ' + workspace)
      if (!ok) assert.deepEqual(res, { ok: false, reason: 'not-read-only' })
      assert.equal(decided, ok ? 1 : 0)
    }
  } finally { rmSync(base, { recursive: true, force: true }) }
})
