import { join } from 'node:path'

/** Starts the STT daemon on demand. Throttled across host processes (desktop and web) by a start timestamp. */
export function createSttLauncher({
  dir,
  configFile = 'config.example.toml',
  port = 8890,
  probe,
  exists,
  spawnDetached,
  readLock,
  writeLock,
  now = Date.now,
  startupGraceMs = 120000,
}) {
  let error
  return {
    lastError: () => error,
    async ensure() {
      if (await probe(port)) return 'running'
      const python = join(dir, '.venv', 'Scripts', 'python.exe')
      if (!exists(python)) {
        error = 'STT is not installed at ' + dir
        return 'unavailable'
      }
      const last = Number(readLock())
      if (Number.isFinite(last) && now() - last < startupGraceMs) return 'starting'
      writeLock(now())
      try {
        spawnDetached(python, ['-m', 'stt', 'serve', '--config', configFile], { cwd: dir })
        error = undefined
        return 'started'
      } catch (e) {
        error = String(e?.message ?? e)
        return 'failed'
      }
    },
  }
}

/** A TCP port as an integer 1-65535 (numbers or digit strings), else the fallback: the value ends up inside URLs. */
export function normalizePort(value, fallback = 8890) {
  const n = typeof value === 'number' ? value : typeof value === 'string' && /^\d{1,5}$/.test(value.trim()) ? Number(value.trim()) : NaN
  return Number.isInteger(n) && n >= 1 && n <= 65535 ? n : fallback
}
