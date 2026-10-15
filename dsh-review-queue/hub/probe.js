/** One health probe of a hub on this machine: the parsed answer when a hub-like program answers on the port, else undefined. */
import http from 'node:http'

export function probeHealth(port, { timeoutMs = 1000 } = {}) {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port, path: '/hub/v1/health', agent: false, timeout: timeoutMs }, (res) => {
      const chunks = []
      res.on('data', (c) => chunks.push(c))
      res.on('end', () => {
        try {
          const body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
          resolve(res.statusCode === 200 && body?.ok === true && typeof body.hubId === 'string' ? body : undefined)
        } catch { resolve(undefined) }
      })
      res.on('error', () => resolve(undefined))
    })
    req.on('timeout', () => { req.destroy(); resolve(undefined) })
    req.on('error', () => resolve(undefined))
  })
}
