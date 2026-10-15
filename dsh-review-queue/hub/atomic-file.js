/**
 * Atomic text files for the hub: write <name>.<pid>.tmp in the same folder, then rename over the target (an atomic replace on
 * NTFS), so a crash leaves the old file or the new one, never half of one. rotate keeps the file being replaced as <name>.bak.
 * prepare(tmp) runs on the finished temp file before the rename (a rename keeps the temp file's rights: that is where a private file is tightened).
 */
import nodeFs from 'node:fs'
import { dirname } from 'node:path'

export function writeAtomic(file, text, { rotate = false, pid = process.pid, fs = nodeFs, mode, prepare } = {}) {
  const tmp = file + '.' + pid + '.tmp'
  fs.mkdirSync(dirname(file), { recursive: true })
  try {
    fs.writeFileSync(tmp, text, mode === undefined ? undefined : { mode })
    prepare?.(tmp)
    if (rotate) { try { fs.renameSync(file, file + '.bak') } catch { /* nothing to keep yet */ } }
    fs.renameSync(tmp, file)
  } catch (error) {
    try { fs.unlinkSync(tmp) } catch { /* not written */ }
    throw error
  }
}

export const readText = (file) => { try { return nodeFs.readFileSync(file, 'utf8') } catch { return undefined } }

/** The io pair of the hub store for one file: read('main' | 'bak') and write(text, { rotate }). */
export function createFileIo(file, opts = {}) {
  return {
    read: (which) => readText(which === 'bak' ? file + '.bak' : file),
    write: (text, { rotate = false } = {}) => writeAtomic(file, text, { ...opts, rotate }),
  }
}
