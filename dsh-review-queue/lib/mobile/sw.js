/**
 * Service worker of the phone page (scope /review-queue/m/). It only shows push notifications and routes their taps; there is no fetch
 * handler on purpose: the API is never cached, the list is always the live one.
 * Push payload (JSON, written by the server): { title, body, tag, url } with url relative to the app, e.g. "#/item/<id>".
 * The text is deliberately generic (type and count): it passes through the push service.
 */
const APP = self.registration.scope

/** The deep link as an absolute URL inside the app scope; anything that would leave it opens the app instead. */
function target(url) {
  try {
    const u = new URL(typeof url === 'string' ? url : '', APP)
    return u.href.startsWith(APP) ? u.href : APP
  } catch { return APP }
}

self.addEventListener('install', (event) => { event.waitUntil(self.skipWaiting()) })
self.addEventListener('activate', (event) => { event.waitUntil(self.clients.claim()) })

self.addEventListener('push', (event) => {
  let data = {}
  try { data = (event.data && event.data.json()) || {} } catch { /* not JSON: still show something, Android requires a notification per push */ }
  const text = (v, fallback) => (typeof v === 'string' && v ? v : fallback)
  event.waitUntil(self.registration.showNotification(text(data.title, 'Task list'), {
    body: text(data.body, ''),
    tag: text(data.tag, 'task-list'), // one notification per type: a newer one replaces the older
    renotify: true,
    icon: './icon-192.png',
    badge: './icon-192.png',
    data: { url: target(data.url) },
  }))
})

self.addEventListener('notificationclick', (event) => {
  event.notification.close()
  const url = target(event.notification.data && event.notification.data.url)
  event.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(async (windows) => {
    const open = windows.find((w) => w.url.startsWith(APP))
    if (!open) return self.clients.openWindow(url)
    await open.focus()
    open.postMessage({ type: 'open', hash: new URL(url).hash || '#/' })
  }))
})
