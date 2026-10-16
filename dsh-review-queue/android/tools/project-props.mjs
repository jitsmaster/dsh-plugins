/** Minimal reader for Gradle/Java .properties text (key=value or key:value, # and ! comments). */
export function parseProperties(text) {
  const out = {}
  for (const raw of String(text ?? '').split(/\r?\n/)) {
    const line = raw.trim()
    if (!line || line.startsWith('#') || line.startsWith('!')) continue
    const m = /^([^=:\s]+)\s*[=:]\s*(.*)$/.exec(line)
    if (m) out[m[1]] = m[2].trim()
  }
  return out
}
