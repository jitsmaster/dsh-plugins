/**
 * What kind of device the phone page runs on (pure, node-tested with fake windows and user agents): iOS or not, which iOS, whether the
 * page was opened from the Home Screen, and what to tell an iPhone user. On iOS the "app" is the PWA itself (Safari, Share, Add to Home
 * Screen) and Web Push works only for that installed app on iOS / iPadOS 16.4 or later, never in a Safari tab.
 */

/** The first iOS release with Web Push for Home Screen apps. */
const PUSH_MIN_IOS = 16.4

const HOME_SCREEN_TEXT = 'To get notifications on this iPhone: tap Share, then Add to Home Screen, open the app from the Home Screen, then turn notifications on in Settings.'

/**
 * @param {{ userAgent?: unknown, maxTouchPoints?: unknown, standalone?: unknown, hasPush?: unknown }} [input]
 * @returns {{ ios: boolean, iosVersion: number | null, standalone: boolean, canPush: boolean }}
 */
export function platformInfo({ userAgent, maxTouchPoints, standalone, hasPush } = {}) {
  const ua = typeof userAgent === 'string' ? userAgent : ''
  // iPadOS asks for desktop sites by default: its user agent says Macintosh, and only the touch points tell it from a real Mac.
  const ipadDesktop = ua.includes('Macintosh') && typeof maxTouchPoints === 'number' && maxTouchPoints > 1
  const ios = /iPhone|iPod|iPad/.test(ua) || ipadDesktop
  const version = ios ? /CPU (?:iPhone )?OS (\d+)_(\d+)/.exec(ua) : null
  const installed = standalone === true
  return { ios, iosVersion: version ? Number(version[1] + '.' + version[2]) : null, standalone: installed, canPush: hasPush === true && (!ios || installed) }
}

/** Why push cannot work here on iOS, or null (not iOS, or nothing to say). */
export function pushHint(info) {
  if (!info || info.ios !== true) return null
  if (info.standalone !== true) return HOME_SCREEN_TEXT
  if (typeof info.iosVersion === 'number' && info.iosVersion < PUSH_MIN_IOS) return 'Notifications need iOS 16.4 or later. Update this iPhone to get them.'
  return null
}

/** The Home Screen text for iOS that runs in a Safari tab, else null. */
export function installHint(info) {
  return info && info.ios === true && info.standalone !== true ? pushHint(info) : null
}

/** True when the page was opened from the Home Screen (iOS navigator.standalone, or display-mode: standalone); never throws. */
export function isStandalone(win) {
  try {
    if (win?.navigator?.standalone === true) return true
  } catch { /* a hostile getter: fall through to the media query */ }
  try {
    return !!win?.matchMedia?.('(display-mode: standalone)')?.matches
  } catch { return false }
}
