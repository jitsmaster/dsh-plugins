/**
 * dsh-remote-access — reach DSH from outside the LAN with no public IP.
 *
 *   browser --HTTPS--> relay host --(ssh -R tunnel)--> 127.0.0.1:<port> auth proxy --> 127.0.0.1:3080 DSH
 *
 * TLS terminates in this plugin's proxy, so the relay only carries ciphertext. The tunnel
 * is Windows' built-in OpenSSH client (no install, no binary download). Opt-in and fail-closed.
 */
import { spawn } from 'node:child_process'
import { appendFileSync, mkdirSync } from 'node:fs'
import { X509Certificate } from 'node:crypto'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { loadAuthRecord } from './auth.js'
import { loadOrCreateTls } from './cert.js'
import { startProxy } from './proxy.js'

export const name = 'remote-access'

export function apply(ctx, config = {}) {
  if (!config.enabled) return
  const dir = resolve(config.stateDir ?? join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'remote-access'))
  mkdirSync(dir, { recursive: true })
  const logFile = join(dir, 'remote-access.log')
  const log = (m) => { try { appendFileSync(logFile, `${new Date().toISOString()} ${m}\n`) } catch { /* ignore */ } ctx.logger.info(`remote-access: ${m}`) }

  if (!loadAuthRecord(dir)) {
    ctx.logger.warn(`remote-access: no password set, NOT starting. Run: node "${join(import.meta.dirname, 'setup.js')}"`)
    return
  }
  const port = config.port ?? 8443
  const tls = loadOrCreateTls(join(dir, 'tls'), config)
  if (tls.generated) log(`self-signed cert SHA-256 fingerprint (compare in the browser's certificate viewer): ${new X509Certificate(tls.cert).fingerprint256}`)
  const stopProxy = startProxy({
    tls, getAuth: () => loadAuthRecord(dir), port,
    getLaunchToken: () => {
      try {
        const base = `http://${config.targetHost ?? '127.0.0.1'}:${config.targetPort ?? 3080}`
        return new URL(ctx.get('connection').authenticatedUrl(base)).searchParams.get('token') ?? undefined
      } catch (e) { log(`cannot get DSH launch token: ${e.message}`); return undefined }
    },
    listenHost: config.listenHost ?? '127.0.0.1', // loopback: only the tunnel reaches it
    targetHost: config.targetHost ?? '127.0.0.1', targetPort: config.targetPort ?? 3080,
    sessionHours: config.sessionHours ?? 12, log,
  })

  let stopTunnel = () => {}
  const t = config.tunnel
  if (config.tailscale?.funnel) stopTunnel = startFunnel(config.tailscale, port, log)
  else if (t?.host && t?.user) stopTunnel = startTunnel(t, port, dir, log)
  else log('no tunnel configured (tunnel.host / tunnel.user); proxy is reachable locally only')

  ctx.effect(() => async () => { stopTunnel(); stopProxy() }, 'remote-access: stop proxy and tunnel')
}

/**
 * Tailscale Funnel: public https://<node>.<tailnet>.ts.net (trusted Let's Encrypt cert, no browser
 * warning) forwarded to the local auth proxy. Funnel itself is only enabled in the tailnet admin console.
 */
function startFunnel(t, localPort, log) {
  const bin = t.bin ?? 'C:\\Program Files\\Tailscale\\tailscale.exe'
  const https = String(t.httpsPort ?? 443) // Funnel allows only 443, 8443 and 10000
  const run = (args) => new Promise((res) => {
    const c = spawn(bin, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    let out = ''; c.stdout.on('data', (d) => { out += d }); c.stderr.on('data', (d) => { out += d })
    c.on('error', (e) => { log(`tailscale spawn failed: ${e.message}`); res() })
    c.on('close', () => { if (out.trim()) log(`tailscale ${args[0]}: ${out.trim()}`); res() })
  })
  void run(['funnel', '--bg', `--https=${https}`, `https+insecure://127.0.0.1:${localPort}`])
  return () => { void run(['funnel', `--https=${https}`, 'off']) }
}

/** Keeps `ssh -R` alive with exponential backoff. Key auth only, strict host-key checking. */
function startTunnel(t, localPort, dir, log) {
  let stopped = false; let child; let delay = 2000; let timer
  const remote = `${t.bindAddress ?? '0.0.0.0'}:${t.remotePort ?? 8443}:127.0.0.1:${localPort}`
  const args = [
    '-N', '-T', '-R', remote,
    '-p', String(t.sshPort ?? 22),
    '-o', 'BatchMode=yes', '-o', 'ExitOnForwardFailure=yes',
    '-o', 'ServerAliveInterval=30', '-o', 'ServerAliveCountMax=3',
    '-o', 'StrictHostKeyChecking=yes', '-o', 'IdentitiesOnly=yes',
    '-o', 'ClearAllForwardings=no', '-o', 'PermitLocalCommand=no',
    ...t.identityFile ? ['-i', t.identityFile] : [],
    `${t.user}@${t.host}`,
  ]
  const run = () => {
    if (stopped) return
    const started = Date.now()
    child = spawn(t.ssh ?? 'ssh.exe', args, { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] })
    child.stderr.on('data', (d) => log(`ssh: ${String(d).trim()}`))
    child.on('error', (e) => log(`ssh spawn failed: ${e.message}`))
    child.on('exit', (code) => {
      if (stopped) return
      delay = Date.now() - started > 60_000 ? 2000 : Math.min(delay * 2, 120_000)
      log(`tunnel exited (${code}); restarting in ${delay / 1000}s`)
      timer = setTimeout(run, delay)
    })
  }
  log(`starting tunnel ${t.user}@${t.host} -R ${remote}`)
  run()
  return () => { stopped = true; clearTimeout(timer); child?.kill() }
}
