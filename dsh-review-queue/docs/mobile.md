# Task list on Android: spec and plan (2026-10-14 grilling)

Status: built (the phone app, push, and with the hub of [hub.md](hub.md) slice H4 the pairing, devices and notifier); the decisions below come from the user, the rows Reach, Sign-in, Lost phone and Presence were changed by the hub design (see the notes in the table). Items marked **VERIFY** or listed under "Still open" are not settled. Builds on [spec.md](spec.md) and the server API in [server.js](../server.js).

## Recommendation
A **mobile-first PWA** served by this plugin, reached over Tailscale HTTPS and installed to the Android home screen. Not a Kotlin app: the server API (long-poll snapshot + small POSTs) already is the phone's API, the card logic and tests are reused, and one UI stays in step with the desktop task list. Revisit a thin native shell (Capacitor / Kotlin) only if one of these happens: web push is not delivered reliably after Android battery optimisation, a persistent notification or home-screen widget becomes a requirement, or full phone voice control is wanted.

## Decisions (from the user)
| Topic | Decision |
|---|---|
| Reach | Tailscale (private VPN) with HTTPS, no public exposure (no Funnel). **Changed by the hub:** the phone does not go through DSH at all. `tailscale serve --bg --https=443 http://127.0.0.1:47615` publishes the **hub** (loopback only) on `https://<pc>.<tailnet>.ts.net`, the app is served by the hub at `/review-queue/m/`, and the hub admits only Host names it knows (`127.0.0.1:<port>`, `localhost:<port>` and the host of `publicUrl` in `hub.config.json`; DNS rebinding) and, when `allowedTailnetLogins` is set, only those Tailscale logins. No `--trusted-host` of DSH is needed. |
| Sign-in | **Changed by the hub (D3):** pair once with a one-time code, no DSH cookie. The desktop task list (**Phone**, **Pair a phone**) shows a code (8 characters, valid 5 minutes, single use); the phone enters it at `#/pair`, names itself and gets a long-lived device token (`Authorization: Bearer rqd_...`, kept in the browser's localStorage, stored on the PC only as a SHA-256). 401 `auth-required` (revoked, or unused for 180 days) brings the phone back to the pairing screen. When the page is served by a DSH app itself (hub off) the old cookie sign-in still applies. |
| App | Installable PWA at `/review-queue/m/` inside this plugin (one plugin, shared logic and tests). |
| Scope | Every card action of the desktop task list: answer (incl. multi-question, late answer), approve, deny, approve all identical, reply, reviewed, reopen, archive session (PR merged), Keep session, filters and search, Resolved list. Read aloud with Android's own speech; free-text boxes (the reply, "Other answer…", a new todo) dictated with the in-page mic button or the keyboard's microphone; start a new todo from the phone ("New todo on the phone" below). No phone voice commands, no PC overlay show/hide. |
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
| Lost phone | **Revoke** on the desktop (**Phone** in the task list) signs that phone out at the hub: its token stops working on the next request, its open long poll ends, its push subscription is deleted. Nothing in DSH's own login is involved, so no other login is touched (the old open question is settled by the token design). |
| Open session | No button on the phone; sessions are opened at the PC (`open-session` is desktop-only at the hub). A phone may start, confirm and cancel todos, never open the session they create. |
| Retention | Same 7 days of Resolved as the desktop; one shared store. |
| Presence | While the desktop task list is being looked at, the push is held; if the item is still open after 60 s without a look it is sent. Built: the overlay's long poll says `&visible=1` while its page is visible, the hub notes the time of the last such poll of the desktop role (a phone's flag does not count), and `hub/notifier.js` holds a push until 60 s have passed. |

