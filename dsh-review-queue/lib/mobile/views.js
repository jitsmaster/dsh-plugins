/** Phone views (Preact + htm, no build step). Card logic comes from the shared core (api.js getCore()). */
import { Component, h, html, useState, useEffect, useLayoutEffect, useRef } from './vendor/preact-htm.js'
import { state, subscribe, set, act, getCore, loadWorkspaces, loadEfforts, startTodo, NEW_TODO_ID, loadThread, loadEarlier, postFollowUp, startThreadPolling, stopThreadPolling, saveNow } from './api.js'
import { HOLD_MS, holdState } from './hold.js'
import { PairView } from './pairing.js'
import { SettingsView } from './settings.js'
import { backHref, heldView, listModel, pausedNote, pausedView, screenFor, todoCancelBody, todoCardModel, todoConfirmBody } from './model.js'
import { viewIssue } from './view-guard.js'
import { platformInfo, installHint, isStandalone } from './platform.js'
import { createDictation } from './dictation.js'
import { bubbleChanged, canPost, createDraftBuffer, hasThread, isNearBottom, scrollPlan } from './thread.js'
import { FOLLOWUP_HINT, FOLLOWUP_MAX, FOLLOWUP_QUERY_PLACEHOLDER, FOLLOWUP_TEXT_PLACEHOLDER, TODO_MAX, effortChoices, effortName, isFollowUpDraft, newTodoPayload, todoErrorText, withTodoMode, workspaceChoices, workspacesNote } from './todo-form.js'

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

export function inlineNodes(s) {
  return getCore().mdInline(s).map((tok) => {
    if (tok.t === 'b') return html`<strong>${tok.text}</strong>`
    if (tok.t === 'bu') return html`<strong class="action">${tok.text}</strong>`
    if (tok.t === 'i') return html`<em>${tok.text}</em>`
    if (tok.t === 'code') return html`<code>${tok.text}</code>`
    if (tok.t === 'a') return html`<a href=${tok.href} target="_blank" rel="noopener noreferrer">${tok.text}</a>`
    return tok.text
  })
}

/** A plain text with its action items (<u>**...**</u>) as emphasis; nothing else in it is read as markdown (question, option, reason and message text). */
export function ActionText({ text }) {
  return getCore().actionTokens(text).map((tok) => (tok.t === 'bu' ? html`<strong class="action">${tok.text}</strong>` : tok.text))
}

