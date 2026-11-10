// Worktree gate: before a lease holder drives the browser, the API server listening on the configured port must
// run from the worktree the holder named in queue_acquire. No dependencies; the listener is found with the OS tools.
// It catches mistakes (a stale server from another worktree), it is not a boundary against a hostile agent.
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const NESTED_WORKTREE = /^\/(\.claude\/worktrees|\.worktrees)\//;
const SCRIPT_EXT = /\.(?:[cm]?[jt]s|tsx)$/;
const LOOKUP_TIMEOUT_MS = 8000;

const norm = (p, platform = process.platform) => {
  let s = String(p).replaceAll('\\', '/');
  if (platform === 'win32') s = s.toLowerCase();
  return s.replace(/\/+$/, '');
};

// Splits a command line into tokens, honouring single and double quotes.
function tokenize(line) {
  const out = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let m;
  while ((m = re.exec(line)) !== null) out.push(m[1] ?? m[2] ?? m[3]);
  return out;
}

// True when some listener entry runs from `worktree`. A known cwd decides alone (it is the working directory the
// server was started in). Without a cwd, the entry matches when a script argument (.js/.ts/...) lies inside the
// worktree; a bare mention of the path (--config, --log) does not count, and `..` segments never match. A path
// inside a worktree nested under `worktree` (.claude/worktrees/x, .worktrees/x) belongs to that worktree instead.
export function listenerMatchesWorktree(entries, worktree, platform = process.platform) {
  const wt = norm(worktree, platform);
  if (!wt) return false;
  const insideOwn = (rest) => !NESTED_WORKTREE.test(`${rest}/`);
  for (const e of Array.isArray(entries) ? entries : []) {
    if (typeof e?.cwd === 'string' && e.cwd) {
      const cwd = norm(e.cwd, platform);
      if (cwd === wt || (cwd.startsWith(`${wt}/`) && insideOwn(cwd.slice(wt.length)))) return true;
      continue;
    }
    if (typeof e?.commandLine !== 'string' || !e.commandLine) continue;
    for (const raw of tokenize(e.commandLine).slice(1)) {
      if (raw.startsWith('-')) continue;
      const t = norm(raw, platform);
      if (!SCRIPT_EXT.test(t) || t.split('/').includes('..') || !t.startsWith(`${wt}/`)) continue;
      if (insideOwn(t.slice(wt.length))) return true;
    }
  }
  return false;
}

// Returns an error message when `worktree` (already resolved, absolute) is not a usable worktree, else null.
export function defaultValidateWorktree(worktree) {
  return fs.existsSync(path.join(worktree, '.git')) ? null : `${worktree} has no .git entry: pass the root of your git worktree.`;
}

// Reads the working directory of a process through the PEB (x64/ARM64 only; null elsewhere or when access is denied).
const WIN_CWD_SOURCE = `
using System; using System.Runtime.InteropServices; using System.Text;
public static class PwqCwd {
  [DllImport("ntdll.dll")] static extern int NtQueryInformationProcess(IntPtr h, int cls, ref PBI pbi, int len, out int ret);
  [DllImport("kernel32.dll")] static extern IntPtr OpenProcess(int acc, bool inh, int pid);
  [DllImport("kernel32.dll")] static extern bool ReadProcessMemory(IntPtr h, IntPtr addr, byte[] buf, int size, out IntPtr read);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr h);
  [StructLayout(LayoutKind.Sequential)] struct PBI { public IntPtr Exit; public IntPtr Peb; public IntPtr Aff; public IntPtr Prio; public IntPtr Pid; public IntPtr Parent; }
  public static string Get(int pid) {
    if (!Environment.Is64BitProcess) return null;
    IntPtr h = OpenProcess(0x1010, false, pid);
    if (h == IntPtr.Zero) return null;
    try {
      PBI pbi = new PBI(); int ret;
      if (NtQueryInformationProcess(h, 0, ref pbi, Marshal.SizeOf(pbi), out ret) != 0) return null;
      byte[] b = new byte[8]; IntPtr rd;
      if (!ReadProcessMemory(h, IntPtr.Add(pbi.Peb, 0x20), b, 8, out rd)) return null;
      IntPtr pp = (IntPtr)BitConverter.ToInt64(b, 0);
      byte[] us = new byte[16];
      if (!ReadProcessMemory(h, IntPtr.Add(pp, 0x38), us, 16, out rd)) return null;
      int len = BitConverter.ToUInt16(us, 0); IntPtr buf = (IntPtr)BitConverter.ToInt64(us, 8);
      if (len <= 0) return null;
      byte[] s = new byte[len];
      if (!ReadProcessMemory(h, buf, s, len, out rd)) return null;
      return Encoding.Unicode.GetString(s);
    } finally { CloseHandle(h); }
  }
}`;

// The C# compile (Add-Type) costs seconds, so the cwd is only read when withCwd is set.
// pids are integers parsed from netstat output, so interpolating them is safe.
function windowsScript(pids, withCwd) {
  const cwdSetup = withCwd ? `Add-Type -TypeDefinition @'\n${WIN_CWD_SOURCE}\n'@` : '';
  const cwdValue = withCwd ? '[PwqCwd]::Get([int]$procId)' : '$null';
  return `
$ErrorActionPreference = 'Stop'
${cwdSetup}
$entries = @()
foreach ($procId in @(${pids.join(',')})) {
  $p = Get-CimInstance Win32_Process -Filter "ProcessId = $procId" -ErrorAction SilentlyContinue
  $entries += [pscustomobject]@{ pid = [int]$procId; commandLine = $p.CommandLine; cwd = ${cwdValue} }
}
ConvertTo-Json -InputObject @($entries) -Compress -Depth 4`;
}

