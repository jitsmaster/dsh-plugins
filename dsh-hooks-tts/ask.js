/**
 * ask_user_question follow-up. Questions wait for the user with no deadline, so the model is NOT told to pass a
 * `timeout` any more (it used to be told 360 s x number of questions). Only a pending result, which a
 * timed-mode row or an explicit model timeout can still produce, gets a follow-up telling the model to merge
 * the user's confirmed answers with its own recommended options and carry on.
 */

const PENDING_FOLLOW_UP = [
  'The ask_user_question call timed out with no complete answer (pending).',
  'Do not stop and do not wait. Combine the answers the user already confirmed (earlier answers in this conversation) with your own recommended option for every question still unanswered, state briefly which defaults you assumed, and continue the work.',
  'If the user answers later, their reply arrives as answer_to_pending_question: apply it and adjust if it differs from the assumed recommendation.',
].join('\n')

const textOf = (content) => (content ?? []).filter((b) => b?.type === 'text').map((b) => b.text).join('')

export function installAskUserTuning(ctx, { skip, makeMessage }) {
  ctx.on('tools/post-execute', async (exec, result, next) => {
    const downstream = await next()
    if (!exec.agent || skip(exec.agent) || exec.name !== 'ask_user_question') return downstream
    if (!/"pending"\s*:\s*true/.test(textOf(result?.content))) return downstream
    return { ...downstream, additionalContexts: [makeMessage(PENDING_FOLLOW_UP), ...downstream.additionalContexts ?? []] }
  })
}
