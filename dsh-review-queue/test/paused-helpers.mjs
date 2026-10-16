// Synthetic DSH session logs for the paused-session tests: the same shapes as ~/.dsh/sessions/--<cwd>--/<id>/session.v4.jsonl.zstd
// (one JSON event per line, concatenated zstd frames), built from small records. Real session logs are never read by a test.
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { zstdCompressSync } from 'node:zlib'

let seq = 0
const ev = (type, data, time) => ({ type, seq: ++seq, time: time ?? 1_000 + seq, data })
export const log = {
  head: (over = {}) => ({ type: 'session', version: 4, id: 'x', createdAt: 1, cwd: 'D:\\w', isSeeded: false, ...over }),
  turnStart: (turn = 1) => ev('turn/start', { turn }),
  turnEnd: (turn = 1, reason = { kind: 'completed' }) => ev('turn/end', { turn, reason }),
  title: (title) => ev('session/title', { title }),
  user: (text, source = { kind: 'user' }) => ev('user/message', { content: [{ type: 'text', text }], source, role: 'user' }),
  assistant: (text, calls = []) => ev('assistant/message', {
    turn: 1, step: 1,
    message: { role: 'assistant', content: [{ type: 'text', text }, ...calls.map(([id, name]) => ({ type: 'tool-call', id, name, arguments: '{}' }))] },
  }),
  result: (callId) => ev('tool/result', { turn: 1, step: 1, message: { role: 'tool', source: { kind: 'tool', callId }, toolCallId: callId, content: [] } }),
  stepEnd: () => ev('step/end', { turn: 1, step: 1 }),
  splice: (target, start, removedCount, inserted = []) => ev('agent/inbox/spliced', { target, start, removedCount, inserted }),
  queued: (text, source = { kind: 'user' }) => ({ content: [{ type: 'text', text }], source, role: 'user' }),
}

const toFrame = (records) => zstdCompressSync(Buffer.from(records.map((r) => JSON.stringify(r)).join('\n') + '\n'))

/** The bytes of a log: one zstd frame per array of records (DSH appends a frame per batch). tornTail cuts the last frame short. */
export function logBytes(frames, { tornTail = 0 } = {}) {
  const bytes = Buffer.concat(frames.map(toFrame))
  return tornTail ? bytes.subarray(0, bytes.length - tornTail) : bytes
}

export function tmpRoot(t) {
  const dir = mkdtempSync(join(tmpdir(), 'rq-paused-'))
  t?.after(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

/** Writes <root>/--<cwd>--/<id>/session.v4.jsonl.zstd with the given frames and last-write time (ms since the epoch). */
export function writeLog(root, id, frames, { cwdDir = '--D-w--', mtimeMs, tornTail, raw } = {}) {
  const dir = join(root, cwdDir, id)
  mkdirSync(dir, { recursive: true })
  const file = join(dir, 'session.v4.jsonl.zstd')
  writeFileSync(file, raw ?? logBytes(frames, { tornTail }))
  if (mtimeMs !== undefined) utimesSync(file, mtimeMs / 1000, mtimeMs / 1000)
  return file
}

/** A complete top-level session that is cut off: a turn that never ended. */
export const cutOff = (over = {}) => [[log.head(over), log.title('Fix the thing'), log.turnStart(1), log.user('please fix it'), log.assistant('on it', [['c1', 'shell']])]]
/** A session whose last turn ended. */
export const finished = (reason = { kind: 'completed' }) => [[log.head(), log.turnStart(1), log.user('hi'), log.assistant('hello'), log.turnEnd(1, reason)]]
