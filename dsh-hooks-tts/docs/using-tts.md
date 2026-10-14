# Using the TTS read-outs (dsh-hooks-tts)

Spoken alerts for DeepSeek Harness: when a session finishes, asks a question or needs a permission, you hear a short line, so you can run several sessions without watching the screen. Speech comes from a local [Kokoro](https://github.com/hexgrad/kokoro) HTTP server; the plugin plays it. Voice **control** (talking to DSH with Ctrl+Alt+V) is a separate feature, see [voice-two-stage-flow.md](voice-two-stage-flow.md); it uses the same speaker.

## Quick start

1. **Run a Kokoro server** that answers `POST /tts` (default `http://127.0.0.1:8880/tts`). The maintainer's server is the separate project `D:\dev\TTS\tts-server-with-kokoro` (start it with its `start-hidden.ps1`; see its `docs/ARCHITECTURE.md`). The plugin works with any server that accepts `{text, voice_gender, speed, pause_s}` and returns a WAV.
2. **Install the plugin** and restart the DSH server, then refresh the browser tab (see the root [README](../../README.md), "Deploy").
3. **Point the plugin at the server, only if it is not on the default URL**, in `~/.dsh/tts/config.local.json`:

   ```json
   {
     "ttsUrl": "http://127.0.0.1:8880/tts",
     "ttsServerScript": "D:\\dev\\TTS\\tts-server-with-kokoro\\start-hidden.ps1",
     "hotkeyDir": "C:\\Users\\you\\.claude",
     "ttsSpeed": 1.2
   }
   ```

   Restart the DSH server after editing it. With `ttsServerScript` set, the plugin starts the server (hidden) the first time it finds nothing listening on `ttsUrl` and waits up to 90 s for it (`DSH_TTS_START_WAIT_SECONDS`, 1 to 300). If that start fails it does not try again for 60 s, so alerts are skipped quietly during that time.
4. **Check it:** open *Hooks and Usage* in the left sidebar and make sure **TTS hooks** is on, then trigger a permission request in any session. You should hear it within a second or two (the first line after a cold server start can take longer).

## What you hear

| Event | Spoken line |
| --- | --- |
| Session finished (Stop) | "Done on: Session: <title>; Workspace: <name>." then the last paragraph of the reply, slower and with pauses between phrases |
| Question (`ask_user_question`) | "Question: <first question, up to 15 words>" |
| Permission request | "Approve write file?" (tool and operand, short) |

When the item is already in the **Task list** (the review queue overlay), the line starts with its position instead: "Item three, done in dsh-plugins." / "Item two, question: …" / "Item four, approve write file?". That is the same number "read item four" and "reply to item four" use by voice. If the item is not in the list (list empty, item hidden as "nothing for you to do", queue plugin absent) you get the plain wording above.

Details worth knowing:

- Alerts use the male voice; the voice-control conversation uses the female one, so you can tell them apart.
- Short phrases are cached as WAV files in `~/.dsh/tts/tts-cache`, so a repeated line starts without a server round trip.
- Alerts raised while a voice-control conversation is running are held and replayed afterwards (a held alert's position is recomputed when it plays).
- Subagent sessions do not speak (`skipSubagents: true`).
- Chinese text is spoken by the server's Chinese model; any Chinese character in a line sends the whole line to it.

## Controls

| Want to | Do this |
| --- | --- |
| Turn all read-outs off or on | *Hooks and Usage* page, **TTS hooks** toggle (`ttsEnabled` in `~/.dsh/tts/settings.json`, takes effect on the next alert, no restart) |
| Cut the line that is playing | **Ctrl+Alt+M** (needs `tts-stop-hotkey.exe` in `hotkeyDir`; the plugin starts it when it is installed there). With voice control on, "stop" or pressing Ctrl+Alt+V stops a Task-list read-aloud |
| Mute without touching settings | Create or delete `~/.dsh/tts/tts-muted.flag`. `scripts/tts-mute-toggle.ps1` does that and also stops the current line, but run it with the plugin's state dir: `$env:DSH_TTS_STATE_DIR = "$HOME\.dsh\tts"; .\scripts\tts-mute-toggle.ps1` (its default is `%TEMP%\dsh-tts`, which the plugin does not look at) |
| Speak faster or slower | `ttsSpeed` in `config.local.json` (1.0 is the server's normal rate; 1.2 is a common choice). Restart the DSH server |
| Have the Task list read a card | The **Read aloud** button on a card, or by voice: "read first item", "read it again", "next", "stop". It follows the mute flag |

## Settings reference

Set in `~/.dsh/tts/config.local.json` (wins over [cordis.patch.yml](../cordis.patch.yml)); restart the DSH server after a change.

| Key | Meaning | Default |
| --- | --- | --- |
| `ttsUrl` | Kokoro endpoint | `http://127.0.0.1:8880/tts` |
| `ttsServerScript` | Script launched hidden when nothing listens on `ttsUrl` | none (server must already run) |
| `hotkeyDir` | Folder with `tts-stop-hotkey.exe` (stop flag, `audio.pids`) | `~/.claude` |
| `ttsSpeed` | Speaking rate sent to the server | the server's own (1.0) |
| `ttsAlertsViaWorker` | `false` goes back to one PowerShell launcher script per alert (slower, kept as a fallback) | on |
| `skipSubagents` | Do not speak for subagents | `true` |

Runtime toggle (page, no restart): **TTS hooks** (`ttsEnabled`, default on).

## Files and logs

All state is in `~/.dsh/tts/`:

| File | What it is |
| --- | --- |
| `settings.json`, `config.local.json` | runtime toggles, machine-specific config |
| `tts-muted.flag`, `tts-stop.flag` | mute and stop flags |
| `tts-cache/` | cached WAV phrases |
| `tts-failures.log` | a line that could not be spoken (server down, bad response) |
| `tts-client-errors.log` | server start attempts, hotkey listener starts, client errors |
| `voice.log` | JSON lines for the alert and voice-control flow (`type: "alert"` entries: `dropped-expired`, held and replayed alerts) |

## Troubleshooting

- **Silence.** Check in order: **TTS hooks** is on; `tts-muted.flag` does not exist; the server answers (`Invoke-RestMethod http://127.0.0.1:8880/docs` or a test `POST /tts`); `tts-failures.log` and `tts-client-errors.log` for the reason. After a failed server start alerts stay skipped for 60 s.
- **Long wait before the first alert after boot.** The Kokoro server loads its model on start (about a minute on a cold start); the plugin waits for it up to the start-wait limit above.
- **The wording is the old "Done on: Session…" but you expected "Item N".** The item was not in the Task list when the alert fired (list empty, queue plugin not loaded, item hidden as not actionable, or the queue captured it a moment later). Not an error.
- **Ctrl+Alt+M does nothing.** `tts-stop-hotkey.exe` is not in `hotkeyDir`, or its listener is not running (the plugin tries the `TtsStopHotkey` scheduled task, then the exe).
- **Works in Claude Code but not in DSH (or the reverse).** They are separate hook setups. This plugin only speaks for DSH sessions; the Claude Code hooks (`tts-send.exe`) live in the Kokoro project.
- **Changed a server-side file and nothing happened.** Plugin `.js` files load at DSH server start; restart the server. Only `lib/client.js` changes need just a browser refresh.

## Related

- [voice-two-stage-flow.md](voice-two-stage-flow.md): voice control (Ctrl+Alt+V), confirmations, task-list commands.
- [Task list voice spec](../../dsh-review-queue/docs/voice-task-list.md): read, reply, approve by voice; alert positions.
- [README](../../README.md): install, deploy, full settings.
