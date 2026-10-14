# Task list by voice: spec and plan (2026-10-13 grilling)

Status: DRAFT, awaiting the user's go-ahead. The review queue is the user's primary way into DSH, so this area must be reliable before it is rich. Builds on [docs/spec.md](spec.md) "Voice control" and dsh-hooks-tts/docs/voice-two-stage-flow.md. Work happens in the main tree on develop (voice open-issue pass already committed as 135cea3). Reviews are skipped by the user's instruction for this task; tests are not.

## Decisions (from the user)
| Topic | Decision |
|---|---|
| Name | Voice says "task list"; also accepts "queue", "review list", "review queue", "to-do list". UI labels are renamed to "Task list". |
| Read-only commands | Recognised by exact phrases in code, run at once: no echo, no LLM, no "yes". Unmatched speech falls back to the existing LLM flow. After acting they speak a short outcome line instead of an echo. |
| Read text | The same text the card's play button reads (fullTextFor), so Kokoro's cache hits. "Item N." is its own chunk so the body chunks hit even when the position changed. Nothing is said before the read starts. |
| Reply scope | Done, question and permission items. |
| Reply confirmation | One read-back, no separate echo step. Yes sends; any other speech replaces the whole prompt; "cancel" aborts. |
| Show / hide | localStorage stays the per-browser memory of open/closed. Voice broadcasts a one-shot command through the queue's existing long-poll; each open browser applies it once and stores the result. A tab opened later uses its own saved state. |
| After a reply | "Task <title>, reply sent. N waiting." and stop. |
| Extra commands in this round | stop reading, read again / repeat, open the first item's session, read item N / next. (Mark reviewed by voice: not now.) |
| Alerts | New-item alerts say the queue position ("Item three, done in dsh-plugins."). |
| Multi-question items | Voice walks through each sub-question. |
| Item changed while dictating | "That item changed. Nothing done." (frozen item id + snapshotId, checked at the yes). |

## Spoken lines
- Show: "Task list showing." Hide: "Task list hidden."
- Count: "Three waiting: one question, one permission, one done." or "Nothing waiting."
- Read first / again / item N / next: starts reading, no lead-in. Empty list or no such item: "Nothing waiting." / "There is no item N."
- Stop: stops at once, no line.
- Open: "Opened <title>." Reply sent: "Task <title>, reply sent. N waiting." Answered: "Task <title>, answered. N waiting." Approved/denied: "Task <title>, approved. N waiting."
- Errors, one short sentence naming the reason: "That item changed. Nothing done.", "Speech service unavailable.", "That is too long to confirm by voice.", "That request is too long or unclear to approve by voice. Answer it on screen."

## Design
### Host half (dsh-review-queue)
- service: `count()` ({ total, byType }), `first()`, `readPosition(n)`; `uiCommand('show'|'hide')` increments `uiSeq` and puts `{ seq, cmd }` in the snapshot, and the long-poll token includes it so a command wakes waiting browsers.
- speech.js: the lead "Item N." becomes its own chunk (chunkForSpeech/fullTextFor), shared by the play button, the voice read and the alert path, so all three hit the same cache entries.
- client: applies a `uiCommand` only when its seq is newer than the last one this tab saw and not on first load, then writes its localStorage state. Labels renamed to "Task list".
- Reply paths for voice reuse `reply`, `answer`, `approve`, `deny`, each with the frozen id + snapshotId.

### Voice half (dsh-hooks-tts)
- `voice/queue-commands.js` (pure): phrase table to an intent ({ kind: 'show'|'hide'|'count'|'read'|'again'|'stop'|'open'|'reply', n? }). Tolerant of STT noise ("the task list", "show me the task list", "how many items", "read the first item", "reply to the first item").
- flow.js: before the echo step, an utterance that matches runs through the fast path (execute, speak the outcome line, end). A reply intent starts REPLY_DICTATE (listen window, no echo), then REPLY_CONFIRM (read-back; classifyAnswer for yes/cancel; other speech replaces the text, same limits and sanitising as a prompt: 1500 chars, speakableText). Question items: "option two", "recommended" or free text, one sub-question at a time, then a single read-back of all answers. Permission items: "approve" / "deny" with the existing approval rules (complete summary read in full, otherwise answer on screen).
- service wiring: the flow gets the queue from `ctx.get('reviewQueue')`; with no queue present nothing changes.
- Reading is a separate process (reader.js). The voice hotkey and "stop" cancel it so the open mic never hears it. voice.log records each queue intent (matched phrase, outcome).
- Alerts: the headline uses the item's queue position when the item is already in the queue, else the old session number.

## Slices (TDD, each RED then GREEN, full suite after each)
1. Queue service + speech: count, first, readPosition, uiCommand and snapshot seq, chunked lead (review-queue tests). **DONE 2026-10-13** (plus `again()`, `POST /v1/ui`; see Implementation notes).
2. Client: apply uiCommand once, rename labels (client tests). **DONE 2026-10-13**.
3. Phrase matcher (large table test incl. STT variants and negatives).
4. Flow fast path: show/hide/count/read/again/stop/open with outcome lines, wired to the queue service.
5. Reply: done items (dictate, read-back, replace, cancel, stale, too long, queue unavailable).
6. Reply: permission, then question incl. multi-question.
7. Alerts by queue position.
8. Docs + dev-route end-to-end check; live test needs a DSH restart (voiceControl on, hotkey ctrl+alt+v, read ~/.dsh/tts/voice.log).

## Reliability checklist
- Every path ends with a spoken line or a deliberate silence; nothing waits forever (listen windows, execute timeout inherited from the flow).
- The queue unavailable, empty, or changing under the user always says so.
- No second action path: replies and answers go through the card's service calls.
- Fast-path phrases never match inside dictated reply text (the dictation step does not run the matcher).

## Implementation notes (slices 1 and 2, differences from the design above)
- `POST /v1/ui {cmd}` is the route behind `uiCommand`; the snapshot carries `ui: { seq, cmd }`. The long-poll token is now `<snapshotId>|<focusId>|<readingId>|<uiSeq>`; a missing 4th part counts as 0, so an old three-part token only matches while no ui command was given, otherwise it gets a full snapshot.
- `uiSeq`/`uiCmd` are module-level (survive a queue re-created in one server run). The tab also resyncs without acting when it sees a lower seq (server restarted).
- `again()` and `readPosition(n)` return `{ ok:true, id }`. `readPosition` focuses the item before reading, so the focus moves even when the read then fails (muted, no speaker); errors: `empty` (nothing waiting), `no-item` (n not an integer in range), else the read error. `again` errors with `nothing-read` (also when the item left the open list). A failed read is not remembered as the last read.
- speech: `fullTextFor(item, n)` is `"Item n.\n\n" + body`; `chunkForSpeech` turns a leading "Item N." paragraph into its own chunk and chunks the rest independently, so body chunks (and the early-start limit) are identical at every position and without one. `spokenFor(item, n)` also returns `lead` and `body`; `headline` keeps the old one-line shape ("Item 3. Done in X: ...") and has no "Item" when there is no position.
- The client labels now say "Task list" (header button, overlay heading and aria label, slot label, unreachable banner); identifiers, CSS classes, storage keys and routes are unchanged.
