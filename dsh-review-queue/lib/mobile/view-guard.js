/**
 * Mobile-view guard (pure). Chrome's "Desktop site" setting makes a phone send a desktop user agent and lay the page out at ~980 CSS px,
 * which breaks the phone layout. viewIssue() judges that from plain values so it can be tested without a DOM; views.js shows the result.
 * Only a touch device is judged: a real desktop browser (no touch points) legitimately has a desktop user agent and a wide window.
 * iPhone and iPod are judged like Android phones; an iPad (also iPadOS in desktop mode: Macintosh user agent with touch) is a tablet and gets no warning.
 */

/** Layout viewports at or above this are not a phone's own width (Desktop site gives ~980). */
export const WIDE_VIEWPORT_PX = 900

const DESKTOP_UA_MESSAGE = 'Chrome is showing the desktop site. Untick Chrome menu > Desktop site to get the phone layout.'
const WIDE_VIEWPORT_MESSAGE = 'This page is laid out too wide for a phone. Untick Chrome menu > Desktop site in Chrome.'
const IPHONE_WIDE_MESSAGE = 'This page is laid out too wide for a phone. In Safari tap the aA button, then Request Mobile Website.'

/**
 * @param {{ userAgent?: unknown, innerWidth?: unknown, maxTouchPoints?: unknown }} [input]
 * @returns {null | { kind: 'desktop-ua' | 'wide-viewport', message: string }}
 */
export function viewIssue({ userAgent, innerWidth, maxTouchPoints } = {}) {
  // A bad or missing value only removes that rule's evidence; it never throws.
  if (typeof maxTouchPoints !== 'number' || !(maxTouchPoints > 0)) return null
  const ua = typeof userAgent === 'string' ? userAgent : null
  // An iPad (or iPadOS asking for the desktop site: Macintosh with touch) is a tablet: wide layouts and desktop user agents are legitimate there.
  if (ua !== null && (ua.includes('iPad') || (ua.includes('Macintosh') && maxTouchPoints > 1))) return null
  const iphone = ua !== null && (ua.includes('iPhone') || ua.includes('iPod'))
  // Chrome's mobile user agent names both Android and Mobile; Desktop site drops "Mobile" (and "Android" on some builds). Safari on iPhone names iPhone.
  if (ua !== null && !iphone && !(ua.includes('Android') && ua.includes('Mobile'))) return { kind: 'desktop-ua', message: DESKTOP_UA_MESSAGE }
  if (typeof innerWidth === 'number' && innerWidth >= WIDE_VIEWPORT_PX) return { kind: 'wide-viewport', message: iphone ? IPHONE_WIDE_MESSAGE : WIDE_VIEWPORT_MESSAGE }
  return null
}
