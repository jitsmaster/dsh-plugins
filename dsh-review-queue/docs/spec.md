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
- Each card has a **task title** (completed items: LLM title from the user's request and the reply, fallback request/first sentence; question: header or question; permission: tool summary) and shows the session title and workspace under it (revision 2026-10-13).
- **Send reply** is the primary button of a done card (Enter sends); **Reviewed** is secondary. **Read aloud** speaks the full message through the dsh-hooks-tts client; one read at a time, Stop kills it.
Roomy, collapsed by default, expands for more detail, **Open session** button jumps to the session.

## Leaving the queue (status = completed)
- Question: answered by the user, or expired and the recommended option was auto-selected (record which option).
- Late answers (added 2026-10-13): an expired question stays answerable from Resolved. If the late answer equals the recommended option the assistant already took, it is only confirmed (resolution `confirmed`, nothing sent). If it differs, it is steered into the live session through `userQuestions.answer(agent, callId, {answers})` and recorded as `late-answered`. After a restart or when the session is gone the answer cannot be delivered (`no-session`).
- Completed: user clicks **Reviewed**, or sends a follow-up message from the card's reply box.
- Permission: Approve/Deny, or session ends.

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
