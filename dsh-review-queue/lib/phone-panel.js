/**
 * The desktop "Phone" panel of the overlay: pair a phone (a one-time code and the address to open on the phone), list the paired phones
 * (name, when paired, last seen, Tailscale login, push) and rename or revoke them. It talks to this app's /review-queue/v1/pairing-code and
 * /v1/devices*, which the app forwards to the hub as the desktop. lib/client.js must stay one self-contained script, so the overlay loads this
 * file on first use (import of /review-queue/m/phone-panel.js) and hands it React; everything but the React calls is plain functions that
 * are tested without a browser (test/client-phone-panel.test.mjs). Nothing here ever sees a token or a push endpoint: the hub never sends them.
 */

/** How often a mounted panel re-reads the device list, so a phone paired while the panel is open shows up without leaving it. */
export const PHONE_REFRESH_MS = 3000

const HUB_DOWN = 'The hub is not running, so phones cannot be paired or managed right now (see the notice at the top of the task list).'

/** The words for a failed call. */
function errorText(status, json) {
  const code = json && typeof json === 'object' ? json.error : undefined
  if (code === 'hub-unavailable') return HUB_DOWN
  if (status === 401 || status === 403) return 'Not allowed (' + (code || 'HTTP ' + status) + ').'
  return 'Could not do that (' + (code || 'HTTP ' + status) + ').'
}

/**
 * @param {{ API: string, fetch?: typeof fetch, now?: () => number }} deps
 * @returns the state (replaced on every change), subscribe / version for useSyncExternalStore and the four calls
 */
export function createPhoneController({ API, fetch: doFetch = (...a) => globalThis.fetch(...a), now = Date.now }) {
  const state = { busy: false, error: null, devices: [], legacy: [], warnings: [], publicUrl: null, code: null, justPaired: null, loaded: false }
  const listeners = new Set()
  let version = 0
  const set = (patch) => { Object.assign(state, patch); version++; for (const l of [...listeners]) l() }

  /**
   * One call; { ok, json } where a failure has already been put into state.error.
   * A quiet call (the background refresh) leaves busy and an existing error alone, and only reports a failure when there was no error yet.
   */
  async function call(method, path, body, quiet = false) {
    if (!quiet) set({ busy: true, error: null })
    const fail = (error) => { if (quiet) { if (!state.error) set({ error }) } else set({ busy: false, error }) }
    try {
      const res = await doFetch(API + path, { method, credentials: 'same-origin', ...(body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }) })
      const json = await res.json().catch(() => ({}))
      if (!res.ok) { fail(errorText(res.status, json)); return { ok: false } }
      if (!quiet) set({ busy: false })
      return { ok: true, json }
    } catch (error) {
      fail('Request failed: ' + String((error && error.message) || error))
      return { ok: false }
    }
  }

  const controller = {
    state, now,
    get version() { return version },
    subscribe(listener) { listeners.add(listener); return () => { listeners.delete(listener) } },
    /** @param {{ quiet?: boolean }} [opts] quiet: a background refresh that does not touch busy or an existing error */
    async refresh({ quiet = false } = {}) {
      const r = await call('GET', '/v1/devices', undefined, quiet)
      if (!r.ok) return
      const devices = r.json.devices ?? []
      // A phone that was not in the list we already had, while the code is still on screen, is the one that just used that code.
      const known = new Set(state.devices.map((d) => d.id))
      const paired = state.code && state.loaded ? devices.find((d) => !known.has(d.id)) : undefined
      set({ devices, legacy: r.json.legacy ?? [], warnings: r.json.warnings ?? [], publicUrl: r.json.publicUrl ?? null, loaded: true, ...(paired ? { code: null, justPaired: paired.name } : {}) })
    },
    async newCode() {
      set({ justPaired: null })
      const r = await call('POST', '/v1/pairing-code', {})
      if (r.ok) set({ code: { code: r.json.code, expiresAt: r.json.expiresAt, url: r.json.url ?? null, link: r.json.link ?? null } })
    },
    async revoke(id) { if ((await call('POST', '/v1/devices/' + encodeURIComponent(id) + '/revoke', {})).ok) await controller.refresh() },
    async rename(id, name) { if ((await call('PATCH', '/v1/devices/' + encodeURIComponent(id), { name })).ok) await controller.refresh() },
  }
  return controller
}

/** The table rows: text only, ready to show. */
export function deviceRows({ devices = [], legacy = [] }, now, fmtAge) {
  const ago = (t) => (t ? fmtAge(now - t) : 'never')
  const pushOf = (p) => (p?.state === 'on' ? (p.lastError ? 'on (last send failed)' : 'on') : 'off')
  return [
    ...devices.map((d) => ({ id: d.id, name: d.name, created: ago(d.createdAt), lastSeen: ago(d.lastSeenAt), lastLogin: d.lastLogin ?? '', push: pushOf(d.push), revoked: d.revokedAt != null, legacy: false })),
    ...legacy.map((d) => ({ id: d.id, name: d.name || 'Phone', created: ago(d.createdAt), lastSeen: ago(d.lastSuccessAt), lastLogin: '', push: pushOf({ state: 'on', lastError: d.lastError }), revoked: false, legacy: true })),
  ]
}

