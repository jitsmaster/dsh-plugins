# dsh-review-queue hub: one queue for every DSH app, one phone (design and plan)

Status: built H1-H4 (hub, agent bridge, proxy/launcher/plugin wiring, overlay delta; auth, pairing, devices, push and notifier, the desktop Phone panel and the phone's pairing screen; 2026-10-15), H5-H6 pending (APK, review). H4 deviations: subscriptions stay in `hub/push.json` (records gain `deviceId`) instead of inside `hub/devices.json`; a paired phone may start todos (`todo`, `todo-confirm`, `todo-cancel`, routed like the desktop's, see 6.4) but never open sessions (`open-session` and every other action off its list is 403 `desktop-only`); `vapid.json` is created on first use. Design below as approved. Builds on [mobile.md](mobile.md) (the phone PWA), [spec.md](spec.md) and the code under [../](../). Reference files are linked, not copied.

## 1. Goals and non-goals

**Goals**
1. One queue the phone and every desktop app provably read: a single process (the **hub**) owns the items, the snapshot, push, pairing and devices.
2. Each desktop app's plugin becomes an **agent** of that hub: it reports what it captures and executes the commands only it can run (it alone has the session controller).
3. The desktop overlay ([lib/client.js](../lib/client.js)) keeps working unchanged (at most the three additive lines in 6.6).
4. Safe reach from the phone: hub on loopback, published by `tailscale serve`, per-device revocable tokens.
5. An Android APK (Trusted Web Activity shell around the PWA), sideloaded, Web Push kept.
6. Never lose an item: hub missing or down means today's standalone behaviour plus a visible notice, and a resync afterwards.

**Non-goals**: Play Store release, Firebase/FCM SDK, a native UI, multi-user accounts, internet exposure (Funnel), phone voice control, moving TTS read-aloud off the PC, changing DSH itself, npm dependencies.

## 2. Decisions

