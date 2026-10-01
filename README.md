# dsh-plugins

Plugins for DeepSeek Harness (DSH). Currently one plugin:

## dsh-hooks-tts

A Claude-Code-style hook runner for DSH plus a few quality-of-life features:

- **Spoken read-outs (TTS)** for finished replies, questions and permission requests, naming the project and session. Uses a local [Kokoro](https://github.com/hexgrad/kokoro) HTTP server (optional).
- **Context cap and auto-resume.** Over a token limit the agent writes a handoff note, and a new session in the same workspace picks it up. The new session inherits the source's access level and gets a numbered title (`x` → `x - 2` → `x - 3`).
- **Worktree continuity.** The plugin records the linked git worktree each session works in (from its tool calls), shows it in the status pill, and handoffs carry a `Worktree:` line so the continuation stays in the same worktree.
- **Status widget** (bottom-right pill): context window, worktree, and a *Hooks and Usage* sidebar page with Claude plan limits, local token usage and live settings.
- **Optional Obsidian session-start hook** that asks the agent to open today's daily note and surface related notes.
- **Always allow full access** toggle (off by default) that forces every session to `danger-full-access` with approvals set to `never`. Understand what that means before enabling it.

### Requirements

- DeepSeek Harness with the web app (`dsh web`), Node 22+, PowerShell (`powershell.exe`) on Windows. The hook scripts are PowerShell.
- Optional: a Kokoro TTS server answering `POST /tts`; Claude Code logged in (only for the plan-usage bars).

### Deploy

1. Clone this repository:

   ```powershell
   git clone https://github.com/jitsmaster/dsh-plugins.git D:\dev\ai\dsh-plugins
   ```

2. Add the plugin to your DSH profile. Edit the profile's `package.json` (for the web profile: `~/.dsh/profiles/web/package.json`): add a `link:` dependency and list the plugin in the profile bundles.

   ```json
   {
     "dependencies": {
       "dsh-hooks-tts": "link:D:/dev/ai/dsh-plugins/dsh-hooks-tts"
     },
     "dsh": {
       "profile": {
         "bundles": ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app", "dsh-hooks-tts"]
       }
     }
   }
   ```

3. Install and restart DSH so the profile picks up the link (run the profile's package install if your DSH setup requires it), then refresh the web page. A *Hooks and Usage* entry appears in the left sidebar.

   Server-side files (`cap.js`, `index.js`, `status.js`, `settings.js`, `worktrees.js`) need a **DSH server restart** after every edit. The client bundle (`lib/client.js`) only needs a page refresh.

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
| `skipSubagents` | Don't run hooks for subagents | `true` |
| `refreshIntervalMs`, `sessionBudgetTokens`, `weeklyBudgetTokens` | Status widget sampling and budgets | 30 s / 30M / 200M |

Runtime settings (editable from the *Hooks and Usage* page, stored in `~/.dsh/tts/settings.json`, re-read on every step): `contextCapTokens`, `ttsEnabled`, `autoResumeHandoff`, `alwaysFullAccess`. A saved value wins over the config default.

### Verify

- **Status pill:** select a session; the bottom-right pill shows `Context Window …` and `⎇ <worktree>`.
- **Handoff and respawn:** temporarily set the context cap low (for example 30000) on the *Hooks and Usage* page. When a session passes it, a handoff note appears in `handoffDir` and a new session starts. Check `~/.dsh/tts/spawn.log` for `copied permission/preset`, `renamed "x" -> "x - 2"` and `spawned session-…`. Restore the cap afterwards.
- **Worktrees:** `~/.dsh/tts/worktrees.json` lists the worktree recorded per session after its next tool call.
- **TTS:** trigger a permission request; with Kokoro running you hear the message plus `Project : … ; Session : …`. Failures are logged to `~/.dsh/tts/tts-failures.log`.

### Files and state

State lives in `~/.dsh/tts/`: `settings.json`, `config.local.json`, `spawn.log`, `worktrees.json`, `usage-ledger.json`, `tts-failures.log`. Nothing is written outside that folder and `handoffDir`.

### Security notes

- The status service listens on `127.0.0.1:3081` only; settings writes are accepted only from the DSH web page origin.
- Claude plan usage reads Claude Code's own OAuth token from `~/.claude/.credentials.json` (read-only, sent only to `api.anthropic.com`). Set `claudeUsage: false` to disable.
- *Always allow full access* disables the sandbox and approval prompts for every session. Leave it off unless you trust everything you run.

### Troubleshooting

- **New session isn't spawned:** read `~/.dsh/tts/spawn.log`; it records every step and any stack trace.
- **Access level not copied:** look for `access copy failed` in `spawn.log`.
- **Pill shows the workspace instead of a worktree:** the worktree is recorded from tool calls, so it appears after the session's next command in that worktree.
- **No sound:** check that `ttsEnabled` is on and the Kokoro server answers on `ttsUrl`.

## License

MIT, see [LICENSE](LICENSE).
