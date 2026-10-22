# dsh-plugins

Plugins for DeepSeek Harness (DSH):

- [dsh-hooks-tts](#dsh-hooks-tts)
- [dsh-git-view](dsh-git-view/README.md): read-only Git tab (branch/worktree, changes, diffs) in the right sidebar; local only, port 3082.
- [dsh-review-queue](dsh-review-queue/README.md): oldest-first review queue of finished work, open questions and permission requests from every session; full-screen overlay opened from a button in the session header.
- dsh-remote-access: moved to its own private repo, `jitsmaster/dsh-remote-access`.

Branches: `main` holds stable, release-ready code only; day-to-day work happens on `develop`.

## dsh-hooks-tts

A Claude-Code-style hook runner for DSH plus a few quality-of-life features:

- **Short spoken alerts (TTS)**: a finished session says "Done on: Session: <title>; Workspace: <name>." and reads the last paragraph of the reply, slower and with pauses between phrases; a question says "Question: <first question, up to 15 words>" and a permission request says "Approve write file?". Uses a local [Kokoro](https://github.com/hexgrad/kokoro) HTTP server (optional).
- **Context cap and auto-resume.** Over a token limit the agent writes a handoff note, and a new session in the same workspace picks it up. The new session inherits the source's access level and gets a numbered title (`x` â†’ `x - 2` â†’ `x - 3`).
- **Archive after handoff.** Once the new session(s) of a handoff exist (context-cap handoff, PR hand-over: after BOTH the PR session and the after-PR session, or the PR session alone when there is no remaining work, and the session menu's *Follow-up from handoff*), the session they came from is archived (`workspaceRegistry.archiveSession`, stop-activity, about 2 s later because the spawn runs inside that session's own turn-stopping hook; a failed spawn or a failed archive never archives or throws). Every new session's first prompt ends with a plain line `Previous session (archived after this handoff; open it from the archived sessions if you need it): "<title>" (session id <id>)` (plain text on purpose: a `dsh-session` mention would attach a copy of the old session). Setting `archiveAfterHandoff` (default on, toggle next to *Auto-resume after handoff*); off: nothing is archived and the line reads `Previous session: ...`.
- **PR state: no auto-respawn, rename, comment poller.** A session titled `PR <n>` is never auto-respawned and is never told to write a handoff (it gets the informational notice instead, "no new session will open"); the check is per session and live, and the global *Auto-resume after handoff* setting is not touched. When a session creates a PR (`az repos pr create` output with `pullRequestId`, or a `PR-CREATED: <id>` line in shell output) it is renamed to `PR <id>`, once (a session already titled `PR <n>` is never renamed). A session started from an Azure DevOps ticket by the Task list is titled `Fix: <ticket title> - <n>`; the session that continues its PR is then titled `PR <id> - Fix: <ticket title> - <n>` (still a PR title) instead of `PR <id>`, and a handoff continuation keeps the ticket number out of the numbering (`... - <n> - 2`). While in PR state, every 10 minutes the plugin reads the PR and its threads from Azure DevOps (`AZURE_DEVOPS_EXT_PAT` from the environment, sent as Basic auth, never stored or logged) and, for threads that are new or whose last comment changed (system, deleted and resolved/closed threads are ignored), queues a message into the same session to run `ado-pr-implement` on that PR up to its approval gate, without committing or replying. **The 10-minute trigger is a visible Automation task.** When the host has the Schedule service, each `PR <n>` session gets ONE recurring Automation task named `PR <id> comment poll` (every 10 minutes, shown in the session's Automation list), created when the session enters PR state and re-created after a restart if needed; the task's tick is handled by the plugin itself, without a model call (the plugin intercepts the schedule message before the step, so no tokens are spent), and the poll logic is exactly the one described here. A tick is handled at the start of the next turn, so a long-running turn polls late; each tick adds a few log events per PR session, so archive a PR session once its PR is merged. If the task cannot be created the timer is used for that session instead. The task never blocks archiving the session and is deleted automatically when the PR is completed or abandoned, when the session is archived, when its title stops being `PR <n>`, and when *Poll PR comments* is switched off (switching it on again restores them); a task the plugin does not own (your own reminders) is never touched, and the task is kept when the DSH server shuts down. Its prompt (`Check Azure DevOps pull request <id> ... PR-WAIT: <id>`) is only a fallback for when the plugin is not loaded; the plugin's own task state is `pr-poll-tasks.json` next to `settings.json`. Without a Schedule service the old in-process 10-minute timer is used. Polling stops only when the PR is completed or abandoned, the session is archived, or its title stops being `PR <n>` (a disposed session is registered again on its next step and keeps the threads it already announced for as long as the server runs); a reviewer's approval or a clean CI review does not stop it, so comments and CI findings that arrive after an approval are still queued; polls never overlap, and everything is traced in `spawn.log` (`pr-poll` lines). Handoffs carry `PR: <id>` and `PR-POLL: <id> seen=<thread>:<lastComment>,...`; a resumed session (or any message) containing that `PR-POLL:` line re-registers the poll. A session already titled `PR <n>` is picked up on its next step, e.g. after a host restart (its seen list starts empty). Switch it off with *Poll PR comments* (`pollPrComments`, default on). **Merged PR: start the follow-up, offer to archive.** When the PR is seen `completed` (by the PR poll or by the wait timer), the plugin locates the follow-up session (`<title> - after PR <id>`: the one with a recorded `PR-WAIT`, plus any session with that title whose wait was lost) and queues ONE "PR was merged, start the remaining work now" message into it. The message says what to do if the session already started (rebase onto origin/develop), and a follow-up that cannot be reached is retried by the wait timer. **Approved PR: the follow-up starts too.** Every follow-up session that waits for its PR (the `PR-WAIT` record made when the `... - after PR <id>` session is created) gets ONE recurring Automation task named `PR <id> approval wait` (every 10 minutes, shown in the session's Automation list; the plugin handles its tick itself, no model call; marker `pr-approval`, registry `pr-approval-tasks.json` next to `settings.json`). When the reviewers have approved the PR (at least one vote of 5 or 10, nobody waiting or rejecting, every required reviewer approved) the plugin queues ONE "PR was approved, start the remaining work now" message into that session (once per session and PR, `pr-approved.json`) and deletes the task; a session that already started ignores it. The wait itself stays, so the merge still sends its own message (rebase onto origin/develop). Without a Schedule service the minute-by-minute wait timer does the approval check. The task is also deleted when the PR is merged or abandoned, the session is archived or retitled. It then reports the `PR <id>` session to the Task list (`reviewQueue.notifyPrMerged`), which offers an *Archive session* button; each PR is handled once, also across restarts (`pr-merged.json`). **Older behaviour, merged PR: suggest, never auto-spawn.** When the poller sees the PR `completed`, it queues ONE message (once per PR; carried across handoffs as `PR-POLL: ... resume=suggested`) telling the agent to ask the user via `ask_user_question` "PR <id> is merged. Spawn a new session to continue from the last handoff?" (Yes / No). On Yes the agent runs `echo PR-RESUME-APPROVED: <id>`; the plugin honours that shell-output line only in a session titled `PR <same id>` whose PR was observed completed, at most once. It then opens ONE new session from the newest `<project>-*-handoff.md` in `handoffDir` with the normal resume's access-level copy, auto-open and prompt, titled `Continue PR <id>` and without the `PR-POLL` marker so it is not PR-state. `autoResumeHandoff` is neither read for this nor changed; no marker, no spawn. Traced in `spawn.log`.
- **Auto-open.** When the continuation session is created, the browser tab showing the source session switches to it. Tabs showing other sessions are left alone. The host publishes spawns in the `:3081/status` JSON (`spawned`); the client acts on spawns that appear after its first poll, so a page refresh does not replay old ones.
- **Follow-up from handoff.** A session's "..." menu shows *Follow-up from handoff* while the latest handoff note that session wrote still exists. A note counts when the plugin asked for it (cap and PR hand-over), when the session wrote it with write/edit (also inside `run_code`) or a shell write (`Set-Content`, `Out-File`, `>`), or when its reply says "handoff written to `<path>`" (the SPARC stop message), for any file named `*handoff.md`. It opens a new session that resumes that note with the sparcr flow (modes:sparc "Resuming from a Handoff"), whatever the *Auto-resume after handoff* setting says. The new session joins the source's group only when the source is in one, inherits its access level, gets the same numbered title (`x` → `x - 2`, a follow-up of `x - 2` → `x - 3`) and opens in the browser. Notes are tracked in `~/.dsh/tts/handoffs.json`; sessions that wrote notes before the plugin version that tracks them are picked up by a one-time history scan when they load.
- **Forward handoff.** When 3 resumed sessions in a row each hit the cap in under 20 minutes, the next handoff is written in the lean "forward mode" format (worktree, what it supersedes, what's left) instead of a full history, and the agent flags that the cap may be too low. The decision is logged in `spawn.log`.
- **Worktree continuity.** The plugin records the linked git worktree each session works in (from its tool calls), shows it in the status pill, and handoffs carry a `Worktree:` line so the continuation stays in the same worktree.
- **Custom app icon.** Replaces the DeepSeek mark with a DeepSeek whale over layered water waves: the browser favicon, the apple-touch icon and the in-app logos (sidebar header, new-session screen). Applied in the browser at load and undone when the plugin is removed. The installed-PWA manifest icon is not changed.
- **Status widget** (bottom-right pill): context window, worktree, and a *Hooks and Usage* sidebar page with Claude plan limits, local token usage and live settings.
- **Action items stand out.** While the plugin is active, every session is told once (with its first step) to put each action item for the user (a confirmation, a question, a clarification, a choice) in its own paragraph, marked `<u>**...**</u>` (the Task list shows that text bold and larger, not underlined), and to use that only for things the user must act on. Subagents are not told. Nothing to configure; remove the plugin to stop it.
- **Optional Obsidian session-start hook** that asks the agent to open today's daily note and surface related notes.
- **Always allow full access** toggle (off by default) that starts each new session at `danger-full-access` with approvals set to `never`. It applies once, before the session's first turn finishes, and never resets a mode chosen later or an existing session. Understand what that means before enabling it.

### Requirements

- DeepSeek Harness with the web app (`dsh web`), Node 22+, PowerShell (`powershell.exe`) on Windows. The hook scripts are PowerShell.
- Optional: a Kokoro TTS server answering `POST /tts`; Claude Code logged in (only for the plan-usage bars).

### Deploy

**Install from GitHub (recommended).** One command; DSH installs the package into the profile and adds it to the profile's bundle list:

```powershell
dsh plugin --profile web add "github:jitsmaster/dsh-plugins#path:/dsh-hooks-tts"
```

(From a DSH source checkout, run it as `pnpm dsh plugin --profile web add ...` in the checkout.) Then restart the DSH server and **refresh the browser page** (the web client only loads the new plugin UI on a page reload). A *Hooks and Usage* entry appears in the left sidebar. The installed copy lives in `~/.dsh/profiles/web/node_modules/dsh-hooks-tts`; this is a copy of the commit installed, not a live link.

Update to the latest commit by running the same `add` command again (pnpm re-resolves the branch), then restart the server and **refresh the browser**. Remove with:

```powershell
dsh plugin --profile web remove dsh-hooks-tts
```

**Develop from a local clone.** Use a `link:` dependency so edits apply without reinstalling:

```powershell
git clone https://github.com/jitsmaster/dsh-plugins.git D:\dev\ai\dsh-plugins
dsh plugin --profile web add "link:D:/dev/ai/dsh-plugins/dsh-hooks-tts"
```

Server-side files (`cap.js`, `handoffs.js`, `index.js`, `status.js`, `settings.js`, `worktrees.js`) need a **DSH server restart** after every edit. The client bundle (`lib/client.js`) only needs a browser refresh.
> **After every install, update or removal: restart the DSH server, then refresh the browser tab.** Without the refresh the page keeps showing the old plugin UI (or none).

### Configure

Defaults live in [`dsh-hooks-tts/cordis.patch.yml`](dsh-hooks-tts/cordis.patch.yml) and contain no personal paths. Put machine-specific values in `~/.dsh/tts/config.local.json`, which overrides the patch:

```json
{
  "ttsUrl": "http://127.0.0.1:8880/tts",
  "ttsServerScript": "C:\\path\\to\\start-hidden.ps1",
  "hotkeyDir": "C:\\Users\\you\\.claude",
  "obsidianVault": "C:\\path\\to\\vault",
  "handoffDir": "C:\\path\\to\\handoffs"
}
```

| Key | Meaning | Default |
| --- | --- | --- |
| `ttsUrl` | Kokoro endpoint | `http://127.0.0.1:8880/tts` |
| `ttsServerScript` | Script launched (hidden) when nothing listens on `ttsUrl` | none |
| `hotkeyDir` | Folder with `tts-stop-hotkey.exe`, stop flag and `audio.pids` | `~/.claude` |
| `obsidianVault` | Vault path for the session-start hook; the hook does nothing when unset | unset |
| `handoffDir` | Where handoff notes are written | `~/.dsh/handoffs` |
| `contextCapTokens` | Handoff threshold (0 disables) | 400000 |
| `warnPercent` | Warn at this % of the cap, via the status pill and a one-time heads-up to the agent (0 disables). With *Auto-resume after handoff* on it reads `⚠ handoff at 400k → new session`, with it off `ℹ nearing 400k cap · auto-handoff off`, and the agent is only informed — it is never told to stop or write a handoff note | 85 |
| `handoffAhead` | With auto-resume on, hand off at the start of a turn when the next chunk of work (the largest growth of the last three finished turns, needs two) would not fit under the cap or the model window | true |
| `skipSubagents` | Don't run hooks for subagents | `true` |
| `refreshIntervalMs`, `sessionBudgetTokens`, `weeklyBudgetTokens` | Status widget sampling and budgets | 30 s / 30M / 200M |

Runtime settings (editable from the *Hooks and Usage* page, stored in `~/.dsh/tts/settings.json`, re-read on every step): `contextCapTokens`, `warnPercent`, `ttsEnabled`, `autoResumeHandoff`, `archiveAfterHandoff`, `handoffAhead`, `pollPrComments`, `alwaysFullAccess`, `decideChime` (voice control: singing bowl while the LLM decides, default on). A saved value wins over the config default.

### Keep the computer awake

While the DSH server runs, the computer is kept from going to sleep (idle sleep), not only while a session is working. It is on by default.

- **Windows:** a tiny hidden PowerShell helper (`scripts/keep-awake.ps1`) holds a `SetThreadExecutionState(ES_CONTINUOUS | ES_SYSTEM_REQUIRED)` request and renews it every 30 s. No admin rights are needed. The helper exits by itself when DSH is gone (also after a crash), and the plugin stops it when it shuts down.
- **macOS:** `caffeinate -i -w <dsh pid>`. **Linux:** `systemd-inhibit --what=sleep ... sleep infinity` when `systemd-inhibit` exists (after a hard kill of DSH this inhibitor lingers until you log out or reboot). Elsewhere, or when the command fails, one line is logged and DSH carries on.
- **The display may still turn off** and the screen may lock; only system sleep is blocked. Closing the lid and a manual Sleep still sleep the machine.
- A helper that dies is restarted up to 3 times, then given up (logged as `hooks-tts: keep-awake: ...`).

Settings (config default in `cordis.patch.yml`, runtime value in `~/.dsh/tts/settings.json`, which wins):

| Key | Meaning | Default |
| --- | --- | --- |
| `keepAwake` | Keep the computer awake while DSH runs. `false` disables it. | `true` |
| `keepDisplayOn` | Also keep the display on (`ES_DISPLAY_REQUIRED`; Windows). | `false` |

A change made through the settings API (`POST` to the status service's `/settings`, as the *Hooks and Usage* page does) starts or stops the helper immediately. After editing `settings.json` by hand, or changing the `cordis.patch.yml` default, restart the DSH server. To disable it for good, put `"keepAwake": false` in `~/.dsh/tts/settings.json` (or `keepAwake: false` in `~/.dsh/tts/config.local.json`).

### Verify

- **Status pill:** select a session; the bottom-right pill shows `Context Window â€¦` and `âŽ‡ <worktree>`.
- **Handoff and respawn:** temporarily set the context cap low (for example 30000) on the *Hooks and Usage* page. When a session passes it, a handoff note appears in `handoffDir` and a new session starts. Check `~/.dsh/tts/spawn.log` for `copied permission/preset`, `renamed "x" -> "x - 2"` and `spawned session-â€¦`. Restore the cap afterwards.
- **Worktrees:** `~/.dsh/tts/worktrees.json` lists the worktree recorded per session after its next tool call.
- **TTS:** trigger a permission request; with Kokoro running you hear the message plus `Project : â€¦ ; Session : â€¦`. Failures are logged to `~/.dsh/tts/tts-failures.log`.

### Files and state

State lives in `~/.dsh/tts/`: `settings.json`, `config.local.json`, `spawn.log`, `worktrees.json`, `handoffs.json`, `usage-ledger.json`, `tts-failures.log`. Nothing is written outside that folder and `handoffDir`.

### Security notes

- The status service listens on `127.0.0.1:3081` only; settings writes are accepted only from the DSH web page origin.
- Claude plan usage reads Claude Code's own OAuth token from `~/.claude/.credentials.json` (read-only, sent only to `api.anthropic.com`). Set `claudeUsage: false` to disable.
- *Always allow full access* disables the sandbox and approval prompts for every new session. Leave it off unless you trust everything you run.

### Troubleshooting

- **New session isn't spawned:** read `~/.dsh/tts/spawn.log`; it records every step and any stack trace.
- **Access level not copied:** look for `access copy failed` in `spawn.log`.
- **Pill shows the workspace instead of a worktree:** the worktree is recorded from tool calls, so it appears after the session's next command in that worktree.
- **No sound:** check that `ttsEnabled` is on and the Kokoro server answers on `ttsUrl`.

## License

MIT, see [LICENSE](LICENSE).

