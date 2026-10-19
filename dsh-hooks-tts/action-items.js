/**
 * Action-item highlighting. Anything in a reply that needs the user to do something (confirm, answer a question,
 * clarify, choose) must be easy to spot, so the model is told once per session to put each such item in its own
 * paragraph, in bold and underlined. Same mechanism as the ask_user_question timeout guidance (ask.js): a message
 * appended to the session's first step, so it is active whenever the plugin is, with nothing to configure.
 */
export const ACTION_ITEM_GUIDANCE = [
  'Highlight every action item directed at the user (a confirmation you need, a question to answer, a clarification, a choice between options) so it cannot be missed:',
  'put it in its own paragraph, separate from the surrounding text, and format it in bold and underlined using `<u>**...**</u>`.',
  'Example: <u>**Would you like me to proceed with Option A or Option B?**</u>',
  'Use this only for things the user must act on; never for status, progress or explanation.',
].join('\n')

export function installActionItemFormatting(ctx, { skip, makeMessage }) {
  const guided = new Set()

  ctx.on('agent/pre-step', async ({ agent }, next) => {
    const downstream = await next()
    if (skip(agent) || downstream.kind !== 'enter' || guided.has(agent.id)) return downstream
    guided.add(agent.id)
    return { ...downstream, messages: [...downstream.messages, makeMessage(ACTION_ITEM_GUIDANCE)] }
  })
}
