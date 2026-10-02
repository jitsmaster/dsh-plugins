# dsh-plugins

Plugins for DeepSeek Harness (DSH):

- [dsh-hooks-tts](#dsh-hooks-tts)
- [dsh-remote-access](dsh-remote-access/README.md): reach DSH from outside the LAN without a public IP.

## dsh-hooks-tts

A Claude-Code-style hook runner for DSH plus a few quality-of-life features:

- **Spoken read-outs (TTS)** for finished replies, questions and permission requests, naming the project and session. Uses a local [Kokoro](https://github.com/hexgrad/kokoro) HTTP server (optional).
- **Context cap and auto-resume.** Over a token limit the agent writes a handoff note, and a new session in the same workspace picks it up. The new session inherits the source's access level and gets a numbered title (`x` â†’ `x - 2` â†’ `x - 3`).
- **Auto-open.** When the continuation session is created, the browser tab showing the source session switches to it. Tabs showing other sessions are left alone. The host publishes spawns in the `:3081/status` JSON (`spawned`); the client acts on spawns that appear after its first poll, so a page refresh does not replay old ones.
- **Forward handoff.** When 3 resumed sessions in a row each hit the cap in under 20 minutes, the next handoff is written in the lean "forward mode" format (worktree, what it supersedes, what's left) instead of a full history, and the agent flags that the cap may be too low. The decision is logged in `spawn.log`.
- **Worktree continuity.** The plugin records the linked git worktree each session works in (from its tool calls), shows it in the status pill, and handoffs carry a `Worktree:` line so the continuation stays in the same worktree.
- **Custom app icon.** Replaces the DeepSeek mark with a DeepSeek whale over layered water waves: the browser favicon, the apple-touch icon and the in-app logos (sidebar header, new-session screen). Applied in the browser at load and undone when the plugin is removed. The installed-PWA manifest icon is not changed.
- **Status widget** (bottom-right pill): context window, worktree, and a *Hooks and Usage* sidebar page with Claude plan limits, local token usage and live settings.
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

Server-side files (`cap.js`, `index.js`, `status.js`, `settings.js`, `worktrees.js`) need a **DSH server restart** after every edit. The client bundle (`lib/client.js`) only needs a browser refresh.
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
| `skipSubagents` | Don't run hooks for subagents | `true` |
| `refreshIntervalMs`, `sessionBudgetTokens`, `weeklyBudgetTokens` | Status widget sampling and budgets | 30 s / 30M / 200M |

Runtime settings (editable from the *Hooks and Usage* page, stored in `~/.dsh/tts/settings.json`, re-read on every step): `contextCapTokens`, `warnPercent`, `ttsEnabled`, `autoResumeHandoff`, `alwaysFullAccess`. A saved value wins over the config default.

### Verify

- **Status pill:** select a session; the bottom-right pill shows `Context Window â€¦` and `âŽ‡ <worktree>`.
- **Handoff and respawn:** temporarily set the context cap low (for example 30000) on the *Hooks and Usage* page. When a session passes it, a handoff note appears in `handoffDir` and a new session starts. Check `~/.dsh/tts/spawn.log` for `copied permission/preset`, `renamed "x" -> "x - 2"` and `spawned session-â€¦`. Restore the cap afterwards.
- **Worktrees:** `~/.dsh/tts/worktrees.json` lists the worktree recorded per session after its next tool call.
- **TTS:** trigger a permission request; with Kokoro running you hear the message plus `Project : â€¦ ; Session : â€¦`. Failures are logged to `~/.dsh/tts/tts-failures.log`.

### Files and state

State lives in `~/.dsh/tts/`: `settings.json`, `config.local.json`, `spawn.log`, `worktrees.json`, `usage-ledger.json`, `tts-failures.log`. Nothing is written outside that folder and `handoffDir`.

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

