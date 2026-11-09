# dsh-playwright-queue

Queue core for serialising visual-test sessions (one CMS, one Playwright at a time).
Several OS processes (for example the web and desktop DSH servers, each with a wrapper MCP server) share a
file-based FIFO lease. This package is the queue only: no MCP server, proxy or hooks yet.

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
