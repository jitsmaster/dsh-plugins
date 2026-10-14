# Task list on Android: spec and plan (2026-10-14 grilling)

Status: DRAFT, decisions below come from the user; items marked **VERIFY** or listed under "Still open" are not settled. Builds on [spec.md](spec.md) and the server API in [server.js](../server.js).

## Recommendation
A **mobile-first PWA** served by this plugin, reached over Tailscale HTTPS and installed to the Android home screen. Not a Kotlin app: the server API (long-poll snapshot + small POSTs) already is the phone's API, the card logic and tests are reused, and one UI stays in step with the desktop task list. Revisit a thin native shell (Capacitor / Kotlin) only if one of these happens: web push is not delivered reliably after Android battery optimisation, a persistent notification or home-screen widget becomes a requirement, or full phone voice control is wanted.

## Decisions (from the user)
| Topic | Decision |
|---|---|
| Reach | Tailscale (private VPN) with HTTPS (`tailscale serve`); no public exposure. The DSH Host only admits a non-loopback hostname that is listed as a trusted host: add the tailnet name. Verified in the DSH source: `dsh web --trusted-host <authority>` (repeatable, host or host:port), usually together with `--public-url https://<name>.ts.net/`. |
| Sign-in | DSH's existing login (cookie) over that HTTPS name. No auth code of our own, no pairing. |
| App | Installable PWA at `/review-queue/m/` inside this plugin (one plugin, shared logic and tests). |
| Scope | Every card action of the desktop task list: answer (incl. multi-question, late answer), approve, deny, approve all identical, reply, reviewed, reopen, archive session (PR merged), Keep session, filters and search, Resolved list. Read aloud with Android's own speech; replies dictated with the keyboard's microphone. No phone voice commands, no PC overlay show/hide. |
| Phone UI | Bottom tabs *Waiting* / *Resolved*; tap an item for a full-screen card with large action buttons; a notification opens that card. |
| Approving | Every approve on the phone shows a confirm sheet with the full command and risk labels. A risky item (the existing risk list) needs a press-and-hold on top of that. The phone sends `via: 'phone', confirmed: true`; the server rejects a phone approve of a risky item without it (defence in depth: same auth, not a second security boundary). |
| Push | Web Push from the PWA (service worker, VAPID). Types: permission, question, PR merged, done. |
| Notification text | The user wants the notification to take them to the item, with the details and the decide/prompt UI in the app. The lock screen shows the type and the number waiting only (e.g. "Permission waiting - 3 items"), never a command, reply or title, because the text passes through Google's push service. The tap goes to `/review-queue/m/#/item/<id>`. |
| Notification buttons | None. Tap opens the card, never acts. |
| Done items | Only items that need the user. The summary step already returns an `actionable` verdict and the desktop list hides "no action" items (`hideNoAction`); the phone uses the same snapshot, so it never lists them. The push for a done item is sent only after that verdict: not at capture time. Verdict false: no push. Unsure answer, model failure or timeout: the item is shown, so it is pushed. |
| UI toolkit | Preact, vendored as one file in the plugin, no build step. Card logic is plain JS shared with the overlay. |
| Push library | Written on `node:crypto` (VAPID JWT, RFC 8291 encryption, tested against the RFC test vectors); the plugin stays dependency-free. |
| Devices | One user, several phones. Each device (push subscription) has its own on/off switch per type in the phone's settings page; the desktop device list can remove any device. |
| Quiet hours | Configurable window (per device). Permission and question may break through it (a session is blocked); done and PR merged wait and arrive as one digest when it ends. |
| Lost phone | Removing the device from the desktop list stops its push at once. Also sign out that phone's DSH session: the plugin first checks (M0) whether DSH can revoke a single login, and what it offers is written here before anything is built. |
| Open session | No button on the phone; sessions are opened at the PC. |
| Retention | Same 7 days of Resolved as the desktop; one shared store. |
| Presence | While a desktop task list or DSH tab is active, the push is held; if the item is still open after 60 s of no desktop activity it is sent. |

## Design
### Server (this plugin)
- Static routes under the existing prefix (all behind `connection.admit`): `/m/` (page), `/m/manifest.webmanifest`, `/m/sw.js` (scope `/review-queue/m/`), icons. Same API as the desktop (`/v1/snapshot`, `/v1/answer`, ..., `/v1/archive`).
- `push.js`: VAPID key pair created once and kept in the state dir; subscriptions in `push.json` (endpoint, keys, created, user agent, last success); a 404/410 from the push service deletes the subscription. Routes: `GET /v1/push/key`, `POST /v1/push/subscribe`, `POST /v1/push/unsubscribe`, `POST /v1/push/test`, `GET /v1/push/devices` (so a lost phone can be removed from the desktop page).
- Notifier: subscribes to the store, decides what to send. One notification per type, replaced by tag instead of piling up ("Permission waiting - 3 items"); TTL 12 h; urgency high for permission and question, normal for done and PR merged. A resolved item cannot clear a shown notification (a push must show something on Android), so a stale tap lands on an "already handled" screen with the resolution line.
- Presence: the desktop client adds `client=desktop&visible=1` to its long-poll; the server keeps the time of the last visible desktop poll. Held pushes are re-checked at +60 s and dropped when the item is gone.

### Client
- The pure card logic now inside lib/client.js (resolution text, filters, answer validation, error text, drafts) moves to a shared module used by both the DSH overlay and the phone page; the overlay keeps its tests. The phone views are new (list, card, confirm sheet, install and notification set-up, connection banner).
- Connection loss: a banner, backoff reconnect, unsent replies and half-picked answers stay in local storage (as on desktop). An action that fails because the item changed shows the same text as the desktop.
- Read aloud: `speechSynthesis` with the `spoken.full` text the snapshot already carries.
- No Open session button on the phone.

## Phases (each: RED tests, then GREEN, full suite after each)
- M0 spike, no code kept: Tailscale HTTPS name, trusted host, DSH login on the phone, long-poll through the tunnel, service worker registered under `/review-queue/m/`, a hand-sent test push received on the phone.
- M1 extract the shared card logic; mobile page with Waiting / Resolved lists and the full-screen card, read-only.
- M2 all actions, the confirm sheet and the risky-item hold, the `via/confirmed` server check.
- M3 push: VAPID, subscriptions, notifier, deep link, test button, device list.
- M4 presence hold and the done-item verdict gate.
- M5 install flow, offline/reconnect polish, README, real-device checklist.

## Testing
node:test for the shared logic, push (including the RFC 8291 encryption against its test vector if we implement it ourselves), notifier decisions (type, hold, verdict gate, dedupe) and server routes. UI: Playwright with a phone viewport against a dev server (the dev route `/v1/dev/ask` creates fake items). Last step by hand on the real phone: install, receive each type of push, tap through, approve a risky item with the hold, answer a multi-question, archive a merged PR session.

## Still open
1. Can DSH sign out one login (the phone's cookie) without signing out the others? Answered in M0; if not, the lost-phone procedure is "remove the device here, then rotate the DSH login".
2. Quiet-hours default window and time zone (the phone's zone is the natural choice; stored per device).
3. Digest wording ("2 done, 1 PR merged waiting"): the same count-only rule as the other pushes.
