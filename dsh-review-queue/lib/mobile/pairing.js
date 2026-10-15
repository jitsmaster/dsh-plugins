/**
 * The pairing screen of the phone (#/pair): the code from the desktop (read from the link's fragment, or typed), a name for this phone, and
 * the Pair button. The code is taken out of the address bar as soon as it is read, so it is not left in the history. The rules and the words
 * are in auth.js, the call in api.js; this file is only the screen.
 */
import { html, useState, useEffect } from './vendor/preact-htm.js'
import { pair } from './api.js'
import { parsePairHash } from './auth.js'
import { defaultDeviceName } from './push-client.js'

export function PairView({ message }) {
  const [code, setCode] = useState(() => parsePairHash(location.hash).code)
  const [name, setName] = useState(() => defaultDeviceName(navigator.userAgent))
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState(null)
  useEffect(() => { if (/^#\/pair\/./.test(location.hash)) history.replaceState(null, '', location.pathname + location.search + '#/pair') }, [])
  const submit = async (e) => {
    e.preventDefault()
    setBusy(true); setNote(null)
    const r = await pair(code, name)
    setBusy(false)
    if (r.ok) { setCode(''); location.hash = '#/'; return }
    setNote(r.message)
  }
  return html`<div class="app"><header><h1>Pair this phone</h1></header>
    <main><form class="pair" onSubmit=${submit}>
      ${message ? html`<div class="banner">${message}</div>` : null}
      <p class="sub">On the desktop open the task list, press <strong>Phone</strong>, then <strong>Pair a phone</strong>. Type the code it shows. The code works once and only for five minutes.</p>
      <label class="sub" for="pair-code">Code</label>
      <input id="pair-code" class="input" value=${code} autocomplete="off" autocapitalize="characters" spellcheck="false" maxlength="20" placeholder="ABCD-EFGH" onInput=${(e) => setCode(e.target.value)} />
      <label class="sub" for="pair-name">Name of this phone</label>
      <input id="pair-name" class="input" value=${name} maxlength="40" onInput=${(e) => setName(e.target.value)} />
      ${note ? html`<div class="err" role="alert">${note}</div>` : null}
      <div class="row"><button class="btn pri" type="submit" disabled=${busy || !code.trim()}>${busy ? 'Pairing…' : 'Pair'}</button></div>
    </form></main></div>`
}
