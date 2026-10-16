# Deploying the task-list PWA on an iPhone

The iPhone app is the web page itself, installed to the Home Screen: no App Store, no Mac, no Apple developer account, nothing to build. No native iOS wrapper exists (it would need macOS, Xcode and a developer account). Everything below is done with the existing hub (see [hub.md](hub.md)) and the pairing runbook in [mobile.md](mobile.md) ("Phone setup").

## What you need

| Item | Why |
| --- | --- |
| iPhone on **iOS 16.4 or later** | Web Push for Home Screen apps starts at 16.4. Older iOS still shows the list but never notifies. |
| **Safari** | Only Safari can "Add to Home Screen" as a standalone app. Chrome, Firefox and the RingCentral in-app browser cannot. |
| **Tailscale** iOS app, signed in to the same tailnet as the PC | The hub is published only on the tailnet (`tailscale serve`), never on the public internet. |
| The PC running DSH and the hub, switched on | The phone talks to the hub on that PC. |

## One-time setup on the PC

Same as for Android; skip it if the Android phone already works.

1. Publish the hub: `tailscale serve --bg --https=443 http://127.0.0.1:47615` (check with `tailscale serve status`). Never use `tailscale funnel`.
2. Create `~/.dsh/review-queue/hub.config.json` with `publicUrl` (the `https://<pc>.<tailnet>.ts.net` name), `allowedTailnetLogins` (your Tailscale login; the iPhone must be signed in as one of them) and optionally `pushSubject`. Without `pushSubject` the hub signs pushes with the https `publicUrl`, which Apple's push service accepts; do not set it to a `mailto:` on `localhost`. Restart the hub after editing the file.
3. Note: the https name does not open **from the PC itself** (Windows' own web service owns port 443 there). That is expected; test from the phone.

## Install on the iPhone

1. Open the Tailscale app, make sure it is **connected**.
2. In **Safari** open `https://<pc>.<tailnet>.ts.net/review-queue/m/` (for this machine: `https://awang-lpt2.taile1279d.ts.net/review-queue/m/`). The page shows *Pair this phone* and an orange banner with the install steps.
3. Tap **Share** (square with an arrow), then **Add to Home Screen**, keep the name *Task list*, tap **Add**.
4. **Close Safari's tab and open the app from the new Home Screen icon.** It opens full screen with no Safari bars. Always use this icon from now on: notifications only work here.
5. **Pair it.** On the PC press Ctrl+Alt+L (task list), **Phone**, **Pair a phone**; a code like `K7QM-2XD9` appears (valid 5 minutes, one use). Type it into the app, optionally rename the device (it defaults to *iPhone*), tap **Pair**.
   - iOS can keep a Home Screen app's storage apart from the Safari tab's, so pair again from the Home Screen app even if you already paired in Safari.
6. **Notifications:** Settings tab, **Turn on notifications**, tap **Allow**, then **Send test**. The prompt only appears from a tap, and only in the Home Screen app. Settings shows a hint instead if the app is not installed or iOS is older than 16.4.

## Using it

- **Waiting / Resolved / Settings** tabs, the same cards as on Android: answer questions, approve or deny (risky approvals need the hold), reply, archive, mark reviewed.
- **+ New todo** starts a session in a workspace you pick (or *Choose for me*, which asks you to confirm the suggestion). A phone can start todos but cannot open sessions.
- **Mic button** next to the reply, answer and todo boxes dictates into the box and never sends; you press Send yourself.

## Check it works (about 5 minutes)

1. The list loads and shows the same waiting count as the desktop.
2. Settings: *Send test* gives a notification (lock the phone first to see it on the lock screen).
3. Tap a notification: the app opens on that item.
4. Reply to a *Done* card with the mic; the text lands in the box and nothing is sent until you tap Send.
5. Row **T12** in [hub.md](hub.md) 11.3 is this checklist; record the result there.

## Troubleshooting

| Symptom | Cause and fix |
| --- | --- |
| Safari cannot connect | Tailscale is off on the phone, or the PC/hub is down. Check `tailscale serve status` and `GET /hub/v1/health` on the PC. |
| 403 *login-not-allowed* | The iPhone's Tailscale login is not in `allowedTailnetLogins`; add it and restart the hub. |
| "Pairing says the address does not answer like the hub" | You opened a DSH page instead of the hub address. |
| *Add to Home Screen* is missing | You are in Chrome or an in-app browser. Open the link in Safari. |
| Turn on notifications does nothing, or says to install | You are in a Safari tab. Open the Home Screen icon. Needs iOS 16.4 or later. |
| Notifications stopped after a while | iOS can drop a subscription when the app is deleted or notifications are switched off in iOS Settings > Notifications > Task list. Turn them on again in the app (Settings tab). |
| Orange banner about a wide layout | Tap *aA* in Safari, **Request Mobile Website**. (On an iPhone that sent a desktop user agent the guard cannot tell; unverified.) |
| Mic button missing or errors | Needs Settings > Siri & Dictation on and the microphone allowed for Safari; it may be unreliable inside a Home Screen app (unverified). Without the speech API the button is hidden. Typing still works. |
| Lost iPhone | PC: **Phone**, **Revoke** next to it (press twice). It is signed out on its next request and gets no more pushes. |

## Updating

The hub serves the app files from disk, so after a code change just close and reopen the Home Screen app (iOS may cache the page; if it looks old, open the URL once in Safari and pull to refresh, or remove and re-add the icon). Pairing and notification settings survive an update.

## Limits

- No native iOS app, no App Store build, and nothing in `android/` applies.
- Developed and tested only on emulated iPhones (Playwright WebKit): layout, install banner and the New todo form are verified there. Standalone install, push delivery and dictation inside the Home Screen app are **not verified on a real iPhone**; T12 is how to confirm them.
- If a native wrapper is ever wanted: a thin WKWebView or Capacitor app on a Mac that loads the same https URL; push still goes through Apple's service exactly as for the PWA.