## Design
### Server (this plugin)
- Static routes under the existing prefix (all behind `connection.admit`): `/m/` (page), `/m/manifest.webmanifest`, `/m/sw.js` (scope `/review-queue/m/`), icons. Same API as the desktop (`/v1/snapshot`, `/v1/answer`, ..., `/v1/archive`).
- `push.js`: VAPID key pair created once and kept in the state dir; subscriptions in `push.json` (endpoint, keys, created, user agent, last success); a 404/410 from the push service deletes the subscription. Routes: `GET /v1/push/key`, `POST /v1/push/subscribe`, `POST /v1/push/unsubscribe`, `POST /v1/push/test`, `GET /v1/push/devices` (so a lost phone can be removed from the desktop page).
- Notifier: subscribes to the store, decides what to send. One notification per type, replaced by tag instead of piling up ("Permission waiting - 3 items"); TTL 12 h; urgency high for permission and question, normal for done and PR merged. A resolved item cannot clear a shown notification (a push must show something on Android), so a stale tap lands on an "already handled" screen with the resolution line.
- Presence: the desktop client adds `client=desktop&visible=1` to its long-poll; the server keeps the time of the last visible desktop poll. Held pushes are re-checked at +60 s and dropped when the item is gone.

### Client
- The pure card logic now inside lib/client.js (resolution text, filters, answer validation, error text, drafts) moves to a shared module used by both the DSH overlay and the phone page; the overlay keeps its tests. The phone views are new (list, card, confirm sheet, install and notification set-up, connection banner).
- Connection loss: a banner, backoff reconnect, unsent replies and half-picked answers stay in local storage (as on desktop). An action that fails because the item changed shows the same text as the desktop.
- Read aloud: `speechSynthesis` with the `spoken.full` text the snapshot already carries. On Android (Chrome and the TWA) that is the device's own TextToSpeech engine. On iPhone and iPad the button is not drawn.
- No Open session button on the phone.
- New todo and dictation: see the two sections below.

