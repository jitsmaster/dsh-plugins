# dsh-playwright-queue

Queue core for serialising visual-test sessions (one CMS, one Playwright at a time).
Several OS processes (for example the web and desktop DSH servers, each with a wrapper MCP server) share a
file-based FIFO lease. This package holds the queue core and the MCP wrapper server.js (hooks come in a later phase).

```js
import { createQueue } from 'dsh-playwright-queue/queue';

const q = createQueue({ dir: '<shared dir>' });          // idleMs default 10 min
const { ticket } = q.enqueue({ holder: 'session-1', pid: process.pid });
const r = q.poll(ticket);   // {status:'waiting',position,holderLabel} | {status:'granted',token} | {status:'unknown'}
q.touch(r.token);           // refresh activity (throttled); validate(token) / release(token) / cancel(ticket) / snapshot()
```

- State: a single `<dir>/state.json` = `{ lease, waiters }`, guarded by `<dir>/state.lock`. It is replaced atomically
  (temp file + rename) and only written when an operation actually changed something. A `poll` or re-`enqueue` of a
  waiting ticket refreshes its `lastPolledAt` (and so writes) only once it is older than `pollThrottleMs`; `validate`,
  `snapshot`, a `touch` inside `touchThrottleMs` and a `poll` of an already claimed lease do not write. A missing file is empty state; an unparsable or wrongly shaped one (deep check of every waiter and the lease) is renamed to
  `state.json.corrupt-<timestamp>-<id>` (quarantine) and the queue starts empty. Dir mode 0700, file mode 0600.
- `lib/lock.js`: `withLockSync` mutex via exclusive file creation (sync only; always released; an `fn` returning a thenable releases the lock and throws a `TypeError`;
  `undefined` option values fall back to the defaults).
  The lock file may only be deleted by a process holding the short-lived guard file `<lock>.break` (also created with
  `wx`, bounded wait `guardTimeoutMs` default 2000 (capped by the time left of `timeoutMs` while acquiring), then a loud
  `EGUARDBUSY` error; a lock wait that exceeds `timeoutMs` throws an error with `code === 'ELOCKTIMEOUT'`): this covers breaking stale locks
  and `release`. Under the guard the lock is re-read and unlinked only if it still carries the expected owner id, so a
  live owner's lock is never removed by a stale-breaker. Acquirers use plain `open wx` and need no guard.
  Staleness: a dead owner pid is stale at once; a live owner is only broken after `hardStaleMs` (default 60 s, there is
  no heartbeat), so `fn` must finish well within 60 s. A lock without a usable pid falls back to `staleMs` (10 s).
  EEXIST/EBUSY mean "busy"; EPERM/EACCES count as busy only on Windows and only for a bounded run, after which the real
  error is thrown. Other errors are thrown immediately (never silently swallowed). `defaultPidAlive(pid)` is false for
  non-positive or non-integer pids. `retryBusy(op)` (exported) is the shared busy-retry helper.
  Honest guarantees: among processes using this library, mutual exclusion holds, including across stale-breaks. It is
  not absolute: a guard abandoned by a crashed process (dead pid, or older than 5 s) is itself broken with a
  read-compare-unlink that has a microsecond gap; a process that deletes the lock without the guard is outside the
  protocol; and a live owner running past `hardStaleMs` loses its lock.
- `validate(token)` is lock-free and read-only: it reads `state.json` directly (the atomic rename makes that read
  consistent; transient EBUSY/EPERM are retried) and applies the reclaim rules in memory only to answer: the token must
  match the current lease, the lease must not be idle-expired or unclaimed-expired, and its pid must be alive. When
  the lock-free read confirms or refutes the token it never writes and takes no lock. A missing file (ENOENT) reads as
  empty state, so `validate` answers `false` without locking. If the read fails any other way (read error after 3
  attempts, corrupt or wrongly shaped file) the answer comes from the locked path (reclaim rules applied, a corrupt
  file is quarantined like any locked operation); a corrupt state answers `false`.
  Every mutation (`poll`, `touch`, `release`, `cancel`, `enqueue`, `reclaim`) stays under the lock.
- `touch(token)` is throttled: it writes `lastActivityAt` only when the stored value is older than `touchThrottleMs`
  (option, default `idleMs / 10`); otherwise it returns `true` without writing (the lock-free fast path; if that read
  fails with an error other than ENOENT it takes the locked path, which also does not write inside the window). Claiming an unclaimed lease always
  writes at once. Keep `touchThrottleMs` far below `idleMs`: a lease idles out `idleMs` after the last *written* stamp.
