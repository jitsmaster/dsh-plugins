/**
 * Writes the generated Android resources from hub.config.json (publicUrl, hubPort): values/twa.xml for the release and debug builds,
 * the localDebug variant's loopback twin, and the launcher art copied from the PWA icon. Run by build.ps1 before Gradle.
 * Usage: node gen-resources.mjs [--hub-config <file>] [--start-url <https url>]
 */
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { startUrlFromConfig, localDebugUrl } from './twa-url.mjs'
import { buildTwaResourcesXml } from './twa-resources.mjs'

const here = dirname(fileURLToPath(import.meta.url))
export const DEFAULT_ANDROID_DIR = join(here, '..')
export const DEFAULT_ICON = join(here, '..', '..', 'lib', 'mobile', 'icon-512.png')
export const DEFAULT_HUB_CONFIG = join(homedir(), '.dsh', 'review-queue', 'hub.config.json')

function put(file, text) {
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, text)
}

/** Nothing is written when the config cannot give a valid https start URL (a half-generated project would build the wrong app). */
export function generateResources({ androidDir = DEFAULT_ANDROID_DIR, hubConfig, iconSource = DEFAULT_ICON, startUrl }) {
  const url = startUrlFromConfig(hubConfig, startUrl)
  const main = buildTwaResourcesXml(url)
  const local = buildTwaResourcesXml(localDebugUrl(hubConfig), { allowHttp: true })
  const art = join(androidDir, 'app/src/main/res/drawable-nodpi/ic_launcher_art.png')
  put(join(androidDir, 'app/src/main/res/values/twa.xml'), main)
  put(join(androidDir, 'app/src/localDebug/res/values/twa.xml'), local)
  mkdirSync(dirname(art), { recursive: true })
  copyFileSync(iconSource, art)
  return { startUrl: url, localUrl: localDebugUrl(hubConfig) }
}

function readHubConfig(file) {
  try { return JSON.parse(readFileSync(file, 'utf8')) } catch { return undefined }
}

function main(argv) {
  let cfgFile = DEFAULT_HUB_CONFIG
  let startUrl
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--hub-config') cfgFile = argv[++i]
    else if (argv[i] === '--start-url') startUrl = argv[++i]
    else throw new Error('unknown argument ' + argv[i])
  }
  const out = generateResources({ hubConfig: readHubConfig(cfgFile), startUrl })
  console.log('start URL: ' + out.startUrl + '  (localDebug: ' + out.localUrl + ')')
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try { main(process.argv.slice(2)) } catch (e) { console.error(e.message); process.exit(1) }
}
