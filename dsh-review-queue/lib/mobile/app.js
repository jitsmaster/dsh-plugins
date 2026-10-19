import { html, render } from './vendor/preact-htm.js'
import { init, state } from './api.js'
import { App } from './views.js'
import { watchTyping } from './view-guard.js'

const root = document.getElementById('app')
watchTyping(document) // a text field outside the composer in focus: no tab bar, so the keyboard leaves room
init().then(() => render(html`<${App} />`, root), (error) => { root.innerHTML = ''; const p = document.createElement('p'); p.className = 'boot'; p.textContent = 'Could not start: ' + (error && error.message || error); root.append(p) })
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('./sw.js', { scope: './' }).catch(() => { /* push is optional */ })
  // a tapped notification focuses this window and says which item to show
  navigator.serviceWorker.addEventListener('message', (e) => { if (e.data && e.data.type === 'open' && /^#\//.test(e.data.hash)) location.hash = e.data.hash })
}
void state
