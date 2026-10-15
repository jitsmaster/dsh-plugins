/**
 * One HTTP request to the hub: JSON in and out, the agent secret and the protocol on every request, a timeout, and a signal to
 * cancel. Resolves { status, json } for any answer the hub gives; a connection that fails or times out rejects with code 'network'.
 */
const networkError = (message) => Object.assign(new Error(message), { code: 'network' })

/** @param {{ baseUrl: string, secret: string, protocol: number, instanceId?: string, fetch?: typeof fetch, timeoutMs?: number }} opts */
export function createTransport({ baseUrl, secret, protocol, instanceId, fetch: doFetch = globalThis.fetch, timeoutMs = 10_000 }) {
  return {
    /** @param {{ body?: object, waitMs?: number, timeoutMs?: number, signal?: AbortSignal }} [opts] */
    async request(method, path, { body, waitMs = 0, timeoutMs: own = timeoutMs, signal } = {}) {
      const abort = new AbortController()
      const timer = setTimeout(() => abort.abort(), own + waitMs)
      const onAbort = () => abort.abort()
      signal?.addEventListener('abort', onAbort, { once: true })
      if (signal?.aborted) abort.abort()
      try {
        const res = await doFetch(baseUrl + path, {
          method,
          headers: { authorization: 'Bearer ' + secret, 'x-rq-protocol': String(protocol), ...(instanceId ? { 'x-rq-instance': instanceId } : {}), ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
          body: body === undefined ? undefined : JSON.stringify(body),
          signal: abort.signal,
        })
        const text = await res.text()
        let json
        try { json = JSON.parse(text) } catch { /* not JSON */ }
        return { status: res.status, json }
      } catch (error) {
        throw networkError(String(error?.name ?? 'error'))
      } finally {
        clearTimeout(timer)
        signal?.removeEventListener('abort', onAbort)
      }
    },
  }
}
