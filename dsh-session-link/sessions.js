import { isSessionId } from './envelope.js'

const oneLine = (v) => String(v ?? '').replace(/\s+/g, ' ').trim()
const folderOf = (cwd) => { if (typeof cwd !== 'string') return ''; const t = cwd.replace(/[/\\]+$/, ''); return oneLine(t.slice(Math.max(t.lastIndexOf('/'), t.lastIndexOf('\\')) + 1)) }
const topLevel = (i) => !i.parentSessionId && i.origin !== 'subagent'

export const isSubagent = (agent) => {
  const h = agent?.session?.header
  return h?.origin === 'subagent' || (h?.parentSession !== undefined && h?.parentSession !== null)
}

export async function listPeers({ controller, registry, senderId, signal }) {
  if (typeof controller?.list !== 'function') throw new Error('the session controller is not available')
  let listed, archived
  try { listed = await controller.list({}, signal ?? AbortSignal.timeout(10_000)); archived = new Set([...(registry?.archivedSessionIds ?? [])].map(String)) } catch { throw new Error('could not list sessions') }
  return (Array.isArray(listed?.items) ? listed.items : [])
    .filter((i) => i && isSessionId(i.sessionId) && i.sessionId !== senderId && topLevel(i) && i.blank !== true && !archived.has(i.sessionId))
    .map((i) => {
      const folder = folderOf(i.cwd)
      const fromRow = oneLine(i.projections?.values?.title)
      return { sessionId: i.sessionId, title: (fromRow || folder || 'Untitled session').slice(0, 200), workspace: folder, running: i.running === true, updatedAt: Number.isFinite(i.updatedAt) ? i.updatedAt : 0 }
    })
    .sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 200)
}
