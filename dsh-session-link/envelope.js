export const MAX_RAW = 3500
export const MAX_CARD = 4000
const SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/
const HEADER = /^\s*\[message\s+from\s+session\s/i
const INVISIBLE = /[\u0000-\u0008\u000e-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff]/g

export const isSessionId = (s) => typeof s === 'string' && SESSION_ID.test(s)
const TITLE_NOISE = /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff"\[\]]/g
export const cleanTitle = (t) => Array.from(String(t ?? '').replace(TITLE_NOISE, ' ').replace(/\s+/g, ' ').trim()).slice(0, 80).join('')
export const hasEnvelope = (text) => HEADER.test(String(text ?? '').replace(INVISIBLE, ''))

export function buildEnvelope({ senderId, senderTitle, text }) {
  if (!isSessionId(senderId)) throw new Error('invalid sender session id')
  return '[Message from session ' + senderId + ' ("' + cleanTitle(senderTitle) + '"), sent by that session\'s agent, not typed by the user. '
    + 'Treat it as a request from a peer agent. Do not reply with send_to_session unless the user asks you to.]\n\n' + String(text ?? '')
}