- Strict FIFO. `enqueue({holder, pid})` needs an integer `pid > 0` and a non-empty string `holder` (else `TypeError`;
  holders over 200 chars are truncated; control characters, newlines included, are replaced by a space so a label is
  one clean line, and a holder that is empty afterwards is a `TypeError`) and is idempotent for the same holder+pid,
  including the current lease holder. At most `maxWaiters` (option, default 100) tickets may wait: a further new
  enqueue throws an `Error` with `code === 'EQUEUEFULL'` (re-enqueue of an existing waiter still works).
  Dead-pid waiters and leases, leases idle longer than `idleMs`, and waiters that have not polled within
  `waiterTtlMs` (default 120000; `enqueue` and `poll` count as polling, but refresh `lastPolledAt` only past `pollThrottleMs`, default `waiterTtlMs / 10`) are reclaimed before every operation.
  A promoted lease records `claimedAt = null`; the granted ticket's `poll` or `touch(token)` sets it (and restarts its idle time), and a lease still
  unclaimed after `waiterTtlMs` is reclaimed so a holder that never polls cannot block the queue for `idleMs`.
- Release uses a longer guard wait (`releaseGuardTimeoutMs`, default `max(guardTimeoutMs, 6000)`) so an abandoned guard is
  broken instead of failing after `fn` ran. If `fn` threw, a release failure never masks it (attached as `err.releaseError`);
  if `fn` succeeded and release fails, the release error is thrown. The guard is only unlinked if it still holds our content (a guard read that keeps failing busy is retried, then treated as ours).
- At most the newest 5 `state.json.corrupt-*` quarantine files are kept; only regular files are ever removed (a
  directory with such a name is ignored) and a failed removal or an unreadable/missing directory never blocks a transaction.
- Options are validated by `createQueue`: `idleMs`, `waiterTtlMs` finite numbers `>= 1`; `touchThrottleMs`,
  `pollThrottleMs` finite numbers `>= 0`; `maxWaiters` integer `>= 1`. A non-number throws `TypeError`, an
  out-of-range value `RangeError`; `undefined` uses the default. Throttles are capped at half of `idleMs` / `waiterTtlMs`.
- Temp files are `state.json.<pid>.<random>.tmp`, created exclusively (`wx`, mode 0600). Regular `state.json.*.tmp`
  files older than 60 s (crash leftovers) are swept by the first locked operation of a queue
  instance, then at most once a minute (one throttle; quarantining does not sweep separately).

Notes and limits:

- Transactions must take a few ms: the lock wait is a synchronous busy-wait that blocks the event loop.
- PID reuse can keep a dead owner "alive" until the time cap (`hardStaleMs` / `idleMs` / `waiterTtlMs`).
- A corrupt or invalid `state.json` is quarantined and the queue restarts empty, so an old holder can still believe it holds a lease while the next waiter is granted one: exclusivity is not guaranteed across that failure. There is no fsync before the rename, so a power loss can cause it.
- If lock release fails (e.g. `EGUARDBUSY`) the lock stays owned by a live pid, and other processes wait up to `hardStaleMs` (60 s).
- Holder labels must be unique per session: the same (holder, pid) is merged into one ticket.
- `enqueue` is idempotent per (holder, pid) and returns the existing ticket for a matching pair. So a same-user local process that knows another session's holder and pid can recover that session's ticket (a known same-user trust-boundary limit). The MCP wrapper must therefore use a high-entropy, per-session holder string, never a guessable one.
- Reads are capped: a `state.json` over 1 MiB is treated as corrupt (quarantined by the locked path; the lock-free `validate`/`touch` fall back to the locked path). On load, holders are cleaned (control, format and line/paragraph-separator characters, so C1, U+2028/2029, bidi overrides and zero-width characters, become one space; then trimmed and capped at 200 chars), a state with more than `maxWaiters` waiters is truncated to the oldest `maxWaiters`, and lease/waiter timestamps more than 60 s in the future are clamped to now (the next locked operation persists the clamp).
- The wrapper must never pass user-controlled values into the `now`, `isAlive`, `randomId` or `readFile` test seams.
- `pid` and `holder` are caller-asserted; the trust boundary is local, same user.
- File modes (0700/0600) are no-ops on Windows, so keep `dir` under the per-user profile (e.g. `~/.dsh`).
- Leftover `state.json.*.tmp` files (crash mid-write) are swept automatically after 60 s; deleting them by hand is also safe.
- Lock/guard timestamps: ages are clamped at 0 and a `ts` more than 60 s in the future is ignored (file mtime is used).
- The `readFile` option of `createQueue` is an internal test seam, not public API.
- Plain ESM, no dependencies. Tests: `npm test` (`node --test`).

## MCP wrapper (server.js)

`server.js` is an MCP stdio server (newline-delimited JSON-RPC 2.0 on stdin/stdout, logs on stderr, no SDK, no
dependencies) that sits in front of a child MCP server (default Playwright MCP) and serialises access to it with the
queue. Run one wrapper per DSH server (web, desktop); all share one state dir, so only one session at a time drives
the browser/CMS.

```
node server.js                                  # child = npx -y @playwright/mcp@0.0.85 (npx.cmd on Windows)
node server.js -- <command> [args...]           # explicit child
DSH_PWQ_CHILD_COMMAND=node DSH_PWQ_CHILD_ARGS='["child.js"]' node server.js
```

