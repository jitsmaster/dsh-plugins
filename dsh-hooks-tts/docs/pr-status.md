# PR poll: status wakes (merge conflicts, merge status, votes)

A session titled `PR <n>` is polled every 10 minutes (see the README, *PR state*). Besides new review comments, each poll now reads the PR's own status and wakes the session, with ONE queued message, when it changes. Code: `pr-status.js` (pure functions), wiring in `pr.js` (`pollOnce`). Tests: `test/pr-status.test.mjs` (fake Azure DevOps client) and `test/pr-poller.test.mjs`.

## What wakes the session

| Change | Condition | Once per |
|---|---|---|
| **Merge conflicts** | `mergeStatus` is `conflicts` and the PR is `active` | PR + head commit (`lastMergeSourceCommit`) + target head commit (`lastMergeTargetCommit`) |
| **Auto-complete blocked** | auto-complete is set and `mergeStatus` is `rejectedByPolicy` or `failure` | blocking state (policy; or failure with its text) |
| **Reviewer vote change** | any change of a required reviewer; for others a negative vote (-5 waiting for the author, -10 rejected) or the lifting of one | change |
| **Merged / abandoned** | `status` is `completed` / `abandoned` | PR (unchanged behaviour: poll ends, follow-up session started or re-asked, PR session archived) |
| **New review comments** | unchanged | thread + last comment |

Notes:

- The first poll of a PR only records the reviewer votes; it does not wake.
- A resolved conflict (`mergeStatus` back to `succeeded`) wakes nothing; it is traced (`merge conflicts of PR <n> are resolved`) and clears the record, so a later conflict is reported again. `queued` (the server is recomputing) neither reports nor clears.
- The same conflict state is never re-woken, also after the poll of the session was stopped and registered again (the state is kept per PR for the process lifetime). A failed hand-over is retried on the next poll: the state is recorded only after the queue accepted the message.
- Status lines and new-comment lines share one message (status first, then the CI line, then the comments). Switch everything off with *Poll PR comments*.

## The conflict message

It tells the session to: fetch the target branch, merge it into the PR source branch in the PR's worktree, resolve the conflicts, run the project's relevant tests, push with a normal push (no force-push without asking the user through `ask_user_question`), then re-check `mergeStatus` with `az repos pr show --id <n> --query mergeStatus` (ado-cli skill).

**Stacked PRs.** The branch is the PR's real `targetRefName`, not `develop`: `git fetch origin <target>` / `git merge origin/<target>`. The message says the PR is stacked, and when the target branch is the source branch of another ACTIVE PR of the same repository (found with `searchCriteria.sourceRefName`) that has conflicts itself, it says so and tells the session to coordinate that PR first. Example: CTnP-QA PR 6796 targeted `task/26078-ai-005-stream-abort` (the source of PR 6776).

**Security.** Branch names, reviewer names and merge-failure text come from Azure DevOps and end up in a prompt that tells an agent to run git commands. A branch name is printed only when it is a plain branch name (letters, digits, `._/-`; no `..`, no leading `-`); otherwise the message points to `az repos pr show` instead. Free text is flattened to one line of at most 200 characters.

## Repository resolution (the PR 6796 HTTP 404)

The poller no longer has a fixed repository id. `GET https://dev.azure.com/ingeniuxdev/_apis/git/pullrequests/<id>` works organisation-wide, and the PR it returns names its own repository (`repository.id`, `repository.project.id`); threads are read from `.../<project>/_apis/git/repositories/<repo>/pullRequests/<id>/threads`. Without `repository` the PR's own `url` is used, only when it stays inside `https://dev.azure.com/ingeniuxdev/` (the PAT must never travel to another host). When the PR names no repository at all, its threads are not read (`spawn.log`: `could not resolve the repository of PR <n>`), and the status reports still work.

Not changed: the CI AI-review build lookup (pipeline 80) is an Ingeniux-project pipeline; for PRs of other repositories it simply finds no runs.

## Real example

CTnP-QA PR 6776 (repo `db3faf01-5377-41f4-b989-5f8ba0052b4e`, project Ingeniux, `task/26078-ai-005-stream-abort` into `develop`) had merge conflicts with `develop` (8 files); the fixtures in the tests use its real commit ids and Laska's -5 vote. At the time of writing its `mergeStatus` is `succeeded` again (develop was merged into the branch).
