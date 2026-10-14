# dsh-review-queue: spec (from the 2026-10-13 grilling)

> **Revision 2026-10-13 (supersedes the sidebar-tab parts below):** the queue is **overlay only**. The right sidebar is per session, so there is no Review tab, no persistence flag and no sidebar-right dependency. The overlay is opened by a button in the session header's utilities slot (`conversation.session.header.utilities`, order 1000, so it sits just left of the right-sidebar button). The overlay itself is one root on `document.body`; state is a single module-level store. Wherever this spec says "sidebar tab", "persistent tab" or "floating anchor button", read "the header button and the overlay".


A **Review** tab in the DSH right sidebar (sibling of dsh-git-view): the user's to-do list of AI work waiting on them. Tab shows a count badge.

## Items (all sessions, all workspaces), sorted by time ascending (oldest first)
- **Completed**: session finished a turn. Card shows session title, workspace/worktree, finish time, an LLM-written 2-3 line summary of what was done (cheapest available DSH model, generated once and cached; falls back to the last paragraph of the reply on failure); full reply behind the expander.
- **Question**: pending ask_user_question. Card shows the full question, all choices with the recommended one marked, time left, and what happens at expiry. Answerable from the card (option buttons).
- **Permission**: pending approval ("Approve write file?"), showing tool and arguments, with Approve/Deny. Never expires or auto-resolves; stays until answered or the session ends; shows its age.

