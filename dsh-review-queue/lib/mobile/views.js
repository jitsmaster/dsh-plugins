/** Phone views (Preact + htm, no build step). Card logic comes from the shared core (api.js getCore()). */
import { html, useState, useEffect, useRef } from './vendor/preact-htm.js'
import { state, subscribe, set, act, getCore } from './api.js'
import { HOLD_MS, holdState } from './hold.js'
import { SettingsView } from './settings.js'

export function useStore() {
  const [, tick] = useState(0)
  useEffect(() => subscribe(() => tick((n) => n + 1)), [])
  return state
}
export function useRoute() {
  const read = () => location.hash.replace(/^#/, '') || '/'
  const [route, setRoute] = useState(read())
  useEffect(() => { const f = () => setRoute(read()); window.addEventListener('hashchange', f); return () => window.removeEventListener('hashchange', f) }, [])
  return route
}
const go = (path) => { location.hash = path }

const now = () => Date.now() + state.skew
const ageOf = (item, key = 'createdAt') => getCore().fmtAge(now() - (item[key] || 0))

// ---- small pieces -------------------------------------------------------------------------------------------------

function Chip({ type }) { return html`<span class=${'chip ' + type}>${getCore().typeLabel(type)}</span>` }

function Md({ text }) {
  const c = getCore()
  const inline = (s) => c.mdInline(s).map((tok) => {
    if (tok.t === 'b') return html`<strong>${tok.text}</strong>`
    if (tok.t === 'i') return html`<em>${tok.text}</em>`
    if (tok.t === 'code') return html`<code>${tok.text}</code>`
    if (tok.t === 'a') return html`<a href=${tok.href} target="_blank" rel="noopener noreferrer">${tok.text}</a>`
    return tok.text
  })
  return html`<div class="md">${c.mdBlocks(text).map((b) => {
    if (b.t === 'h') return html`<div class=${'h h' + Math.min(b.level, 3)}>${inline(b.text)}</div>`
    if (b.t === 'ul') return html`<ul>${b.items.map((i) => html`<li>${inline(i)}</li>`)}</ul>`
    if (b.t === 'ol') return html`<ol>${b.items.map((i) => html`<li>${inline(i)}</li>`)}</ol>`
    if (b.t === 'q') return html`<blockquote>${inline(b.text)}</blockquote>`
    if (b.t === 'code') return html`<pre><code>${b.text}</code></pre>`
    return html`<p>${inline(b.text)}</p>`
  })}</div>`
}

/** Press and hold for `HOLD_MS` to confirm; letting go early cancels. Pointer or keyboard (Space / Enter). */
export function HoldButton({ label, onDone, disabled }) {
  const [progress, setProgress] = useState(0)
  const start = useRef(0)
  const raf = useRef(0)
  const stop = () => { cancelAnimationFrame(raf.current); start.current = 0; setProgress(0) }
  const tick = () => {
    if (!start.current) return
    const s = holdState(start.current, performance.now(), HOLD_MS)
    setProgress(s.progress)
    if (s.done) { start.current = 0; setProgress(0); onDone(); return }
    raf.current = requestAnimationFrame(tick)
  }
  const down = () => { if (disabled || start.current) return; start.current = performance.now(); raf.current = requestAnimationFrame(tick) }
  useEffect(() => stop, [])
  return html`<button class="btn bad hold" disabled=${disabled} style=${{ '--p': progress }}
    onPointerDown=${down} onPointerUp=${stop} onPointerLeave=${stop} onPointerCancel=${stop} onContextMenu=${(e) => e.preventDefault()}
    onKeyDown=${(e) => { if ((e.key === ' ' || e.key === 'Enter') && !e.repeat) { e.preventDefault(); down() } }} onKeyUp=${stop}>
    <span class="fill"></span><span class="lbl">${progress > 0 ? 'Keep holding…' : label}</span></button>`
}

/** Bottom sheet: what is about to happen, in full, and a confirm button (a risky action asks for a hold instead of a tap). */
function Sheet({ title, lines = [], mono, risks = [], confirmLabel, hold, onConfirm, onCancel }) {
  return html`<div class="scrim" onClick=${(e) => { if (e.target === e.currentTarget) onCancel() }}>
    <div class="sheet" role="dialog" aria-modal="true" aria-label=${title}>
      <h3>${title}</h3>
      ${risks.length ? html`<div class="risks">${risks.map((r) => html`<span class="risk">⚠ ${r.label}</span>`)}</div>` : null}
      ${lines.map((l) => html`<div class="sub">${l}</div>`)}
      ${mono ? html`<pre class="mono">${mono}</pre>` : null}
      <div class="row">
        ${hold ? html`<${HoldButton} label=${'Hold to ' + confirmLabel.toLowerCase()} onDone=${onConfirm} />` : html`<button class="btn pri" onClick=${onConfirm}>${confirmLabel}</button>`}
        <button class="btn" onClick=${onCancel}>Cancel</button>
      </div>
    </div></div>`
}

function ReadAloud({ item }) {
  const [on, setOn] = useState(false)
  if (typeof speechSynthesis === 'undefined' || !item.spoken) return null
  useEffect(() => () => { if (on) speechSynthesis.cancel() }, [on])
  const toggle = () => {
    if (on) { speechSynthesis.cancel(); setOn(false); return }
    const u = new SpeechSynthesisUtterance(item.spoken.full)
    u.onend = u.onerror = () => setOn(false)
    speechSynthesis.cancel()
    speechSynthesis.speak(u)
    setOn(true)
  }
  return html`<button class="btn" aria-pressed=${on} onClick=${toggle}>${on ? '■ Stop' : '▶ Read aloud'}</button>`
}

// ---- item bodies ------------------------------------------------------------------------------------------------

function QuestionBody({ item, path = '/v1/answer', sendLabel = 'Send answer' }) {
  const c = getCore()
  const st = useStore()
  const questions = item.payload.questions || []
  const drafts = st.drafts[item.id] || {}
  const busy = st.busy[item.id]
  const setDraft = (qid, next) => set({ drafts: { ...st.drafts, [item.id]: { ...drafts, [qid]: next } } })
  const answers = c.buildAnswers(questions, drafts)
  const send = async () => { if (await act(path, { id: item.id, answers }, item.id)) { set({ drafts: { ...state.drafts, [item.id]: undefined } }); if (path === '/v1/answer') go('/') } }
  return html`<div>
    ${questions.map((q) => {
      const d = drafts[q.id] || { selected: [], custom: '' }
      return html`<div class="q" key=${q.id}>
        ${q.header ? html`<div class="sub">${q.header}</div>` : null}
        <div class="qtext">${q.question}</div>
        ${(q.options || []).map((o) => html`<button class=${'opt' + (d.selected.includes(o.label) ? ' on' : '')} disabled=${busy} aria-pressed=${d.selected.includes(o.label)}
          onClick=${() => setDraft(q.id, c.toggleChoice(d, o.label, !!q.multiSelect))}>
          <span class="mark">${d.selected.includes(o.label) ? (q.multiSelect ? '☑' : '◉') : (q.multiSelect ? '☐' : '○')}</span>
          <span><span>${c.recommended(q, o.label) ? '★ ' : ''}${o.label}</span>${o.description ? html`<div class="d">${o.description}</div>` : null}</span></button>`)}
        <input class="input" placeholder="Other answer…" value=${d.custom || ''} disabled=${busy} onInput=${(e) => setDraft(q.id, { selected: q.multiSelect ? d.selected : [], custom: e.target.value })} />
      </div>`
    })}
    <div class="row"><button class="btn pri" disabled=${!answers || busy} onClick=${send}>${busy ? 'Sending…' : sendLabel}</button></div>
    ${!answers ? html`<div class="sub">Pick an option or type an answer for every question.</div>` : null}
  </div>`
}

function PermissionBody({ item }) {
  const c = getCore()
  const st = useStore()
  const [ask, setAsk] = useState(null) // 'approve' | 'similar'
  const busy = st.busy[item.id]
  const p = item.payload || {}
  const risks = item.risks || []
  const same = c.similarCount(st.snap ? st.snap.open : [], item)
  const command = p.detail && p.detail !== p.summary ? p.detail : p.summary || p.toolName
  const approve = async (extra) => { setAsk(null); if (await act('/v1/approve', { id: item.id, via: 'phone', confirmed: true, ...extra }, item.id)) go('/') }
  const approveAll = async () => { setAsk(null); if (await act('/v1/approve-similar', { id: item.id, via: 'phone', confirmed: true }, item.id)) go('/') }
  return html`<div>
    ${risks.length ? html`<div class="risks">${risks.map((r) => html`<span class="risk">⚠ ${r.label}</span>`)}</div>` : null}
    <pre class="mono">${command}</pre>
    ${p.reason ? html`<div class="sub">${p.reason}</div>` : null}
    <div class="row">
      <button class="btn pri" disabled=${busy} onClick=${() => setAsk('approve')}>Approve…</button>
      <button class="btn bad" disabled=${busy} onClick=${async () => { if (await act('/v1/deny', { id: item.id }, item.id)) go('/') }}>Deny</button>
    </div>
    ${same > 1 ? html`<div class="row"><button class="btn" disabled=${busy} onClick=${() => setAsk('similar')}>Approve all ${same} identical…</button></div>` : null}
    ${ask === 'approve' ? html`<${Sheet} title="Approve this request?" lines=${[(item.sessionTitle || 'A session') + ' wants to run:']} mono=${command} risks=${risks}
      confirmLabel="Approve" hold=${risks.length > 0} onConfirm=${() => approve(risks.length ? { held: true } : {})} onCancel=${() => setAsk(null)} />` : null}
    ${ask === 'similar' ? html`<${Sheet} title=${'Approve all ' + same + ' identical?'} lines=${['Same session, tool and command:']} mono=${command} confirmLabel="Approve all" onConfirm=${approveAll} onCancel=${() => setAsk(null)} />` : null}
  </div>`
}

function CompletedBody({ item }) {
  const c = getCore()
  const st = useStore()
  const busy = st.busy[item.id]
  const reply = st.replies[item.id] || ''
  const send = async () => { if (await act('/v1/reply', { id: item.id, text: reply }, item.id)) { set({ replies: { ...state.replies, [item.id]: '' } }); go('/') } }
  return html`<div>
    <div class="text">${item.summary || 'Finished.'}</div>
    ${item.payload && item.payload.reply ? html`<details open=${(item.payload.reply || '').length < 1500}><summary class="sub">Full reply</summary><${Md} text=${item.payload.reply} /></details>` : null}
    <textarea class="input ta" placeholder="Reply to this session…" value=${reply} disabled=${busy} onInput=${(e) => set({ replies: { ...st.replies, [item.id]: e.target.value } })}></textarea>
    <div class="row">
      <button class="btn pri" disabled=${busy || !reply.trim()} onClick=${send}>${busy ? 'Sending…' : 'Send reply'}</button>
      <button class="btn" disabled=${busy} onClick=${async () => { if (await act('/v1/reviewed', { id: item.id }, item.id)) go('/') }}>Reviewed</button>
    </div>
  </div>`
}

function PrMergedBody({ item }) {
  const st = useStore()
  const [ask, setAsk] = useState(false)
  const busy = st.busy[item.id]
  const p = item.payload || {}
  const followUps = p.followUps || []
  return html`<div>
    <div class="text">Pull request ${p.prId} is merged.</div>
    <div class="sub">${followUps.length ? (followUps.length === 1 ? 'Follow-up session told to start: ' : 'Follow-up sessions told to start: ') + followUps.map((f) => f.title || f.id).join(', ') : 'No follow-up session was waiting for this PR.'}</div>
    <div class="row">
      <button class="btn pri" disabled=${busy} onClick=${() => setAsk(true)}>${busy ? 'Archiving…' : 'Archive session…'}</button>
      <button class="btn" disabled=${busy} onClick=${async () => { if (await act('/v1/reviewed', { id: item.id }, item.id)) go('/') }}>Keep session</button>
    </div>
    ${ask ? html`<${Sheet} title="Archive this session?" lines=${[item.sessionTitle || 'The PR session', 'Anything it is still running is stopped.']} confirmLabel="Archive"
      onConfirm=${async () => { setAsk(false); if (await act('/v1/archive', { id: item.id }, item.id)) go('/') }} onCancel=${() => setAsk(false)} />` : null}
  </div>`
}

/** A todo is started and confirmed from the desktop task list; the phone only shows it. */
function TodoBody({ item }) {
  return html`<div>
    <div class="text">${item.text}</div>
    <div class="sub">${item.suggested ? 'Suggested workspace: ' + item.suggested.title : item.workspaceTitle ? 'Workspace: ' + item.workspaceTitle : 'No workspace chosen yet.'}</div>
    <div class="sub">Start or cancel this todo from the task list on the desktop.</div>
  </div>`
}

// ---- screens ----------------------------------------------------------------------------------------------------

function ItemRow({ item }) {
  const c = getCore()
  const risky = item.type === 'permission' && item.risks && item.risks.length
  return html`<a class="rowitem" href=${'#/item/' + item.id}>
    <div class="top"><${Chip} type=${item.type} />${risky ? html`<span class="risk small">⚠ risky</span>` : null}<span class="age">${ageOf(item)}</span></div>
    <div class="title">${c.cardTitle(item)}</div>
    ${item.sessionTitle ? html`<div class="sub">${item.sessionTitle}</div>` : null}
  </a>`
}

function FilterBar() {
  const c = getCore()
  const st = useStore()
  const f = st.filter
  return html`<div class="filter">
    <div class="chips">${['all', 'completed', 'question', 'permission', 'pr-merged'].map((t) => html`<button class=${'fchip' + (f.type === t ? ' on' : '')} aria-pressed=${f.type === t} onClick=${() => set({ filter: { ...f, type: t } })}>${t === 'all' ? 'All' : c.typeLabel(t)}</button>`)}</div>
    <input class="input" type="search" placeholder="Search…" value=${f.query} onInput=${(e) => set({ filter: { ...f, query: e.target.value } })} />
  </div>`
}

function WaitingList() {
  const c = getCore()
  const st = useStore()
  const all = st.snap ? st.snap.open : []
  const shown = c.filterItems(all, st.filter)
  return html`<div>
    ${all.length > 3 || st.filter.query || st.filter.type !== 'all' ? html`<${FilterBar} />` : null}
    ${shown.length ? shown.map((i) => html`<${ItemRow} key=${i.id} item=${i} />`) : html`<div class="empty">${all.length ? 'Nothing matches this filter.' : 'Nothing is waiting for you.'}</div>`}
  </div>`
}

function ResolvedList() {
  const c = getCore()
  const st = useStore()
  const all = st.snap ? st.snap.resolved : []
  const shown = c.filterItems(all, st.filter)
  return html`<div>
    <${FilterBar} />
    ${shown.length ? shown.map((i) => html`<a class="rowitem" key=${i.id} href=${'#/item/' + i.id}>
      <div class="top"><${Chip} type=${i.type} /><span class="age">${ageOf(i, 'resolvedAt')}</span></div>
      <div class="title">${c.cardTitle(i)}</div><div class="sub">${c.resolutionText(i)}</div></a>`) : html`<div class="empty">${all.length ? 'Nothing matches this filter.' : 'Nothing resolved in the last 7 days.'}</div>`}
  </div>`
}

function ItemView({ id }) {
  const c = getCore()
  const st = useStore()
  const open = st.snap && st.snap.open.find((i) => i.id === id)
  const resolved = !open && st.snap && st.snap.resolved.find((i) => i.id === id)
  const item = open || resolved
  if (!item) return html`<div class="empty">${st.snap ? 'That item is no longer here.' : 'Loading…'}<div class="row"><a class="btn" href="#/">Back to the list</a></div></div>`
  const late = resolved && item.type === 'question' && item.resolution && item.resolution.kind === 'expired'
  const Body = item.type === 'question' ? QuestionBody : item.type === 'permission' ? PermissionBody : item.type === 'pr-merged' ? PrMergedBody : item.type === 'todo' ? TodoBody : CompletedBody
  return html`<article class="card">
    <div class="top"><${Chip} type=${item.type} /><span class="age">${resolved ? ageOf(item, 'resolvedAt') : ageOf(item)}</span></div>
    <h2>${c.cardTitle(item)}</h2>
    ${item.sessionTitle ? html`<div class="sub">${item.sessionTitle}${item.workspace ? ' · ' + item.workspace : ''}</div>` : null}
    ${open ? html`<${Body} item=${item} />` : html`<div>
      <div class="resolution">${c.resolutionText(item)}</div>
      ${late ? html`<details><summary class="sub">Answer now (late)</summary><${QuestionBody} item=${item} path="/v1/late-answer" sendLabel="Send late answer" /></details>` : null}
      ${c.isReopenable(item) ? html`<div class="row"><button class="btn" disabled=${st.busy[item.id]} onClick=${async () => { if (await act('/v1/reopen', { id: item.id }, item.id)) go('/') }}>Reopen</button></div>` : null}
    </div>`}
    ${st.errors[item.id] ? html`<div class="err">${st.errors[item.id]}</div>` : null}
    <div class="row"><${ReadAloud} item=${item} /><a class="btn" href=${resolved ? '#/resolved' : '#/'}>Back</a></div>
  </article>`
}

export function App() {
  const st = useStore()
  const route = useRoute()
  const [, tick] = useState(0)
  useEffect(() => { const t = setInterval(() => tick((n) => n + 1), 30000); return () => clearInterval(t) }, [])
  if (!st.ready && !st.snap) return html`<p class="boot">${st.error || 'Loading the task list…'}</p>`
  const item = /^\/item\/(.+)$/.exec(route)
  const tab = route === '/resolved' ? 'resolved' : route === '/settings' ? 'settings' : 'waiting'
  const count = st.snap ? st.snap.open.length : 0
  return html`<div class="app">
    <header><h1>Task list</h1><span class="count">${count} waiting</span></header>
    ${st.error ? html`<div class="banner">${st.error}</div>` : null}
    <main>
      ${item ? html`<${ItemView} id=${decodeURIComponent(item[1])} />` : tab === 'resolved' ? html`<${ResolvedList} />` : tab === 'settings' ? html`<${SettingsView} />` : html`<${WaitingList} />`}
    </main>
    <nav>
      <a class=${tab === 'waiting' && !item ? 'on' : ''} href="#/">Waiting${count ? html`<span class="badge">${count}</span>` : null}</a>
      <a class=${tab === 'resolved' && !item ? 'on' : ''} href="#/resolved">Resolved</a>
      <a class=${tab === 'settings' && !item ? 'on' : ''} href="#/settings">Settings</a>
    </nav>
  </div>`
}
