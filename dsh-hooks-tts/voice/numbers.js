import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const pad = (n) => String(n).padStart(2, '0')
const localDate = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`

/**
 * Short spoken session numbers. A session gets the next number the first time it alerts that
 * (local) day and keeps it until midnight, so "three" means the same session all day.
 */
export function createNumbers(stateDir, now = () => new Date()) {
  const path = join(stateDir, 'voice-numbers.json')
  const fresh = (date) => ({ date, next: 1, ids: Object.create(null) })
  let state = fresh('')
  try {
    const saved = JSON.parse(readFileSync(path, 'utf8'))
    if (saved && typeof saved.ids === 'object' && saved.ids && Number.isInteger(saved.next)) {
      state = { date: String(saved.date ?? ''), next: saved.next, ids: Object.assign(Object.create(null), Object.fromEntries(Object.entries(saved.ids).filter(([, n]) => Number.isInteger(n)))) }
    }
  } catch { /* first run, or a corrupt file: start empty */ }

  const save = () => {
    try { writeFileSync(path, JSON.stringify(state)) } catch { /* numbering still works in memory */ }
  }
  const roll = () => {
    const today = localDate(now())
    if (state.date !== today) {
      state = fresh(today)
      save()
    }
  }

  return {
    numberFor(sessionId) {
      roll()
      if (!state.ids[sessionId]) {
        state.ids[sessionId] = state.next++
        save()
      }
      return state.ids[sessionId]
    },
    sessionFor(number) {
      roll()
      return Object.keys(state.ids).find((id) => state.ids[id] === number)
    },
  }
}
