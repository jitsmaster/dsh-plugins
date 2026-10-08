/**
 * Session groups, per workspace.
 *
 * A group collects a "family" of sessions: the session that created a PR or wrote a handoff plus every session
 * spawned from it (PR session, "after PR" session, handoff continuations). The first such event for a session
 * creates its group; later events (follow-up PR creation, handoff spawns) reuse the group of the session they
 * come from. The group is named after the original session: its own title when that says something, otherwise a
 * name derived from the work it actually did (first user request).
 *
 * State lives in `<stateDir>/groups.json` (survives restarts) and is published by the status endpoint.
 */
import { randomUUID } from 'node:crypto'
import { copyFileSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/** Longest group name; clipping keeps at least this share of it so a cut never lands in the first word. */
const MAX_NAME = 60
const MIN_CUT_SHARE = 0.5
/** Newest groups kept; older ones are dropped on save so groups.json and the published list stay bounded. */
const MAX_GROUPS = 200
/** A numbered continuation suffix the plugin appends ("x - 2"); real titles like "Upgrade deps - 2024" are kept. */
const NUMBER_SUFFIX = /\s-\s\d{1,2}$/
/** Opening lines that say nothing about the work: slash-commands, code fences, @file refs, session-start boilerplate. */
const BOILERPLATE_LINE = /^(?:\/|```|@|session start\b)/i
/** Titles that carry no information about the work: defaults, "PR <n>", numbered copies of nothing. */
const GENERIC_TITLE = /^(?:new (?:session|chat|conversation)|untitled(?: session)?|session(?: \d+)?|chat(?: \d+)?|conversation(?: \d+)?|pr \d+(?:\s*-\s*\d+)?|continue pr \d+)$/i

const textOf = (content) => {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) return content.map((part) => (typeof part === 'string' ? part : part?.text ?? '')).join('')
  return ''
}

/** Shorten at a word boundary. */
function clip(text, max = MAX_NAME) {
  const t = text.replace(/\s+/g, ' ').trim()
  if (t.length <= max) return t
  const cut = t.slice(0, max)
  const space = cut.lastIndexOf(' ')
  return (space > max * MIN_CUT_SHARE ? cut.slice(0, space) : cut).replace(/[\s,;:.\-–—]+$/, '') + '…'
}

/** True when a session title names the work (not empty, not a default or a bare PR title). */
export function isMeaningfulTitle(title) {
  const t = String(title ?? '').trim()
  return t.length >= 3 && !GENERIC_TITLE.test(t)
}

/** Strip numbering/after-PR suffixes the plugin itself appends to continuation titles: "x - after PR 5" -> "x". */
function baseTitle(title) {
  return String(title).replace(/\s+-\s+after PR \d+$/i, '').replace(NUMBER_SUFFIX, '').trim()
}

/** First real user request of the session, as a one-line summary; undefined when there is none. */
export function firstRequest(agent) {
  try {
    for (const message of agent.session.deriveMessages()) {
      if (message.role !== 'user') continue
      // Skip the plugin's own injected prompts (handoff resume, caps) and system reminders.
      const text = textOf(message.content).replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '').trim()
      if (!text || /^(Resume the work from this handoff|Continue from handoff|CONTEXT CAP|PR \d+ WAS JUST CREATED)/i.test(text)) continue
      const line = text.split(/\r?\n/).map((l) => l.trim()).find((l) => l.length >= 8 && !BOILERPLATE_LINE.test(l))
      if (line) return clip(line.replace(/^[#>*\-\s]+/, '').replace(/[.!?:]+$/, ''))
    }
  } catch { /* best effort */ }
  return undefined
}

/**
 * The group name for a session: its own title when meaningful; else a summary of what it worked on; else the
 * project folder name.
 */
export function deriveGroupName({ title, request, cwd }) {
  const base = baseTitle(title ?? '')
  if (isMeaningfulTitle(base)) return clip(base)
  // The request may be a function: scanning the conversation is only worth it when the title is no help.
  const text = typeof request === 'function' ? request() : request
  if (text) return clip(text)
  const project = String(cwd ?? '').split(/[\\/]/).filter(Boolean).at(-1)
  return project ? `${project} work` : 'Session group'
}

/** Explicit fields only: nothing else in the file is ever served. */
const clone = (g) => ({ id: g.id, workspaceId: g.workspaceId, name: g.name, createdAt: g.createdAt, sessionIds: [...g.sessionIds] })

/** A group read from disk is trusted only with the expected shape; malformed entries are dropped. */
const validGroup = (g) => typeof g?.id === 'string' && typeof g.name === 'string' && typeof g.createdAt === 'number'
  && (g.workspaceId === undefined || typeof g.workspaceId === 'string') && Array.isArray(g.sessionIds) && g.sessionIds.every((s) => typeof s === 'string')

/**
 * @param {string} stateDir
 * @param {{ now?: () => number, trace?: (line: string) => void }} [options]
 */
export function createGroups(stateDir, { now = Date.now, trace = () => {} } = {}) {
  const path = join(stateDir, 'groups.json')
  /** @type {{ groups: { id: string, workspaceId?: string, name: string, createdAt: number, sessionIds: string[] }[] }} */
  let data = { groups: [] }
  let raw
  try { raw = readFileSync(path, 'utf8') } catch { /* first run: no file yet */ }
  if (raw !== undefined) {
    try {
      const parsed = JSON.parse(raw)
      if (Array.isArray(parsed?.groups)) data = { groups: parsed.groups.filter(validGroup).map(clone) }
    } catch (error) {
      // Keep the unreadable file: the next save would otherwise overwrite every group.
      trace(`groups.json is unreadable (${error}); kept as groups.json.corrupt`)
      try { copyFileSync(path, `${path}.corrupt`) } catch { /* best effort */ }
    }
  }

  /** Atomic: a crash mid-write leaves the previous file intact. */
  const save = () => {
    try {
      if (data.groups.length > MAX_GROUPS) data.groups.splice(0, data.groups.length - MAX_GROUPS)
      writeFileSync(`${path}.tmp`, JSON.stringify(data, null, 2))
      renameSync(`${path}.tmp`, path)
    } catch (error) { trace(`could not save groups: ${error}`) }
  }

  /** The group a session belongs to, or undefined. */
  function groupOf(sessionId) {
    const g = data.groups.find((x) => x.sessionIds.includes(sessionId))
    return g ? clone(g) : undefined
  }

  /**
   * The group of `sessionId`, created if it has none. A new group is named from `naming`
   * ({ title, request, cwd } of the original session, or a function returning it, evaluated only when a group is
   * actually created) and starts with the session as its first member.
   */
  function ensureGroup(sessionId, workspaceId, naming) {
    const hit = data.groups.find((x) => x.sessionIds.includes(sessionId))
    if (hit) {
      // The workspace registry may not have listed the session when the group was created: fill it in later.
      if (hit.workspaceId === undefined && workspaceId !== undefined) { hit.workspaceId = workspaceId; save() }
      return clone(hit)
    }
    const group = { id: randomUUID(), workspaceId, name: deriveGroupName(typeof naming === 'function' ? naming() : naming ?? {}), createdAt: now(), sessionIds: [sessionId] }
    data.groups.push(group)
    save()
    return clone(group)
  }

  /** Put `sessionId` into the group `groupId` (idempotent; a session lives in one group only). */
  function addToGroup(groupId, sessionId) {
    const g = data.groups.find((x) => x.id === groupId)
    if (!g) return undefined
    if (!g.sessionIds.includes(sessionId)) {
      for (const other of data.groups) if (other !== g) other.sessionIds = other.sessionIds.filter((id) => id !== sessionId)
      g.sessionIds.push(sessionId)
      dropEmpty()
      save()
    }
    return clone(g)
  }

  /** A group with no member left carries no information: remove it. */
  function dropEmpty() { data.groups = data.groups.filter((x) => x.sessionIds.length > 0) }

  /** Manual move: into group `groupId`, or out of every group when it is null. Throws on an unknown group. */
  function moveSession(sessionId, groupId) {
    if (groupId === null) {
      for (const g of data.groups) g.sessionIds = g.sessionIds.filter((id) => id !== sessionId)
      dropEmpty()
      save()
      return undefined
    }
    const target = addToGroup(groupId, sessionId)
    if (!target) throw new Error('unknown group')
    return target
  }

  /** A new group with a user-chosen name, holding `sessionId` (moved out of any other group). */
  function createGroup(name, sessionId, workspaceId) {
    const clean = clip(String(name ?? ''))
    if (!clean) throw new Error('a group needs a name')
    for (const other of data.groups) other.sessionIds = other.sessionIds.filter((id) => id !== sessionId)
    const group = { id: randomUUID(), workspaceId, name: clean, createdAt: now(), sessionIds: [sessionId] }
    data.groups.push(group)
    dropEmpty()
    save()
    return clone(group)
  }

  /** Give a workspace-less group the workspace of a session that joined it. */
  function backfillWorkspace(groupId, workspaceId) {
    const g = data.groups.find((x) => x.id === groupId)
    if (g && g.workspaceId === undefined && workspaceId !== undefined) { g.workspaceId = workspaceId; save() }
  }

  /** Groups, optionally of one workspace. */
  const list = (workspaceId) => data.groups.filter((g) => workspaceId === undefined || g.workspaceId === workspaceId).map(clone)

  return { ensureGroup, addToGroup, moveSession, createGroup, backfillWorkspace, groupOf, list, path }
}

/**
 * Apply one manual move request from the web page: `{ sessionId, groupId }` (groupId null = out of every group) or
 * `{ sessionId, newGroupName }`. A session can only join a group of its own workspace.
 * @returns {{ status: number, error?: string }}
 */
export function applyMove(groups, body, workspaceOf = () => undefined, isLive = () => true) {
  const sessionId = body?.sessionId
  if (typeof sessionId !== 'string' || !sessionId || sessionId.length > 200) return { status: 400, error: 'sessionId is required' }
  // Only a live session can be put into a group (no fabricated ids); taking any session out is always allowed.
  if (body.groupId !== null && !isLive(sessionId)) return { status: 404, error: 'unknown session' }
  const sessionWorkspace = workspaceOf(sessionId)
  try {
    if (body.newGroupName !== undefined) {
      if (typeof body.newGroupName !== 'string') return { status: 400, error: 'newGroupName must be text' }
      groups.createGroup(body.newGroupName, sessionId, sessionWorkspace)
      return { status: 200 }
    }
    if (body.groupId !== null && typeof body.groupId !== 'string') return { status: 400, error: 'groupId must be a group id or null' }
    if (body.groupId !== null) {
      const target = groups.list().find((x) => x.id === body.groupId)
      if (!target) return { status: 404, error: 'unknown group' }
      if (target.workspaceId !== undefined && sessionWorkspace !== undefined && target.workspaceId !== sessionWorkspace) {
        return { status: 409, error: 'a session can only join a group of its own workspace' }
      }
    }
    groups.moveSession(sessionId, body.groupId)
    if (body.groupId !== null) groups.backfillWorkspace(body.groupId, sessionWorkspace)
    return { status: 200 }
  } catch (error) {
    return { status: 400, error: String(error?.message ?? error) }
  }
}

/**
 * The /groups payload: each group with titled members, plus every live session with the group it is in (so the page
 * can offer sessions that are in no group yet).
 * @param {ReturnType<ReturnType<typeof createGroups>['list']>} groupList
 * @param {{ id: string, title?: string, workspaceId?: string }[]} sessions
 */
export function buildGroupsView(groupList, sessions) {
  const titleOf = new Map(sessions.map((s) => [s.id, s.title]))
  const groupOf = new Map()
  for (const g of groupList) for (const id of g.sessionIds) groupOf.set(id, g.id)
  return {
    groups: groupList.map((g) => ({ id: g.id, workspaceId: g.workspaceId, name: g.name, members: g.sessionIds.map((id) => ({ id, title: titleOf.get(id), live: titleOf.has(id) })) })),
    sessions: sessions.map((s) => ({ id: s.id, title: s.title, workspaceId: s.workspaceId, groupId: groupOf.get(s.id) })),
  }
}
