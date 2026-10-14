# dsh-review-queue

A review queue for DeepSeek Harness (called the **Task list** on screen and by voice). It collects what is waiting on you from **every session** in one oldest-first list:

- **Done**: a session finished a turn. The card has a task title (written by the model from your request and the reply; the session name sits underneath), a short summary and the full reply one click away. *Send reply* (the default button; Enter in the box sends, Shift+Enter is a new line) continues that session; *Reviewed* just clears the item.
- **Question**: an `ask_user_question` is open. Answer it from the card (pick an option or type your own). Questions with a timeout expire into *Resolved* with the recommended option taken. An expired question stays answerable from *Resolved* (*Answer now (late)*): picking the option the assistant already took is only recorded as confirmed; a different answer is steered into the session if it is still live.
- **Permission**: a tool needs approval. *Approve* or *Deny* from the card.

**Two filter rules.**
- *Done messages with nothing for you are not listed.* The summary step also judges whether the message holds anything to follow up, decide or do by hand. A plain "renamed the helper, 120 tests pass, committed" is moved straight to *Resolved* ("Hidden: nothing for you to do", the tooltip shows its summary, *Reopen* brings it back, a log line records it). A question, a choice, a failure or blocker, a manual step, a request to review/approve/test or an open next step is never hidden: the model may only say no, a keyword/question-mark guard overrides it, and an unsure answer, a model failure or timeout all mean the item is shown. The card appears first and vanishes within a few seconds when the verdict is no.
- *A question you answered in its own session leaves the list immediately.* The plugin watches that session: your reply to the question (or any plain message you send there), or the question's tool call returning, resolves the item as "Answered in the session" on the next snapshot, and an expired question answered there no longer offers a late answer. Answering from the card works as before; a question pending in another session stays. Details and edge cases: [docs/spec.md](docs/spec.md) ("Task-list filter rules").

**Working through the queue:** the next card is selected automatically after you send, review, answer, approve or deny; keyboard `j`/`k` or ↑/↓ move, `r` reads aloud, `e` marks reviewed, `Shift+A` / `Shift+D` approve or deny (Shift so it cannot happen by accident), Esc closes. A filter bar (type chips and text search) appears once there are more than a few items. Unsent replies and half-picked answers survive a reload. Permission cards show the full command, warn about risky ones (recursive delete, force push, hard reset, git clean, piping a download into a shell, elevation, disk tools, writes outside the workspace) and offer *Approve all N identical* (same session, tool and command; never for a risky one). A newer result from the same session replaces its older unreviewed ones (they go to Resolved); *Reopen* in Resolved brings back a misclicked *Reviewed* or a replaced result. Full replies are shown as formatted text, and whether a reply's *Full reply* section (and a card's expanded state) is open is remembered per item across closing and reopening the overlay and across reloads, and reading aloud stops when you close the overlay, open a session, or the item leaves the queue.

The queue is global, so it is an **overlay only** (the right sidebar is per session and is not used). A round-check button in the session header, just left of the right-sidebar button, opens it; Esc, the Close button or the button again closes it, and it closes by itself 15 seconds after the last waiting item is gone (only when the list went from non-empty to empty while it was open, and not if something is waiting again by then). *Open session* jumps to the item's session. **▶ Read aloud** on every card speaks the whole message (the full reply of a done item, not the summary; the question with its options; the permission with its reason) and becomes **■ Stop reading**; it uses the dsh-hooks-tts speech stack, so it follows the TTS mute switch (a muted voice is refused with a message), never overlaps an alert and the Ctrl+Alt+M hotkey stops it. Resolved items are kept for 7 days.

**Hotkey:** `Ctrl+Alt+L` toggles the task list from anywhere in the page (also while typing in a field); `Esc` or the same chord closes it. It is handled in the browser tab, so it needs a page refresh after the plugin updates.