## Persistent view (added after the grilling)
The Review tab must stay visible when the user switches sessions; they must never have to re-open it per session.
- Finding: DSH right-sidebar tabs are per session (the sidebar-right `inject(sessionId)` / `controller.openTab(kind, options)` in packages/client/ui-sidebar-right), so a normal tab like Git has to be opened again in every session.
- Design: the plugin keeps a global "Review tab wanted" flag (localStorage, default on once the user opens it the first time). Whenever the selected session changes and has no Review tab, the client opens one through the sidebar-right openTab API (kind = the Review tab kind, without stealing focus from the session's other tabs). Closing the tab by hand clears the flag; re-opening it from the guide sets it again.
- Tab content, expanded cards and scroll position live in one module-level store shared by every session's tab instance (not component state), so switching sessions shows the same list with nothing collapsed or reset.
- Verify at build time which client hook gives the selected-session change and whether openTab can be called from a plugin (ctx.sidebarRightTabs is register-only in dsh-git-view); if not exposed, fall back to a small shim or a DSH change.

## Two surfaces, one list (added after the grilling)
The same queue is shown in two places:
1. **Sidebar tab** (persistent across sessions, see above).
2. **Full-screen overlay**: a container that overlaps the whole app, opened and closed by an **anchor button**, so the task list can use all the screen space.
- Anchor button: a small always-visible floating button (right edge, vertically centred, clear of the bottom-right TTS status pill) showing the waiting-count badge. Click toggles the overlay; Esc or the button closes it; a configurable shortcut is added later.
- The overlay is global, not bound to a session, so switching sessions never closes or resets it. Its open/closed state is remembered across page refreshes.
- Wide layout: master-detail. A compact list on the left (same ascending order), the selected item's full detail on the right (whole question with all options, full reply, summary, reply box). Below a width threshold it falls back to the single-column card list.
- It reuses the same list component, store and API as the sidebar tab; only the container differs. Expanded/selected state is shared, so an item expanded in the sidebar is expanded in the overlay.
- **Open session** closes the overlay (unless pinned open) and jumps to the session.
- Mounting follows the precedent in dsh-hooks-tts/lib/client.js: a host element on document.body rendered with React createRoot, fixed position, high z-index but below DSH modals, themed with the page's light/dark class.
- Voice: "open the queue" / "close the queue" are read-only navigation commands (queue_show / queue_hide), run immediately; "read item two" works with either surface open.

## Card
- Revision 2026-10-13 (b): auto-advance after an action, keyboard shortcuts, filter bar, draft persistence, risk warnings and Approve-all-identical on permission cards, supersede of older done items from the same session (Reopen from Resolved), markdown rendering of full replies, read-aloud stops with the overlay or when the item leaves the queue. See README.
- Revision 2026-10-13 (c): when the waiting list goes from non-empty to empty while the overlay is open, it closes after 15 s unless an item is waiting again at that point (cancelled by a new item, a manual close or open-session; an overlay opened on an already empty queue stays).
- Revision 2026-10-14 (d): two list-keeping rules, see "Task-list filter rules" below.
- Each card has a **task title** (completed items: LLM title from the user's request and the reply, fallback request/first sentence; question: header or question; permission: tool summary) and shows the session title and workspace under it (revision 2026-10-13).
- **Send reply** is the primary button of a done card (Enter sends); **Reviewed** is secondary. **Read aloud** speaks the full message through the dsh-hooks-tts client; one read at a time, Stop kills it.
Roomy, collapsed by default, expands for more detail, **Open session** button jumps to the session.

## Leaving the queue (status = completed)
- Question: answered by the user, or expired and the recommended option was auto-selected (record which option).
- Late answers (added 2026-10-13): an expired question stays answerable from Resolved. If the late answer equals the recommended option the assistant already took, it is only confirmed (resolution `confirmed`, nothing sent). If it differs, it is steered into the live session through `userQuestions.answer(agent, callId, {answers})` and recorded as `late-answered`. After a restart or when the session is gone the answer cannot be delivered (`no-session`).
- Completed: user clicks **Reviewed**, or sends a follow-up message from the card's reply box.
- Permission: Approve/Deny, or session ends.

## Task-list filter rules (revision 2026-10-14)

### Rule 1: a done message with nothing for the user is not listed
- **Verdict, at capture time.** The summary LLM call that already writes TITLE and SUMMARY for a done item also answers `ACTIONABLE: yes|no` (summary.js; the prompt says no only for a plain report of finished work, "when in doubt answer yes"). The verdict is stored on the item as `actionable` (true/false; absent = no verdict).
- **Conservative by construction.** Only an explicit `no` hides. Missing line, unreadable value, model failure, timeout, no LLM service, or a fallback summary all give no verdict and the item stays. On top of the model, `actionable.js` (`needsUser`) is a one-sided code guard: when the reply (code blocks and inline code ignored; "0 failures", "no errors" ignored) contains any question mark, a request or choice ("please", "which one", "let me know", "you need/should/can"), a failure or blocker word, a manual step ("restart", "by hand", "test it"), a request to review, approve or confirm, or an open next step ("next step", "todo", "remaining", "not yet"), a model `no` is overridden to `yes` (and logged). The guard can only keep an item, never hide one.
- **How it is hidden and found again.** The item is created and shown at once as before (the card never waits for the model); when a `no` verdict arrives while it is still open, it is resolved as `{kind:'no-action', by:'auto'}` and moves to **Resolved** (kept 7 days) with its title and summary; the Resolved line says "Hidden: nothing for you to do", its tooltip shows the summary, and **Reopen** puts it back (`reopen` accepts `no-action`). Each hiding writes a log line `review-queue: capture: hid done item "<title>" (no action needed): <summary>`; a guard override writes `summary: kept a done item the model called no-action ...`. Trade-off: because the card is not held back, a hidden item can show for the second or so the model needs, then disappears (holding every done card for the model call was rejected: it delays every real item and a failed model would have to be waited out).
- **Edge cases.** An item the user already reviewed, replied to or that was superseded before the verdict arrives keeps that resolution (the hide is a no-op). A newer done item from the same session replaces older unreviewed ones; if the newer one is then hidden, the items it replaced are reopened (the supersede resolution records `newerId`), because the older message may be the one that needs the user. `count()`, `first()` and voice only see open items, so hidden ones are never read.

### Rule 2: a question handled in its own session leaves the list at once
- **How questions are tracked.** DSH shows the card for a pending `ask_user_question` via the `user-questions/request` waterfall; the plugin wraps it. When the user answers on the on-screen card, the wrapped `next()` settles and the item is resolved `answered by screen` (already the case). The gap was everything that settles the question without going through that promise while the item is still listed: the user replies in the session itself (the late-reply path of a timed question, or free text), or the wait ran out and the question was answered later in the session.
- **Signals used (all host side, no timeout).**
  1. `session/event` `user/message` with source `user-question-reply` and the question's `callId`: DSH's own record that the question was answered. Open item: resolved `{kind:'answered', by:'session', answers}`. Expired item (it sits in Resolved offering a late answer): re-labelled `answered by session`, keeping `assumed`, so no late answer is offered any more.
  2. `session/event` `tool/result` for the question's call id while the item is still open: the call returned. A pending payload (`{pending:true}`) means the wait ran out and the item expires like a timeout (recommended option noted); anything else resolves it `answered by session`. This also covers the legacy blocking schema, which the DSH `userQuestions` projection does not track.
  3. `agent/pre-step` (the handler that already resolves done items): a claimed message that is a reply to this question, or a plain user message (source `user` or none, not injected context such as time or instruction messages), resolves the open question items of that session.
- **Matching.** Always by session id and, for 1 and 2, the call id, so a question of another session (even with the same call id) or another question of the same session stays. Only questions of that session are touched in 3.
- **Not disturbed.** The request promise stays DSH's to settle: a session-resolved item is dropped from the card-answerable set (`answerQuestion` then says `not-pending`) but `next()` and abort still flow through untouched. Answering from the card works exactly as before: the item is resolved first, later events find it settled. A late answer sent from the card is shielded while it is in flight (its own reply event must not re-label it `late-answered`).
- **Other item types.** Permission items: an approval already settles through the same wrapped waterfall when answered on screen, and a plain user message does not decide a permission, so no session signal is added. Done items are already resolved by the user continuing the session (`replied by session`) and by the card; unchanged.
- **Edge cases.** A question still pending in another session is untouched. If the plugin's session ids differ from the agent ids the matching simply never fires (items then end by answer, expiry or session end as before). Events from a session the plugin does not receive (not loaded yet) cannot help; after a restart open questions are cancelled anyway.

## Persistence
Survives server restarts. Resolved items kept in a collapsed **Resolved** section for 7 days, then deleted.

## Build notes
- Name dsh-review-queue; structure and install flow like dsh-git-view (package.json dsh.client inject sidebar-right, cordis.patch.yml, index.js, lib/client.js, tests).
- Feasibility: DSH already projects pending questions (packages/interaction/user-questions: answer_to_pending_question / callId), so card answers should be possible; verify the plugin-side API first. Timeout behaviour is in dsh-hooks-tts/ask.js (timeout = 120 s x question count).
- TDD; server-side files need a DSH restart, client bundle a browser refresh.

## Voice control (designed together; wiring ships later, but the seams ship now)

Builds on the existing two-stage voice flow in dsh-hooks-tts (docs/voice-two-stage-flow.md: echo, LLM decide, deterministic read-back, strict yes, execute) and [[Dsh Voice Control Design Spec]]. Decisions from the user: read-only queries run immediately; items are spoken by queue position; confirmed actions are answer, approve/deny, mark Reviewed, open session.

### Design rules
1. **One source of truth.** The queue's host half owns the item store and exposes a small in-process service (`reviewQueue`) plus the HTTP routes the sidebar uses. The sidebar and voice are both clients of the same service, never separate copies. Voice never reads the DOM.
2. **No second action path.** Permission items reuse the voice approvals registry (`approvals.js` peek/token and the "not-approvable" rule: an approve needs a complete summary of a known tool). Question answers go through the same call the card button uses. Reviewed and Open are service calls too.
3. **Speakable by construction.** Every item carries, besides its card fields: `spoken.headline` (about 15 words, e.g. "Question from dsh-plugins: which port? Options one, two, three."), `spoken.full` (whole question with numbered options, or the 2-3 line completion summary), all passed through sanitize.js (`speakableText`, `spokenName`). The completion summary is written once by the LLM and reused for the card, the voice alert and "read item".
4. **Numbering = position.** Item "one" is the oldest open item (same order as the screen). Numbers shift when an item leaves; the service returns a `snapshotId`, and a mutating voice action freezes the item's real id plus snapshotId. If the item changed or left before the "yes", execution refuses: "That item changed. Nothing done." (same pattern as the approval token).
5. **Read-only runs now, mutations take the two-yes flow.**

### New actions
| Kind | Voice examples | Flow |
|---|---|---|
| `queue_status` | "what's in my queue", "how many waiting" | immediate: "Three waiting: one question, one permission, one done." |
| `queue_read` | "read item two", "next", "repeat", "full text" | immediate: headline first; "full text" speaks `spoken.full` |
| `queue_answer` | "answer item one, option two", "pick the recommended one" | two-yes; read-back says the question and the exact option text |
| `queue_approve` / `queue_deny` | "approve item three" | two-yes, via approvals.js rules (summary read in full) |
| `queue_review` | "item four reviewed" | two-yes |
| `queue_open` | "open item two" | two-yes (cheap, but it switches the screen) |

The decider's SYSTEM prompt and actions.js ACTIONS set get these entries; the queue snapshot (handles q1..qN, type, session title, headline, seconds to expiry) is added to the decider context beside `sessions`. Item text is untrusted data like session titles: sanitised and capped before it enters the LLM payload.

### Alerts and expiry
- A new item triggers the existing terse alert with the queue position: "Item three, question: ...". When several arrive together they coalesce ("Two new: question, done").
- Expiry warning: a question 30 s from timing out is announced once ("Item one expires in 30 seconds, recommended option two"). On expiry the item moves to Resolved and the spoken line says which recommended option was taken.
- Speaking while a flow is active is held, as D7 of the two-stage spec says.

### Seams built in v1 (no voice code yet)
- `reviewQueue` service API: `snapshot()`, `onChange(cb)`, `answer(itemId, optionId, snapshotId)`, `approve/deny`, `markReviewed`, `openSession`, each returning a short error for stale items.
- `spoken` fields generated and cached at item creation, with tests for sanitising and length caps.
- The sidebar uses only this service, which proves the API is enough for voice.
- Selected/targeted item is service state (`focusItemId`), so "read next" and the highlighted card stay in sync, and a voice "read item two" scrolls and expands that card.

### Open for later
- Whether the queue number should replace the session numbers in alerts entirely or sit next to them.
- Hotkey/wake word behaviour is inherited from the voice-control spec; no queue-specific trigger.
