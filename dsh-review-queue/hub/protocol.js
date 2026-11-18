export const PROTOCOL = 3
export const MIN_HUB_PROTOCOL = 3
/** The peer addresses of this PC itself (the hub listens on 127.0.0.1 only; ::1 and the mapped form are accepted for completeness). */
export const LOOPBACK_ADDRESSES = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1'])