## New todo on the phone
The same flow as the desktop task list's "+ New todo" (see [spec.md](spec.md) and the vault note *Task List Todo Design*), over the same API; the hub lets a paired phone call `POST /review-queue/v1/todo`, `/v1/todo-confirm` and `/v1/todo-cancel` (`DEVICE_ACTIONS` in [hub/http.js](../hub/http.js)); `open-session` and every other action stay desktop-only (403).
- **Form** (Waiting screen, **+ New todo**, route `#/new`): a textarea for the task (several lines, 4000 characters like the server), a workspace dropdown (*Choose for me* first, then every workspace by title from `GET /v1/workspaces`; a failed load or an empty list says so and offers a reload), *Use SPARC* (off), a mic button and **Start todo** (disabled while the text is empty or a request is running). It posts `{text, workspaceId?, sparc?}`; on success the phone goes back to the list. Errors use the desktop's words (`core.errorText`), with friendly sentences for `empty`, `too-long`, `unknown-workspace`, `no-registry` and `owner-offline`. The draft is kept while the user moves between screens and is saved to localStorage (`rq-m.todoDraft`) on every change, flushed on pagehide and when the page is hidden, and restored when the page starts (reload, crash); only a successful start clears it, a refused or failed one keeps it. There is no Tune prompt button on the phone (and `/v1/todo-tune` is not a phone action).
- **Card**: a todo awaiting confirmation or failed shows the suggested workspace line, a dropdown preselected like the desktop (the user's pick, else the workspace the todo was given, else the suggestion), **Start** (**Retry** when failed) and **Cancel**. Starting, started and cancelled are read-only text; there is no Open session button.
- **Code**: pure logic in [lib/mobile/todo-form.js](../lib/mobile/todo-form.js) (`newTodoPayload`, `workspaceChoices`, `workspacesNote`, `todoErrorText`) and `todoCardModel` in [lib/mobile/model.js](../lib/mobile/model.js), which reuses the overlay's `todoLine`, `todoSelect` and `todoTarget` (exported in `exports.shared` of [lib/client.js](../lib/client.js)); views.js stays thin.

## Dictation (speech to text)
A mic button sits next to every free-text box: the new-todo text, "Reply to this session…" and each question's "Other answer…". **It fills the box and never sends**: the recognised text is pasted at the end of what is already there (one separating space when needed, existing text never lost), and the user reviews it and presses the normal Send button. While listening the box shows the interim text live and replaces it as it refines; the final result commits. Tapping the button again stops. One recognition runs at a time (starting one stops another); leaving the screen stops it.
- **Engine**: the Web Speech API (`window.SpeechRecognition` or `webkitSpeechRecognition`). In Chrome and the TWA on Android that is Google's speech service, the device's system speech-to-text (with the newer Google speech models where they are installed). `lang` is `navigator.language` (fallback `en-US`), `interimResults` on, `continuous` off (unreliable on Android Chrome). **A web page cannot detect or call the Gemini app**, and nothing here sends the text to an LLM: plain STT only. Without the API the mic buttons are hidden. A later APK shell may use Android's `RecognizerIntent` instead of the web API.
- **Errors** appear under the box: permission blocked (`not-allowed`, `service-not-allowed`: allow the microphone in Chrome's site settings), "Didn't hear anything" (`no-speech`), no microphone (`audio-capture`), speech service unreachable (`network`), language not supported; `aborted` is silent.
- **Code**: [lib/mobile/dictation.js](../lib/mobile/dictation.js) (`dictationSupport`, `mergeDictation`, `dictationError`, `createDictation`) is pure and tested with a fake recognition class; it has no network, no api.js and no endpoint, so it cannot send. `Mic` in views.js is the only user. Real-device check: T11 in [hub.md](hub.md) 11.3.

## Paused sessions (read only)
Sessions a DSH restart cut off in the middle of work are listed as items of type `paused` (the detection, resume and dismiss are described in [hub.md](hub.md) 6.7). The phone **shows** them and never acts on them: it cannot resume or dismiss (the paused routes are not in `DEVICE_ACTIONS`, so they answer 403 `desktop-only`; no code of the phone page calls them) and no push is sent for them.
- **Indicator**: the header reads "N waiting · ⏸ M paused" (paused sessions do not raise the waiting count); the Waiting list starts with a banner "M sessions were paused by a restart. Resume or dismiss them at the PC." and a **Show** button that sets the *Paused* filter chip.
- **Card**: chip *Paused*; the facts the desktop card shows (why it is listed, how long ago it last wrote, a tool call that may be half done, the last request) and "To resume this session, use the Task list on the PC."
- **Code**: `pausedNote`, `pausedView` and the `paused` count of `listModel` in [lib/mobile/model.js](../lib/mobile/model.js) (the facts and the count come from `pausedFacts` / `pausedCount` of the overlay's `exports.shared`); `PausedBody` in views.js.

## iPhone
Step-by-step deployment guide: [iphone.md](iphone.md).

On an iPhone the app is the web page itself, installed to the Home Screen: no store, no Mac, no developer account.
1. **Tailscale**: install the Tailscale iOS app, sign in to the same tailnet and turn it on. The phone must reach the HTTPS name from `publicUrl` (`https://<pc>.<tailnet>.ts.net/review-queue/m/`).
2. **Open it in Safari** (not Chrome for iOS: only Safari offers Add to Home Screen with the standalone app), then **Share, Add to Home Screen**, name it. Until it is installed the page shows a one-time banner with these steps (dismiss it with *Dismiss*; remembered in `localStorage` key `rq-m.install-hint-dismissed`).
3. **Open the app from the Home Screen icon** (standalone, no Safari bars; the icon is `lib/mobile/icon-180.png`, the status bar is black). Pair it as in the runbook below: iOS may keep a Home Screen app's storage apart from the Safari tab's (unverified), so pair again from the Home Screen app if it asks.
4. **Notifications** (Settings tab, *Turn on notifications*, from a tap) work **only from the Home Screen app on iOS / iPadOS 16.4 or later**, never in a Safari tab; Settings says so on an iPhone that is not installed or too old. Push goes through Apple's service (`web.push.apple.com`), which needs a valid VAPID subject: the hub uses its https `publicUrl` origin unless `pushSubject` is set (see the runbook).
- **View guard**: an iPhone/iPod user agent counts as a phone. If the page is laid out wider than 900 px the banner says to tap the *aA* button in Safari and choose *Request Mobile Website*. An iPad (also iPadOS in desktop mode, a Macintosh user agent with touch) is a tablet and gets no warning. Safari's *Request Desktop Website* on an iPhone sends a Macintosh user agent, so the guard cannot detect it (unverified); the width rule still applies only when the user agent says iPhone.
- **Dictation**: Safari has `webkitSpeechRecognition`, but it needs *Settings, Siri & Dictation* turned on, the microphone allowed for Safari, and it may be unreliable or unavailable in a Home Screen app (unverified; check with T12). The error under the box then says so. Without the API the mic buttons are hidden.
- **Not applicable**: `assetlinks.json`, the TWA and the APK are Android only.
- **No native shell is built.** A wrapper app needs macOS, Xcode and an Apple developer account. If wanted later: a thin WKWebView (or Capacitor) app that loads the same HTTPS URL; push would still go through Apple's service exactly as the PWA does. Real-device check: T12 in [hub.md](hub.md) 11.3.

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

## Phone setup (runbook)

Done once, on the PC that runs DSH and the hub.

1. **Publish the hub on the tailnet** (PowerShell; the hub listens on 127.0.0.1:47615 only; the first time it may need an elevated shell):
   ```
   tailscale serve --bg --https=443 http://127.0.0.1:47615
   tailscale serve status        # check: shows https://awang-lpt2.taile1279d.ts.net -> 127.0.0.1:47615
   tailscale serve --https=443 off   # remove
   ```
   (If DSH itself is ever published on 443, give the hub `--https=8443` and use that origin in `publicUrl`.) Never use `tailscale funnel`.
2. **Tell the hub its public address.** Create `~/.dsh/review-queue/hub.config.json` (no secrets in it):
   ```json
   {
     "publicUrl": "https://awang-lpt2.taile1279d.ts.net",
     "allowedTailnetLogins": ["<your tailscale login, e.g. you@example.com>"],
     "pushSubject": "mailto:<your address>"
   }
   ```
   `pushSubject` is optional: when left out the hub signs its push messages with the https `publicUrl` origin (Apple's push service rejects a `mailto:` on localhost); an explicit value always wins. `publicUrl` is required (without it the hub refuses the tailnet host name). `allowedTailnetLogins` is recommended (find your login with `tailscale status`); leave the list out only if every device in your tailnet may pair. Restart the hub so it reads the file (it is read at start): `POST /hub/v1/shutdown` with the agent secret, or end the `node hub/main.js` process; the next DSH app starts it again. Restart DSH (and refresh the browser) once to load the new overlay and instance routes.
3. **Open the app on the phone**, in Chrome, with Tailscale on: `https://awang-lpt2.taile1279d.ts.net/review-queue/m/`. It shows *Pair this phone*.
4. **On the desktop** open the task list (Ctrl+Alt+L), press **Phone**, then **Pair a phone**. A code like `K7QM-2XD9` and a link appear (valid 5 minutes, one use).
5. **On the phone** type the code (or open the link from the desktop), keep or change the name, press **Pair**. The list appears.
6. **Notifications:** Settings tab, **Turn on notifications**, allow them, **Send test**. Optionally install the app (Chrome menu, Install app).
7. **Lost phone:** on the desktop, **Phone**, then **Revoke** next to it (press twice to confirm). It is signed out on its next request and gets no more notifications. A phone you only want to sign out yourself: Settings, **Forget pairing** (it stays in the desktop list until revoked).

If pairing says the address does not answer like the hub, you opened the DSH page instead of the hub address. If the phone says 403 *login-not-allowed*, add its Tailscale login to `allowedTailnetLogins` and restart the hub.
