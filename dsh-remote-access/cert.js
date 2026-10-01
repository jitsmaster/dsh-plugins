/**
 * Pure-Node self-signed certificate (EC P-256, ecdsa-with-SHA256). Hand-built DER so no
 * openssl/PowerShell process is spawned and no dependency is needed.
 */
import { generateKeyPairSync, randomBytes, sign, X509Certificate } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { isIP } from 'node:net'
import { join } from 'node:path'

const len = (n) => n < 128 ? Buffer.from([n]) : n < 256 ? Buffer.from([0x81, n]) : Buffer.from([0x82, n >> 8, n & 255])
const tlv = (tag, ...parts) => { const body = Buffer.concat(parts); return Buffer.concat([Buffer.from([tag]), len(body.length), body]) }
const seq = (...p) => tlv(0x30, ...p)
const oid = (s) => {
  const n = s.split('.').map(Number)
  const out = [n[0] * 40 + n[1]]
  for (const v of n.slice(2)) {
    const b = [v & 127]
    for (let x = v >> 7; x > 0; x >>= 7) b.unshift((x & 127) | 128)
    out.push(...b)
  }
  return tlv(0x06, Buffer.from(out))
}
const utc = (d) => tlv(0x17, Buffer.from(d.toISOString().replace(/[-:T]/g, '').slice(2, 14) + 'Z'))
const name = (cn) => seq(tlv(0x31, seq(oid('2.5.4.3'), tlv(0x0c, Buffer.from(cn)))))

function generate(hostnames) {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
  const spki = publicKey.export({ type: 'spki', format: 'der' })
  const sigAlg = seq(oid('1.2.840.10045.4.3.2'))
  const names = ['localhost', ...hostnames]
  const san = seq(...names.map((h) => isIP(h) === 4
    ? tlv(0x87, Buffer.from(h.split('.').map(Number)))
    : tlv(0x82, Buffer.from(h))))
  const ext = tlv(0xa3, seq(
    // End-entity leaf (CA:FALSE), digitalSignature, serverAuth: what browsers expect of a server cert.
    seq(oid('2.5.29.19'), tlv(0x01, Buffer.from([0xff])), tlv(0x04, seq())),
    seq(oid('2.5.29.15'), tlv(0x01, Buffer.from([0xff])), tlv(0x04, tlv(0x03, Buffer.from([0x07, 0x80])))),
    seq(oid('2.5.29.37'), tlv(0x04, seq(oid('1.3.6.1.5.5.7.3.1')))),
    seq(oid('2.5.29.17'), tlv(0x04, san)),
  ))
  const serial = randomBytes(8); serial[0] &= 0x7f; serial[0] |= 0x01
  const now = new Date(); const end = new Date(now.getTime() + 397 * 864e5)
  const cn = `dsh-remote-access ${names[1] ?? names[0]}`
  const tbs = seq(
    tlv(0xa0, tlv(0x02, Buffer.from([2]))), tlv(0x02, serial), sigAlg,
    name(cn), seq(utc(new Date(now.getTime() - 864e5)), utc(end)), name(cn), spki, ext,
  )
  const sig = sign('sha256', tbs, privateKey)
  const der = seq(tbs, sigAlg, tlv(0x03, Buffer.concat([Buffer.from([0]), sig])))
  const pem = `-----BEGIN CERTIFICATE-----\n${der.toString('base64').match(/.{1,64}/g).join('\n')}\n-----END CERTIFICATE-----\n`
  return { cert: pem, key: privateKey.export({ type: 'pkcs8', format: 'pem' }) }
}

/** Returns { cert, key } PEM strings: user-supplied files, else a persisted self-signed pair. */
export function loadOrCreateTls(dir, config) {
  if (config.tlsCert && config.tlsKey) {
    return { cert: readFileSync(config.tlsCert), key: readFileSync(config.tlsKey), generated: false }
  }
  mkdirSync(dir, { recursive: true })
  const c = join(dir, 'selfsigned.crt'); const k = join(dir, 'selfsigned.key')
  const want = JSON.stringify(config.hostnames ?? [])
  const m = join(dir, 'selfsigned.hosts')
  if (existsSync(c) && existsSync(k) && existsSync(m) && readFileSync(m, 'utf8') === want) {
    try {
      const cert = readFileSync(c, 'utf8')
      const exp = new X509Certificate(cert).validTo
      if (Date.parse(exp) - Date.now() > 14 * 864e5) return { cert, key: readFileSync(k, 'utf8'), generated: true }
    } catch { /* regenerate */ }
  }
  const pair = generate(config.hostnames ?? [])
  writeFileSync(c, pair.cert); writeFileSync(k, pair.key, { mode: 0o600 }); writeFileSync(m, want)
  return { ...pair, generated: true }
}