/** @param {any} React @param {{ API: string, fmtAge: (ms: number) => string, controller?: ReturnType<typeof createPhoneController> }} deps */
export function createPhonePanel(React, { API, fmtAge, controller = createPhoneController({ API }), refreshMs = PHONE_REFRESH_MS }) {
  const h = React.createElement

  /** A plain function (not a component): it is called while the panel renders. */
  function codeBox(code, now) {
    const left = Math.ceil((code.expiresAt - now) / 60_000)
    return h('div', { className: 'rq-pair' },
      h('div', null, 'Code: ', h('strong', { style: { fontSize: '1.4em', letterSpacing: '0.1em' } }, code.code)),
      h('div', { className: 'rq-sub' }, left > 0 ? 'Valid once, for another ' + left + (left === 1 ? ' minute.' : ' minutes.') : 'This code has expired: create a new one.'),
      code.link
        ? h('div', null, h('div', { className: 'rq-sub' }, 'Open this on the phone (Chrome), or open ' + code.url + ' and type the code:'), h('input', { className: 'rq-input', readOnly: true, value: code.link, style: { width: '100%' }, onFocus: (e) => e.target.select() }))
        : h('div', { className: 'rq-err' }, 'No public address is set: add "publicUrl": "https://<this PC>.<tailnet>.ts.net" to hub.config.json, restart the hub, and open <that address>/review-queue/m/ on the phone.'))
  }

  return function PhonePanel() {
    React.useSyncExternalStore(controller.subscribe, () => controller.version)
    const [armed, setArmed] = React.useState(null)
    React.useEffect(() => {
      controller.refresh()
      // Only while mounted; a tick is skipped while another request is running so a slow hub is never queued up.
      const timer = setInterval(() => { if (!controller.state.busy) controller.refresh({ quiet: true }) }, refreshMs)
      return () => clearInterval(timer)
    }, [])
    const st = controller.state
    const now = controller.now()
    const rows = deviceRows(st, now, fmtAge)
    const revoke = (row) => { if (armed === row.id) { setArmed(null); controller.revoke(row.id) } else setArmed(row.id) }
    const rename = (row) => { const next = typeof window !== 'undefined' && typeof window.prompt === 'function' ? window.prompt('Name for this phone', row.name) : null; if (next && next.trim()) controller.rename(row.id, next.trim()) }
    return h('div', { className: 'rq-phone', style: { padding: '12px 20px', overflow: 'auto' } },
      h('div', { className: 'rq-row' }, h('button', { className: 'rq-btn pri', disabled: st.busy, onClick: () => controller.newCode() }, 'Pair a phone'), h('button', { className: 'rq-btn', disabled: st.busy, onClick: () => controller.refresh() }, 'Refresh'), h('span', { className: 'rq-sub' }, ' Opens a one-time code, valid for 5 minutes.')),
      st.code ? codeBox(st.code, now) : null,
      st.justPaired ? h('div', { className: 'rq-sub' }, 'Paired: ' + st.justPaired) : null,
      st.error ? h('div', { className: 'rq-err' }, st.error) : null,
      st.warnings.map((w) => h('div', { className: 'rq-err', key: w }, 'Warning: ' + w + ' on a hub file (see the hub log).')),
      h('h3', null, 'Phones'),
      rows.length || st.loaded ? h('table', { style: { borderCollapse: 'collapse', width: '100%' } },
        h('tr', null, ['Name', 'Paired', 'Last seen', 'Tailscale login', 'Push', ''].map((c, i) => h('th', { key: i, style: { textAlign: 'left', padding: '2px 8px' } }, c))),
        rows.map((r) => h('tr', { key: r.id },
          h('td', { style: { padding: '2px 8px' } }, r.name + (r.legacy ? ' (older registration)' : '')),
          h('td', { style: { padding: '2px 8px' } }, r.created),
          h('td', { style: { padding: '2px 8px' } }, r.lastSeen),
          h('td', { style: { padding: '2px 8px' } }, r.lastLogin),
          h('td', { style: { padding: '2px 8px' } }, r.revoked ? 'revoked' : r.push),
          h('td', { style: { padding: '2px 8px' } }, r.revoked ? null : [
            h('button', { className: 'rq-btn bad', key: 'revoke', disabled: st.busy, onClick: () => revoke(r) }, armed === r.id ? 'Revoke: click again to confirm' : 'Revoke'),
            r.legacy ? null : h('button', { className: 'rq-link', key: 'rename', disabled: st.busy, onClick: () => rename(r) }, 'Rename'),
          ])))) : h('div', { className: 'rq-sub' }, st.busy ? 'Loading…' : 'No phones yet.'),
      h('div', { className: 'rq-sub' }, 'A lost phone: press Revoke. It is signed out at once and its notifications stop.'))
  }
}