Voice control (read, answer, approve, deny by voice) is a later phase; the plugin already exposes a `reviewQueue` service with speakable text for each item. Besides `snapshot`, `read`, `stop`, `answer`, `approve`, `deny`, `reply`, `markReviewed` it has `count()` (`{total, byType:{question, permission, completed}}`, open items only), `first()` (the oldest open item), `readPosition(n)` (reads the open item at 1-based position n and focuses it; errors `empty`, `no-item`), `again()` (reads the last item read once more; `nothing-read`) and `uiCommand('show'|'hide')`. The text of a read is `"Item N."` as a chunk of its own followed by body chunks that do not depend on the position, so the speech cache hits at any position.

## Todo: start a session from the list

Add a task here and rely on the list for everything after it. **+ New todo** (task list header, next to *Resolved*) opens a small form: the task (several lines; Ctrl+Enter or *Add todo* submits), a workspace dropdown (*Choose for me* by default, then every workspace by title) and a *Use SPARC* checkbox (off by default). Esc closes the form first, then the list.

- **Workspace given:** the session is created at once, with no confirmation. The card shows *Starting...* and moves to *Resolved* as "Started in <workspace> (in the background)".
- **Choose for me:** nothing is ever created before you confirm. The plugin suggests a workspace: first the one whose title or folder name appears in the task as a whole word (any case, a unique match wins; "named in the text"), else a pick by the cheapest LLM (the same service as the summaries; it sees the task, the workspaces and a few recent session titles; 15 s limit; an unknown id or any failure means no suggestion). The *Todo* card then reads "Start in <workspace> - <reason>" (or "Pick a workspace" with no suggestion) and offers **Start**, **Change workspace** (the dropdown) and **Cancel**. Enter does not start it, and Shift+A, Shift+D and e do nothing on a todo.
- **Started in the background:** the session is created like the handoff follow-ups are (create, rename to the first line of the task, at most 60 characters, then the task as its first prompt, queued). It is not focused and not opened. Its questions, permission requests and "done" results reach this list like any session's, so the list is the only place you need to watch.
- **Open session:** a started card has an *Open session* **button** (also while it is still starting). It never opens by itself.
- **Use SPARC:** the first prompt is the task, then the /sparc flow instructions and the text of ~/.claude/commands/modes/sparc.md (config sparcCommandPath), the same convention as the handoff resume of dsh-hooks-tts. Without the file it asks the session to invoke the modes:sparc skill.
- **Failed:** the card is still waiting and shows the error with **Retry** and **Cancel**. Retry starts it again; a session that was already created is reused, not duplicated. A todo that was *starting* when the server restarted comes back as failed.
- **Counting:** a todo counts as waiting while it needs you (waiting for confirmation, or failed), not while it is starting. Voice reads it as "Todo: <task>, start in <workspace>?"; answering a todo by voice is not built yet.

Service for other plugins (ctx.get('reviewQueue')): addTodo(text, { workspaceId?, sparc? }) returns { ok, id, state } at once (the session or the suggestion is worked out in the background), confirmTodo(id, { workspaceId? }) (also Retry), cancelTodo(id), workspaces(). A todo is an item { type: 'todo', text, sparc, state, workspaceId?, workspaceTitle?, suggested?: { workspaceId, title, reason }, suggesting?, error?, sessionId? } with state awaiting-confirm, starting, started (resolved), failed or cancelled (resolved).

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
| `sparcCommandPath` | ~/.claude/commands/modes/sparc.md | The modes:sparc command text a *Use SPARC* todo puts in the new session's first prompt. |
| `dev` | off | `true`, or env `DSH_REVIEW_QUEUE_DEV=1`, enables `POST /v1/dev/ask` which creates fake items (testing only; never enable in a real profile). |

## HTTP API

Served on the DSH web server under `/review-queue` (same host/origin fence and cookie auth as the rest of the web UI). JSON only.