export function Md({ text }) {
  const c = getCore()
  const inline = inlineNodes
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
  // Android: Chrome's speechSynthesis is the device's own TextToSpeech engine. iPhone / iPad: no Read aloud button at all.
  if (platformInfo({ userAgent: navigator.userAgent, maxTouchPoints: navigator.maxTouchPoints }).ios || typeof speechSynthesis === 'undefined' || !item.spoken) return null
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
 * The owner can halt the dictation (the ref `halt` is filled with a function): the composer does before it posts. It also halts by itself when the
 * button gets disabled (a post or an answer is running) and when it is removed: a result that lands after that must not reach the box.
 */
function Mic({ text, onText, disabled, halt }) {
  const [on, setOn] = useState(false)
  const [problem, setProblem] = useState(null)
  const latest = useRef(onText)
  latest.current = onText
  const dictation = useRef(undefined)
  // iOS words the permission errors differently (Settings > Safari, Siri & Dictation).
  const ios = platformInfo({ userAgent: navigator.userAgent, maxTouchPoints: navigator.maxTouchPoints }).ios
  if (dictation.current === undefined) dictation.current = createDictation({ win: window, ios, onText: (t) => latest.current(t), onState: setOn, onError: setProblem })
  const d = dictation.current
  if (halt) halt.current = () => { if (d) d.halt() }
  useEffect(() => { if (disabled && d) d.halt() }, [disabled]) // a post or an answer is running: nothing more may reach the box
  useEffect(() => () => { if (d) d.halt() }, []) // leaving the screen releases the microphone, and a late result lands nowhere
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
        ${q.header ? html`<div class="sub"><${ActionText} text=${q.header} /></div>` : null}
        <div class="qtext"><${ActionText} text=${q.question} /></div>
        ${(q.options || []).map((o) => html`<button class=${'opt' + (d.selected.includes(o.label) ? ' on' : '')} disabled=${busy} aria-pressed=${d.selected.includes(o.label)}
          onClick=${() => setDraft(q.id, c.toggleChoice(d, o.label, !!q.multiSelect))}>
          <span class="mark">${d.selected.includes(o.label) ? (q.multiSelect ? '☑' : '◉') : (q.multiSelect ? '☐' : '○')}</span>
          <span><span>${c.recommended(q, o.label) ? '★ ' : ''}${o.label}</span>${o.description ? html`<div class="d"><${ActionText} text=${o.description} /></div>` : null}</span></button>`)}
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
    ${p.reason ? html`<div class="sub"><${ActionText} text=${p.reason} /></div>` : null}
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
  const st = useStore()
  const busy = st.busy[item.id]
  // Writing back to the session is the composer under the card (ItemView): this body keeps the summary, the full reply and Reviewed.
  return html`<div>
    <div class="text" style="white-space:pre-line">${item.summary ? inlineNodes(item.summary) : 'Finished.'}</div>
    ${item.payload && item.payload.reply ? html`<details open=${(item.payload.reply || '').length < 1500}><summary class="sub">Full reply</summary><${Md} text=${item.payload.reply} /></details>` : null}
    <div class="row">
      <button class="btn" disabled=${busy} onClick=${async () => { if (await act('/v1/reviewed', { id: item.id }, item.id)) go('/') }}>Reviewed</button>
      <${OnHoldButton} item=${item} />
    </div>
    <${OnHoldForm} item=${item} />
  </div>`
}

function ArchiveBody({ item }) {
  const st = useStore()
  const [ask, setAsk] = useState(false)
  const busy = st.busy[item.id]
  const reason = (item.payload && item.payload.reason) || ''
  return html`<div>
    <div class="text">This session asks to be archived.</div>
    ${reason ? html`<div class="sub">Reason: ${reason}</div>` : null}
    <div class="row">
      <button class="btn pri" disabled=${busy} onClick=${() => setAsk(true)}>${busy ? 'Archiving…' : 'Archive session…'}</button>
      <button class="btn" disabled=${busy} onClick=${async () => { if (await act('/v1/reviewed', { id: item.id }, item.id)) go('/') }}>Keep session</button>
    </div>
    ${ask ? html`<${Sheet} title="Archive this session?" lines=${[item.sessionTitle || 'This session', 'Anything it is still running is stopped.']} confirmLabel="Archive"
      onConfirm=${async () => { setAsk(false); if (await act('/v1/archive', { id: item.id }, item.id)) go('/') }} onCancel=${() => setAsk(false)} />` : null}
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
 * A todo waiting for the user (awaiting confirmation, or failed): the suggested workspace (a follow-up: the suggested session), a dropdown
 * preselected like the desktop, Start (a follow-up: Send; Retry when failed) and Cancel. Starting ("Sending…" for a follow-up), started and
 * cancelled are read-only text.
 */
function TodoBody({ item }) {
  const st = useStore()
  const [pick, setPick] = useState('')
  const busy = st.busy[item.id]
  const m = todoCardModel(getCore(), item, st.workspaces, pick || undefined)
  useEffect(() => { if (m.needsWorkspaces && !state.workspaces) loadWorkspaces() }, [m.needsWorkspaces])
  const start = async () => { if (await act('/v1/todo-confirm', todoConfirmBody(item, m.selected), item.id)) go('/') }
  const cancel = async () => { if (await act('/v1/todo-cancel', todoCancelBody(item), item.id)) go('/') }
  return html`<div>
    <div class="text">${m.text}</div>
    ${m.sparc ? html`<div class="sub">Use SPARC</div>` : null}
    ${m.effort ? html`<div class="sub">Effort: ${effortName(st.efforts, m.effort)}</div>` : null}
    ${m.line ? html`<div class=${m.failed ? 'err' : 'sub'}>${m.line}</div>` : null}
    ${m.canAct ? html`<select class="input" aria-label=${m.selectLabel} value=${m.selected} disabled=${busy} onChange=${(e) => setPick(e.target.value)}>
        ${m.placeholder ? html`<option value="" disabled selected=${!m.selected}>${m.placeholder}</option>` : null}
        ${m.options.map((o) => html`<option key=${o.id} value=${o.id} selected=${o.id === m.selected}>${o.title}</option>`)}
      </select>
      <div class="row">
        <button class="btn pri" disabled=${busy || !m.canStart} onClick=${start}>${busy ? 'Working…' : m.startLabel}</button>
        <button class="btn" disabled=${busy} onClick=${cancel}>Cancel</button>
      </div>` : null}
  </div>`
}

/** A session a restart cut off: the phone shows why it is listed and can Dismiss it (it needs no action); resuming it is done at the PC. */
function PausedBody({ item }) {
  const st = useStore()
  const busy = st.busy[item.id]
  const v = pausedView(getCore(), item, now())
  return html`<div>
    ${v.facts.map((f, i) => html`<div class=${i === 0 ? 'text' : 'sub'} key=${i}>${f}</div>`)}
    <div class="sub">${v.note}</div>
    <div class="row">
      <button class="btn" disabled=${busy} onClick=${async () => { if (await act('/v1/paused-dismiss', { id: item.id }, item.id)) go('/') }}>Dismiss</button>
      <${OnHoldButton} item=${item} />
    </div>
    <${OnHoldForm} item=${item} />
  </div>`
}

/** Hold (Done and Paused cards): park the session in the On hold tab. The reason is optional; OnHoldButton sits in the row, OnHoldForm (the reason line) under it. */
const holdOpen = new Set() // item ids whose reason line is open (survives a re-render of the card)
function OnHoldButton({ item }) {
  const st = useStore()
  return html`<button class="btn" disabled=${st.busy[item.id] || holdOpen.has(item.id)} onClick=${() => { holdOpen.add(item.id); set({}) }}>Hold…</button>`
}
function OnHoldForm({ item }) {
  const st = useStore()
  const [reason, setReason] = useState('')
  const busy = st.busy[item.id]
  if (!holdOpen.has(item.id)) return null
  const close = () => { holdOpen.delete(item.id); set({}) }
  return html`<div class="holdbox" data-holdbox>
    <input class="input" placeholder="Why? (optional, e.g. waiting for the customer)" maxlength="300" value=${reason} disabled=${busy} onInput=${(e) => setReason(e.target.value)} />
    <div class="row">
      <button class="btn pri" disabled=${busy} onClick=${async () => { if (await act('/v1/hold', { id: item.id, reason }, item.id)) { close(); go('/') } }}>${busy ? 'Holding…' : 'Put on hold'}</button>
      <button class="btn" disabled=${busy} onClick=${close}>Cancel</button>
    </div>
  </div>`
}

/** A session on hold: why, the ticket being watched and when it was last checked; Continue prompts the session now, Release takes it off hold. */
function HeldBody({ item }) {
  const st = useStore()
  const busy = st.busy[item.id]
  const v = heldView(getCore(), item, now())
  return html`<div>
    ${v.facts.map((f, i) => html`<div class=${i === 0 ? 'text' : 'sub'} key=${i}>${f}</div>`)}
    <div class="row">
      <button class="btn pri" disabled=${busy} onClick=${async () => { if (await act('/v1/hold-continue', { id: item.id }, item.id)) go('/onhold') }}>${busy ? 'Working…' : 'Continue'}</button>
      <button class="btn" disabled=${busy} onClick=${async () => { if (await act('/v1/hold-release', { id: item.id }, item.id)) go('/onhold') }}>Release</button>
    </div>
  </div>`
}

// ---- chat thread (docs/mobile.md "Chat thread") ----------------------------------------------------------------------------------

/** One message: the user's text as plain pre-wrapped text on the right, the assistant's rendered as markdown on the left. */
export function Bubble({ m }) {
  const user = m.role === 'user'
  const when = m.pending ? (m.sent ? 'Sent' : 'Sending…') : m.time > 1e12 ? getCore().fmtAge(now() - m.time) : ''
  return html`<div class=${'bubble ' + (user ? 'user' : 'assistant') + (m.pending ? ' pending' : '')}>
    ${user ? html`<div class="utext">${m.text}</div>` : html`<${Md} text=${m.text} />`}
    ${m.truncated ? html`<div class="sub trunc">… the rest of this message is not shown.</div>` : null}
    ${when ? html`<div class="meta">${when}</div>` : null}
  </div>`
}

/** A component that is drawn again only when `changed(oldProps, newProps)` says so (the vendored preact has no memo): a poll that brings nothing new re-renders no bubble. */
function onlyWhen(changed, Inner) {
  return class extends Component {
    shouldComponentUpdate(next) { return changed(this.props, next) }
    render(props) { return h(Inner, props) }
  }
}
const MemoBubble = onlyWhen(bubbleChanged, Bubble)

/**
 * The past conversation of the item's session: newest 40 messages, Load earlier, the 5 s refresh. Conversation mounts it only while its section is
 * open, so the first load and the polling start when the section opens and stop when it closes (or the screen is left).
 */
function ThreadView({ item }) {
  const st = useStore()
  const id = item.id
  const t = st.threads[id]
  const messages = t ? t.messages : []
  const box = useRef(null)
  const near = useRef(true) // was the reader at the bottom before the last change?
  const seen = useRef({ count: 0, lastId: undefined })
  const anchor = useRef(null) // distance from the bottom while an earlier page is loading: the reader keeps their place
  const [pill, setPill] = useState(0)
  const minute = Math.floor(now() / 60000) // the age under a bubble moves on once a minute
  useEffect(() => { loadThread(id); startThreadPolling(id); return () => stopThreadPolling() }, [id])
  const toBottom = () => { const el = box.current; if (el) el.scrollTop = el.scrollHeight }
  useLayoutEffect(() => {
    const el = box.current
    const prev = seen.current
    const last = messages.length ? messages[messages.length - 1] : undefined
    seen.current = { count: messages.length, lastId: last && last.id }
    if (!el || !messages.length) return
    if (anchor.current !== null) { el.scrollTop = el.scrollHeight - anchor.current; if (messages.length > prev.count) anchor.current = null; return }
    if (!prev.count) { toBottom(); near.current = true; return }
    const plan = scrollPlan({ wasNearBottom: near.current, added: messages.length - prev.count, posted: !!last && last.pending === true && last.id !== prev.lastId })
    if (plan.stick) toBottom()
    else if (plan.pill) setPill((n) => n + plan.pill)
  }, [messages])
  // The box can change size without a new message (the card above it shrinks, the keyboard opens): a reader who was at the bottom stays there.
  const shown = messages.length > 0
  useEffect(() => {
    const el = box.current
    if (!el || typeof ResizeObserver === 'undefined') return undefined
    const watcher = new ResizeObserver(() => { if (near.current) toBottom() })
    watcher.observe(el)
    return () => watcher.disconnect()
  }, [shown])
  const earlier = async () => { const el = box.current; if (el) anchor.current = el.scrollHeight - el.scrollTop; await loadEarlier(id); anchor.current = null }
  const onScroll = () => { const el = box.current; if (!el) return; near.current = isNearBottom(el); if (near.current) setPill(0) }
  if (!t || (t.loading && !messages.length)) return html`<div class="thread"><div class="empty" role="status">Loading the conversation…</div></div>`
  if (t.error && !messages.length) return html`<div class="thread"><div class="empty"><div class="err" role="alert">${t.error}</div><div class="row"><button class="btn" onClick=${() => loadThread(id)}>Retry</button></div></div></div>`
  if (!messages.length) return html`<div class="thread"><div class="empty">No messages yet.</div></div>`
  return html`<div class="thread">
    <div class="thread-scroll" ref=${box} onScroll=${onScroll}>
      ${t.hasMore ? html`<button class="btn thread-more" disabled=${t.loadingEarlier} onClick=${earlier}>${t.loadingEarlier ? 'Loading…' : 'Load earlier'}</button>` : null}
      ${messages.map((m) => html`<${MemoBubble} key=${m.id} m=${m} minute=${minute} />`)}
    </div>
    ${pill ? html`<button class="pill" onClick=${() => { toBottom(); near.current = true; setPill(0) }}>↓ ${pill} new message${pill === 1 ? '' : 's'}</button>` : null}
    ${t.error ? html`<div class="thread-note sub" role="status">${t.error}</div>` : null}
  </div>`
}

/** The conversation as a collapsible section below the card's actions: open for done and resolved items, closed where the buttons matter. */
function Conversation({ item, defaultOpen }) {
  const st = useStore()
  const [open, setOpen] = useState(defaultOpen)
  const t = st.threads[item.id]
  const n = t ? t.messages.filter((m) => !m.pending).length : 0
  return html`<details class="conversation" open=${open} onToggle=${(e) => setOpen(e.currentTarget.open)}>
    <summary>Conversation${n ? ' (' + n + (t.hasMore ? '+' : '') + ')' : ''}</summary>
    ${open ? html`<${ThreadView} item=${item} />` : null}
  </details>`
}

/** Grows the box with its text; the style caps it at about five lines (then it scrolls). */
function autoGrow(el) {
  if (!el) return
  el.style.height = 'auto'
  el.style.height = el.scrollHeight + 'px'
}

/**
 * The box under the card: write a follow-up to the session. Enter is a newline; Send posts; the mic only fills the box. While a post runs the
 * box is read-only, not disabled: a disabled box loses the focus and the phone's keyboard closes.
 */
function Composer({ item }) {
  const st = useStore()
  const id = item.id
  const busy = !!st.busy[id]
  const stored = st.replies[id] || ''
  const box = useRef(null)
  const buffer = useRef(null)
  const micHalt = useRef(null) // the Mic fills it: Send halts a running dictation before it posts
  if (buffer.current === null) buffer.current = createDraftBuffer({ read: () => state.replies[id] || '', write: (text) => set({ replies: { ...state.replies, [id]: text } }) })
  const [draft, setShown] = useState(() => buffer.current.value())
  // Typing (and the dictation, which writes many times a second) stays in this component: the store, and so every view, hears of the draft 250 ms after the last change.
  // Dictated text is ignored while a post of this item runs (read live: the recognition calls back between renders): a late result must not come back as a draft.
  const setDraft = (text) => { if (state.busy[id]) return; buffer.current.set(text); setShown(text) }
  const flush = () => buffer.current.flush()
  // A change from outside (an accepted post cleared the draft) is taken over, unless a write of the typed text is waiting.
  useEffect(() => { const next = buffer.current.adopt(stored); if (next !== undefined) setShown(next) }, [stored])
  useEffect(() => {
    const b = buffer.current
    const leave = () => { b.flush(); saveNow() }
    const hidden = () => { if (document.hidden) leave() }
    window.addEventListener('pagehide', leave)
    document.addEventListener('visibilitychange', hidden)
    return () => { window.removeEventListener('pagehide', leave); document.removeEventListener('visibilitychange', hidden); b.dispose() }
  }, [])
  useLayoutEffect(() => autoGrow(box.current), [draft])
  const send = async () => { if (micHalt.current) micHalt.current(); buffer.current.flush(); await postFollowUp(id, state.replies[id] || '') }
  return html`<div class="composer">
    ${st.errors[id] ? html`<div class="err" role="alert">${st.errors[id]}</div>` : null}
    <div class="composer-row">
      <textarea class="input composer-input" ref=${box} rows="1" placeholder="Message this session…" aria-label="Message to this session" value=${draft} readOnly=${busy}
        onInput=${(e) => setDraft(e.target.value)} onBlur=${flush}></textarea>
      <${Mic} text=${draft} disabled=${busy} onText=${setDraft} halt=${micHalt} />
      <button class="btn pri send" type="button" disabled=${busy || !draft.trim()} onClick=${send}>${busy ? 'Sending…' : 'Send'}</button>
    </div>
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
  const note = pausedNote(model.paused)
  return html`<div>
    <div class="row todo-link"><a class="btn pri" href="#/new">+ New todo</a></div>
    ${note ? html`<div class="banner paused-note" role="status">⏸ ${note} <button class="btn" type="button" onClick=${() => set({ filter: { ...st.filter, type: 'paused' } })}>Show</button></div>` : null}
    ${model.barVisible ? html`<${FilterBar} model=${model} />` : null}
    ${shown.length ? shown.map((i) => html`<${ItemRow} key=${i.id} item=${i} />`) : html`<div class="empty">${all.some((i) => i.type !== 'onhold') ? 'Nothing matches this filter.' : 'Nothing is waiting for you.'}</div>`}
  </div>`
}

/** The On hold tab (#/onhold): sessions parked until they can continue, with the search box of the other lists. */
function HeldList() {
  const st = useStore()
  const model = listModel(getCore(), st.snap, st.filter)
  const f = st.filter
  return html`<div>
    <input class="input" type="search" placeholder="Search…" value=${f.query} onInput=${(e) => set({ filter: { ...f, query: e.target.value } })} />
    ${model.heldOpen.length ? model.heldOpen.map((i) => html`<${ItemRow} key=${i.id} item=${i} />`) : html`<div class="empty">${model.held ? 'Nothing matches this search.' : 'No session is on hold.'}</div>`}
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
  const follow = isFollowUpDraft(draft) // Follow up: the text goes to an existing session described in words (no workspace, no SPARC)
  const [message, setMessage] = useState(null)
  useEffect(() => { if (!follow && !state.workspaces) loadWorkspaces() }, [follow]) // a follow-up never needs the workspaces
  useEffect(() => { if (!follow) loadEfforts() }, [follow]) // nor the efforts; asked again each time the form is shown (the default model may have changed)
  const edit = (patch) => set({ todoDraft: typeof patch === 'function' ? patch(state.todoDraft) : { ...state.todoDraft, ...patch } })
  const note = follow ? null : workspacesNote(st.workspaces, st.workspacesError)
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
    <div class="chips" role="group" aria-label="Kind of todo">
      ${[['new', 'New session'], ['followup', 'Follow up']].map(([mode, label]) => html`<button key=${mode} type="button" class=${'fchip' + (follow === (mode === 'followup') ? ' on' : '')} aria-pressed=${follow === (mode === 'followup')} disabled=${busy}
        onClick=${() => { setMessage(null); edit((d) => withTodoMode(d, mode)) }}>${label}</button>`)}
    </div>
    <textarea class="input ta" placeholder=${follow ? FOLLOWUP_TEXT_PLACEHOLDER : 'What should the new session do?'} maxlength=${TODO_MAX} value=${draft.text} disabled=${busy}
      onInput=${(e) => edit({ text: e.target.value })}></textarea>
    <div class="row"><${Mic} text=${draft.text} disabled=${busy} onText=${(t) => edit({ text: t })} /></div>
    ${follow ? html`<div class="inwrap followup-query">
      <input class="input" type="text" required aria-label="Which session" placeholder=${FOLLOWUP_QUERY_PLACEHOLDER} maxlength=${FOLLOWUP_MAX} value=${draft.followUp || ''} disabled=${busy}
        onInput=${(e) => edit({ followUp: e.target.value })} />
      <${Mic} text=${draft.followUp || ''} disabled=${busy} onText=${(t) => edit({ followUp: t })} />
    </div>` : null}
    ${follow ? null : html`<label class="field">Workspace
      <select class="input" value=${draft.workspaceId} disabled=${busy} onChange=${(e) => edit({ workspaceId: e.target.value })}>
        ${workspaceChoices(st.workspaces).map((o) => html`<option key=${o.value} value=${o.value} selected=${o.value === draft.workspaceId}>${o.label}</option>`)}
      </select>
    </label>`}
    ${note ? html`<div class="sub">${note}</div>` : null}
    ${!follow && (st.workspacesError || (st.workspaces && !st.workspaces.length)) ? html`<div class="row"><button class="btn" type="button" onClick=${() => loadWorkspaces()}>Reload workspaces</button></div>` : null}
    ${follow ? null : html`<label class="switch"><input type="checkbox" checked=${draft.sparc} disabled=${busy} onChange=${(e) => edit({ sparc: e.target.checked })} /> Use SPARC</label>`}
    ${!follow && effortChoices(st.efforts).length ? html`<label class="field">Effort
      <select class="input" aria-label="Effort" title="Only this session uses it; the default effort stays as it is" value=${draft.effort || ''} disabled=${busy} onChange=${(e) => edit({ effort: e.target.value })}>
        ${effortChoices(st.efforts).map((o) => html`<option key=${o.value} value=${o.value} selected=${o.value === (draft.effort || '')}>${o.label}</option>`)}
      </select>
    </label>` : null}
    ${follow ? html`<div class="sub">${FOLLOWUP_HINT}</div>` : null}
    ${message ? html`<div class="err">${message}</div>` : null}
    <div class="row">
      <button class="btn pri" type="button" disabled=${busy || !draft.text.trim()} onClick=${start}>${busy ? 'Starting…' : follow ? 'Add follow-up' : 'Start todo'}</button>
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
  const Body = item.type === 'question' ? QuestionBody : item.type === 'permission' ? PermissionBody : item.type === 'pr-merged' ? PrMergedBody : item.type === 'archive' ? ArchiveBody : item.type === 'todo' ? TodoBody : item.type === 'paused' ? PausedBody : item.type === 'onhold' ? HeldBody : CompletedBody
  const chat = hasThread(item) // every item with a session (not a todo): its conversation below the actions
  const writable = canPost(item) // and a composer at the bottom, except for a paused one (it is resumed at the PC)
  return html`<article class="card">
    <div class="top"><${Chip} type=${item.type} /><span class="age">${resolved ? ageOf(item, 'resolvedAt') : ageOf(item)}</span></div>
    <h2>${c.cardTitle(item)}</h2>
    ${item.sessionTitle ? html`<div class="sub">${item.sessionTitle}${item.workspace ? ' · ' + item.workspace : ''}</div>` : null}
    ${open ? html`<${Body} item=${item} />` : html`<div>
      <div class="resolution">${c.resolutionText(item)}</div>
      ${late ? html`<details><summary class="sub">Answer now (late)</summary><${QuestionBody} item=${item} path="/v1/late-answer" sendLabel="Send late answer" /></details>` : null}
      ${c.isReopenable(item) ? html`<div class="row"><button class="btn" disabled=${st.busy[item.id]} onClick=${async () => { if (await act('/v1/reopen', { id: item.id }, item.id)) go('/') }}>Reopen</button></div>` : null}
    </div>`}
    ${chat ? html`<${Conversation} key=${item.id} item=${item} defaultOpen=${!!resolved || item.type === 'completed'} />` : null}
    ${st.errors[item.id] && !writable ? html`<div class="err">${st.errors[item.id]}</div>` : null}
    <div class="row"><${ReadAloud} item=${item} /><a class="btn" href=${backHref(item)}>Back</a></div>
    ${writable ? html`<${Composer} key=${item.id} item=${item} />` : null}
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
  if (!st.ready && !st.snap) return html`<p class="boot">${st.error || 'Loading the Coding Boss Review Queue…'}</p>`
  const item = /^\/item\/(.+)$/.exec(route)
  const isNew = route === '/new'
  const tab = route === '/resolved' ? 'resolved' : route === '/settings' ? 'settings' : route === '/onhold' ? 'onhold' : 'waiting'
  const model = listModel(getCore(), st.snap, st.filter)
  const count = model.waiting
  const guard = viewIssue({ userAgent: navigator.userAgent, innerWidth: window.innerWidth, maxTouchPoints: navigator.maxTouchPoints })
  // iPhone in a Safari tab: say once how to install the Home Screen app (the only place push works on iOS).
  const install = hintGone ? null : installHint(platformInfo({ userAgent: navigator.userAgent, maxTouchPoints: navigator.maxTouchPoints, standalone: isStandalone(window) }))
  return html`<div class="app">
    <header><h1>Coding Boss Review Queue</h1><div class="counts"><span class="count">${count} waiting${model.paused ? html` · <span class="paused-count">⏸ ${model.paused} paused</span>` : null}</span><span class="count sessions" title=${getCore().sessionsTitle}>${model.sessions}</span></div></header>
    ${guard ? html`<div class="banner view-guard">${guard.message}</div>` : null}
    ${install ? html`<div class="banner install-hint">${install} <button class="btn" type="button" onClick=${() => { dismissInstallHint(); setHintGone(true) }}>Dismiss</button></div>` : null}
    ${st.error ? html`<div class="banner">${st.error}</div>` : null}
    <main>
      ${item ? html`<${ItemView} id=${decodeURIComponent(item[1])} />` : isNew ? html`<${NewTodoView} />` : tab === 'resolved' ? html`<${ResolvedList} />` : tab === 'onhold' ? html`<${HeldList} />` : tab === 'settings' ? html`<${SettingsView} />` : html`<${WaitingList} />`}
    </main>
    <nav>
      <a class=${tab === 'waiting' && !item ? 'on' : ''} href="#/">Waiting${count ? html`<span class="badge">${count}</span>` : null}</a>
      ${model.held || tab === 'onhold' ? html`<a class=${tab === 'onhold' && !item ? 'on' : ''} href="#/onhold">On hold${model.held ? html`<span class="badge dim">${model.held}</span>` : null}</a>` : null}
      <a class=${tab === 'resolved' && !item ? 'on' : ''} href="#/resolved">Resolved${model.resolvedCount ? html`<span class="badge dim">${model.resolvedCount}</span>` : null}</a>
      <a class=${tab === 'settings' && !item ? 'on' : ''} href="#/settings">Settings</a>
    </nav>
  </div>`
}
