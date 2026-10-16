/** Parsers for the adb outputs adb-check.ps1 collects (pure; adb-report.mjs prints them). */

/** "adb devices" text -> [{ serial, state }]. */
export function parseDevices(text) {
  const out = []
  for (const line of String(text ?? '').split(/\r?\n/)) {
    const m = /^(\S+)\t(device|offline|unauthorized|recovery|sideload|bootloader|no permissions.*)$/.exec(line.trim())
    if (m) out.push({ serial: m[1], state: m[2] })
  }
  return out
}

/** The serial to talk to: the requested one, else the only online device. Throws with a reason otherwise. */
export function chooseDevice(devices, serial) {
  if (serial) {
    if (!devices.some((d) => d.serial === serial)) throw new Error('device ' + serial + ' is not listed by adb')
    return serial
  }
  const online = devices.filter((d) => d.state === 'device')
  if (online.length === 1) return online[0].serial
  if (online.length > 1) throw new Error('several devices online (' + online.map((d) => d.serial).join(', ') + '): pass -Serial')
  const bad = devices.find((d) => d.state === 'unauthorized')
  if (bad) throw new Error('device ' + bad.serial + ' is unauthorized: accept the USB debugging prompt on the phone')
  throw new Error('no device online (start the emulator or connect the phone with USB debugging)')
}

/**
 * From `adb logcat -d -s TwaLauncher TWALauncherActivity`: the library logs "Launching Trusted Web Activity." when it asks the browser for a
 * TWA and "Using url from Manifest/Intent" for the page. Chrome decides on verification, so TRUSTED_WEB_ACTIVITY is what was requested;
 * the screenshot / UI dump shows whether Chrome kept it (no address bar) or fell back to a Custom Tab.
 */
export function launchMode(logcat) {
  // One launch = a "Using url ..." line (LauncherActivity picks the page) followed by TwaLauncher's "Launching Trusted Web Activity." when it
  // asks the browser for a TWA; without that line the launch went through the Custom Tab fallback.
  let launch
  for (const line of String(logcat ?? '').split(/\r?\n/)) {
    const m = /Using (?:url from (?:Manifest|Intent)|protocol handler url): (\S+)/.exec(line)
    if (m) launch = { mode: 'CUSTOM_TAB', url: m[1] }
    else if (launch && /Launching Trusted Web Activity/.test(line)) launch = { ...launch, mode: 'TRUSTED_WEB_ACTIVITY' }
  }
  return launch ?? { mode: 'UNKNOWN', url: undefined }
}

/** @returns {{ packageName: string, versionCode: number, versionName: string, minSdk: number, targetSdk: number, firstInstallTime: string } | undefined} */
export function parsePackageInfo(dumpsys, packageName) {
  const text = String(dumpsys ?? '')
  if (!text.includes('Package [' + packageName + ']')) return undefined
  const num = (re) => { const m = re.exec(text); return m ? Number(m[1]) : undefined }
  const str = (re) => re.exec(text)?.[1]
  return {
    packageName,
    versionCode: num(/versionCode=(\d+)/),
    versionName: str(/versionName=(\S+)/),
    minSdk: num(/minSdk=(\d+)/),
    targetSdk: num(/targetSdk=(\d+)/),
    firstInstallTime: str(/firstInstallTime=([^\r\n]+)/),
  }
}

/** Notification records owned by the package in `dumpsys notification --noredact`. */
export function notificationsFor(dumpsys, packageName) {
  const out = []
  for (const line of String(dumpsys ?? '').split(/\r?\n/)) {
    const m = /NotificationRecord\([^ ]+ pkg=(\S+) .*?id=(-?\d+) tag=(\S+)/.exec(line)
    if (m && m[1] === packageName) out.push({ id: Number(m[2]), tag: m[3] === 'null' ? undefined : m[3] })
  }
  return out
}

/** uiautomator dump heuristic: Chrome's URL bar or Custom Tab toolbar resource ids mean an address bar is on screen. */
export function hasAddressBarHint(uiDump) {
  return /resource-id="[^"]*:id\/(url_bar|custom_tabs_toolbar|location_bar|toolbar_container)"/.test(String(uiDump ?? ''))
}
