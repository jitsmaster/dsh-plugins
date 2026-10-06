/**
 * ask_user_question tuning. DSH freezes tool arguments before a plugin sees them, so the timeout cannot be rewritten
 * in a hook: instead the model is told once per session to pass `timeout` = 120 s x number of questions, and a
 * timed-out (pending) result gets a follow-up telling it to merge the user's confirmed answers with its own
 * recommended options and carry on.
 */
const PER_QUESTION_SECONDS = 120

const GUIDANCE = `When you call ask_user_question, pass the "timeout" argument explicitly as ${PER_QUESTION_SECONDS} seconds multiplied by the number of questions in that call (for example 3 questions -> timeout 360), so the user has enough time to answer.`

const PENDING_FOLLOW_UP = [
  'The ask_user_question call timed out with no complete answer (pending).',
  'Do not stop and do not wait. Combine the answers the user already confirmed (earlier answers in this conversation) with your own recommended option for every question still unanswered, state briefly which defaults you assumed, and continue the work.',
  'If the user answers later, their reply arrives as answer_to_pending_question: apply it and adjust if it differs from the assumed recommendation.',
].join('\n')

const textOf = (content) => (content ?? []).filter((b) => b?.type === 'text').map((b) => b.text).join('')

export function installAskUserTuning(ctx, { skip, makeMessage }) {
  const guided = new Set()

  ctx.on('agent/pre-step', async ({ agent }, next) => {
    const downstream = await next()
    if (skip(agent) || downstream.kind !== 'enter' || guided.has(agent.id)) return downstream
    guided.add(agent.id)
    return { ...downstream, messages: [...downstream.messages, makeMessage(GUIDANCE)] }
  })

  ctx.on('tools/post-execute', async (exec, result, next) => {
    const downstream = await next()
    if (!exec.agent || skip(exec.agent) || exec.name !== 'ask_user_question') return downstream
    if (!/"pending"\s*:\s*true/.test(textOf(result?.content))) return downstream
    return { ...downstream, additionalContexts: [makeMessage(PENDING_FOLLOW_UP), ...downstream.additionalContexts ?? []] }
  })
}
