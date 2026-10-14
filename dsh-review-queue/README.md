# dsh-review-queue

A review queue for DeepSeek Harness. It collects what is waiting on you from **every session** in one oldest-first list:

- **Done**: a session finished a turn. The card has a task title (written by the model from your request and the reply; the session name sits underneath), a short summary and the full reply one click away. *Send reply* (the default button; Enter in the box sends, Shift+Enter is a new line) continues that session; *Reviewed* just clears the item.
- **Question**: an `ask_user_question` is open. Answer it from the card (pick an option or type your own). Questions with a timeout expire into *Resolved* with the recommended option taken. An expired question stays answerable from *Resolved* (*Answer now (late)*): picking the option the assistant already took is only recorded as confirmed; a different answer is steered into the session if it is still live.
- **Permission**: a tool needs approval. *Approve* or *Deny* from the card.

**Working through the queue:** the next card is selected automatically after you send, review, answer, approve or deny; keyboard `j`/`k` or ↑/↓ move, `r` reads aloud, `e` marks reviewed, `Shift+A` / `Shift+D` approve or deny (Shift so it cannot happen by accident), Esc closes. A filter bar (type chips and text search) appears once there are more than a few items. Unsent replies and half-picked answers survive a reload. Permission cards show the full command, warn about risky ones (recursive delete, force push, hard reset, git clean, piping a download into a shell, elevation, disk tools, writes outside the workspace) and offer *Approve all N identical* (same session, tool and command; never for a risky one). A newer result from the same session replaces its older unreviewed ones (they go to Resolved); *Reopen* in Resolved brings back a misclicked *Reviewed* or a replaced result. Full replies are shown as formatted text, and reading aloud stops when you close the overlay, open a session, or the item leaves the queue.

The queue is global, so it is an **overlay only** (the right sidebar is per session and is not used). A round-check button in the session header, just left of the right-sidebar button, opens it; Esc, the Close button or the button again closes it. *Open session* jumps to the item's session. **▶ Read aloud** on every card speaks the whole message (the full reply of a done item, not the summary; the question with its options; the permission with its reason) and becomes **■ Stop reading**; it uses the dsh-hooks-tts speech stack, so it follows the TTS mute switch (a muted voice is refused with a message), never overlaps an alert and the Ctrl+Alt+M hotkey stops it. Resolved items are kept for 7 days.

Voice control (read, answer, approve, deny by voice) is a later phase; the plugin already exposes a `reviewQueue` service with speakable text for each item.

## Install

```
dsh plugin --profile <p> add "link:D:/dev/ai/dsh-plugins/dsh-review-queue"
```

(From a DSH source checkout run it as `pnpm dsh plugin --profile <p> add ...`.) Restart the DSH server and refresh the browser page. Remove it with `dsh plugin --profile <p> remove dsh-review-queue`.

## Config

Set in the plugin's `config` (see `cordis.patch.yml`); all optional.

| Key | Default | Meaning |
| --- | --- | --- |
| `stateDir` | `~/.dsh/review-queue` (`$DSH_HOME/review-queue`) | Where `queue.json` is kept. If unusable the queue works but is not persisted. |
| `ttsClient` | `../dsh-hooks-tts/scripts/tts-client.ps1` | Path of the TTS client script the play button uses. |
| `voice` | `male` | `male` or `female` voice for the play button. |
| `dev` | off | `true`, or env `DSH_REVIEW_QUEUE_DEV=1`, enables `POST /v1/dev/ask` which creates fake items (testing only; never enable in a real profile). |

## HTTP API

Served on the DSH web server under `/review-queue` (same host/origin fence and cookie auth as the rest of the web UI). JSON only.

| Route | Method | Body | Notes |
| --- | --- | --- | --- |
| `/v1/snapshot` | GET | query `since=<snapshotId>[|<focusId>]`, `wait=<ms>` | Open and resolved items, `snapshotId`, `serverNow`, `reading`; every item has a `title`. With `since` (`<snapshotId>|<focusId>|<readingId>`) it long-polls up to 25 s and answers `{unchanged:true}` if nothing changed. |
| `/v1/answer` | POST | `{id, answers:[{id, selected:[...], custom?}]}` | Answers an open question. |
| `/v1/late-answer` | POST | `{id, answers:[{id, selected:[...], custom?}]}` | Answers an expired question. Same as the recommended option: recorded as `confirmed`, nothing sent. Different: sent into the session (`late-answered`). |
| `/v1/approve`, `/v1/deny` | POST | `{id}` | Permission items. |
| `/v1/reviewed` | POST | `{id}` | Done items only. |
| `/v1/reply` | POST | `{id, text}` | Done items only; queues the text as a prompt to that session. |
| `/v1/read` | POST | `{id}` | Reads the item's whole message aloud (any item, open or resolved). Errors: `muted`, `no-speaker`, `nothing-to-read`, `not-found`. The snapshot's `reading` is the id being read. |
| `/v1/stop` | POST | `{}` | Stops reading. |
| `/v1/reopen` | POST | `{id}` | Done items resolved as reviewed or superseded only (`not-reopenable` otherwise). |
| `/v1/approve-similar` | POST | `{id}` | Approves the permission request and identical open ones of the same session; `{ok, count}`; `risky` is refused. |
| `/v1/focus` | POST | `{id}` or `{id:null}` | Shared selection (screen and voice follow it). |

Answers: 200 `{ok:true}`; 400 for bad input (`bad-answer`, `bad-decision`, `empty`, `too-long`); 409 when it cannot apply now (`not-open`, `not-completed`, `no-controller`, `not-expired`, `no-session` (the session is no longer live, e.g. after a restart), `not-pending` (the assistant no longer waits on that question), `reply-queued`, or the host's error); 413/415 for body size/type.

## Limits

- Request body 64 KB; reply text 4000 characters; stored text per field 20,000 characters.
- Resolved items are pruned after 7 days (hourly).
- Summaries use the host's LLM service when available and fall back to the last paragraph of the reply.

## Develop

`npm test` in this folder (Node's built-in test runner). Design and decisions: [docs/spec.md](docs/spec.md).
