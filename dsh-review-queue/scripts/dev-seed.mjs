/**
 * Demo data for the phone page's dev server: one item per card type the phone draws, plus a few resolved ones. Everything goes
 * through the plugin's real code (the dev route /v1/dev/ask and the queue), nothing is written to the store directly.
 */
const json = { 'content-type': 'application/json' }
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

const REPLY = [
  '## Dark theme for the phone page',
  '',
  'I added the dark palette and checked every screen on a 360 px wide viewport:',
  '',
  '- **Cards** use the new surface colours',
  '- *Chips* keep their contrast (4.5:1 or better)',
  '- the `--tap` size stays 48 px',
  '',
  '```',
  'npm test  # 396 passing',
  '```',
  '',
  'All tests pass. Do you want me to open the pull request now, or wait for your review of the screenshots?',
].join('\n')

const QUESTION_ONE = [{ id: 'cache', header: 'Cache', question: 'Where should the lookup cache live?', multiSelect: false, options: [
  { label: 'In memory (Recommended)', description: 'Fast, and it is rebuilt after a restart.' },
  { label: 'SQLite file', description: 'Survives restarts, one more file to manage.' },
  { label: 'Redis', description: 'Shared between machines; needs a server.' },
] }]
const QUESTION_MULTI = [
  { id: 'scope', header: 'Scope', question: 'Which platforms should the release cover?', multiSelect: true, options: [
    { label: 'Android', description: 'Chrome 120 and newer' },
    { label: 'iOS', description: 'Safari 17 and newer' },
    { label: 'Desktop', description: 'Chrome and Edge' },
  ] },
  { id: 'when', header: 'Timing', question: 'When should it ship?', multiSelect: false, options: [{ label: 'This week (Recommended)' }, { label: 'Next sprint' }] },
]

/** Seeds the queue behind `base` (the dev server's own URL). `queue` is the plugin's review queue. */
export async function seed({ base, queue }) {
  const ask = async (body) => {
    const res = await fetch(base + '/review-queue/v1/dev/ask', { method: 'POST', headers: json, body: JSON.stringify(body) })
    if (!res.ok) throw new Error('seed ' + body.kind + ' failed: HTTP ' + res.status)
    await sleep(40) // the summary and the title land a moment after a finished turn
    return newestOpen(queue)
  }
  const expired = ask({ kind: 'question', title: 'Release notes', questions: QUESTION_ONE, timeoutSec: 1 })

  // resolved first, so the open list below is in a natural order (oldest = position 1)
  const reviewed = await ask({ kind: 'completed', title: 'Docs session', reply: 'Updated the README install section.\n\nThe install steps now match the new folder layout.' })
  queue.markReviewed(reviewed.id)
  const approved = await ask({ kind: 'permission', title: 'Build session', command: 'npm run build' })
  queue.approve(approved.id)
  const denied = await ask({ kind: 'permission', title: 'Cleanup session', command: 'del *.tmp' })
  queue.deny(denied.id)
  const answered = await ask({ kind: 'question', title: 'API session', questions: QUESTION_ONE })
  queue.answer(answered.id, [{ id: 'cache', selected: ['SQLite file'] }])
  const hidden = await ask({ kind: 'completed', title: 'Lint session', reply: 'Ran the linter.\n\n[no-action] Nothing to report.' })
  void hidden
  queue.notifyPrMerged({ prId: '7', prSessions: [{ id: 'pr-7', title: 'PR 7 - icons' }], followUps: [] })
  await queue.archive(queue.snapshot().open.find((i) => i.type === 'pr-merged').id)
  await expired
  await sleep(1300) // the one-second question expires

  // open items: every type, a risky and a plain permission, a single and a multi question
  await ask({ kind: 'permission', title: 'Test session', command: 'npm test -- --run' })
  await ask({ kind: 'permission', title: 'Deploy session', command: 'git push --force origin main' })
  await ask({ kind: 'permission', sessionId: 'dev-same', title: 'Docs session', command: 'node scripts/make-icons.mjs' })
  await ask({ kind: 'permission', sessionId: 'dev-same', title: 'Docs session', command: 'node scripts/make-icons.mjs' })
  await ask({ kind: 'permission', title: 'Report session', command: 'powershell -NoProfile -Command "Get-ChildItem -Recurse -File D:\\dev\\ai\\dsh-plugins\\dsh-review-queue\\lib\\mobile | Sort-Object Length -Descending | Select-Object -First 20 FullName, Length | ConvertTo-Json"' })
  await ask({ kind: 'question', title: 'Cache session', questions: QUESTION_ONE })
  await ask({ kind: 'question', title: 'Release session', questions: QUESTION_MULTI })
  await ask({ kind: 'completed', title: 'Theme session', reply: REPLY })
  queue.notifyPrMerged({ prId: '42', prSessions: [{ id: 'pr-42', title: 'PR 42 - phone page' }], followUps: [{ id: 'f-42', title: 'phone page - after PR 42' }] })
  await queue.addTodo('Add a dark theme to the dsh-plugins phone page')
  return queue.count()
}

/** The newest open item (the one a dev ask just made). */
function newestOpen(queue) {
  const open = queue.snapshot().open
  return open[open.length - 1]
}
