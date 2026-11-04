// Runs the explicit test file list (scripts/test-files.json) through `node --test`, keeping package.json's test script short (Windows cmd limit is 8191 chars).
import { spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const listFile = process.env.RUN_TESTS_FILES_OVERRIDE || join(root, 'scripts', 'test-files.json')
const files = JSON.parse(readFileSync(listFile, 'utf8'))
const child = spawn(process.execPath, ['--test', ...process.argv.slice(2), ...files], { cwd: process.env.RUN_TESTS_FILES_OVERRIDE ? process.cwd() : root, stdio: 'inherit', shell: false })
child.on('error', (err) => { console.error(err); process.exit(1) })
child.on('exit', (code, signal) => process.exit(code ?? (signal ? 1 : 1)))
