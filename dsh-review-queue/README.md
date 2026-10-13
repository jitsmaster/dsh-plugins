# dsh-review-queue

A review queue for DeepSeek Harness. It collects what is waiting on you from **every session** in one oldest-first list:

- **Done**: a session finished a turn (short summary; the full reply is one click away). Clear it with *Reviewed*, or send a reply into that session.
- **Question**: an `ask_user_question` is open. Answer it from the card (pick an option or type your own). Questions with a timeout expire into *Resolved* with the recommended option taken.
- **Permission**: a tool needs approval. *Approve* or *Deny* from the card.

The queue is global, so it is an **overlay only** (the right sidebar is per session and is not used). A round-check button in the session header, just left of the right-sidebar button, opens it; Esc, the Close button or the button again closes it. *Open session* jumps to the item's session. Resolved items are kept for 7 days.

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
| `dev` | off | `true`, or env `DSH_REVIEW_QUEUE_DEV=1`, enables `POST /v1/dev/ask` which creates fake items (testing only; never enable in a real profile). |

## HTTP API

Served on the DSH web server under `/review-queue` (same host/origin fence and cookie auth as the rest of the web UI). JSON only.

| Route | Method | Body | Notes |
| --- | --- | --- | --- |
| `/v1/snapshot` | GET | query `since=<snapshotId>[|<focusId>]`, `wait=<ms>` | Open and resolved items, `snapshotId`, `serverNow`. With `since` it long-polls up to 25 s and answers `{unchanged:true}` if nothing changed. |
| `/v1/answer` | POST | `{id, answers:[{id, selected:[...], custom?}]}` | Answers an open question. |
| `/v1/approve`, `/v1/deny` | POST | `{id}` | Permission items. |
| `/v1/reviewed` | POST | `{id}` | Done items only. |
| `/v1/reply` | POST | `{id, text}` | Done items only; queues the text as a prompt to that session. |
| `/v1/focus` | POST | `{id}` or `{id:null}` | Shared selection (screen and voice follow it). |

Answers: 200 `{ok:true}`; 400 for bad input (`bad-answer`, `bad-decision`, `empty`, `too-long`); 409 when it cannot apply now (`not-open`, `not-completed`, `no-controller`, or the host's error); 413/415 for body size/type.

## Limits

- Request body 64 KB; reply text 4000 characters; stored text per field 20,000 characters.
- Resolved items are pruned after 7 days (hourly).
- Summaries use the host's LLM service when available and fall back to the last paragraph of the reply.

## Develop

`npm test` in this folder (Node's built-in test runner). Design and decisions: [docs/spec.md](docs/spec.md).