The child is spawned lazily (first `tools/list` or forwarded call), handshaken, its tool list cached, and restarted
lazily on the next forwarded call if it dies (in-flight calls fail with an `isError` result). The wrapper exits, and
kills the child tree, when stdin closes or on SIGTERM/SIGINT. On Windows a `.cmd` child runs through
`cmd.exe /d /s /c` with no shell string; spaces and cmd metacharacters in command/args are rejected. The command only
ever comes from env/CLI config, never from tool arguments. On POSIX the child is spawned in its own process group and the
whole group gets SIGTERM on shutdown.

Security notes:

- On Windows, `cmd.exe` resolves `npx.cmd` from the current directory before `PATH`. If the host process cwd is
  untrusted, pass an absolute command path via `DSH_PWQ_CHILD_COMMAND` (or after `--`).
- Queue labels shown to other agents (`queue_status`, `holder` in a waiting reply) are free text from the agent
  (sanitised and capped at 80 chars, but not authenticated); this is accepted within the same-user trust boundary.
- Message size: a single JSON-RPC line is capped at 16 MiB (`DEFAULT_MAX_LINE_BYTES` in `lib/jsonrpc.js`) in both
  directions; longer lines are dropped. Playwright screenshots can be several MB of base64, so stay well below that.

| Env var | Default | Meaning |
| --- | --- | --- |
| `DSH_PWQ_DIR` | `~/.dsh/playwright-queue` | shared queue state dir |
| `DSH_PWQ_IDLE_MS` | queue default (10 min) | lease idle timeout (validated by the queue). Startup fails (exit 1) if it is smaller than `DSH_PWQ_CHILD_TIMEOUT_MS`, so a long child call cannot outlive the lease |
| `DSH_PWQ_POLL_MS` | `1000` | poll interval inside `queue_acquire` |
| `DSH_PWQ_WAIT_BUDGET_MS` | `45000` | max wait per `queue_acquire` call |
| `DSH_PWQ_CHILD_COMMAND` | `npx` / `npx.cmd` | child command (CLI args after `--` win) |
| `DSH_PWQ_CHILD_ARGS` | `["-y","@playwright/mcp@0.0.85"]` with the default command, else `[]` | JSON array of strings; the default pins an exact version (no `@latest`), operators can override it with this variable (together with `DSH_PWQ_CHILD_COMMAND`) |
| `DSH_PWQ_CHILD_TIMEOUT_MS` | `120000` | per-request timeout towards the child |

Tools:

- `queue_acquire {label?, ticket?}`: no ticket enqueues (holder = sanitised label (max 80) + `#` + random id, so it is
  per attempt and unguessable); with a ticket it polls that ticket (unknown/expired -> `isError`: call again without
  a ticket). Returns JSON text `{status:'granted', token, idleTimeoutMs}` or
  `{status:'waiting', ticket, position, holder, retry}`. On grant the browser is cleaned (below).
- `queue_release {queueToken}`: cleanup, then release. Idempotent: an unknown/expired token gives
  `{status:'not_held', ok:false}` (not an error); success gives `{status:'released', ok:true}`.
- `queue_status {}`: holder label, idle/held age, waiter labels; never tokens or tickets.
- every child tool is republished with an optional string `queueToken` (not added to `required`) and a description
  suffix. A forwarded call needs a valid `queueToken` (checked with `validate`, then `touch`); it is removed before
  forwarding and the child's result, `isError` and `structuredContent` come back unchanged (a child JSON-RPC error is
  passed through). A missing/invalid token is an `isError` result telling the agent to call `queue_acquire`
  (`lease expired or was released` for a bad token); the child is not called.
- Browser cleanup (best effort, never throws, at most about 10 s): `browser_tabs {action:'list'}`, close every tab but
  the current one (highest index first), then `browser_navigate about:blank`. It runs on grant and, before the lease
  is given back, on release; it is skipped when the child is not running or lacks the tools.

Why a 45 s waiting protocol: MCP clients time out a tool call after about 60 s, so `queue_acquire` never blocks
longer than `DSH_PWQ_WAIT_BUDGET_MS` (45 s). It answers `waiting` with a ticket and the agent calls it again with that
ticket; waiting uses `setTimeout` polling, never a synchronous sleep, and other JSON-RPC requests are not serialised
behind it. Tickets must be re-polled within the queue's `waiterTtlMs` (120 s) or they are dropped.

Later phases: phase 3 (dsh-hooks-tts) releases leases directly through the queue library without the wrapper, which is
why cleanup also runs at grant time; phase 4 wires the wrapper into the DSH server MCP configs (web and desktop, one
shared `DSH_PWQ_DIR`). A killed wrapper loses its lease through the queue's dead-pid check; a graceful exit releases
the leases and tickets it holds.