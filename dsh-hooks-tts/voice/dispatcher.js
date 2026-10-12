import { randomUUID } from 'node:crypto'
import { matchCommand, resolveConfirmation, resolveSession } from './commands.js'

const LABELS = {
  'session-fork': 'Fork session',
  permission: 'Switch permission',
  'session-rename': 'Rename session',
}

/**
 * Turns STT transcripts into DSH actions. Every side effect is injected (session controller, approvals, slash
 * runner, UI, speech), so this is pure routing: confidence gate, confirmation read-back, target resolution.
 */
export function createDispatcher({
  sessions,
  lastAlerted,
  session,
  approvals,
  slash,
  ui,
  speak = () => {},
  now = Date.now,
  minConfidence = 0.3,
  confirmTtlMs = 15000,
  approveMinConfidence = 0.75,
}) {
  let pending

  async function execute(match, target) {
    const sessionId = target?.id
    switch (match.action) {
      case 'session':
        switch (match.method) {
          case 'cancel': return session.cancel({ sessionId })
          case 'create': return session.create({})
          case 'fork': return session.fork({ sessionId })
          case 'rename': return session.rename({ sessionId, title: match.args.text })
          case 'selectModel': return session.selectModel({ sessionId, model: match.args.text })
        }
        throw new Error('unknown session method ' + match.method)
      case 'approval':
        return approvals.answer({ sessionId, decision: match.decision, ...(match.args.number !== undefined ? { number: match.args.number } : {}) })
      case 'slash': {
        const arg = match.args.text ?? match.args.preset
        return slash({ sessionId, name: match.slash, input: arg === undefined ? '' : ' ' + arg })
      }
      case 'ui':
        return ui.switchTo({ sessionId })
    }
    throw new Error('unknown action ' + match.action)
  }

  async function run(match, target) {
    try {
      await execute(match, target)
      return { kind: 'executed', id: match.id, sessionId: target?.id }
    } catch (error) {
      speak(`Could not ${match.id}: ${error?.message ?? error}`)
      return { kind: 'failed', id: match.id, error: String(error?.message ?? error) }
    }
  }

  return {
    async handle(event) {
      if (event?.type !== 'transcript') return { kind: 'ignored' }
      const text = String(event.text ?? '').trim()
      if (!text) return { kind: 'ignored' }
      if (typeof event.confidence === 'number' && event.confidence < minConfidence) return { kind: 'ignored' }

      if (pending) {
        const waiting = pending
        pending = undefined
        if (now() - waiting.at <= confirmTtlMs) {
          const answer = resolveConfirmation(text)
          if (answer === 'yes') return run(waiting.match, waiting.target)
          if (answer === 'no') return { kind: 'cancelled' }
        }
      }

      const list = sessions()
      const match = matchCommand(text)
      if (!match) {
        const target = event.context ? list.find((s) => s.id === event.context) : list.find((s) => s.id === lastAlerted())
        if (!target) return { kind: 'no-session' }
        try {
          await session.prompt({
            requestId: 'voice-' + randomUUID(),
            sessionId: target.id,
            mode: 'queue',
            content: [{ type: 'text', text }],
          })
          return { kind: 'dictation', sessionId: target.id }
        } catch (error) {
          speak('Could not send that: ' + (error?.message ?? error))
          return { kind: 'failed', id: 'dictation', error: String(error?.message ?? error) }
        }
      }

      // A misheard approve would grant a permission, so it needs a confident transcript (deny stays easy).
      if (match.action === 'approval' && match.decision === 'approve' && !(event.confidence >= approveMinConfidence)) {
        speak('Say approve again')
        return { kind: 'unsure', id: match.id }
      }

      let target
      const needsSession = !(match.action === 'ui' || match.id === 'session-new')
      if (match.action === 'ui') {
        const found = resolveSession(match.args.text, list, undefined)
        if (found?.ambiguous) {
          speak('Which one? ' + found.ambiguous.map((s) => s.title).join(', '))
          return { kind: 'ambiguous' }
        }
        if (!found) {
          speak('No session matches ' + match.args.text)
          return { kind: 'no-session' }
        }
        target = found
      } else if (needsSession) {
        const spoken = match.target ?? undefined
        const found = resolveSession(spoken, list, event.context ?? lastAlerted())
        if (found?.ambiguous) {
          speak('Which one? ' + found.ambiguous.map((s) => s.title).join(', '))
          return { kind: 'ambiguous' }
        }
        if (!found) {
          speak(spoken ? 'No session matches ' + spoken : 'No session to act on')
          return { kind: 'no-session' }
        }
        target = found
      }

      if (match.confirm) {
        pending = { match, target, at: now() }
        speak(`${LABELS[match.id] ?? match.id}${target ? ' ' + target.title : ''}. Say yes to confirm.`)
        return { kind: 'confirming', id: match.id }
      }
      return run(match, target)
    },
  }
}
