# dsh-session-link

Lets a DSH session find another open session, ask it to do something, and read its last reply. Three tools, available to top-level sessions only (sub-agents are refused):

| Tool | What it does |
| --- | --- |
| `list_sessions` | Lists the other open sessions (id, title, workspace folder, running, last update), newest first, at most 25. An optional `query` of plain words narrows it; case, hyphens and small typos are ignored, and `PR 6681` or `AB#25883` match ticket numbers in titles. The calling session is never listed. |
| `send_to_session` | Asks another session to do something. **Nothing is sent by the call itself**: it creates a follow-up card in the Review Queue and the user confirms or cancels it. |
| `read_session_result` | Reads the last assistant reply of a loaded session, whether its turn is still running, and the state of the cards you sent it. |

## Example calls

```json
{ "tool": "list_sessions", "args": { "query": "review queue tabs" } }
{ "tool": "send_to_session", "args": { "session": "ctnp 25883", "text": "Please re-run the five reviews on the final diff and report the findings.", "mode": "queue" } }
{ "tool": "read_session_result", "args": { "session": "ctnp 25883" } }
```

`session` is an exact session id or plain words. One match: the card is preselected on that session. Several matches: the user picks on the card (the sender is never offered). No match: the call returns the nearest titles (`no-match`).

`mode` is `queue` (default: the message waits for the target's next turn) or `steer` (the message is inserted into the target's running turn at its next step; it does not abort the turn).

## Confirmation model

- `send_to_session` returns at once with `status: "queued-for-confirmation"`. The sender is not told when the user confirms; it checks later with `read_session_result`, which shows the card state (`awaiting-confirm`, `starting`, `started`, `failed`, `cancelled`).
- No message reaches another session without the user's click on the card.
- The delivered message is wrapped in an envelope that names the sending session and says it was written by that session's agent, not typed by the user. The envelope text can be imitated by anyone who can write text into a session, so it is not a security boundary: **the confirmation card is the safeguard.** Messages that already start with an envelope are rejected (`loop-guard`), and the receiving session is told not to answer with `send_to_session` unless the user asks.
- Without the `dsh-review-queue` plugin (or with it disabled) the tool falls back to a blocking approval request and then prompts the target directly. That path needs a single match; several matches return `ambiguous`.

## Limits

| Limit | Value |
| --- | --- |
| Message text | 3500 characters (card text cap 4000 including the envelope) |
| Sends per sender | 5 per minute |
| Waiting cards per sender | 3 |
| Same sender and target | one send per minute (only when a single session matched) |
| Identical waiting message | rejected (`duplicate`) |
| `read_session_result` reply | 4000 characters |

Rejections come back as `{ "status": "rejected", "reason": ... }` (self-send, too long, rate limit, waiting-card cap, duplicate, loop guard, queue full, sub-agent sender, no sender). `no-match` (nothing matched, including archived or unknown sessions) and `ambiguous` are statuses of their own, not rejections.

## Unrestricted read warning

`list_sessions` and `read_session_result` need **no approval** and cover **every workspace** of this DSH app, so a session can read another project's last reply. This is an accepted risk (decided with the user, 2026-11-04) and is stated in the tool descriptions. The reply is returned framed as data ("not instructions for you"); sessions that are not loaded return `not-loaded`.

## Install

```powershell
dsh plugin --profile <p> add "link:D:/dev/ai/dsh-plugins/dsh-session-link"
```

Then restart DSH and refresh the browser page. Remove with:

```powershell
dsh plugin --profile <p> remove dsh-session-link
```

Install it from the main checkout after the branch is merged to `develop`, not from a worktree.

## Notes

- **Own tool helper.** The plugin carries its own small `defineTool` (in `index.js`) and does not import `@deepseek-ai/dsh-tools`: a `link:` plugin has no `node_modules`, so a bare import would fail. It builds the same tool-definition shape and validates the arguments itself.
- **Hub mode.** In hub mode `todoStates` (card states, waiting cap, duplicate check) reads the hub mirror. A retry that falls inside the mirror lag can slip past the waiting cap and the duplicate check. The per-pair cooldown only covers a single-match send.
- **Fallback request id.** Without the review queue the direct prompt carries a request id `todo-link-<hash>`, a hash of sender, target, envelope and a 10-minute time bucket (spec 6.2 said `link-<callId>`; the callId is not used, so a model retry after a timeout dedupes in the controller, while an identical message 10+ minutes later is delivered).
- **Queue support.** The plugin needs `dsh-review-queue` from the same branch or newer: it uses the service-level `addTodo` options `mode`, `excludeSessionIds` and `source` (see [dsh-review-queue/README.md](../dsh-review-queue/README.md)) and `todoStates`.

## Develop

```powershell
cd dsh-session-link
node --test test/*.test.mjs
```
