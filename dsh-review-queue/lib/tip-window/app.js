// The tip pop-out page. Every text goes in with textContent (never as HTML). Routes are relative to /review-queue/ (this page is /review-queue/tip-window/).
(() => {
  const $ = (id) => document.getElementById(id)
  const API = '../v1'
  let tip
  let reading = false
  let busy = false

  async function call(route, body) {
    const res = await fetch(API + '/' + route, { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body ?? {}) })
    const json = await res.json().catch(() => ({}))
    if (!res.ok || json.ok === false) throw new Error(({ 'no model available': 'No model is available to write that right now.', 'LLM error': 'The model could not do that. Try again.' })[json.error] ?? 'That did not work (' + (json.error ?? res.status) + ').')
    return json
  }
  const paragraphs = (text) => String(text ?? '').split(/\n+/).filter(Boolean)
  function fill(el, texts) {
    el.textContent = ''
    for (const t of texts) { const p = document.createElement('p'); p.textContent = t; el.appendChild(p) }
  }
  function showError(message) { $('error').textContent = message ?? ''; $('error').hidden = !message }
  function setBusy(on) {
    busy = on
    for (const id of ['next', 'write', 'go-deeper', 'read', 'topic']) $(id).disabled = on
  }
  function render() {
    if (!tip) return
    $('category').textContent = tip.category ?? ''
    $('source').textContent = tip.topic ? 'On your topic' : tip.source === 'model' ? 'AI-generated' : 'Tip of the day'
    $('title').textContent = tip.title
    fill($('body'), paragraphs(tip.body))
    const deeper = tip.deeper && Array.isArray(tip.deeper.paragraphs) ? tip.deeper.paragraphs : []
    fill($('deeper'), deeper)
    $('go-deeper').hidden = deeper.length > 0
    $('read').textContent = reading ? '■ Stop reading' : '▶ Read aloud'
  }
  async function run(work) {
    if (busy) return
    setBusy(true)
    showError()
    try { await work() } catch (error) { showError(error.message) }
    setBusy(false)
  }
  const load = () => run(async () => { tip = (await call('tip-current')).tip; render() })

  $('next').addEventListener('click', () => run(async () => { reading = false; tip = (await call('tip-next')).tip; render() }))
  $('topic-form').addEventListener('submit', (event) => {
    event.preventDefault()
    const topic = $('topic').value.trim()
    if (!topic) return
    run(async () => { reading = false; tip = (await call('tip-next', { topic })).tip; $('topic').value = ''; render() })
  })
  $('go-deeper').addEventListener('click', () => run(async () => { const r = await call('tip-deeper', { id: tip.id }); tip = { ...tip, deeper: r.deeper }; render() }))
  $('read').addEventListener('click', () => run(async () => {
    if (reading) { await call('stop'); reading = false } else { await call('read-tip', { id: tip.id }); reading = true }
    render()
  }))
  load()
})()