| Route | Method | Body | Notes |
| --- | --- | --- | --- |
| `/v1/snapshot` | GET | query `since=<snapshotId>|<focusId>|<readingId>|<uiSeq>`, `wait=<ms>` | Open and resolved items, `snapshotId`, `serverNow`, `reading`, `ui`; every item has a `title`. With `since` it long-polls up to 25 s and answers `{unchanged:true, snapshotId}` if nothing changed, including the ui command sequence. Missing trailing parts mean none (ui seq 0), so a token from before `uiSeq` existed only matches while no ui command has been given and otherwise gets a full snapshot. |
| `/v1/answer` | POST | `{id, answers:[{id, selected:[...], custom?}]}` | Answers an open question. |
| `/v1/late-answer` | POST | `{id, answers:[{id, selected:[...], custom?}]}` | Answers an expired question. Same as the recommended option: recorded as `confirmed`, nothing sent. Different: sent into the session (`late-answered`). |
| `/v1/approve`, `/v1/deny` | POST | `{id}` | Permission items. |
| `/v1/reviewed` | POST | `{id}` | Done items only. |
| `/v1/reply` | POST | `{id, text}` | Done items only; queues the text as a prompt to that session. |
| `/v1/read` | POST | `{id}` | Reads the item's whole message aloud (any item, open or resolved). Errors: `muted`, `no-speaker`, `nothing-to-read`, `not-found`. The snapshot's `reading` is the id being read. |
| `/v1/stop` | POST | `{}` | Stops reading. |
| `/v1/ui` | POST | `{cmd:'show'|'hide'}` | Asks every open browser to show or hide the overlay (voice uses it). `{ok:true, seq}`; anything else is 400 `bad-command`. See below. |
| `/v1/reopen` | POST | `{id}` | Done items resolved as reviewed, superseded or hidden as no-action only (`not-reopenable` otherwise). |
| `/v1/approve-similar` | POST | `{id}` | Approves the permission request and identical open ones of the same session; `{ok, count}`; `risky` is refused. |
| `/v1/todo` | POST | {text, workspaceId?, sparc?} | Adds a todo. {ok, id, state}: starting with a workspace (the session is created in the background), else awaiting-confirm. 400: empty, too-long (4000), unknown-workspace; 409 no-registry. |
| `/v1/todo-confirm` | POST | {id, workspaceId?} | Starts (or retries) a todo in workspaceId, else the given or suggested one. 400 no-workspace, unknown-workspace; 409 not-open, not-todo, not-confirmable. |
| `/v1/todo-cancel` | POST | {id} | Cancels a todo that waits (or failed); nothing is created. |
| `/v1/workspaces` | GET | | {workspaces: [{id, title}]} for the dropdowns. |
| `/v1/focus` | POST | `{id}` or `{id:null}` | Shared selection (screen and voice follow it). |

**UI command.** The snapshot carries `ui: { seq, cmd }` (`cmd` is absent until the first command; `seq` starts at 0 per server run and goes up by one per command). A browser tab applies a command only when its `seq` is newer than the last one that tab has seen, never on its first snapshot (a tab opened later uses its own saved open/closed state), and never twice for the same `seq`. It uses the same function as the header button, so the per-browser open/closed state in localStorage still follows. The command wakes waiting long-polls.

Answers: 200 `{ok:true}`; 400 for bad input (`bad-answer`, `bad-decision`, `empty`, `too-long`); 409 when it cannot apply now (`not-open`, `not-completed`, `no-controller`, `not-expired`, `no-session` (the session is no longer live, e.g. after a restart), `not-pending` (the assistant no longer waits on that question), `reply-queued`, or the host's error); 413/415 for body size/type.

## Limits

- Request body 64 KB; reply text 4000 characters; stored text per field 20,000 characters.
- Resolved items are pruned after 7 days (hourly).
- Summaries use the host's LLM service when available and fall back to the last paragraph of the reply. The same call gives the `ACTIONABLE` verdict; without it nothing is ever hidden.

## Develop

`npm test` in this folder (Node's built-in test runner). Design and decisions: [docs/spec.md](docs/spec.md).
