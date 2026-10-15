/** Phone views (Preact + htm, no build step). Card logic comes from the shared core (api.js getCore()). */
import { html, useState, useEffect, useRef } from './vendor/preact-htm.js'
import { state, subscribe, set, act, getCore, loadWorkspaces, startTodo, NEW_TODO_ID } from './api.js'
import { HOLD_MS, holdState } from './hold.js'
import { PairView } from './pairing.js'
import { SettingsView } from './settings.js'
import { listModel, screenFor, todoCardModel } from './model.js'
import { viewIssue } from './view-guard.js'
import { platformInfo, installHint, isStandalone } from './platform.js'
import { createDictation } from './dictation.js'
import { TODO_MAX, newTodoPayload, todoErrorText, workspaceChoices, workspacesNote } from './todo-form.js'

export function useStore() {
  const [, tick] = useState(0)
  const seen = useRef(state.version)
  seen.current = state.version
  useEffect(() => {
    // The effect runs after the first paint: an update that landed in between (a fast local snapshot) would be missed for good,
    // so catch up once when the version moved on since this render.
    if (state.version !== seen.current) tick((n) => n + 1)
    return subscribe(() => tick((n) => n + 1))
  }, [])
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

/**
 * Dictation button next to a free-text box: tap to listen, tap again to stop. The recognised text goes to onText (the box's draft setter),
 * after the text already in the box; the user reviews it and presses the normal Send button. Hidden when the browser cannot do speech to text.
 */
function Mic({ text, onText, disabled }) {
  const [on, setOn] = useState(false)
  const [problem, setProblem] = useState(null)
  const latest = useRef(onText)
  latest.current = onText
  const dictation = useRef(undefined)
  // iOS words the permission errors differently (Settings > Safari, Siri & Dictation).
  const ios = platformInfo({ userAgent: navigator.userAgent, maxTouchPoints: navigator.maxTouchPoints }).ios
  if (dictation.current === undefined) dictation.current = createDictation({ win: window, ios, onText: (t) => latest.current(t), onState: setOn, onError: setProblem })
  const d = dictation.current
  useEffect(() => () => { if (d) d.stop() }, []) // leaving the screen releases the microphone
  if (!d) return null
  return html`<div class="micwrap">
    <button class=${'btn mic' + (on ? ' on' : '')} type="button" aria-pressed=${on} aria-label=${on ? 'Stop dictation' : 'Dictate'} disabled=${disabled}
      onClick=${() => (on ? d.stop() : d.start(text))}>${on ? '■' : '🎤'}</button>
    ${problem ? html`<div class="sub" role="status">${problem}</div>` : null}
  </div>`
}

// ---- item bodies ------------------------------------------------------------------------------------------------

function QuestionBody({ item, path = '/v1/answer', sendLabel = 'Send answer' }) {
  const c = getCore()
  const st = useStore()
  const questions = item.payload.questions || []
  const drafts = st.drafts[item.id] || {}
  const busy = st.busy[item.id]
  // Read the live drafts: dictation updates a box many times a second, between two renders.
  const setDraft = (qid, next) => set({ drafts: { ...state.drafts, [item.id]: { ...(state.drafts[item.id] || {}), [qid]: next } } })
  const answers = c.buildAnswers(questions, drafts)
  const note = path === '/v1/answer' ? c.detachedNote(item) : undefined
  const send = async () => { if (await act(path, { id: item.id, answers }, item.id)) { set({ drafts: { ...state.drafts, [item.id]: undefined } }); if (path === '/v1/answer') go('/') } }
  return html`<div>
    ${note ? html`<div class="sub">${note}</div>` : null}
    ${questions.map((q) => {
      const d = drafts[q.id] || { selected: [], custom: '' }
      return html`<div class="q" key=${q.id}>
        ${q.header ? html`<div class="sub">${q.header}</div>` : null}
        <div class="qtext">${q.question}</div>
        ${(q.options || []).map((o) => html`<button class=${'opt' + (d.selected.includes(o.label) ? ' on' : '')} disabled=${busy} aria-pressed=${d.selected.includes(o.label)}
          onClick=${() => setDraft(q.id, c.toggleChoice(d, o.label, !!q.multiSelect))}>
          <span class="mark">${d.selected.includes(o.label) ? (q.multiSelect ? '☑' : '◉') : (q.multiSelect ? '☐' : '○')}</span>
          <span><span>${c.recommended(q, o.label) ? '★ ' : ''}${o.label}</span>${o.description ? html`<div class="d">${o.description}</div>` : null}</span></button>`)}
        <div class="inwrap">
          <input class="input" placeholder="Other answer…" value=${d.custom || ''} disabled=${busy} onInput=${(e) => setDraft(q.id, { selected: q.multiSelect ? d.selected : [], custom: e.target.value })} />
          <${Mic} text=${d.custom || ''} disabled=${busy} onText=${(t) => setDraft(q.id, { selected: q.multiSelect ? d.selected : [], custom: t })} />
        </div>
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
      <${Mic} text=${reply} disabled=${busy} onText=${(t) => set({ replies: { ...state.replies, [item.id]: t } })} />
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

/**
 * A todo waiting for the user (awaiting confirmation, or failed): the suggested workspace, a dropdown preselected like the desktop,
 * Start (Retry when failed) and Cancel. Starting, started and cancelled are read-only text.
 */
function TodoBody({ item }) {
  const st = useStore()
  const [pick, setPick] = useState('')
  const busy = st.busy[item.id]
  const m = todoCardModel(getCore(), item, st.workspaces, pick || undefined)
  useEffect(() => { if (m.canAct && !state.workspaces) loadWorkspaces() }, [m.canAct])
  const start = async () => { if (await act('/v1/todo-confirm', { id: item.id, workspaceId: m.selected }, item.id)) go('/') }
  const cancel = async () => { if (await act('/v1/todo-cancel', { id: item.id }, item.id)) go('/') }
  return html`<div>
    <div class="text">${m.text}</div>
    ${m.sparc ? html`<div class="sub">Use SPARC</div>` : null}
    ${m.line ? html`<div class=${m.failed ? 'err' : 'sub'}>${m.line}</div>` : null}
    ${m.canAct ? html`<select class="input" aria-label="Workspace" value=${m.selected} disabled=${busy} onChange=${(e) => setPick(e.target.value)}>
        ${m.placeholder ? html`<option value="" disabled selected=${!m.selected}>${m.placeholder}</option>` : null}
        ${m.options.map((o) => html`<option key=${o.id} value=${o.id} selected=${o.id === m.selected}>${o.title}</option>`)}
      </select>
      <div class="row">
        <button class="btn pri" disabled=${busy || !m.canStart} onClick=${start}>${busy ? 'Working…' : m.startLabel}</button>
        <button class="btn" disabled=${busy} onClick=${cancel}>Cancel</button>
      </div>` : null}
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

function FilterBar({ model }) {
  const st = useStore()
  const f = st.filter
  return html`<div class="filter">
    <div class="chips">${model.chips.map((c) => html`<button class=${'fchip' + (c.on ? ' on' : '')} aria-pressed=${c.on} onClick=${() => set({ filter: { ...f, type: c.type } })}>${c.label}</button>`)}</div>
    <input class="input" type="search" placeholder="Search…" value=${f.query} onInput=${(e) => set({ filter: { ...f, query: e.target.value } })} />
  </div>`
}

function WaitingList() {
  const c = getCore()
  const st = useStore()
  const all = st.snap ? st.snap.open : []
  const model = listModel(c, st.snap, st.filter)
  const shown = model.open
  return html`<div>
    <div class="row todo-link"><a class="btn pri" href="#/new">+ New todo</a></div>
    ${model.barVisible ? html`<${FilterBar} model=${model} />` : null}
    ${shown.length ? shown.map((i) => html`<${ItemRow} key=${i.id} item=${i} />`) : html`<div class="empty">${all.length ? 'Nothing matches this filter.' : 'Nothing is waiting for you.'}</div>`}
  </div>`
}

function ResolvedList() {
  const c = getCore()
  const st = useStore()
  const all = st.snap ? st.snap.resolved : []
  const model = listModel(c, st.snap, st.filter)
  const shown = model.resolved
  return html`<div>
    <${FilterBar} model=${model} />
    ${shown.length ? shown.map((i) => html`<a class="rowitem" key=${i.id} href=${'#/item/' + i.id}>
      <div class="top"><${Chip} type=${i.type} /><span class="age">${ageOf(i, 'resolvedAt')}</span></div>
      <div class="title">${c.cardTitle(i)}</div><div class="sub">${c.resolutionText(i)}</div></a>`) : html`<div class="empty">${all.length ? 'Nothing matches this filter.' : 'Nothing resolved in the last 7 days.'}</div>`}
  </div>`
}

/** The "+ New todo" screen (#/new): same flow as the desktop form. The draft lives in state, so it survives a trip to another screen. */
function NewTodoView() {
  const c = getCore()
  const st = useStore()
  const draft = st.todoDraft
  const busy = st.busy[NEW_TODO_ID]
  const [message, setMessage] = useState(null)
  useEffect(() => { if (!state.workspaces) loadWorkspaces() }, [])
  const edit = (patch) => set({ todoDraft: { ...state.todoDraft, ...patch } })
  const note = workspacesNote(st.workspaces, st.workspacesError)
  const start = async () => {
    const payload = newTodoPayload(draft)
    if (!payload.ok) { setMessage(payload.message); return }
    setMessage(null)
    const result = await startTodo(payload.body)
    if (result.ok) go('/')
    else setMessage(result.text || todoErrorText(c, result.status, result.body))
  }
  return html`<form class="card newtodo" onSubmit=${(e) => e.preventDefault()}>
    <h2>New todo</h2>
    <textarea class="input ta" placeholder="What should the new session do?" maxlength=${TODO_MAX} value=${draft.text} disabled=${busy}
      onInput=${(e) => edit({ text: e.target.value })}></textarea>
    <div class="row"><${Mic} text=${draft.text} disabled=${busy} onText=${(t) => edit({ text: t })} /></div>
    <label class="field">Workspace
      <select class="input" value=${draft.workspaceId} disabled=${busy} onChange=${(e) => edit({ workspaceId: e.target.value })}>
        ${workspaceChoices(st.workspaces).map((o) => html`<option key=${o.value} value=${o.value} selected=${o.value === draft.workspaceId}>${o.label}</option>`)}
      </select>
    </label>
    ${note ? html`<div class="sub">${note}</div>` : null}
    ${st.workspacesError || (st.workspaces && !st.workspaces.length) ? html`<div class="row"><button class="btn" type="button" onClick=${() => loadWorkspaces()}>Reload workspaces</button></div>` : null}
    <label class="switch"><input type="checkbox" checked=${draft.sparc} disabled=${busy} onChange=${(e) => edit({ sparc: e.target.checked })} /> Use SPARC</label>
    ${message ? html`<div class="err">${message}</div>` : null}
    <div class="row">
      <button class="btn pri" type="button" disabled=${busy || !draft.text.trim()} onClick=${start}>${busy ? 'Starting…' : 'Start todo'}</button>
      <a class="btn" href="#/">Back</a>
    </div>
  </form>`
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

const INSTALL_HINT_KEY = 'rq-m.install-hint-dismissed'
/** Storage can be blocked (private mode): a failure only means the banner is not remembered. */
const installHintDismissed = () => { try { return localStorage.getItem(INSTALL_HINT_KEY) === '1' } catch { return false } }
const dismissInstallHint = () => { try { localStorage.setItem(INSTALL_HINT_KEY, '1') } catch { /* not remembered */ } }

export function App() {
  const st = useStore()
  const route = useRoute()
  const [, tick] = useState(0)
  const [hintGone, setHintGone] = useState(installHintDismissed)
  useEffect(() => { const t = setInterval(() => tick((n) => n + 1), 30000); return () => clearInterval(t) }, [])
  // Rotating the phone or toggling Desktop site changes the viewport: re-render so the guard banner follows.
  useEffect(() => { const f = () => tick((n) => n + 1); window.addEventListener('resize', f); return () => window.removeEventListener('resize', f) }, [])
  if (screenFor(st, route) === 'pair') return html`<${PairView} message=${st.pairMessage} />`
  if (!st.ready && !st.snap) return html`<p class="boot">${st.error || 'Loading the task list…'}</p>`
  const item = /^\/item\/(.+)$/.exec(route)
  const isNew = route === '/new'
  const tab = route === '/resolved' ? 'resolved' : route === '/settings' ? 'settings' : 'waiting'
  const model = listModel(getCore(), st.snap, st.filter)
  const count = model.waiting
  const guard = viewIssue({ userAgent: navigator.userAgent, innerWidth: window.innerWidth, maxTouchPoints: navigator.maxTouchPoints })
  // iPhone in a Safari tab: say once how to install the Home Screen app (the only place push works on iOS).
  const install = hintGone ? null : installHint(platformInfo({ userAgent: navigator.userAgent, maxTouchPoints: navigator.maxTouchPoints, standalone: isStandalone(window) }))
  return html`<div class="app">
    <header><h1>Task list</h1><span class="count">${count} waiting</span></header>
    ${guard ? html`<div class="banner view-guard">${guard.message}</div>` : null}
    ${install ? html`<div class="banner install-hint">${install} <button class="btn" type="button" onClick=${() => { dismissInstallHint(); setHintGone(true) }}>Dismiss</button></div>` : null}
    ${st.error ? html`<div class="banner">${st.error}</div>` : null}
    <main>
      ${item ? html`<${ItemView} id=${decodeURIComponent(item[1])} />` : isNew ? html`<${NewTodoView} />` : tab === 'resolved' ? html`<${ResolvedList} />` : tab === 'settings' ? html`<${SettingsView} />` : html`<${WaitingList} />`}
    </main>
    <nav>
      <a class=${tab === 'waiting' && !item ? 'on' : ''} href="#/">Waiting${count ? html`<span class="badge">${count}</span>` : null}</a>
      <a class=${tab === 'resolved' && !item ? 'on' : ''} href="#/resolved">Resolved${model.resolvedCount ? html`<span class="badge dim">${model.resolvedCount}</span>` : null}</a>
      <a class=${tab === 'settings' && !item ? 'on' : ''} href="#/settings">Settings</a>
    </nav>
  </div>`
}