// Listener PIDs of a TCP port from `netstat -ano` (milliseconds, no PowerShell).
export function parseNetstatListeners(text, port) {
  const pids = new Set();
  for (const line of String(text).split(/\r?\n/)) {
    const m = /^\s*TCP\s+\S+:(\d+)\s+\S+\s+LISTENING\s+(\d+)\s*$/i.exec(line);
    if (m && Number(m[1]) === port && Number(m[2]) > 0) pids.add(Number(m[2]));
  }
  return [...pids];
}

const run = (file, args) =>
  new Promise((resolve, reject) => {
    execFile(file, args, { timeout: LOOKUP_TIMEOUT_MS, killSignal: 'SIGKILL', windowsHide: true, maxBuffer: 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) return reject(Object.assign(new Error(`${path.basename(file)} failed: ${(stderr || err.message).toString().trim().slice(0, 300)}`), { code: err.code }));
      resolve(stdout.toString());
    });
  });

// Resolves { listening, entries: [{ pid, commandLine, cwd? }] }; cwd is only read with { withCwd: true }.
export async function defaultListenerInfo(port, { withCwd = false } = {}, platform = process.platform) {
  if (platform === 'win32') {
    const pids = parseNetstatListeners(await run('netstat.exe', ['-ano', '-p', 'tcp']), port);
    if (pids.length === 0) return { listening: false, entries: [] };
    const encoded = Buffer.from(windowsScript(pids, withCwd), 'utf16le').toString('base64');
    const out = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded]);
    return { listening: true, entries: [].concat(JSON.parse(out.trim()) ?? []) };
  }
  let pids = [];
  try {
    pids = (await run('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-t'])).split(/\s+/).filter(Boolean);
  } catch (e) {
    // lsof exits 1 when nothing listens (an empty result); a missing lsof is a real error
    if (e.code === 'ENOENT') throw e;
  }
  const entries = [];
  for (const pid of pids) {
    let commandLine = null;
    try { commandLine = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').replaceAll('\0', ' ').trim(); } catch { /* no /proc (macOS) */ }
    if (!commandLine) commandLine = await run('ps', ['-o', 'command=', '-p', pid]).then((s) => s.trim(), () => null);
    let cwd;
    if (withCwd) {
      cwd = null;
      try { cwd = fs.readlinkSync(`/proc/${pid}/cwd`); } catch { /* no /proc (macOS) */ }
      if (!cwd) {
        cwd = await run('lsof', ['-a', '-p', pid, '-d', 'cwd', '-Fn']).then((s) => s.split('\n').find((l) => l.startsWith('n'))?.slice(1) ?? null, () => null);
      }
    }
    entries.push({ pid: Number(pid), commandLine, cwd });
  }
  return { listening: pids.length > 0, entries };
}

// Only the pid and the executable name are shown to the agent: command lines can carry tokens and passwords.
const describeEntries = (entries) =>
  entries.length === 0
    ? 'unknown process'
    : entries
        .map((e) => {
          const exe = tokenize(String(e.commandLine ?? ''))[0];
          return `pid ${e.pid} (${exe ? path.basename(exe.replaceAll('\\', '/')) : 'unknown executable'})`;
        })
        .join(', ');

export function createServerGate({ port, listenerInfo = defaultListenerInfo, platform = process.platform } = {}) {
  if (typeof port !== 'number') throw new TypeError('port must be a number');
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new RangeError('port must be an integer from 1 to 65535');
  const inflight = new Map(); // worktree -> shared promise of an in-progress check

  async function checkOnce(worktree) {
    let info;
    try {
      info = await listenerInfo(port, { withCwd: false });
    } catch (e) {
      return { ok: false, message: `Could not determine which process listens on port ${port}: ${e.message}` };
    }
    if (!info || typeof info !== 'object') {
      return { ok: false, message: `Could not determine which process listens on port ${port}.` };
    }
    if (!info.listening) {
      return {
        ok: false,
        message: `No server is listening on port ${port}. Start the API server from your worktree (${worktree}) on port ${port}, then retry.`,
      };
    }
    if (listenerMatchesWorktree(info.entries, worktree, platform)) return { ok: true };
    // The script path did not settle it (e.g. a relative path): read the working directory, which costs more.
    let withCwd = info;
    try {
      withCwd = (await listenerInfo(port, { withCwd: true })) ?? info;
    } catch (e) {
      return { ok: false, message: `Could not read the working directory of the process on port ${port}: ${e.message}` };
    }
    const entries = Array.isArray(withCwd.entries) ? withCwd.entries : [];
    if (listenerMatchesWorktree(entries, worktree, platform)) return { ok: true };
    const unreadable = entries.some((e) => !e.cwd) ? ' Its working directory could not be read.' : '';
    return {
      ok: false,
      message:
        `The API server on port ${port} is not running from your worktree ${worktree} (found: ${describeEntries(entries)}).${unreadable} ` +
        `Stop that server and start one on the same port ${port} from your worktree, then retry.`,
    };
  }

  return {
    port,
    check(worktree) {
      let p = inflight.get(worktree);
      if (!p) {
        p = checkOnce(worktree).finally(() => inflight.delete(worktree));
        inflight.set(worktree, p);
      }
      return p;
    },
  };
}
