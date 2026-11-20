/**
 * Status reports of the PR poll (see pr.js): merge conflicts, a blocked auto-complete and reviewer vote changes, plus the
 * repository the PR lives in. Pure functions: the poller owns the state object and the Azure DevOps calls.
 *
 * Everything that comes from Azure DevOps and lands in a message for the agent (branch names, reviewer names, merge failure
 * text) is bounded and checked first: the message tells the agent to run git commands, so a branch name is only ever
 * printed when it looks like a plain branch name.
 */

/** Targets that are the main line: a PR into one of them is not a stacked PR. */
export const MAIN_BRANCHES = new Set(['develop', 'main', 'master'])

const SAFE_BRANCH = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/
const MAX_TEXT = 200
const SEGMENT = /^[\w.%-]{1,100}$/

/** One bounded line of free text from Azure DevOps (no line breaks, no control characters). */
export function flat(text, max = MAX_TEXT) {
  const line = String(text ?? '').replace(/[\u0000-\u001f\u007f-\u009f\s]+/g, ' ').trim()
  return line.length > max ? `${line.slice(0, max - 1)}…` : line
}

/** "refs/heads/task/x" -> "task/x"; undefined when it is not a plain, safe branch name. */
export function branchOf(ref) {
  const name = String(ref ?? '').replace(/^refs\/heads\//, '')
  if (!SAFE_BRANCH.test(name) || name.includes('..') || name.includes('//') || name.endsWith('/') || name.endsWith('.lock')) return undefined
  return name
}

const shortSha = (id) => (/^[0-9a-f]{40}$/i.test(String(id ?? '')) ? String(id).slice(0, 7) : undefined)

/**
 * The URL of the PR inside ITS OWN repository (".../<project>/_apis/git/repositories/<repo>/pullRequests/<id>"), from the PR
 * itself: its repository (id and project), else its own `url` when that stays inside the organisation. Never a fixed repository:
 * undefined when the PR does not say.
 */
export function repoPrBase(org, pr, prId) {
  const repo = pr?.repository?.id
  const project = pr?.repository?.project?.id ?? pr?.repository?.project?.name
  if (repo && project) return `${org}/${encodeURIComponent(project)}/_apis/git/repositories/${encodeURIComponent(repo)}/pullRequests/${encodeURIComponent(prId)}`
  const url = typeof pr?.url === 'string' ? pr.url : ''
  if (!url.startsWith(`${org}/`)) return undefined // the PAT must never travel to a host the PR names
  const m = /^\/([^/]+)\/_apis\/git\/repositories\/([^/]+)\/pullRequests\/(\d+)$/i.exec(url.slice(org.length))
  if (!m || m[3] !== String(prId) || !SEGMENT.test(m[1]) || !SEGMENT.test(m[2])) return undefined
  return `${org}/${m[1]}/_apis/git/repositories/${m[2]}/pullRequests/${m[3]}`
}

/** `{ conflictKey, blockedKey, votes }`: what was already reported for one PR (votes: reviewer -> vote, undefined until first seen). */
export function createStatusState(from) {
  return { conflictKey: from?.conflictKey, blockedKey: from?.blockedKey, votes: from?.votes ? new Map(from.votes) : undefined }
}

const VOTE_LABEL = new Map([[10, 'approved'], [5, 'approved with suggestions'], [0, 'no vote'], [-5, 'waiting for the author'], [-10, 'rejected']])
const voteLabel = (v) => VOTE_LABEL.get(v) ?? 'unknown vote'

/**
 * The reviewer vote changes worth a message: any change of a required reviewer, and for the others a negative vote or the lifting
 * of one. `next` is the vote map to record once the message was delivered. Without a previous map nothing is announced
 * (the first poll only records).
 */
function voteNotices(prId, previous, reviewers) {
  const next = new Map(previous ?? [])
  const lines = []
  for (const r of reviewers) {
    const key = r && (r.id ?? r.uniqueName ?? r.displayName)
    if (!key) continue
    const vote = Number(r.vote) || 0
    const before = previous?.get(String(key)) ?? 0
    next.set(String(key), vote)
    if (!previous || vote === before) continue
    if (!(r.isRequired || vote < 0 || before < 0)) continue
    const who = `${flat(r.displayName ?? key, 80)}${r.isRequired ? ' (required reviewer)' : ''}`
    lines.push([
      `${who} changed their vote on PR ${prId} to ${vote} (${voteLabel(vote)}), was ${before} (${voteLabel(before)}).`,
      vote < 0 ? `Run the \`ado-pr-implement\` skill on PR ${prId} and take it up to its user-approval gate to see what they ask for.` : '',
    ].filter(Boolean).join(' '))
  }
  return { lines, next }
}

/** Auto-complete is set but the merge cannot happen: a policy rejected it or the merge itself failed. (Conflicts are reported by conflictLine.) */
function blockedNotice(prId, pr, key) {
  if (!pr?.autoCompleteSetBy) return undefined
  if (pr.mergeStatus === 'rejectedByPolicy') {
    return { key: `${key}|rejectedByPolicy`, line: `Auto-complete on PR ${prId} is blocked: a branch policy rejected the merge (mergeStatus rejectedByPolicy). List the failing policies with \`az repos pr policy list --id ${prId}\`, fix what is in your reach and tell the user about the rest.` }
  }
  if (pr.mergeStatus === 'failure') {
    const why = flat([pr.mergeFailureType, pr.mergeFailureMessage].filter(Boolean).join(': '))
    return { key: `${key}|failure|${why}`, line: `Auto-complete on PR ${prId} is blocked: the merge failed${why ? ` (${why})` : ''}. Look at the PR with \`az repos pr show --id ${prId}\` and tell the user what is needed.` }
  }
  return undefined
}

/**
 * What the current PR JSON says, compared with `state` (nothing is changed here):
 * `conflictKey` (set while mergeStatus is conflicts: PR + head commit + target head commit), `blocked` ({ key, line }),
 * `votes` ({ lines, next } or undefined without a reviewers list) and `resolved` (a reported conflict or block is gone).
 */
export function evaluateStatus(state, prId, pr) {
  const head = String(pr?.lastMergeSourceCommit?.commitId ?? 'unknown')
  const targetHead = String(pr?.lastMergeTargetCommit?.commitId ?? 'unknown')
  const key = `${prId}|${head}|${targetHead}`
  return {
    resolved: pr?.mergeStatus === 'succeeded' && Boolean(state.conflictKey || state.blockedKey),
    conflictKey: pr?.mergeStatus === 'conflicts' ? key : undefined,
    blocked: blockedNotice(prId, pr, key),
    votes: Array.isArray(pr?.reviewers) ? voteNotices(prId, state.votes, pr.reviewers) : undefined,
  }
}

/**
 * The message for a PR that cannot merge: how to bring the target branch in, locally, in the PR's worktree.
 * @param {{ id: string|number, conflicts: boolean }} [opts.targetPr] - the active PR whose source branch is this PR's target (stacked PRs).
 */
export function conflictLine(prId, pr, { targetPr } = {}) {
  const target = branchOf(pr?.targetRefName)
  const source = branchOf(pr?.sourceRefName)
  const heads = [shortSha(pr?.lastMergeSourceCommit?.commitId) && `head ${shortSha(pr.lastMergeSourceCommit.commitId)}`, shortSha(pr?.lastMergeTargetCommit?.commitId) && `target head ${shortSha(pr.lastMergeTargetCommit.commitId)}`].filter(Boolean)
  const stacked = Boolean(target && !MAIN_BRANCHES.has(target))
  const show = pr?.autoCompleteSetBy ? ' It cannot merge, auto-complete stays blocked, and' : ' It cannot be merged and'
  const where = source ? `the worktree of ${source}` : 'the worktree of the PR source branch'
  return [
    `PR ${prId} has MERGE CONFLICTS with ${target ?? 'its target branch'}${heads.length ? ` (${heads.join(', ')})` : ''}.${show} the CI review pipeline cannot run until they are resolved.`,
    ...(stacked ? [`This is a stacked PR: its target is the feature branch ${target}, not develop. Merge that branch, not develop.`] : []),
    ...(targetPr?.conflicts && target ? [`The target branch ${target} is the source branch of active PR ${targetPr.id}, which also has merge conflicts: resolve or coordinate that PR first, then merge the updated ${target}.`] : []),
    'Resolve them now, in this session:',
    target
      ? `1. In ${where} (see \`git worktree list\`; create one for the branch if there is none) run \`git fetch origin ${target}\`.`
      : `1. Read the target branch name with \`az repos pr show --id ${prId}\` (its name is not shown here because it looks unusual), then fetch it in ${where}.`,
    target ? `2. Merge it into the PR source branch: \`git merge origin/${target}\`, and resolve every conflict, keeping the intent of both sides.` : '2. Merge origin/<that branch> into the PR source branch and resolve every conflict, keeping the intent of both sides.',
    '3. Run the project\'s relevant tests.',
    '4. Commit and push the source branch with a normal push. Do NOT force-push without asking the user first (use `ask_user_question`).',
    `5. Re-check the merge status with \`az repos pr show --id ${prId} --query mergeStatus\` (ado-cli skill) until mergeStatus is no longer conflicts.`,
  ].join('\n')
}
