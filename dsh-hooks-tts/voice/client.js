/** Client for the STT service's event stream (ws://127.0.0.1:8890/events). Reports; it never decides. */

export function buildEventsUrl({ host = '127.0.0.1', port = 8890, token } = {}) {
  return `ws://${host}:${port}/events?token=${encodeURIComponent(token ?? '')}`
}

const BUSY_ON = new Set(['listening', 'transcribing'])
const BUSY_OFF = new Set(['idle', 'error'])

export function createVoiceClient({
  url,
  WebSocketImpl = globalThis.WebSocket,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
  backoff = {},
  onEvent = () => {},
  onState = () => {},
  onBusy = () => {},
} = {}) {
  const { initialMs = 500, maxMs = 10000, factor = 2 } = backoff
  let socket
  let wanted = false
  let timer
  let delay = initialMs
  const client = { state: 'disconnected', busy: false, lastTranscript: undefined }

  const setState = (s) => {
    if (client.state === s) return
    client.state = s
    onState(s)
  }
  const setBusy = (b) => {
    if (client.busy === b) return
    client.busy = b
    onBusy(b)
  }

  const scheduleReconnect = () => {
    if (!wanted) return
    const ms = delay
    delay = Math.min(maxMs, delay * factor)
    timer = setTimer(() => {
      timer = undefined
      connect()
    }, ms)
  }

  const handleClose = (sock) => {
    if (sock !== socket) return
    socket = undefined
    setBusy(false)
    setState('disconnected')
    scheduleReconnect()
  }

  const handleMessage = (data) => {
    let event
    try {
      event = JSON.parse(typeof data === 'string' ? data : String(data))
    } catch {
      return
    }
    if (!event || typeof event !== 'object' || typeof event.type !== 'string') return
    if (event.type === 'hello') delay = initialMs
    if (BUSY_ON.has(event.type)) setBusy(true)
    else if (BUSY_OFF.has(event.type)) setBusy(false)
    if (event.type === 'transcript' && String(event.text ?? '').trim()) client.lastTranscript = event
    onEvent(event)
  }

  function connect() {
    setState('connecting')
    let sock
    try {
      sock = new WebSocketImpl(url)
    } catch {
      setState('disconnected')
      scheduleReconnect()
      return
    }
    socket = sock
    sock.onopen = () => {
      if (sock === socket) setState('connected')
    }
    sock.onmessage = (m) => {
      if (sock === socket) handleMessage(m.data)
    }
    sock.onclose = () => handleClose(sock)
    sock.onerror = () => {}
  }

  client.start = () => {
    if (wanted) return
    wanted = true
    delay = initialMs
    connect()
  }
  client.stop = () => {
    wanted = false
    if (timer !== undefined) clearTimer(timer)
    timer = undefined
    const sock = socket
    if (sock) {
      try {
        sock.close()
      } catch {}
    }
    socket = undefined
    setBusy(false)
    setState('disconnected')
  }
  return client
}
