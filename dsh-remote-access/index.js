/**
 * dsh-remote-access — reach DSH from outside the LAN with no public IP.
 *
 *   browser --HTTPS--> relay host --(ssh -R tunnel)--> 127.0.0.1:<port> auth proxy --> 127.0.0.1:3080 DSH
 *
 * TLS terminates in this plugin's proxy, so the relay only carries ciphertext. The tunnel
 * is Windows' built-in OpenSSH client (no install, no binary download). Opt-in and fail-closed.
 */
import { execFileSync, spawn } from 'node:child_process'
import { appendFileSync, mkdirSync, readFileSync } from 'node:fs'
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
  const listenHosts = [config.listenHost ?? '127.0.0.1']
  // Tailscale: use the real (Let's Encrypt) certificate for the node's ts.net name and also listen on
  // this machine's own tailnet address, so the ts.net name works from this machine too (the OS answers
  // connections to its own tailnet IP locally, so Funnel/serve never sees them).
  const ts = config.tailscale?.funnel ? tailscaleIdentity(config.tailscale, join(dir, 'tls'), log) : undefined
  if (ts?.ip && config.tailscale.listenOnTailnetIp !== false) listenHosts.push(ts.ip)
  const tls = ts?.tls ?? loadOrCreateTls(join(dir, 'tls'), config)
  if (tls.generated) log(`self-signed cert SHA-256 fingerprint (compare in the browser's certificate viewer): ${new X509Certificate(tls.cert).fingerprint256}`)
  const stopProxy = startProxy({
    tls, getAuth: () => loadAuthRecord(dir), port,
    getLaunchToken: () => {
      try {
        const base = `http://${config.targetHost ?? '127.0.0.1'}:${config.targetPort ?? 3080}`
        return new URL(ctx.get('connection').authenticatedUrl(base)).searchParams.get('token') ?? undefined
      } catch (e) { log(`cannot get DSH launch token: ${e.message}`); return undefined }
    },
    listenHosts, // loopback (the tunnel) and, with Tailscale, this machine's tailnet IP
    targetHost: config.targetHost ?? '127.0.0.1', targetPort: config.targetPort ?? 3080,
    sessionHours: config.sessionHours ?? 12, log,
  })

  let stopTunnel = () => {}
  const t = config.tunnel
  if (config.tailscale?.funnel) stopTunnel = startFunnel(config.tailscale, port, log)
  else if (t?.host && t?.user) stopTunnel = startTunnel(t, port, dir, log)
  else log('no tunnel configured (tunnel.host / tunnel.user); proxy is reachable locally only')

  // Let's Encrypt certs last ~90 days: re-issue daily (tailscale only renews when due) and hot-swap.
  let renew
  if (ts) {
    renew = setInterval(() => {
      const next = tailscaleIdentity(config.tailscale, join(dir, 'tls'), log, true)
      if (next?.tls) { try { stopProxy.setTls(next.tls) } catch (e) { log(`cert swap failed: ${e.message}`) } }
    }, 24 * 3600e3)
    renew.unref()
  }

  ctx.effect(() => async () => { clearInterval(renew); stopTunnel(); stopProxy() }, 'remote-access: stop proxy and tunnel')
}

/** Tailscale node identity: tailnet IPv4 plus a real certificate for its ts.net name. Undefined on any failure. */
function tailscaleIdentity(t, tlsDir, log, quiet = false) {
  const bin = t.bin ?? 'C:\\Program Files\\Tailscale\\tailscale.exe'
  try {
    mkdirSync(tlsDir, { recursive: true })
    const status = JSON.parse(execFileSync(bin, ['status', '--json'], { encoding: 'utf8', timeout: 20_000, windowsHide: true }))
    const name = String(status.Self?.DNSName ?? '').replace(/\.$/, '')
    if (!name) throw new Error('node has no DNS name (is HTTPS enabled for the tailnet?)')
    const ip = execFileSync(bin, ['ip', '-4'], { encoding: 'utf8', timeout: 20_000, windowsHide: true }).trim().split(/\s+/)[0]
    const c = join(tlsDir, 'ts.crt'); const k = join(tlsDir, 'ts.key')
    execFileSync(bin, ['cert', '--cert-file', c, '--key-file', k, name], { timeout: 90_000, windowsHide: true, stdio: 'ignore' })
    if (!quiet) log(`tailscale identity: ${name} (${ip}); using its Let's Encrypt certificate`)
    return { name, ip, tls: { cert: readFileSync(c), key: readFileSync(k), generated: false } }
  } catch (e) {
    log(`tailscale certificate unavailable (${String(e.message).split('\n')[0]}); falling back to a self-signed certificate`)
    return undefined
  }
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