| # | Decision | Source |
| --- | --- | --- |
| D1 | Standalone hub process, Node built-ins only, fixed configurable port (default **47615**, key `hubPort` / env `DSH_RQ_HUB_PORT`), started once per login by the first plugin instance that finds none (lock file, `hub.json`, health probe), launched detached the way DSH used to launch the STT daemon (that auto-start was removed 2026-10-16, STT is now started by hand) | user |
| D2 | Plugins are agents: register, report capture events, long-poll commands, execute locally, report the result. Instance routes `/review-queue/v1/*` become thin proxies to the hub | user |
| D3 | Hub listens on 127.0.0.1 only; `tailscale serve` publishes it on HTTPS; phone pairs once with a one-time code, gets a long-lived revocable per-device token (hashed at rest); agents use a local secret file; no reuse of DSH's cookie | user |
| D4 | APK = TWA shell (Chrome delivers Web Push, no Firebase), Gradle project in the repo, locally generated keystore never committed, `adb install` / sideload; hub serves `/.well-known/assetlinks.json` | user |
| D5 | **Each item has one owner instance** (the one that captured it). Only the owner mutates its pending request; the hub applies only hub-local transitions (reviewed, reopen, session gone). Single writer per item, so no merge logic | design |
| D6 | The hub keeps the **same URL layout** the overlay and PWA already use (`/review-queue/v1/*`, `/review-queue/m/*`); hub-only endpoints live under `/hub/v1/*`. Zero path changes in either client | design |
| D7 | Instance-local, never through the hub: `/v1/read`, `/v1/stop` (speakers are on this PC), `/v1/ui` (this browser), `/v1/focus` (this overlay's selection). The snapshot the overlay sees = hub items + this instance's `focusId/reading/ui` | design |
| D8 | `via` (phone or desktop) is derived by the hub from the credential, never trusted from the body. The confirm / hold / risky checks move to the hub | design |
| D9 | Workspace registry stays **per instance** (it is DSH data of that profile); the hub holds an in-memory union reported by agents. Todos are hub items routed by workspace owner (see 6.4) | design |
| D10 | Vanished owner: grace, then resolved `session-ended` ("session gone"); a returning owner revives its items. Replaces the per-start `cancelStalePending` ([capture.js](../capture.js) line 335) | design |
| D11 | Hub state lives in `~/.dsh/review-queue/hub/`; the legacy shared `queue.json` is only imported once and then left alone (old plugin builds may still write it) | design |
| D12 | APK project in `dsh-review-queue/android/` (rationale in 11.1); JDK 17 + AGP 8.13 + Gradle 8.13; androidbrowserhelper 2.7.4 | design |
| D13 | M0 spike with a hard decision gate before any APK build; fallback = Custom Tab shell or plain installed PWA | user |

## 3. Facts found on this machine (2026-10-14)

| Topic | Finding |
| --- | --- |
| Tailscale | Installed: `C:\Program Files\Tailscale\tailscale.exe` 1.102.4, service Running, on PATH. Tailnet name of this PC: **`awang-lpt2.taile1279d.ts.net`** (MagicDNS suffix `taile1279d.ts.net`); the node has the `https` capability, so serve certificates are available. `tailscale serve status` = "No serve config". Other nodes: `admins-mac-mini` (macOS) and `node` (android, 100.103.0.32), probably the phone. |
| serve command | `tailscale serve --bg --https=443 http://127.0.0.1:47615` (check: `tailscale serve status`; remove: `tailscale serve --https=443 off`). Serve config is per node and per HTTPS port: if DSH itself is ever published on 443 too, give the hub `--https=8443` and use that origin everywhere (assetlinks, TWA start URL). Not Funnel. May need an elevated shell the first time (verify in M0). |
| Android SDK | `C:\Program Files (x86)\Android\android-sdk`: platforms **android-34, android-35**; build-tools **35.0.0**; cmdline-tools **12.0**; platform-tools (adb 1.0.41, 34.0.5). No Android 36 platform (the phone runs Android 16 = API 36; compileSdk/targetSdk 35 is fine). The folder is not writable for the current user (TrustedInstaller/Administrators ACL, not elevated), has no `licenses/` and no `package.xml` files (only `source.properties`); AGP does not need a licence for packages that are already installed, but if it insists on installing anything it cannot write there (risk R6). | **Update 2026-10-15**: the SDK actually used is `C:\Users\awang\AppData\Local\Android\Sdk` (user-writable, licences accepted); `platforms;android-36` was installed there with `sdkmanager` (JDK 17) because `androidbrowserhelper` 2.7.4 needs androidx.core 1.17.0 (compileSdk 36); R6 did not bite.
| JDK | `java` on PATH = Microsoft OpenJDK **11.0.16.1**; also a JDK 8 under `C:\Program Files\Android\jdk`. **`JAVA_HOME` is set to `C:\Program Files\Java\jdk-21`, which does not exist**, so `gradlew.bat` would stop with "invalid JAVA_HOME". AGP 8.x needs **JDK 17+**, so JDK 11 cannot build the app. Get Temurin 17 (zip, no admin: adoptium.net, version 17) or `winget install Microsoft.OpenJDK.17`, and let `android/build.ps1` set JAVA_HOME per run. |
| Gradle | None on PATH. Bootstrap the wrapper once from `gradle-8.13-bin.zip` (`gradle wrapper --gradle-version 8.13`) and commit `gradlew`, `gradlew.bat`, `gradle/wrapper/*`. |
| Node | v24.21.0 on PATH. DSH runs plugins inside its own process (Electron or Node); the hub launcher must not assume `process.execPath` is plain Node (see 8.1). |
| State dir | `~/.dsh/review-queue` has `queue.json` (**620 KB** today, so write cost matters, see 7) and `vapid.json`; no `push.json` yet. Inherited ACL includes SYSTEM, Administrators, awang and igxadmin, so a secret file needs its own ACL (9.3). |
| Ports in use | 64047 (DSH), 8890 (STT), 8880 (TTS); 53231 is the other app's DSH port. 47615 was free. |

## 4. TWA findings (sources: Chrome's integration guide and quick start in the developer.chrome.com repo, the android-browser-helper README and releases, Bubblewrap README; fetched today)

- **Library**: `com.google.androidbrowserhelper:androidbrowserhelper:2.7.4` (Google Maven latest, released 2026-10-02). `androidx.browser:browser` 1.10.0 comes with it. Bubblewrap itself needs JDK 17 as well.
- **Who verifies**: Chrome itself, when the TWA launches: it checks the Digital Asset Links in both directions (app to site: `asset_statements` meta-data in the manifest; site to app: `https://<origin>/.well-known/assetlinks.json`, "the only place Chrome will look for it"). On failure Chrome shows the site as a **Custom Tab with an address bar** (docs: "If verification fails, the browser will fall back to displaying your website as a Custom Tab"). I found no Google document saying in so many words that the fetch runs on the phone and not on a Google server, and the Chromium source was not reachable from here. What points to on-device: the documented debug switch below can only skip a check Chrome runs locally, and the Google-assisted path is the Android 12+ App Links domain verification (`autoVerify`), which a TWA does not use. **So: treat as likely on-device, prove it in M0 test T2** (tailnet-only host, no flag). Do not declare `android:autoVerify` intent filters.
- **Workaround for debug/sideload** (Chrome integration guide): chrome://flags, "Enable command line on non-rooted devices" = Enabled, restart Chrome, then `adb shell "echo '_ --disable-digital-asset-link-verification-for-url=\"https://awang-lpt2.taile1279d.ts.net\"' > /data/local/tmp/chrome-command-line"`, force-stop Chrome. Applies to the app-to-site direction skip only for that URL. Per-device, dev-grade, may vanish with a Chrome update: it is a fallback, not the plan.
- **File rules**: HTTPS, status 200 on the exact path at the origin root, JSON, no redirect, strict JSON parser (a trailing comma breaks it), one statement per package with `sha256_cert_fingerprints` listing every key that signs the APK (debug and release both during development). Relation `delegate_permission/common.handle_all_urls`.
- **Which browser**: the library picks the user's single default browser if it supports TWA, else a system/Play-installed one. **The phone is a Samsung: if Samsung Internet is the default it would be chosen**, and it has no notification delegation. Pin Chrome with `<meta-data android:name="android.support.customtabs.trusted.LAUNCHING_BROWSER" android:value="com.android.chrome"/>` (test T7).
- **Web Push in a TWA**: works. The service worker and push subscription live in Chrome's storage for the origin and are shared by the TWA and the Chrome tab. Chrome supports **notification delegation** (README support table: Chrome yes, Samsung Internet no): with `DelegationService` declared in the APK, the notification permission becomes Android's `POST_NOTIFICATIONS` of the app, notifications are shown by the app and a tap launches the TWA. Without delegation they are ordinary Chrome notifications with Chrome's own site permission. Delegation only works while the TWA is in verified TWA mode (a Custom Tab fallback clears the delegation token). Both variants are tested in M0 (T5).
- **Unverified, to watch**: Google is rolling out developer verification for apps installed on certified Android devices in 2026-27 (only seen in a third-party issue here; `adb install` is said to stay available). Recheck at H5.

## 5. Architecture

### 5.1 Overview

```
 phone (Chrome / TWA)  --tailnet-->  tailscale serve :443 (TLS)
        |  Bearer rqd_<device token>             |  http://127.0.0.1:47615
        v                                        v
 +--------------------------- HUB  (node hub/main.js, one per login) ----------------------------+
 |  store (items, rev, seq)   snapshot long-poll   push + notifier (VAPID)   devices + pairing    |
 |  instances registry + stale handling   command queues   assetlinks.json   static phone PWA    |
 |  state: ~/.dsh/review-queue/hub/*   discovery: ~/.dsh/review-queue/hub.json, hub.secret       |
 +--------^-------------------------^--------------------------------------------^---------------+
          | agent API (Bearer secret) /hub/v1/agent/*   register, ops, sync, long-poll commands
 +--------+----------+     +--------+----------+                      +----------+---------+
 | DSH app A :64047   |     | DSH app B :53231   |   ...               | pairing/devices page|
 | plugin = AGENT     |     | plugin = AGENT     |                      | (instance route,    |
 |  capture, service  |     |  capture, service  |                      |  behind DSH login)  |
 |  todo, TTS, local  |     |  ...               |                      +---------------------+
 |  store (own items) |     +--------------------+
 |  /review-queue/v1/* = proxy to hub (+ local read/stop/ui/focus)
 +----^---------------+
      | DSH login cookie (unchanged)
   overlay lib/client.js (unchanged), browser tab
```

### 5.2 Who does what

| Concern | Hub | Agent (plugin) |
| --- | --- | --- |
| Item list, order, positions, snapshot id, long-poll | owns | mirrors it (for the `reviewQueue` service) |
| Capture (DSH events), pending promises, session controller, registry, LLM summaries, todo session creation | no | owns |
| Mutating an item | only hub-local transitions | everything else, then reports an op |
| Auth, pairing, devices, push, notifier, presence | owns | proxies desktop UI calls |
| TTS read/stop, overlay show/hide, focus | no | owns (D7) |

### 5.3 Data flow in one line each
- **Capture**: DSH event, then [capture.js](../capture.js) writes the instance's local store (sync, as today), the store adapter queues an op, the agent POSTs it to the hub (batched, retried), the hub assigns `seq`, bumps `rev` and wakes every snapshot long-poll.
- **Phone approve**: `POST /review-queue/v1/approve`, the hub checks token, item, confirm/hold/risk, queues a `approve` command for the owner, the owner's command long-poll returns it, the agent calls `queue.approve` ([service.js](../service.js)), [capture.js](../capture.js) resolves the pending promise and writes the resolution, the op reaches the hub, the HTTP call returns the result.
- **Desktop approve**: same path, the proxy adds the agent secret and `X-RQ-Role: desktop`. Desktop and phone therefore share validation and state, which is the point.

## 6. Components, behaviour and file layout

### 6.1 New and moved files (all inside `dsh-review-queue/`; add `hub` and `agent` to the `files` list of [package.json](../package.json), not `android`)

| Path | Role |
| --- | --- |
| `hub/main.js` | Entry: parse flags (`--state-dir --port`), singleton guard (EADDRINUSE + health check), write `hub.json`, signal handling, idle exit |
| `hub/hub.js` | `createHub({stateDir, port, now, ...})`: composition, injectable clock and ports for tests |
| `hub/http.js` | Router, role resolution, Host/Origin checks, rate limits, error mapping (same `outcome()` rules as [server.js](../server.js)) |
| `hub/hub-store.js` | Wraps the order/snapshot/prune logic of [store.js](../store.js) (reused, not copied) with owner, `rev`, hub-assigned `seq`, debounced atomic persistence |
| `hub/instances.js` | Registry, away/gone states, grace, adoption, revival (6.3) |
| `hub/commands.js` | Per-instance FIFO command queue, result waiters, timeouts (6.2) |
| `hub/devices.js` | Pairing codes, device tokens, revoke, rate limiting (9) |
| `hub/notifier.js` | Push decisions (type tag, presence hold, actionable gate), written new here per [mobile.md](mobile.md) |
| `hub/push.js, webpush.js, push-routes.js` | **Moved** from the plugin root (git mv); device records gain `deviceId` |
| `hub/assetlinks.js` | Builds `/.well-known/assetlinks.json` from `hub.config.json` |
| `agent/launcher.js` | `ensureHub()`: discovery, lock, spawn, upgrade (8) |
| `agent/client.js` | Register, heartbeat via the command long-poll, ops outbox, full sync, backoff |
| `agent/store-adapter.js` | The [store.js](../store.js) interface over the local store plus an op log (what [capture.js](../capture.js), [service.js](../service.js), [todo.js](../todo.js) already call) |
| `agent/executor.js` | Command to service call mapping, result cache by `cid` (idempotent) |
| `agent/proxy.js` | The instance's `/review-queue/v1/*` routes: forward to the hub, or local (D7), or fall back (10) |
| `agent/hub-queue.js` | `reviewQueue` service in hub mode: synchronous reads from the mirror, actions through the hub ([dsh-hooks-tts](../../dsh-hooks-tts/index.js) and the voice runner call it via `ctx.get('reviewQueue')`) |
| `android/` | TWA project (11) |
| `scripts/hub-status.mjs` | Prints hub.json, health, instances, devices (support) |

**Stays in the plugin**: [capture.js](../capture.js), [service.js](../service.js) (as the local executor; it keeps the `focus/reading/ui` state), [todo.js](../todo.js), [summary.js](../summary.js), [actionable.js](../actionable.js), [reader.js](../reader.js), [signals.js](../signals.js), [filelog.js](../filelog.js), [store.js](../store.js) (own items only), [index.js](../index.js). **Shared pure modules** imported by the hub through relative paths: [risk.js](../risk.js), [speech.js](../speech.js), [mobile.js](../mobile.js) and `lib/mobile/*`.

### 6.2 Command routing (the tricky part)

Commands: `answer, late-answer, approve, approve-similar, deny, reply, thread, post, archive, paused-resume, paused-dismiss, todo-suggest, todo-start, todo-cancel` (owner executes) and `apply` (hub tells the owner about a hub-local change; no result). Hub-local: `reviewed, reopen`. Not exposed to the phone: `read, stop, ui, focus` (403 `local-only`).

```
POST /review-queue/v1/<action> {id, ...}               // role: device | desktop
  item = store.get(id)                                  // 409 not-found / not-open exactly as service.js today
  via  = role === 'device' ? 'phone' : 'desktop'        // D8, body.via ignored
  if kind == approve|approve-similar and via == 'phone':
      require body.confirmed                            // else 400 needs-confirm   // TEST: phone approve without confirm
      if riskOf(item).length: require body.held         // else 400 needs-hold; approve-similar -> 409 risky
  if kind in HUB_LOCAL: apply in store; push 'apply' to owner; return {ok:true}
  owner = instances.get(item.owner)
  if !owner or owner.state == 'gone': 409 owner-offline   // "its DSH app is not running"
  if owner.state == 'away':          409 owner-away       // missed 45 s of polling
  cmd = { cid: uuid, seq: ++owner.cmdSeq, kind, itemId: id, args, deadline: now + TIMEOUT[kind] }
  owner.queue.push(cmd); owner.wake()
  result = await waiter(cid, deadline)
  on timeout: if cmd still queued -> remove, 504 owner-timeout
              else 200? no: 504 unknown-outcome        // delivered, no result: client re-reads the snapshot
  return result                                          // {ok:true,...} or {ok:false,error} mapped like server.js outcome()
agent loop: GET /hub/v1/agent/commands?after=<seq>&wait=25000  -> [cmd...]
  for cmd in order: r = cache.get(cmd.cid) ?? execute(cmd); POST /hub/v1/agent/result {cid, ...r}
```

| Kind | Hub timeout | Notes |
| --- | --- | --- |
| answer, deny, approve, approve-similar | 10 s | executor calls `queue.*`; a "not-pending" result (promise already settled on screen) is a normal 409 |
| late-answer | 15 s | uses `userQuestions.answer` |
| reply | 35 s | `controller.prompt` already has its own 30 s signal |
| archive | 35 s | registry call |
| thread | 15 s | reads the session log from disk (6.8); the item need not be open |
| post | 35 s | `controller.prompt` like reply (own 30 s signal); the item need not be open |
| paused-resume | 35 s | `controller.prompt` on the session (own 30 s signal); paused-dismiss 10 s |
| todo-* | 10 s (accept) | the work continues in the background and shows as item state, as today |

Commands run one at a time per instance, in order; the agent caches the last 200 results by `cid` so a re-delivery after a lost response returns the same answer. Commands are in memory only; a hub restart fails pending ones with `unknown-outcome`.

### 6.3 Items, ids, ordering, stale owners

- **Ids**: `<instanceShort4>-<12 hex>` created by the instance (so the local store can answer synchronously); the hub rejects a duplicate id from a different instance (409 `id-conflict`). **Order**: `(createdAt, seq)` like today; `createdAt` comes from the instance (all instances share this PC's clock; the hub clamps it to [now - 24 h, now]), `seq` is hub-assigned and persisted, so ties and replays are stable. Positions ("item 3") are global across instances, for the overlay, the phone and voice alike.
- **Ownership**: every item has `owner = instanceId`; the snapshot adds `ownerLabel` and `ownerState` (online|away|gone) so a card can say why an action is disabled.
- **Ops** (agent to hub, idempotent): `add, update, resolve, reopen, resolveSession, retitle` with per-instance counter `n`; the hub acks the last applied `n`; a gap answers 409 `resync-needed` and the agent sends a full `sync` (its open items, recent resolved, workspaces, session ids). First resolve wins; a later `update` of a resolved item still applies (a late summary).

```
every 10 s:  for inst in instances:
  if inst.state == 'online' and now - inst.lastPollAt > AWAY_MS (45 s):   inst.state = 'away'
  if inst.state == 'away'   and now - inst.lastSeenAt > GRACE_MS (120 s): inst.state = 'gone'; settle(inst)
  (hub start counts as lastSeenAt for every persisted instance: agents get GRACE after boot to reconnect)
settle(inst):                                     // idempotent
  for item in openItemsOf(inst):
    if item.type in (question, permission): resolve(item, {kind:'session-ended', by:'hub', reason:'owner-gone'})
    else keep open, ownerState 'gone'; resolve as session-ended after ORPHAN_KEEP (24 h)
register(instanceKey, instanceId, sync):
  prev = byKey[instanceKey]
  if prev and prev.id != instanceId:               // the app was restarted: its promises are dead
      settle(prev) now; adopt prev's remaining open items (completed, pr-merged, todo) into the new instance
  else if prev:                                    // same process reconnecting (hub restart, sleep, network)
      for it in sync.openItems: if hub has it resolved with by:'hub' -> reopen        // revival   // TEST: laptop asleep 10 min
      for it in hubOpenItemsOf(prev) not in sync.openItems: resolve(it, session-ended)
  every register and sync (see "Adoption by session id" below) adopts the unowned items whose session the instance reports
graceful bye (ctx.effect cleanup): settle now (question/permission), keep the rest as orphans
```

**Adoption by session id.** On every register and every sync the hub gives an online instance the open **completed, pr-merged and todo** items whose session is in the `sessionIds` it reports and whose owner is missing (legacy import), unknown, or **gone** (a replaced app, an instance key that changed): owner := that instance, `ownerLabel`/`ownerState` follow from the owner, the log says `adopted N by session`. Away owners are not robbed (they may come back), an online owner keeps its items, and open questions and permissions of a gone owner are never adopted (their promises died: `session-ended`, `owner-gone`). The new owner has no local copy, so the answer to the register / sync carries the items (`adoptedItems`, also for the same-key restart above); an item stays on the instance's handed list, and is handed again instead of ended as `not-in-sync`, until the instance lists it in a sync. The agent reports every session it can reach (live agents, workspace sessions, sessions its capture has seen, sessions of its own open items), sends a full sync when that list changes (checked every 15 s) and at least every 60 s, so a session learned later or an owner that went gone is picked up within a minute. The instance key (home plus web port) is only a shortcut: the port changes at every DSH start, so the continuity is the session id. The agent waits up to 3 s for the web port before registering, then falls back to a pid key.

**No app has the session.** An action on an open item without an owner whose session nobody reports goes to the coordinator (6.4): it is handed the item (`apply` / `adopt`) and becomes the owner if the action succeeds; if it answers `no-session` the item stays ownerless and the card shows `session-unavailable` ("That session is not available in this app, so this cannot be sent."), not "That app is not running". With no app online at all it is still `owner-offline`.

Kind `session-ended` is the existing resolution ([lib/client.js](../lib/client.js) line 84 shows "Session ended"), so no client text changes; `by:'hub'` tells logs and the revival rule apart. Why a grace at all: a sleeping laptop or a hub restart must not wipe live questions; the real process still holds the promise and revives them.

### 6.4 Todos and workspaces
- Each agent reports its workspace list (`{id,title,path,sessionIds}` from `workspaceRegistry`) at register/sync and on change; the hub keeps the union in memory (not persisted; an offline instance's workspaces drop out). `GET /review-queue/v1/workspaces` returns every online instance's list; ids are opaque `<instanceShort>/<workspaceId>` strings (the overlay only passes them back); titles of other instances get a " (label)" suffix, the caller's own come first (the proxy sends `X-RQ-Instance`). The agent re-reports its workspaces whenever the registry's ids, titles or folders differ from the last report (checked every 15 s with the session list), and the proxy has the hub updated first (waits at most 2 s) before it answers the overlay's `GET /v1/workspaces`, so a workspace added after register shows up at once. The `<instanceShort>` is the id of one start of an app: a todo card that waited over a restart keeps the old one, and the hub then finds the workspace by its own id when exactly one live app lists it (else `unknown-workspace`). The overlay asks for the list again when a card waits for a pick and the list it has is empty; the log says `workspaces: the hub lists none | N` when the count changes.
- A todo is a normal hub item (type `todo`, states unchanged, see [todo.js](../todo.js) header). **Add with a workspace**: owner = that workspace's instance, hub sends `todo-start`. **Choose for me**: the hub picks the *coordinator* (the calling instance for desktop, else the most recently desktop-active online instance) and sends `todo-suggest` with the union list; the coordinator runs name match then LLM ([todo.js](../todo.js)), writes the suggestion, the item waits for confirm; confirm sends `todo-start` to the chosen workspace's owner and the item's owner moves there. The "Open session" button for a session of another instance needs that instance's controller: it goes through `apply`/command `open-session` to the owner (new, small), the overlay button is unchanged.
- **Phone todos.** A paired phone may call `POST /v1/todo`, `/v1/todo-confirm` and `/v1/todo-cancel` (the `DEVICE_ACTIONS` list in [hub/http.js](../hub/http.js)); they route exactly as above, so a phone todo with "Choose for me" is coordinated by the most recently desktop-active online app (open question 6, accepted). The phone still cannot open a session: `open-session` stays desktop-only (403). The phone form and card are described in [mobile.md](mobile.md) "New todo on the phone".
- No instance online: `409 no-registry` as today.

### 6.5 Plugin `apply()` flow (index.js)
1. Build the local store (own file, 7), capture, service, reader, todo exactly as now; `cancelStalePending` is **not** called in hub mode (the hub settles stale owners); in standalone mode it still is, but only for items captured before this process (as today).
2. Start the agent (async, never blocks `apply`): `ensureHub()`, register, sync, command loop. Until it reports connected the instance serves standalone (10) and the proxy flips when ready.
3. Register the same `/review-queue` prefix route behind `connection.admit`; `ctx.provide('reviewQueue', hubQueue)` where `hubQueue` delegates to the local service while degraded.

### 6.6 Overlay delta (the only client change; all additive, old servers ignore it)
(a) render `snap.notice` as a one-line banner (fallback notices, 10); (b) add `&visible=1` to the long-poll URL when `document.visibilityState === 'visible'` (presence for the notifier: today the overlay polls from page load even when hidden, so "polling" cannot mean "looking"); (c) three entries in its error text map: `owner-offline, owner-away, owner-timeout`. Tests first in the existing client tests.

### 6.7 Paused sessions after a restart

A DSH restart or crash leaves sessions cut off in the middle of work. Their logs (`~/.dsh/sessions/--<cwd>--/<id>/session.v4.jsonl.zstd`, concatenated zstd frames of JSON lines) say so, and the task list offers to resume them. New item type **`paused`** (read-only for the phone), written by the agent and owned by the instance that scanned; it uses the normal ops, so the hub and the phone get it like any item. Code: [paused.js](../paused.js); the plugin wiring is in [index.js](../index.js).

- **What counts** (`classifyLog`, ported from the vault note *How To Tell A DSH Session Was Cut Off*): the last turn has no `turn/end` (`open-turn`); the last `turn/end` is `interrupted` with no later turn (`interrupted`); a message queued for the **next turn** was never consumed (`pending-inbox`; next-step notices from hooks, the working directory and reminders are left in finished sessions all the time and are ignored); the last frame is half written (`torn`). Not a cut: stopped by the user, error, parent abort, cap handoff, max tokens. Subagents (`origin: subagent`) never. Only logs written in the last **3 days** (`MAX_AGE_MS`).
- **Never a live session.** A log is read only when its session is not live (not seen by this app's capture, not in `ctx.get('agents').list()`), not archived, and either last written **before this app started** (a restart: nothing of that process is running) or at least **2 minutes** ago (`STALE_MS`). Logs over 64 MB are skipped; the scan yields to the event loop between logs and reads nothing else. Needs `zlib.zstdDecompressSync` (Node 22.15+); without it the scan fails as a whole (`no-zstd`) and changes nothing.
- **When.** At startup (`pausedStartMs`, 5 s), once more after the quiet time (`pausedRescanMs`, `STALE_MS` + 15 s: sessions the host loaded right after the restart), and on demand (`POST /v1/paused-scan`, the overlay's **Find paused**; local to the app, never through the hub). Every scan reconciles: a new cut session gets an item, a changed one is updated in place, one that is not cut off any more is resolved `recovered`. A restart does not cancel paused items (`cancelStalePending` skips them); the next scan decides.
- **Item**: `{ type: 'paused', sessionId, sessionTitle, workspace: <cwd>, payload: { lastWrite, kinds, reason, turn, danglingCalls, pending, lastUser, lastAssistant } }`. It is not "waiting on you": `waitingCount` and `count().total` leave it out; `count().byType.paused` and the overlay's "⏸ N paused" carry it. No push is sent for it.
- **Resume** (`POST /v1/paused-resume {id}`, command `paused-resume` to the owner): `controller.prompt({ requestId: 'resume-…', sessionId, mode: 'queue', content: [{ type: 'text', text: RESUME_PROMPT }] })`, the same call a card reply uses (DSH restores a cold session for it), then the item resolves `resumed`. `RESUME_PROMPT` (one constant in paused.js): "Resume the work this session was doing when it was cut off. First check git status and git log in its worktree and the last tool calls, because the last tool may have half-applied, then continue." A session DSH no longer has gives 409 `session-gone` and the item ends. **Dismiss** (`POST /v1/paused-dismiss`) resolves it `dismissed`.
- **Dismissed stays dismissed**: resume and dismiss both record `{ sessionId: lastWrite }` in `<stateDir>/paused-dismissed.json` (kept 7 days). A session stays quiet until its log is written again; a later cut is a new case. Caveat: if DSH itself writes to a dismissed log later (for example the crash-repair closer on the next load of that session) its last write moves and it can reappear once.
- **Resume all** (overlay only): the header button "Resume all (N)" asks first ("Resume all N paused sessions, 3 at a time?"); then `runResumeAll` (lib/client.js) sends the prompts so that at most `RESUME_AT_A_TIME` = 3 sessions are working: a place is given back when the session has a new done / question / permission item since its resume, when the session is no longer running (a held place asks `POST /v1/running-sessions` every 3 s after a 30 s start grace, because a session restored from cold is not listed as running before its turn begins; the lanes share one request per poll round; two polls in a row that do not list it free the place; a failed poll starts the count again), when the resume was refused, or, as the last resort, after 2 minutes. The running text says when sessions wait: "Resuming: 3 of 5 started, 3 working, 2 waiting for a place…". **Stop** starts no new one and ends the polling. The resume routes are the per-card ones, so in hub mode it is the same command path; `/v1/running-sessions` is always answered by this app (not in the hub's forwarded actions) and lists only this app's sessions together with its `instanceId`, so it frees a place early only for items this app owns (`item.owner` equals that id, or the item has no owner); a session of another app is never called stopped and falls back to the settled item or the timeout.
- **Phone**: read only. It gets the items in the snapshot (chip *Paused*, filter chip, a banner "N sessions were paused by a restart. Resume or dismiss them at the PC.", a card with the facts); `DEVICE_ACTIONS` is unchanged, so `paused-resume` / `paused-dismiss` are 403 `desktop-only`. See [mobile.md](mobile.md).
- **Owner gone**: nothing special: the items stay with the owner like todos; the next app's startup scan creates its own and the hub's 24 h orphan rule expires the old ones.
- **Pause all and quit (on purpose).** The Task list header has a **Pause all & quit** button (after a confirmation bar) and the overlay's Close is a split button whose menu has **Close** and **Quit**. Pause all cancels the active turn of every running top-level session through the session controller, waits up to 8 s for the turns to end, writes `paused-by-user.json` in the state directory (session id, title, folder, time), and closes the DSH desktop app. A clean stop leaves a log that the scan does not call cut off, so the scan adds the remembered sessions as extra candidates (`userpause.js`, reason "Paused on purpose with Pause all and quit"); an entry goes away when the session's log is written more than a minute after the pause, when it is archived, or after a week. Resume and Resume all work on them like on any paused card. **Quit** only closes the desktop (no pausing; the normal scan finds what it cut off). The desktop is found by `scripts/desktop-quit.ps1`: the top-most ancestor of this host process with the same image name, an Electron or DeepSeek Harness executable that is not a child-type process; it stops that process first, then its tree. Windows only; DSH in a browser has no desktop, so both buttons answer `no-desktop` and nothing is paused. Both routes are always answered by this app, never forwarded to the hub.


### 6.7a Session numbers and the tip

- **Session numbers.** Each app reports `{ working, open }` (its sessions with a turn running / open sessions, `sessions.js`) to the hub: in the register body, then through the existing `presence` agent call (`{ sessions }`) every 4 s when the numbers changed. An older hub ignores the extra field; an older agent reports none and adds 0. `hub/instances.js` keeps the last numbers per instance (whole numbers, working not above open, copied) and `sessionsTotal()` sums the instances that are online (away or gone adds nothing; `undefined` when none reports). The hub snapshot carries `sessions` when known. The sum never moves `snapshotId`; `hub.onChange` also fires when it changes so long polls wake, and the long-poll token's fifth part (`<working>/<open>`) is compared when the client sends it (clients that send only the old four parts are never given full snapshots for it).
- **Is anybody looking?** The apps only keep their numbers fresh while somebody looks: a phone polling the hub (device role) or a desktop overlay that is open (its proxy adds `watch=1`) sets `hub.noteWatch()`; the `register` and `presence` answers carry `watch: hub.watching()` (true for 60 s after). The agent (`sessionsWatch`) touches its counter only while that is true (only `watch === true` counts; an older hub sends no `watch`, so an app on a new version against an old hub lists no sessions and the header count stays hidden: the hub must be restarted onto the new version, PROTOCOL is unchanged) and then posts presence only on a change or every 30 s; while nobody looks it posts a number-less presence every few seconds to notice a first look (one call at a time; after 3 answers in a row that say nobody looks every 15 s, so a first look can take up to 15 s to show numbers; a change to report or a watcher brings the short interval back). The hub wakes its long polls for the numbers at most once per 3 s, with the final sum (one trailing timer); a change of an app's own numbers never wakes its hub-mode long poll (its screen shows the hub's sum), only a standalone one.
- **Tip of the day.** Produced by the local app's service only (its model, its speaker). In hub mode the proxy (`agent/proxy.js`) adds `queue.tip()` to the snapshot it serves to its desktop panel when the hub's own last full answer says the merged list is empty and the poll has `tip=1` (the agent's mirror is only a hint before there was such an answer), judges the token's sixth part itself and keeps `POST /v1/read-tip` local (`LOCAL_ROUTES`; the hub answers 403 `local-only`). The hub and the phone never see a tip.

### 6.8 Chat thread and follow-up posts (`thread`, `post`)

The phone's chat view of a session ([mobile.md](mobile.md) "Chat thread"). Two owner actions with the same URL layout as `reply`; both are on `DEVICE_ACTIONS` (the phone) and open to the desktop role. Neither needs the item to be open (`OWNER_ACTIONS` value `false`, like `late-answer`): a resolved item's session can be read and continued. Code: [thread.js](../thread.js) (log reading), `thread` and `post` in [service.js](../service.js), the commands in [agent/executor.js](../agent/executor.js), routing in [hub/routing.js](../hub/routing.js).

```
POST /review-queue/v1/thread {id, before?, limit?, after?}   // command thread, hub timeout 15 s, args {before, limit, after, sessionId} (sessionId: the item's, added by the hub)
  -> 200 { ok: true, sessionId, title, messages: [{ id, role: 'user'|'assistant', text, time?, truncated? }], hasMore, cursor? }
  -> 200 { ok: true, unchanged: true }   // only for `after`: the newest message of the log is that id
POST /review-queue/v1/post   {id, text}              // command post, hub timeout 35 s, args {text}
  -> 200 { ok: true }
```

- **thread.** The last `limit` (default 40, clamped 1 to 100) text messages of the item's session, oldest first, read by the owning app from `~/.dsh/sessions/--<cwd>--/<id>/session.v4.jsonl.zstd` (the folder the paused scan reads; [paused.js](../paused.js) `parseLog`). User messages without a source or with source `user`, and the text parts of assistant messages (joined with a blank line); never tool calls, tool results, thinking or hook / system notices. `id` is the index of the record in the log, stable while the log only grows; `before` returns only messages with a smaller id; `cursor` is the id of the oldest message returned (pass it as `before` for the page before; `hasMore` says there is one). A text over 4000 characters is cut and marked `truncated: true`. A half-written last frame (a live session) still gives what was read. The newest messages of a log (at most 501, `MAX_KEPT_MESSAGES` = `MAX_THREAD_DEPTH` + `MAX_LIMIT` + 1, plus their total count) are cached, one entry per log file (8 files, keyed by path; a changed file replaces its entry); a log that only **grew** (larger file, and its old end, the end of the last complete zstd frame, starts a new frame) is read and decoded from that offset on, with the record indexes (message ids) continuing, a torn last frame is not counted and is read again once it is complete, and anything else (shrunk, replaced, same size with another mtime, a failed or short ranged read) is parsed in full; the answers are those of a full parse. Any request for a log (whatever `before` and `limit`) is answered from the messages of its last read for max(3 s, 5 x the duration of that read), at most 30 s, per log file, so the phone's 5 s refresh does not re-read an unchanged log, varying the paging arguments does not bypass it and a live log is not decoded on every poll; concurrent requests for one log share one read; each frame is decoded with a 32 MiB output cap and all frames of one log together with a 64 MiB cap (over either: `too-large`). The session id must match `^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$` ([thread.js](../thread.js) `isSessionId`, also applied to the `sessionId` the hub carries). Surface replacement records (`surfaceOp` replace) are skipped. `title` is the item's session title. Works for every item that has a session, open or resolved, except a `todo`.
- **after (unchanged answer).** For the newest page only (no `before`): `after` is the id of the newest message the phone already shows. When the newest message of the log **is** that id, the answer is `{ ok: true, unchanged: true }` and no page is sent (the phone polls every few seconds; a page is 12 to 41 KB). Any other case gets the normal page: a newer message exists, `after` is not a non-negative integer, an empty log, or `after` is newer than anything in the log (the log was replaced; stricter than "no message newer than `after`", so the phone never keeps messages that no longer exist). A message's text never changes once logged (ids are record indexes of an append-only log), so the id alone says whether anything changed. The decision is made in `service.thread`; the log reader gets no `after`, and the executor, the agent's hub queue and `argsFor` only pass it on (as the other paging arguments, omitted when not given).
- **post.** Queues `text` as a prompt of the item's session through the same `controller.prompt` path and limits as `reply` (trimmed, at most 4000 characters). An item that is **open and of type `completed`** is resolved `{kind:'replied', by:'card'}` exactly like `reply`; any other item (another type, or already resolved) keeps its state. **A session takes one post at a time, whatever the item:** while a post for a session id is on its way (awaiting `controller.prompt`) another post for the same session, through any item of it, open or resolved, answers `busy`; the mark is per session id and is released when the prompt ends, whatever its outcome (`reply` is not covered by it). **Idempotency key.** The phone sends `key` with every post: a string of 1 to 64 characters of `[A-Za-z0-9_-]` (anything else is ignored, not an error; [post-key.js](../post-key.js) `postKeyOf`, applied by the hub routing and again by the service). It travels `/v1/post` body, hub routing (`argsFor.post`), the executor, `service.post(id, text, { key })`. The service keeps the last 200 keys of the last 10 minutes in memory (a restart forgets them): a repeat of a key whose first attempt was **accepted** (`{ ok: true }`) answers `{ ok: true, duplicate: true }` without prompting the session again (item state is not touched again); a failed attempt is not remembered, so its retry prompts normally, and a repeat that arrives while the first attempt is still on its way answers `busy` (only an accepted attempt is remembered). The phone makes one key per composed message and reuses it for retries of the same text after an error or a timeout; after an accepted post, or when the text changes, it makes a new one. A **`paused` item takes no post** (open or resolved): answer `paused`, nothing is prompted, because resuming one is `paused-resume` (guard, `markHandled`, resolve; desktop only). Its thread can still be read. A `todo` or an item without a session is refused.
- **Executor and agent client.** `thread` is a read and idempotent: the agent's executor runs it at once, outside the serial command chain, and does not store its result in the 200-entry cid cache; the agent client ([agent/client.js](../agent/client.js)) likewise runs `thread` commands beside its one-at-a-time command line (at most 2 reads in flight, the others wait among the thread commands only; at most 8 wait, the next one is answered `busy` at once; a waiting command whose `deadline` has passed is dropped without an answer, the hub having answered it at its own timeout; a read that has not settled after 20 s gives its slot back and its late result is discarded), so a slow read never delays an approve and never waits behind one; `post` (like every accepted command) is serialized and cached by cid.
- **Errors** (mapped like server.js `outcome()`): `thread`: 409 `not-found` (no such item), `no-session` (a todo, or an item with no session id), `no-log` (no log file for the session on this PC), `too-large` (compressed log over 8 MiB, the thread's own cap, `maxLogBytes` overrides it; or a frame that decodes to over 32 MiB), `no-zstd` (this Node has no zstd), `unreadable`, `no-reader`; `thread` can also answer `busy` (the agent already has 8 reads waiting); `post`: 400 `empty`, `too-long`; 409 `not-found`, `not-a-session`, `paused` (a paused item: resume it at the PC), `busy` (a post for the same session is on its way), `no-session` (this app's controller does not know the session), `no-controller`, `post-failed` (any other failure of the controller; never its text). Routing errors as for any owner action: `owner-offline`, `owner-away`, `owner-timeout`, `unknown-outcome`.
- **Security note (set `allowedTailnetLogins`).** A paired phone can now prompt any item's session (`post`) and read transcripts (`thread`), not only answer or approve one card, so `allowedTailnetLogins` in `hub.config.json` should be set to your own login (section 9.5, open question 4) and the tailnet ACL should allow only your phone. Limits and traces: a todo is refused by the hub before anything is sent (`thread`: `no-session`, `post`: `not-a-session`); the paging depth is capped by `MAX_THREAD_DEPTH` = 400 ([thread.js](../thread.js)): a `before` cursor with more than 400 messages at or after it answers `{ ok: true, messages: [], hasMore: false }`, so a device reads the recent conversation and cannot dump a whole transcript (a page that starts 400 back can still reach up to its `limit` further); every post of a phone leaves one line in the hub log, `post: device <deviceId> item <itemId> chars <n>` (written in [hub/http.js](../hub/http.js) where the device is known, never the text); a controller failure reaches the phone only as the fixed code `post-failed` (the code or name is logged as `post: <code>`; `reply` shares this); a `post` that is retried with the same idempotency `key` after `unknown-outcome` (the command was delivered, the answer never came back) or a timeout is not prompted twice: the app answers `{ ok: true, duplicate: true }` when the first attempt had been accepted (a retry without a key, or with a changed text, is a new message). **Write access (user decision, 2026-10-19):** the phone's write access now spans every session-bearing item (questions, permissions, done, paused, pr-merged and resolved items), not only done cards, and setting `allowedTailnetLogins` is strongly recommended.
- **Routing.** An item with an owner goes to its owner like any action, resolved or not. An **ownerless open** item: `thread` behaves like `open-session` at its special case in `actOnOrphan`: it is sent to the coordinator **without adopting the item** (no `apply` / `adopt`, no `setOwner`), and the coordinator's answer is returned as it is. The command carries the item's `sessionId`: the coordinator's own store does not hold the item, so `service.thread` reads that session (empty `title`) when the local store has no such item. The standalone `/v1/thread` route never takes a `sessionId` from its body. `post` takes the orphan path of `reply` **only for an open `completed` item** (posting resolves it as replied): the coordinator is handed the item, runs the command and keeps the item on success; on a refusal the item stays ownerless and `post` answers `session-unavailable` where the app does not know the session. For an ownerless open question, permission, paused or merged-PR item `post` answers `session-unavailable` at once, without adopting it or sending anything (`reply` keeps its old path). An **ownerless resolved** item has nobody to ask: 409 `owner-offline`.

## 7. Data model and persistence

Single writer: only the hub process writes `hub/*`; agents write only their own `local/<instanceKey>.json`.

| File (under `~/.dsh/review-queue/`) | Writer | Content |
| --- | --- | --- |
| `hub.json` | hub | `{pid, port, hubId, version, protocol, startedAt}`; written after listen succeeds, removed on clean exit only if it names this pid |
| `hub.lock` | launcher | created with flag `wx`: `{pid, ts}`; removed by the hub once listening |
| `hub.secret` | first launcher / hub | 32 random bytes base64url, ACL restricted (9.3); created if absent, never rotated automatically |
| `hub.config.json` | user | `hubPort, publicUrl, allowedTailnetLogins[], staleGraceMs, android:{packageName, sha256CertFingerprints[]}, pushSubject` (VAPID subject; unset: the https `publicUrl` origin, else `mailto:dsh-review-queue@localhost`); no secrets |
| `hub/queue.json` | hub | `{v:2, epoch, seq, rev, items[], instances[{key,id,label,lastSeenAt}]}`; keeps the last good copy as `queue.json.bak` |
| `hub/devices.json` | hub | device records: `id, name, tokenHash(sha256), createdAt, lastSeenAt, lastLogin, push:{endpoint,keys,types,quiet,lastSuccessAt,lastError}, revokedAt` (subscription endpoint/keys never leave through the API) |
| `hub/vapid.json` | hub | VAPID pair, imported from the old `vapid.json` so existing subscriptions stay valid |
| `hub/hub.log` | hub | size-capped via [filelog.js](../filelog.js), no secrets (9.6) |
| `local/<instanceKey>.json` | agent | that instance's own items (v1 format of [store.js](../store.js)) plus its op counter; the durable outbox and the standalone-mode store |

**Writes**: temp file `<name>.<pid>.tmp` in the same directory, then rename over the target (atomic replace on NTFS), **debounced** (200 ms, forced at 1 s, flushed on shutdown) because the file is already 620 KB and `save()` in [store.js](../store.js) writes it on every change; a corrupt file loads the `.bak` (TEST: truncated queue.json). Pairing codes, command queues, presence and the workspace union are memory only.

**Item (additive)**: today's fields ([store.js](../store.js): `id, seq, type, status, createdAt, resolvedAt, resolution, sessionId, sessionTitle, workspace, payload, summary, key, ...`) plus `owner`. **Instance**: `{id, key, label, pid, protocol, pluginVersion, state, lastPollAt, lastSeenAt, cmdSeq, lastOp, workspaces, sessionIds}`. `instanceKey` = sha256 of the DSH home directory plus this app's web port (H2 checks what `ctx` exposes; else pid-based and no adoption). `label` = config `instanceLabel` or "DSH :<port>".

## 8. Lifecycle

Live check (2026-10-16): after two DSH restarts the hub snapshot held `paused` items for three cut-off sessions (open turn with a dangling `run_code`), Resume from the card prompted the existing session with the resume prompt and the item closed as `resumed` (the sessions continued), and a later scan closed one item as `recovered` after the user had typed into the session. Two apps listed the same session once each (one item per owner); the second scan reconciles them.

### 8.1 Start, lock, discovery
```
ensureHub():                                        // called from apply() and every 60 s while degraded
  info = read hub.json
  if info and health(info.port) answers {ok, hubId == info.hubId}: return info
  if exists hub.lock:
      if holder pid alive and age < 30 s: wait up to 10 s for hub.json + health; return it   // TEST: two instances race
      else delete stale lock
  create hub.lock with 'wx'  (EEXIST: loop above)   // the port bind in main.js is the real mutex, the lock only avoids a spawn storm
  spawn(nodeExe, [hub/main.js, '--state-dir', dir], {detached:true, stdio:['ignore', logfd, logfd], windowsHide:true, env: minimal}).unref()
  poll health every 150 ms up to 10 s; fail -> 'unavailable' (reason in log + notice), the lock is removed
main.js: bind 127.0.0.1:port; EADDRINUSE -> if health ok exit(0) else exit(2) 'port taken by another program'
         after listen: write hub.json, remove hub.lock
```
`nodeExe` resolution: config `hubNode`, else `process.execPath` when `process.versions.electron` is absent, else `node` found on PATH, else Electron's exe with `ELECTRON_RUN_AS_NODE=1` (H2 verifies which process hosts the plugin). Differences from the former STT launcher (removed 2026-10-16): atomic `wx` lock instead of a timestamp file, pid liveness, a health nonce (`hubId`) so a foreign program on the port is not mistaken for the hub, and no 120 s blind window.

### 8.2 Upgrade, version skew
- `protocol` is one integer (starts at 1). The hub speaks `[protocol-1, protocol]`; agents send `X-RQ-Protocol`. All instances load the plugin from the same linked folder, so skew exists only between *running* processes started before and after an update.
- **New plugin, older hub**: if `hub.protocol < plugin.MIN_HUB_PROTOCOL` the agent calls `POST /hub/v1/shutdown {reason:'upgrade'}`, waits, `ensureHub()`; it never downgrades (only a strictly newer plugin protocol may restart the hub), so an old instance cannot thrash it. Same protocol, other build: tolerated; the support script and a "Restart hub" action on the devices page restart it on demand (no auto-restart on file change: it would drop phone long-polls and in-flight commands).
- **Old plugin, newer hub**: hub answers 426 `upgrade-required`; that agent runs standalone with the notice "hub is newer, restart DSH". Pre-hub plugin builds never talk to the hub and keep their old standalone server.
- Agents reconnect on their own (backoff 1 s to 10 s) after a hub restart and resync; phones just see a reconnect banner.

### 8.3 Shutdown
Hub: SIGINT/SIGTERM, or `shutdown` with the secret: stop accepting, answer long-polls with `503 shutting-down`, flush stores, remove `hub.json` if it is its own, exit. Idle exit after 12 h with no agent and no device request (the next instance restarts it). Agent (`ctx.effect` cleanup): `bye`, stop loops, never kills the hub. Windows logoff ends the hub with the session (started once per login).

## 9. Security

### 9.1 Threat model
Tailnet peers are semi-trusted (any device in the tailnet can reach the HTTPS name); the phone can be lost; local malware running as the same Windows user is out of scope (it could read the secret and DSH's own files too). Assets: the ability to approve commands in agent sessions, the reply text, push endpoints.

### 9.2 Roles and credentials
| Role | Credential | May |
| --- | --- | --- |
| public | none | `GET /hub/v1/health` (minimal), `/.well-known/assetlinks.json`, static `/review-queue/m/*` (no data), `POST /hub/v1/pair` |
| device | `Authorization: Bearer rqd_...` | snapshot, item actions (via forced to phone), start / confirm / cancel todos (`todo`, `todo-confirm`, `todo-cancel`), read the chat of a session and post a follow-up (`thread`, `post`, 6.8) and read `GET /v1/workspaces` for the todo dropdown, own push settings, `GET /hub/v1/session`. **Never** `open-session` (a session is opened at the PC) nor any other action: 403 `desktop-only` |
| desktop | agent secret + `X-RQ-Role: desktop` from an instance proxy (the user passed DSH's login there) | everything a device may, plus create pairing code, list/rename/revoke devices, restart hub, `client=desktop` presence |
| agent | agent secret | register, ops, sync, commands, results, presence, bye, shutdown |

### 9.3 Secrets and files
Agent secret: 256 bits from `crypto.randomBytes`, compared with `timingSafeEqual`. `mode: 0o600` means nothing on Windows, so after writing the launcher runs `icacls <file> /inheritance:r /grant:r "<DOMAIN\user>:(R,W)"` (same for `hub/devices.json`, `hub/vapid.json`); failure is logged and shown on the devices page as "file permissions could not be tightened". Device tokens are 256-bit, shown once, stored as SHA-256 only; lookup by hash.

### 9.4 Pairing, revoke
```
POST /hub/v1/pairing-codes (desktop)  -> code = 8 chars Crockford base32 (40 bits), ttl 5 min, single use, one active code;
                                         page shows code + URL https://<publicUrl>/review-queue/m/#/pair  (QR optional, code only in the fragment)
POST /hub/v1/pair {code, name}        (public)
  if ratelimited(ip from X-Forwarded-For when peer is loopback, plus a global bucket 10/min): 429 Retry-After
  active = current code; if none/expired: delay, 400 bad-code                        // same answer for wrong, expired, used
  if !timingSafeEqual(sha256(normalize(code)), active.hash):
      active.tries++; if tries >= 5: invalidate;  delay 0.5 s * 2^fails (cap 8 s);  400 bad-code      // TEST: 6th guess never succeeds
  consume code; token = 'rqd_' + b64url(random32); device = {id, name<=40, tokenHash, createdAt, lastLogin = Tailscale-User-Login header}
  persist devices.json, then respond {deviceId, token, name}   // the only time the token exists in clear
request auth: sha256(token) -> device; revoked or idle > 180 d -> 401 auth-required; update lastSeenAt (throttled)
revoke (desktop): device.revokedAt = now; delete its push subscription; abort its open long-polls; persist   // takes effect on the next request at the latest
```
The phone stores the token in localStorage of the Chrome origin (shared by TWA and tab) and sends the header on fetch; no cookie, so classic CSRF does not apply, but state-changing calls still require `Content-Type: application/json` and an `Origin`, when present, in the allow-list.

### 9.5 Other controls
- **Network**: bind 127.0.0.1 only. **Host allow-list**: `127.0.0.1:<port>`, `localhost:<port>` and the configured `publicUrl` host (DNS rebinding). Optional `allowedTailnetLogins`: `Tailscale-User-Login` (set by serve, trusted only for loopback peers) must match; recommended on (Q4).
- **Approvals**: the existing confirm sheet, press-and-hold for risky items and server-side `via/confirmed/held` checks stay, now keyed off the credential (D8); `approve-similar` never for risky ones; Origin check on every POST.
- **Rate limits**: pairing as above; per device 120 requests/min excluding the snapshot long-poll; body cap 64 KB as today; push subscribe keeps the SSRF guard in [push.js](../hub/push.js) (no private hosts).
- **Push content**: counts and types only on the lock screen, as in [mobile.md](mobile.md).
- **The assetlinks file** is public by design; it holds package name and a certificate fingerprint only.

### 9.6 Logging
No tokens, pairing codes, secrets, push endpoints, command text, replies or titles in logs; device ids and item ids only; `Authorization` never echoed; error bodies are codes. TEST: a log-scan test over a full integration run (grep for the generated secret, a token and a code).

## 10. Failure modes and fallback

Instance mode machine: `starting -> hub | standalone`; `hub -> degraded` on hub loss; both degraded states promote back to `hub` after a successful `ensureHub()` + full sync. The local service ([service.js](../service.js) over the instance's own store) is always alive, so nothing is lost.

| Failure | Behaviour |
| --- | --- |
| Hub cannot start (no node, port taken, spawn error) | **Standalone**: today's behaviour on the instance's own items; proxy answers from the local service; snapshot carries `notice:{level:'warn', text:'Phone sync is off: hub not running (<reason>). This app shows only its own items.'}`; retry `ensureHub` every 60 s (backoff to 10 min); reason in `review-queue.log` |
| Hub dies while connected | Agent keeps captured items in its local store/outbox, keeps pending handlers; proxy serves the last mirror plus own items with a notice "hub unreachable"; desktop actions on **own** items run locally and are queued as ops; other apps' items are shown read-only; on return: register, sync, revival rules |
| Owner not polling (away/gone) | 409 `owner-away/owner-offline`; cards show the reason; reviewed/reopen still work (hub-local) |
| Command lost (response dropped) | cid idempotency; the client re-reads the snapshot; `unknown-outcome` is never shown as success |
| Duplicate hubs (two spawn at once) | the second fails to bind and exits; both agents use the one in `hub.json` |
| Corrupt hub/queue.json | load `.bak`, else start empty and let every agent resync (their local stores hold the live items) |
| Clock jump / laptop sleep | grace clocks use the hub's monotonic time; revival on wake |
| Tailscale down / phone offline | phone shows its connection banner; nothing else affected; push still arrives via FCM and opens the app once the VPN is back |
| Old/new protocol mismatch | 8.2 |
| Hub on a stale build | tolerated within the protocol window; manual restart |

## 11. APK (Trusted Web Activity)

### 11.1 Layout and rationale
`dsh-review-queue/android/`: keeps the origin config, assetlinks and docs next to the code they depend on, one place to version together; the [package.json](../package.json) `files` whitelist keeps it out of the installed plugin (the DSH install is a `link:` of this folder, so build output must not be mistaken for plugin code: `android/.gitignore` covers `build/ .gradle/ local.properties keystore.properties *.jks *.keystore`). The sibling-directory alternative was rejected: the repo root is "one folder per DSH plugin".
```
android/
  settings.gradle.kts  build.gradle.kts  gradle.properties  gradlew  gradlew.bat  gradle/wrapper/*
  app/build.gradle.kts            compileSdk 36, targetSdk 36, minSdk 26, namespace, applicationId from props
  app/src/main/AndroidManifest.xml   LauncherActivity (DEFAULT_URL, LAUNCHING_BROWSER=com.android.chrome,
                                     asset_statements, ADDITIONAL_TRUSTED_ORIGINS if any), DelegationService (notification
                                     delegation, behind a boolean resource), POST_NOTIFICATIONS; no autoVerify, no INTERNET
  app/src/main/res/values/strings.xml  generated by build.ps1 from the hub URL; icons from lib/mobile/icon-512.png via scripts/make-icons.mjs
  build.ps1  install.ps1  fingerprint.ps1  adb-check.ps1  README.md
  keystore.properties.example      storeFile / storePassword / keyAlias / keyPassword (real file untracked)
```
Dependency: `implementation("com.google.androidbrowserhelper:androidbrowserhelper:2.7.4")`; AGP 8.13.x, Gradle 8.13 (re-check the pairing at H5), JDK 17 (11.2).

### 11.2 Build, sign, install
1. One time: JDK 17 unzipped (path in untracked `android/local-tools.json` or env `RQ_JDK17`); wrapper bootstrap (3); `sdk.dir` in untracked `local.properties`; if AGP needs to install anything, copy the SDK pieces to a writable folder and point `sdk.dir` there (R6).
2. Keystore, outside the repo: `keytool -genkeypair -v -keystore %USERPROFILE%\.dsh\review-queue\android-signing\rq-release.jks -alias rq -keyalg RSA -keysize 2048 -validity 10000`; `keystore.properties` (untracked) holds the path and passwords. `fingerprint.ps1` prints SHA-256 of the release and debug certs (`keytool -list -v`) and writes them into `hub.config.json` so `/.well-known/assetlinks.json` lists both.
3. `build.ps1 -Release`: sets JAVA_HOME, runs `gradlew.bat assembleRelease`, verifies with `apksigner verify --print-certs` (build-tools 35.0.0), prints the APK path and fingerprint.
4. `install.ps1`: `adb install -r app-release.apk` (phone USB debugging on, or wireless adb), or copy the APK to the phone and open it (allow "install unknown apps" for the file manager once).
5. First run: Tailscale on, open the app, pair with the code from the desktop page, allow notifications.

### 11.3 M0 spike: decision gate before 11.1-11.2
Throwaway: 30-line Node server answering `/.well-known/assetlinks.json`, a manifest and a page with a service worker, behind `tailscale serve`; a minimal TWA built from 11.1 with the **debug** keystore. Phone: SM-S918U, Android 16, Chrome (record version), Samsung Internet default (the worst case).

| Test | Pass |
| --- | --- |
| T1 | https name loads on the phone over the tailnet, valid certificate, service worker registers |
| **T2** | right fingerprint, **no flag, tailnet-only host**: the app opens full screen without an address bar (proves on-device verification) |
| T3 | wrong fingerprint: address bar shows (proves the check is live, not cached) |
| T4 | only if T2 fails: with the chrome-command-line flag full screen; note whether it survives phone reboot and Chrome restart |
| **T5** | Web Push from the test server to the TWA with the screen off; tap opens the right fragment URL; run once with and once without `DelegationService`; note permission prompt (Android vs Chrome) and who owns the notification |
| T6 | localStorage token survives closing/reopening the TWA and is shared with a Chrome tab |
| T7 | Samsung Internet default does not hijack the launch (LAUNCHING_BROWSER pin works) |
| T8 | adb install works on Android 16; Play Protect / developer-verification prompts noted |
| T10 | the app (TWA/WebAPK) sends the mobile user agent and innerWidth is about the device width (CSS px ~384 on SM-S918U); the in-page view guard (lib/mobile/view-guard.js) shows no warning |
| T11 | mic button works in the TWA: permission prompt, text lands in the box, nothing is sent |
| T12 | iPhone: Add to Home Screen, opens standalone in mobile layout, pairing, queue, answer, reply with mic (no auto-send), New todo, push arrives (iOS 16.4+, installed app only) |

**Gate**: T2 and T5 pass: build the real APK (H5), delegation on if T5 shows it better. T2 fails but T4 passes: ask the user whether a flag-dependent TWA is acceptable. Otherwise **fallback F1**: the APK is a Custom Tab launcher (no DAL needed; address bar visible, push through Chrome) or **F2**: plain Chrome "Add to Home screen" PWA only (needs a WebAPK; Google's minting service may be unable to fetch a private host's icons, so Chrome may create only a shortcut: unverified, test as T9). F1/F2 drop the assetlinks work but the hub, pairing and push stand unchanged.

### 11.4 Results of the first build and emulator run (2026-10-15, H5 part 1)

Versions: Gradle 8.13 (wrapper jar from the gradle/gradle v8.13.0 tag), AGP 8.13.2, JDK 17 (`C:\Users\awang\tools\jdk-17`), `androidbrowserhelper` 2.7.4 with its own androidx.browser 1.10.0 / core 1.17.0, **compileSdk and targetSdk 36** (platform 36 installed with sdkmanager; build-tools 35.0.0), minSdk 26. Chrome on the emulator 133.0.6943.137.

Findings that changed the code:
- The earlier pins (browser 1.8.0, core 1.16.0, compileSdk 35) built green but **crashed at launch**: `NoSuchMethodError WindowCompat.enableEdgeToEdge` (the library calls core 1.17.0). Pins removed, compileSdk/targetSdk 36 (the version assertion in `test/android-project.test.mjs` was the only test edit).
- The library then crashed with `ManageDataLauncherActivity does not exist`; the manifest now declares it (Bubblewrap does the same) and sets it as `manageSpaceActivity`.
- Hub restart: `POST /hub/v1/shutdown` needs `Content-Type: application/json` (a body-less request gets 415 and nothing happens).

| Test | Result | Why / evidence |
| --- | --- | --- |
| T1 https name loads over the tailnet, service worker | NOT RUN | needs the phone on Tailscale; the emulator reached the hub over `adb reverse` on loopback only. The PWA page itself loaded on the emulator (queue list, todos) |
| T2 verified full screen, no flag | NOT RUN | needs the real phone and the https name. On the emulator the loopback URL cannot be verified (Chrome: `Verification failed ... as not https or localhost`), so it fell back to a Custom Tab with an address bar, as expected for localDebug |
| T3 wrong fingerprint shows the address bar | NOT RUN | real phone |
| T4 flag fallback | NOT RUN | only if T2 fails |
| T5 Web Push into the TWA, delegation on/off | NOT RUN | real phone, Tailscale, screen off |
| T6 localStorage token survives and is shared with Chrome | NOT RUN | real phone (the emulator page ran in a Custom Tab, a different case) |
| T7 Samsung Internet does not hijack launch | NOT RUN | needs the Samsung (LAUNCHING_BROWSER is pinned to Chrome; the emulator launch went to Chrome) |
| T8 adb install works on Android 16 | PARTIAL | adb install of the localDebug APK succeeded on the Android 16 (API 36) emulator; the Samsung R5CW30PD58H was not connected, Play Protect / developer verification not observed |
| T9 WebAPK / Add to Home screen | NOT RUN | only if F2 is needed |
| T10 mobile user agent, innerWidth | NOT RUN | real phone (emulator Custom Tab not measured) |
| T11 mic button in the TWA | NOT RUN | real phone |
| T12 iPhone | NOT RUN | no iPhone |
| Build debug / release / localDebug | PASS | all three assemble; `apksigner verify --print-certs` OK; debug and localDebug use the debug key, release the `rq` key |
| Launch on pixel7_api36 (localDebug) | PASS with fallback | `TwaLauncher: Launching Trusted Web Activity` then Chrome verification failed for the loopback http origin, so a **Custom Tab** (address bar, X button) showed the PWA task list; `adb-check.ps1` reports `TRUSTED_WEB_ACTIVITY` as the requested mode and `address bar on screen: yes`. Chrome needed its first-run screen dismissed once |
| assetlinks | PASS | `/.well-known/assetlinks.json` lists `dev.dsh.reviewqueue` with the release and debug SHA-256 fingerprints after the hub restart |

Gate: T2 and T5 are still the decision. The APK is ready for them: install the **release** or **debug** APK (https start URL from `hub.config.json` `publicUrl`) with `android/install.ps1`; on the phone, Tailscale must be on, because the https name resolves only there.

## 12. Migration
1. First hub start: if `hub/queue.json` is missing and `queue.json` (v1) exists: copy to `hub/queue.v1-import-<ts>.json`, load items; open question/permission items become `session-ended` (their promises died with the old process); completed, pr-merged, todo stay open as orphans (6.3 adoption by session id). Resolved items keep their 7-day retention. The old file is left untouched (an old plugin build may still write it; the import runs once).
2. `vapid.json` (exists today) copied to `hub/vapid.json` so subscriptions stay valid; `push.json` (absent today) imported as legacy devices without token if it appears: they keep receiving pushes, cannot poll; a paired device that subscribes with the same endpoint absorbs the record.
3. Agents: first run creates `local/<key>.json`; if none exists and the hub is unreachable, load the legacy `queue.json` read-only once so nothing seems to vanish.
4. Docs to update in H6 (not touched now): [mobile.md](mobile.md) (decisions Reach, Sign-in, Lost phone, trusted host), [README.md](../README.md) (config table, API table, state files), [spec.md](spec.md) pointer.

## 13. Test strategy (node:test, tests first, as the repo does)
- **Unit** (fake clock, in-memory io): hub-store ordering/prune/rev/persistence and `.bak` recovery; instances (away, gone, settle, adoption, revival); commands (routing, timeouts, idempotent redelivery, unknown-outcome); http (roles, Host/Origin, rate limits, error mapping equals [server.js](../server.js) `outcome()`); devices (pairing, 5-try lock, revoke, idle expiry, hash at rest); notifier (type, hold, actionable gate; reuses the [push.test.mjs](../test/hub-push.test.mjs) and [webpush.test.mjs](../test/hub-webpush.test.mjs) vectors after the move); assetlinks JSON; launcher (lock race, stale lock, foreign port, nodeExe resolution) with injected fs/spawn/probe like the former STT launcher's tests.
- **Contract**: `test/hub-api-contract.test.mjs` runs the existing [server.test.mjs](../test/server.test.mjs) and [phone-approve.test.mjs](../test/phone-approve.test.mjs) cases against the proxy-to-hub path, so the overlay's API is provably unchanged. Existing 440 tests stay green at every slice.
- **Integration (in process)**: `createHub({port:0})` + **two fake agents** built from the real `agent/client.js` over a fake capture: A and B add items, ordering and global positions, phone approve of A's permission routed to A only, B restarts (same key, new id: its question gone, completed adopted), A sleeps (revival), hub restart mid-run (resync, no loss), hub killed (standalone notice, items kept, promotion back), protocol skew (426 path), log-scan for secrets.
- **Process-level**: spawn `node hub/main.js` on a random port with a temp state dir: lock race with 3 launchers, singleton on a busy port, clean shutdown removes hub.json.
- **UI**: the dev server ([scripts/dev-server.mjs](../scripts/dev-server.mjs)) gains a hub mode; Playwright phone viewport for the pairing screen and the "owner offline" card.
- **adb** (`android/adb-check.ps1`, real phone): `adb devices`; `adb shell pm list packages | findstr <pkg>`; `adb shell dumpsys package <pkg>` (signature, version); `adb logcat -d -s TwaLauncher` (the library logs the launch mode: TRUSTED_WEB_ACTIVITY vs CUSTOM_TAB); `adb exec-out screencap -p` saved and looked at for the address bar; `adb shell dumpsys notification --noredact` to see the pushed notification and its owner; manual checklist from [mobile.md](mobile.md) M5 (approve a risky item with the hold, multi-question, archive).

## 14. Phased plan (each slice: RED tests, GREEN, full suite; one subagent each)

| Slice | Scope | Entry | Exit | Effort | Main risks |
| --- | --- | --- | --- | --- | --- |
| **M0** spike (parallel to H1; needs ~1 h of the user's phone) | 11.3 on a throwaway server and debug-signed minimal TWA; tailscale serve; JDK 17 install | JDK 17 + wrapper available | T1-T8 recorded in a short result note; gate decided | 0.5 day + user time | JDK/SDK setup (R6), Chrome flag, Samsung browser |
| **H1** hub core | `hub-store, snapshot long-poll, client read API, persistence, health, hub.json, main.js, static + assetlinks`; no agents yet (test feeder) | this doc approved | hub runs standalone, unit + process tests green, migration import tested | 1 day | write cost of 620 KB file, port choice |
| **H2** agent bridge | `agent/client, store-adapter, executor, hub-queue`; register/ops/sync/commands/results; instances (away/gone/adopt/revive); agent secret auth; hub-side command routing and risk gate | H1 | two-fake-agent integration test green; the real plugin can run against a local hub in a dev profile | 2 days | store-adapter fidelity (capture/todo expect sync store), instanceKey, todo split |
| **H3** proxy + lifecycle + fallback | `agent/proxy, launcher`, `apply()` wiring, D7 local routes, workspaces union, overlay delta (6.6), degraded modes, protocol skew | H2 | contract tests green; kill-hub and start-without-hub scenarios pass; desktop A and B show the same list in the real apps | 1.5 days | Electron/Node spawn, overlay snapshot token merge, voice service sync reads |
| **H4** auth, pairing, devices, push | `devices.js`, pairing + desktop devices page (instance route), tokens in [lib/mobile/api.js](../lib/mobile/api.js) (pairing screen), move push files, `notifier.js` + presence, ACL hardening | H3 | pairing/revoke/rate-limit tests; real phone pairs over `tailscale serve` in Chrome and receives a push; lost-phone drill | 2 days | ACL via icacls, FCM from the hub's process, quiet-hours tests |
| **H5** APK | 11.1-11.2 (only if M0 passed or fallback F1) | M0 gate + H4 | APK installs by adb, opens verified full-screen, push + tap deep link work, adb-check green | 1 day | AGP/JDK/SDK on this machine, Play Protect, developer verification |
| **H6** review, docs, release | reviews (code, security, AI-pitfall), docs 12.4, README, real-device checklist, release note | H5 | all suites green, reviews clean, docs updated | 1 day | none new |

## 15. Open questions (only real ones, each with my recommendation)
1. **Port 47615** for the hub and **HTTPS 443** for serve? Recommend yes; if you may later publish DSH itself through serve, give the hub 8443 now so the TWA origin never changes.
2. **Grace periods**: question/permission of a vanished app resolved after 2 min, other items kept as orphans 24 h. Recommend these defaults, configurable.
3. **Presence needs the tiny overlay change** (`&visible=1`, banner, 3 error texts, 6.6). Recommend accept; the alternative is no desktop-presence hold (every push goes out).
4. **Restrict by Tailscale login** (`allowedTailnetLogins` = your login) and ideally a tailnet ACL allowing only your phone to reach this PC on 443. Recommend on, since peers are only semi-trusted.
5. **Notification delegation** in the TWA: recommend on if T5 shows it works (notifications become the app's, Android permission), else off.
6. **Phone-created todo with "Choose for me"** is coordinated by the most recently active desktop app. Recommend that; the alternative is requiring an explicit workspace on the phone.
7. **Hub restarts only on protocol bumps**, never on file change. Recommend yes (a manual "Restart hub" button covers dev).

## 16. Risks
R1 hub is a single point of failure for the phone (mitigated: standalone fallback, local stores). R2 plugin host is Electron and `process.execPath` is not Node (8.1 resolution order, test in H2). R3 TWA verification on a private host unproven (M0 gate, fallbacks). R4 Samsung Internet hijacks the launch (pin Chrome, T7). R5 Windows ACL commands may fail (reported, secret still loopback-only). R6 Android SDK folder read-only, no licences, only `source.properties`: copy to a writable SDK root and run `sdkmanager --licenses` with JDK 17. R7 dangling `JAVA_HOME` (set per run by `build.ps1`). R8 620 KB queue file makes naive per-change writes slow (debounce, measure in H1). R9 store-adapter divergence from [store.js](../store.js) semantics (contract tests in H2). R10 developer-verification rules for sideloaded apps may arrive in 2027 (adb stays; recheck at H5).

### 11.5 Results on the real phone (Samsung SM-S918U, Android 16, Chrome 155, 2026-10-16)

Release APK `dev.dsh.reviewqueue` (signed with the `rq` key, https start URL `https://awang-lpt2.taile1279d.ts.net/review-queue/m/`), phone on Tailscale.

Finding: the release APK first installed from a **stale build** (built before the `ManageDataLauncherActivity` manifest fix) and crashed at launch with `Component class ...ManageDataLauncherActivity does not exist`. `build.ps1 -Release` was re-run (JDK 17 at `C:\Users\awang\tools\jdk-17`); always rebuild before installing.

| Test | Result | Evidence |
| --- | --- | --- |
| T1 https name over the tailnet, service worker | PASS | page loads in the TWA, service worker `activated`, `isSecureContext` true |
| **T2** verified full screen, no flag | **PASS** | `adb-check`: last launch `TRUSTED_WEB_ACTIVITY`, address bar on screen: no; page `display-mode: standalone`; no Chrome flag set |
| T3 wrong fingerprint shows the address bar | NOT RUN | needs a build signed with another key |
| T5 push into the TWA, delegation on/off | **SKIPPED by the user (2026-10-16)** | see below |
| T6 token survives and is shared with Chrome | PASS (inferred) | `rq-m.token` present at first TWA launch although the TWA had never run before (paired earlier in Chrome); survives force-stop and relaunch |
| T7 Samsung Internet does not hijack launch | PASS | the TWA opened in Chrome's `CustomTabActivity` (Samsung Internet is installed) |
| T8 adb install on Android 16 | PASS | `adb install -r` succeeded; no Play Protect block observed |
| T9 WebAPK from Add to Home screen | PASS (observed) | Chrome had minted a WebAPK for the private tailnet host on 2026-10-15 (`org.chromium.webapk.ab16a329686517f8d_v2`) |
| T10 mobile UA, width, view guard | PASS | UA `Mozilla/5.0 (Linux; Android 10; K) ... Chrome/155.0.0.0 Mobile Safari/537.36`, `innerWidth` 384, no "Desktop site" banner |
| T11 mic in the TWA | PARTIAL | `SpeechRecognition` exists in the page; the permission prompt and dictation were not exercised (needs a tap) |

T5 notes:
- With the old WebAPK installed, a hub test push (`POST /review-queue/v1/push/test`, screen off, status Dozing) was accepted by FCM and shown **under the WebAPK package**, not the TWA: an installed WebAPK for the same origin wins over the TWA, so uninstall it before testing delegation.
- Uninstalling the WebAPK reset the notification permission to `default`. Chrome then showed its own prompt (delegation off: Chrome, not Android, asks). The prompt was dismissed, Chrome stored **denied** for the site, and the page stayed `denied` after a Chrome restart, also with delegation on and `POST_NOTIFICATIONS` granted through `adb shell pm grant`. adb taps are ignored on this phone and DevTools `Browser.setPermission`/`grantPermissions` have no effect on Android Chrome, so the site permission must be set by hand: Chrome ⋮ → Settings → Site settings → Notifications → Allow (or Clear & reset, then pair again).
- Decision (2026-10-16): the user skipped T5. Gate outcome: T2 passed, so the real APK ships with notification delegation **off** (`enable_notification_delegation` false); pushes go through Chrome. Delegation can be measured later by allowing the site's notifications and repeating the two runs.
