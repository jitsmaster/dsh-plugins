/**
 * Prints the report adb-check.ps1 asks for. Input (stdin, JSON): { packageName, serial, devices, package, logcat, notifications, ui }, the raw
 * texts of the adb commands; every parser is in adb-parse.mjs. Exit code 1 when no device can be chosen.
 */
import { fileURLToPath } from 'node:url'
import { chooseDevice, hasAddressBarHint, launchMode, notificationsFor, parseDevices, parsePackageInfo } from './adb-parse.mjs'

/** @returns {string[]} report lines */
export function buildReport(input) {
  const out = []
  let serial
  try { serial = chooseDevice(parseDevices(input.devices), input.serial || undefined) } catch (e) { return ['device: ' + e.message] }
  out.push('device: ' + serial)
  const info = parsePackageInfo(input.package, input.packageName)
  if (!info) return [...out, 'package ' + input.packageName + ': not installed']
  out.push('package ' + info.packageName + ': version ' + info.versionName + ' (' + info.versionCode + '), minSdk ' + info.minSdk + ', targetSdk ' + info.targetSdk + ', installed ' + info.firstInstallTime)
  const launch = launchMode(input.logcat)
  out.push('last launch: ' + launch.mode + (launch.url ? ' ' + launch.url : ''))
  out.push('address bar on screen: ' + (input.ui ? (hasAddressBarHint(input.ui) ? 'yes (Custom Tab or Chrome UI)' : 'no') : 'unknown (no UI dump)'))
  const notes = notificationsFor(input.notifications, input.packageName)
  out.push('notifications owned by the app: ' + notes.length + notes.map((n) => ' [id ' + n.id + (n.tag ? ' tag ' + n.tag : '') + ']').join(''))
  return out
}

async function readStdin() {
  const chunks = []
  for await (const c of process.stdin) chunks.push(c)
  return Buffer.concat(chunks).toString('utf8')
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const lines = buildReport(JSON.parse(await readStdin()))
  console.log(lines.join('\n'))
  process.exit(lines[0].startsWith('device: ') && !/not listed|no device|several|unauthorized/.test(lines[0]) ? 0 : 1)
}
