/**
 * Settings tab of the phone page: notifications on/off for this phone, its name, which types may notify, quiet hours, a test push and
 * the list of all registered phones (a lost phone is removed here or on the desktop). The rules live in push-client.js (unit-tested),
 * the server calls in api.js; this file is only the screen.
 */
import { html, useState, useEffect } from './vendor/preact-htm.js'
import { getCore, getToken, signOut, getPushPrefs, setPushPrefs, getDeviceId, setDeviceId, pushKey, pushSubscribe, pushUnsubscribe, pushTest, pushSettings, pushDevices } from './api.js'
import { PUSH_TYPES, urlBase64ToUint8Array, validateQuietHours, buildSubscribePayload, notificationStatus, subscribeFresh } from './push-client.js'
import { platformInfo, pushHint, isStandalone } from './platform.js'

const zone = () => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC' } catch { return 'UTC' } }
const supported = () => typeof navigator !== 'undefined' && 'serviceWorker' in navigator && typeof PushManager !== 'undefined' && typeof Notification !== 'undefined'
const messageOf = (e) => String((e && e.message) || e)

async function currentSubscription() {
  const reg = await navigator.serviceWorker.ready
  return { reg, sub: await reg.pushManager.getSubscription() }
}

export function SettingsView() {
  const [prefs, setPrefs] = useState(() => getPushPrefs(zone()))
  const [sub, setSub] = useState(null)
  const [permission, setPermission] = useState(supported() ? Notification.permission : 'unsupported')
  const [devices, setDevices] = useState(null)
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState(null) // { ok: boolean, text: string }
  const [quietError, setQuietError] = useState(null)

  const say = (ok, text) => setNote({ ok, text })
  const loadDevices = () => pushDevices().then(setDevices, (e) => { setDevices([]); say(false, 'Device list: ' + messageOf(e)) })
  useEffect(() => {
    if (supported()) currentSubscription().then((c) => setSub(c.sub), () => {})
    loadDevices()
  }, [])

  /** Runs one action with the busy flag and a visible error; the Notification permission prompt must start from the tap that calls this. */
  const run = async (fn) => {
    setBusy(true); setNote(null)
    try { await fn() } catch (e) { say(false, messageOf(e)) } finally { setBusy(false) }
  }

  const enable = () => run(async () => {
    const answer = await Notification.requestPermission()
    setPermission(answer)
    if (answer !== 'granted') throw new Error('Notifications are blocked for this site. Allow them in the browser site settings, then try again.')
    const { reg } = await currentSubscription()
    const subscription = await subscribeFresh(reg, urlBase64ToUint8Array(await pushKey())) // always new: an old browser subscription may be one the push service forgot (410)
    const saved = await pushSubscribe(buildSubscribePayload({ subscription, settings: prefs, userAgent: navigator.userAgent, maxTouchPoints: navigator.maxTouchPoints, tz: zone() }))
    if (saved.device && saved.device.id) setDeviceId(saved.device.id)
    setSub(subscription)
    say(true, 'Notifications are on for this phone.')
    await loadDevices()
  })

  const disable = () => run(async () => {
    if (sub) { await pushUnsubscribe({ endpoint: sub.endpoint }).catch(() => {}); await sub.unsubscribe() }
    setDeviceId(null); setSub(null)
    say(true, 'Notifications are off for this phone.')
    await loadDevices()
  })

  /** Keeps `next` locally and tells the server (when this phone is subscribed). */
  const save = (next, okText) => run(async () => {
    const quiet = validateQuietHours(next.quiet)
    if (!quiet.ok) { setQuietError(quiet.error); return }
    setQuietError(null)
    const clean = { ...next, quiet: quiet.value }
    setPrefs(clean); setPushPrefs(clean)
    if (sub) { await pushSettings({ endpoint: sub.endpoint, name: clean.name, types: clean.types, quiet: clean.quiet }); await loadDevices() }
    if (okText) say(true, okText)
  })

  const toggleType = (id, on) => save({ ...prefs, types: { ...prefs.types, [id]: on } })
  const sendTest = () => run(async () => { await pushTest(sub.endpoint); say(true, 'Test sent. It should arrive in a few seconds.') })
  const remove = (device) => run(async () => {
    if (device.id === getDeviceId() && sub) { await sub.unsubscribe(); setSub(null); setDeviceId(null) }
    await pushUnsubscribe({ id: device.id })
    await loadDevices()
  })

  const age = (ts) => (ts ? getCore().fmtAge(Date.now() - ts) : 'never')
  const mine = getDeviceId()
  const status = notificationStatus({ supported: supported(), permission, subscribed: !!sub })
  // On iOS push needs the Home Screen app (and 16.4+): say that instead of the generic "unsupported" text.
  const hint = pushHint(platformInfo({ userAgent: navigator.userAgent, maxTouchPoints: navigator.maxTouchPoints, standalone: isStandalone(window), hasPush: supported() }))
  return html`<div class="settings">
    <section>
      <h3>Notifications</h3>
      ${hint ? html`<div class="sub">${hint}</div>` : null}
      ${status.state === 'unsupported' ? (hint ? null : html`<div class="sub">${status.text}</div>`) : html`<div>
        <div class="sub">${status.text}</div>
        <div class="row">
          ${sub
            ? html`<button class="btn" disabled=${busy} onClick=${disable}>Turn off</button><button class="btn pri" disabled=${busy || permission === 'denied'} onClick=${sendTest}>Send test</button>`
            : html`<button class="btn pri" disabled=${busy || permission === 'denied'} onClick=${enable}>Turn on notifications</button>`}
        </div></div>`}
      ${note ? html`<div class=${note.ok ? 'resolution ok' : 'err'} role="status">${note.text}</div>` : null}
    </section>
    <section>
      <h3>This phone</h3>
      <label class="sub" for="dev-name">Name shown in the device list</label>
      <input id="dev-name" class="input" maxlength="40" placeholder="e.g. Pixel 7" value=${prefs.name} onInput=${(e) => { const v = e.target.value; setPrefs((p) => ({ ...p, name: v })) }} />
      <div class="row"><button class="btn" disabled=${busy} onClick=${() => save(prefs, 'Saved.')}>Save name</button></div>
    </section>
    <section>
      <h3>What may notify</h3>
      ${PUSH_TYPES.map((t) => html`<label class="switch" key=${t.id}><span>${t.label}</span>
        <input type="checkbox" checked=${prefs.types[t.id]} disabled=${busy} onChange=${(e) => toggleType(t.id, e.target.checked)} /></label>`)}
    </section>
    <section>
      <h3>Quiet hours</h3>
      <label class="switch"><span>Hold the quiet types</span>
        <input type="checkbox" checked=${prefs.quiet.enabled} disabled=${busy} onChange=${(e) => save({ ...prefs, quiet: { ...prefs.quiet, enabled: e.target.checked } })} /></label>
      <div class="sub">Permission requests and questions still come through (a session is blocked). Done and merged items wait and arrive together when quiet hours end. Time zone: ${prefs.quiet.tz}.</div>
      <div class="times">
        <label>From <input class="input" type="time" value=${prefs.quiet.start} onInput=${(e) => { const v = e.target.value; setPrefs((p) => ({ ...p, quiet: { ...p.quiet, start: v } })) }} /></label>
        <label>Until <input class="input" type="time" value=${prefs.quiet.end} onInput=${(e) => { const v = e.target.value; setPrefs((p) => ({ ...p, quiet: { ...p.quiet, end: v } })) }} /></label>
      </div>
      ${quietError ? html`<div class="err" role="alert">${quietError}</div>` : null}
      <div class="row"><button class="btn" disabled=${busy} onClick=${() => save(prefs, 'Saved.')}>Save quiet hours</button></div>
    </section>
    ${getToken() ? html`<section>
      <h3>Pairing</h3>
      <div class="sub">This phone is paired with the hub. Forgetting it here only signs this phone out; it stays in the desktop list until you revoke it there (Phone, then Revoke).</div>
      <div class="row"><button class="btn bad" onClick=${() => { if (confirm('Sign this phone out? You will need a new code to pair it again.')) signOut() }}>Forget pairing</button></div>
    </section>` : null}
    <section>
      <h3>Phones that get notifications</h3>
      ${devices === null ? html`<div class="sub">Loading…</div>` : devices.length === 0 ? html`<div class="sub">None yet.</div>` : devices.map((d) => html`<div class="device" key=${d.id}>
        <div class="grow"><div class="title">${d.name || 'Phone'}${d.id === mine ? ' (this phone)' : ''}</div><div class="sub">Last delivery: ${age(d.lastSuccessAt)}</div></div>
        <button class="btn bad" disabled=${busy} aria-label=${'Remove ' + (d.name || 'phone')} onClick=${() => remove(d)}>Remove</button></div>`)}
    </section>
  </div>`
}
