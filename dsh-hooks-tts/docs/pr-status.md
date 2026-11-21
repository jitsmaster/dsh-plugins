# PR poll: status wakes (merge conflicts, merge status, votes)

A session titled `PR <n>` is polled every 10 minutes (see the README, *PR state*). Besides new review comments, each poll now reads the PR's own status and wakes the session, with ONE queued message, when it changes. Code: `pr-status.js` (pure functions), wiring in `pr.js` (`pollOnce`). Tests: `test/pr-status.test.mjs` (fake Azure DevOps client) and `test/pr-poller.test.mjs`.

## What wakes the session

| Change | Condition | Once per |
|---|---|---|
| **Merge conflicts** | `mergeStatus` is `conflicts` and the PR is `active` | PR + head commit (`lastMergeSourceCommit`) + target head commit (`lastMergeTargetCommit`) |
| **Auto-complete blocked** | auto-complete is set and `mergeStatus` is `rejectedByPolicy` or `failure` | blocking state (policy; or failure + failure type) |
| **Reviewer vote change** | any change of a required reviewer; for others a negative vote (-5 waiting for the author, -10 rejected) or the lifting of one | change |
| **Merged / abandoned** | `status` is `completed` / `abandoned` | PR (unchanged behaviour: poll ends, follow-up session started or re-asked, PR session archived) |
| **New review comments** | unchanged | thread + last comment |

Notes:

- The first poll of a PR only records the reviewer votes; it does not wake. A vote that is already negative when the poll starts (or after a restart, the record is in memory) is therefore not announced: only a CHANGE is. This keeps a standing -5 from re-waking every restored session on each restart.
- Re-wakes follow the spec: a PR that stays in conflict is reported again whenever the target branch moves (new target head commit) or the PR branch is pushed (new head commit), at most one message per 10-minute poll. On a busy target branch this can be frequent; switch *Poll PR comments* off to silence it.
- The reported conflict and block records live in memory only: after a DSH restart a PR that still conflicts (or is still blocked) is reported once more, like comment threads.
- A resolved conflict (`mergeStatus` back to `succeeded`) wakes nothing; it is traced (`merge conflicts of PR <n> are resolved`) and clears the record, so a later conflict is reported again. `queued` (the server is recomputing) neither reports nor clears.
- The same conflict state is never re-woken, also after the poll of the session was stopped and registered again (the state is kept per PR for the process lifetime). A failed hand-over is retried on the next poll: the state is recorded only after the queue accepted the message.
- Status lines and new-comment lines share one message (status first, then the CI line, then the comments). Switch everything off with *Poll PR comments*.

## The conflict message

It tells the session to: fetch the target branch, merge it into the PR source branch in the PR's worktree, resolve the conflicts, run the project's relevant tests, commit the merge, and NOT push until the user approves through `ask_user_question` (never a force-push without asking), then, after the approved push, re-check `mergeStatus` with `az repos pr show --id <n> --query mergeStatus` (ado-cli skill). A local merge does not change `mergeStatus`; only the push does. If the message also carries new review comments (and the target branch is a plain one, so a merge is made), it is one sequence with ONE gate: commit the merge without pushing, commit the comment fixes locally as their own commit, then ask once with `ask_user_question` what may be pushed (only the merge commit, both commits, or nothing); nothing is pushed, replied to or resolved before that answer. With an unusual target branch name no merge is made and the plain comments wording is used. Accepted: the conflict is reported once per PR + head commit + target head commit, so a push the user declines (or never answers) is not re-reported until the target or the PR head moves.

**Stacked PRs.** The branch is the PR's real `targetRefName`, not `develop`: `git fetch origin <target>` / `git merge origin/<target>`. The message names the target branch ("targets the branch X, not develop", plus "stacked on active PR n" when that PR is found), and when the target branch is the source branch of another ACTIVE PR of the same repository (found with `searchCriteria.sourceRefName`) that has conflicts itself, it says so and tells the session to coordinate that PR first. Example: CTnP-QA PR 6796 targeted `task/26078-ai-005-stream-abort` (the source of PR 6776).

**Security.** Branch names, reviewer names and merge-failure text come from Azure DevOps and end up in a prompt that tells an agent to run git commands. A branch name is printed only when it is a plain branch name (letters, digits, `._/-`; no `..`, no leading `-`); otherwise the message says the name is unusual and asks the session to use `ask_user_question` instead of fetching it. Reviewer names are printed only when they are plain display names (else the reviewer id), always quoted and marked as data. The merge failure type is printed only from a fixed list (else "unknown"); the free-text merge failure message is never copied. A target branch spelled `Develop` or `MAIN` makes no stacked-PR lookup (compared case-insensitively, `isMainBranchIgnoreCase`), but the conflict message still carries the off-main warning and the "look at what the merge brought in" step (exact, case-sensitive match, `isMainBranchExact`), because Azure Repos refs are case-sensitive and `Develop` can be a different branch from `develop`. Accepted limitation: a real stacked PR whose target is spelled `Develop`/`MAIN` loses the "stacked on PR n / coordinate that PR first" hint. The conflict message does not pre-approve any push: the session commits the merge and asks the user through `ask_user_question` before pushing (and never force-pushes without asking). Accepted risk (by the task): a stacked PR merges another author's branch; the message tells the session to look at what the merge brought in before running tests. Reviewer names must be at most 30 characters and 3 words (else the reviewer id is printed) and a target ref must be under `refs/heads/` with no dot component. Redirects are refused on every Azure DevOps request (`redirect: 'error'`) so the PAT header cannot follow one, and repository and project ids that are dot segments or contain odd characters are rejected.

## Reporting details

- When a negative reviewer vote and new review comments arrive in the same poll, the message asks for `ado-pr-implement` once (the comments part carries it); the vote line itself is still reported.
- A thread-read failure that persists is traced once per distinct cause (the scrubbed error text, so a 404 turning into a 401 is traced again), and again after a successful read.

## Repository resolution (the PR 6796 HTTP 404)

The poller no longer has a fixed repository id. `GET https://dev.azure.com/ingeniuxdev/_apis/git/pullrequests/<id>` works organisation-wide, and the PR it returns names its own repository (`repository.id`, `repository.project.id`); threads are read from `.../<project>/_apis/git/repositories/<repo>/pullRequests/<id>/threads`. Without `repository` the PR's own `url` is used, only when it stays inside `https://dev.azure.com/ingeniuxdev/` (the PAT must never travel to another host). When the PR names no repository at all, its threads are not read (`spawn.log`: `could not resolve the repository of PR <n>`), and the status reports still work.

Limits: the CI AI-review build lookup (pipeline 80) belongs to the Ingeniux project, so no build lookup is made for a PR of another project or when the repository is unresolved. Auto-complete blocked is detected only through `mergeStatus` `rejectedByPolicy` or `failure` (a failing build policy or a missing approval usually keeps `mergeStatus` `succeeded` and is not reported). Reviewer groups (containers) are ignored.

## Real example

CTnP-QA PR 6796 (repo `db3faf01-5377-41f4-b989-5f8ba0052b4e`) targeted `task/26078-ai-005-stream-abort`, the source branch of PR 6776, and its poll answered HTTP 404 because the Ingeniux repository id was used. The tests model that shape (a stacked PR in a non-Ingeniux repository) with a fake Azure DevOps client.
