import { randomUUID } from 'node:crypto'
import { describeMatch, matchCommand, resolveConfirmation, resolveSession } from './commands.js'

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
  router,
  ack = true,
  maxRouterWords = 20,
  confirm = true,
}) {
  const confirmOn = () => (typeof confirm === 'function' ? confirm() : confirm) !== false
  const say = (text) => { if (ack) speak(text) }
  const heard = (text) => (text.length > 60 ? text.slice(0, 60) : text)
  const tooLong = (text) => text.split(/\s+/).length > maxRouterWords || text.length > 140
  let pending
  let seq = 0
  // Stop, deny and option answers never wait for a read-back.
  const isFast = (m) => m.id === 'cancel' || (m.action === 'approval' && (m.decision === 'deny' || m.decision === 'option'))

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

  async function sendPrompt(text, target) {
    try {
      await session.prompt({
        requestId: 'voice-' + randomUUID(),
        sessionId: target.id,
        mode: 'queue',
        content: [{ type: 'text', text }],
      })
      return { kind: 'dictation', sessionId: target.id, text }
    } catch (error) {
      speak('Could not send that: ' + (error?.message ?? error))
      return { kind: 'failed', id: 'dictation', error: String(error?.message ?? error) }
    }
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
    clear(sessionId) { if (sessionId === undefined || pending?.sessionId === sessionId) pending = undefined },
    async handle(event) {
      if (event?.type !== 'transcript') return { kind: 'ignored' }
      const text = String(event.text ?? '').trim()
      if (!text) return { kind: 'ignored' }
      if (typeof event.confidence === 'number' && event.confidence < minConfidence) return { kind: 'ignored' }

      if (pending) {
        const waiting = pending
        const direct = matchCommand(text)
        const soft = ['no', 'nope', 'never mind', '不', '不要', '否'].includes(text.toLowerCase().replace(/[.!?,，。！？\s]+$/g, '').trim())
        const stopWord = /\bstop\b|停/i.test(text)
        const dismiss = resolveConfirmation(text) === 'no' && !stopWord
        if (direct && isFast(direct) && !soft && !dismiss) {
          pending = undefined
        } else if (now() - waiting.at > confirmTtlMs) {
          pending = undefined
        } else {
          const answer = resolveConfirmation(text)
          if (answer === 'yes' && !(event.confidence >= approveMinConfidence)) {
            speak('Say yes again')
            return { kind: 'unsure' }
          }
          pending = undefined
          if (answer === 'yes') return waiting.go()
          if (answer === 'no') return { kind: 'cancelled' }
        }
      }

      const mySeq = ++seq
      const list = sessions()
      let match = matchCommand(text)
      let dictation = false
      if (!match) {
        if (router && !tooLong(text)) {
          const routed = await router(text, { sessions: list, lastAlerted: lastAlerted() })
          if (seq !== mySeq) return { kind: 'superseded' }
          // No decision (model down, slow or unparseable): treat as dictation, which the read-back still gates.
          if (routed === undefined || routed.kind === 'dictation') dictation = true
          else match = routed
        } else dictation = true
      }

      if (dictation) {
        const target = event.context ? list.find((s) => s.id === event.context) : list.find((s) => s.id === lastAlerted())
        if (!target) {
          speak('No session to send that to')
          return { kind: 'no-session' }
        }
        if (confirmOn()) {
          pending = { go: () => sendPrompt(text, target), at: now(), sessionId: target.id }
          speak(`Heard: ${text}. Send to ${target.title}? Say yes to confirm.`)
          return { kind: 'confirming', id: 'dictation' }
        }
        say(`Heard. Sending to ${target.title}.`)
        return sendPrompt(text, target)
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

      // The model's reading of an utterance is a guess: anything beyond answering a prompt is read back first.
      // With confirm on, everything is read back except the fast safety paths (stop, deny).
      if (match.confirm || (match.viaLlm && !(match.action === 'approval' && match.decision === 'deny')) || (confirmOn() && !isFast(match))) {
        const isApprove = match.action === 'approval' && match.decision === 'approve'
        const snap = isApprove && approvals.peek ? approvals.peek({ sessionId: target?.id }) : undefined
        pending = {
          at: now(),
          sessionId: target?.id,
          go: async () => {
            if (isApprove && approvals.peek && approvals.peek({ sessionId: target?.id })?.token !== snap?.token) {
              speak('That request changed. Not approving.')
              return { kind: 'stale', id: match.id }
            }
            return run(match, target)
          },
        }
        const said = snap ? describeMatch(match, target?.title).replace('Approving', `Approving ${snap.toolName}`) : describeMatch(match, target?.title)
        speak(`${said}. Say yes to confirm.`)
        return { kind: 'confirming', id: match.id }
      }
      say(`Heard "${heard(text)}". ${describeMatch(match, target?.title)}.`)
      return run(match, target)
    },
  }
}
