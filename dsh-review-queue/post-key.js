/**
 * The idempotency key of a phone post (docs/hub.md 6.8): a string of 1 to 64 characters of letters, digits, underscore and dash. The phone makes one
 * per composed message; anything else the client sends (too long, other characters, not a string) is ignored, never an error.
 */
const POST_KEY = /^[A-Za-z0-9_-]{1,64}$/

/** @returns {string | undefined} the key when it is a valid one */
export const postKeyOf = (value) => (typeof value === 'string' && POST_KEY.test(value) ? value : undefined)
