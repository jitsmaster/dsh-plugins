# Claude session token chart (Hooks and Usage page)

One chart under the five-hour and weekly bars, showing token usage of the **current Claude plan session window** (the five-hour window of the saved Claude reading), per 5-minute bucket, from DSH sessions that run on the Claude Code provider.

## Decisions (user-approved 2026-10-29)

| Topic | Decision |
| --- | --- |
| Lines | Six, each its own colour: Cache read, Context, Cache write, Fresh input, Output, Reasoning, plus a text line "Input mix" with the shares of the prompt. "Tool calls token" is left out (the API reports no such figure). Changed 2026-10-30 (user): the earlier All and Input lines overlapped (output is about 0.5% of input, and Input already contains the cache traffic), so they could not show what the prompt is made of. |
| Input (prompt) | fresh input + cache read + cache write, shown split: Fresh input = `inputTokens` (what was actually new this step), Cache read, Cache write. Shares over the window are printed under the chart ("Input mix"). |
| Output / Reasoning | `outputTokens` / `reasoningTokens` as reported. |
| Context | Prompt size of a request (`inputTokens + cacheReadTokens + cacheWriteTokens`) = how full the context was. Per bucket the **largest** value over all counted sessions. A level, not a rate: drawn on a right-hand axis; the flow lines use left axes (All and Input share one, Output and Reasoning have their own, see Client drawing). |
| Shape | Per-interval (not cumulative), bucket = 5 minutes. |
| Window | `resetsAt - 5h` .. `resetsAt` of the `session` limit in the Claude reading. No current window (reading missing or expired) = no chart, a note instead. After a reset the chart starts fresh because the window moves. |
| Sessions counted | Only sessions whose assistant message `source.provider` is a Claude Code provider id: `claude-code` by default, config `claudeProviderIds` (array) overrides. DeepSeek and other providers are excluded. The chart is labelled "DSH sessions only". |
| History | None. The chart starts empty and fills going forward. No backfill. |
| Placement | `UsagePage` in `lib/client.js`, directly under the limit bars and above the local-tokens line. |

## Data capture

`ctx.on('session/event', (session, event) => ...)` in `status.js`. For `event.type === 'assistant/message'` with `event.data.usage` and `event.data.message.source.provider` in the Claude provider ids, add one observation: time = `event.time` when a finite number, else `Date.now()`. `assistant/attempt` events carry no usage and are ignored (a retried attempt that billed tokens is therefore not counted; accepted). The existing `tokenUsage` projection has no reasoning bucket, which is why the events are read directly.

Observations go into 5-minute buckets keyed by the bucket start (epoch ms, floored to a multiple of 300000):

```
{ t, input, output, reasoning, ctx, fresh, cacheRead, cacheWrite }   // input = fresh + cacheRead + cacheWrite; ctx = max prompt size seen in the bucket, 0 when none
```

Buckets older than 6 hours are dropped. They persist in `<stateDir>/usage-buckets.json` as `{ v: 1, buckets: [...] }`, written from the existing `sample()` tick only when something changed (never per event), and loaded at start. A missing, corrupt or wrong-version file starts empty.

## Snapshot

`snapshot.claudeChart`:

```
{
  enabled: boolean,                 // false when claudeUsage is false
  window: { start, end } | null,    // ISO strings
  bucketMs: 300000,
  points: [ { t, all, input, output, reasoning, fresh, cacheRead, cacheWrite, context } ],   // t ISO; one per bucket from window start to min(now, end)
  note: string | null               // e.g. 'no current Claude session window'
}
```

`context` is `null` for a bucket with no observation (the client breaks the line); the flow values (`all`, `input`, `output`, `reasoning`, `fresh`, `cacheRead`, `cacheWrite`) are 0. `all` and `input` stay in the snapshot but the client no longer draws them. At most 61 points. Recomputed on every `sample()`.

## Modules

- `dsh-hooks-tts/usage-chart.js` (new, pure, no I/O except two small load/save helpers taking a path): `BUCKET_MS`, `RETAIN_MS`, `bucketStart(ms)`, `isClaudeProvider(provider, ids)`, `addObservation(buckets, { at, usage }, now)` (mutates and prunes, ignores unusable usage), `chartFor(buckets, windowEndMs | undefined, now)` (returns the snapshot object), `loadBuckets(path, now)`, `saveBuckets(path, buckets)`.

Input limits (hardening): `addObservation` ignores an observation dated later than `now + 5 min` or earlier than `now - 6 h`, and any usage with a count field above 1e9. At most 100 buckets are kept (oldest dropped). `loadBuckets` drops buckets outside `[now - 6 h, now + 5 min]` or with a value above 1e12, keeps only the keys `t, input, output, reasoning, ctx, fresh, cacheRead, cacheWrite` (buckets saved before the split had no `fresh`, `cacheRead`, `cacheWrite`: they load as 0; a present split value that is negative or above 1e12 drops the bucket), sorts by time and applies the same 100-bucket cap.
- `status.js`: wiring only. Creates the buckets, registers the `session/event` listener, includes `claudeChart` in the snapshot, saves in `sample()` when dirty.
- `lib/client.js`: `ClaudeChart` component, inline SVG, pure helper `chartModel(chart, width, height)` exported through `exports.__test`.

## Client drawing

Inline SVG (no chart library), width 100% of the 520px page column. Two stacked panels, each with its own scale, because cache read is about a thousand times larger than the other series (on one shared axis they sat flat on the baseline). Main panel (viewBox 480x180): Cache read on the left axis (0..max, nice rounded top, labelled with `fmt`), Context on the right axis (0..max context). Second panel (viewBox 480x110, captioned "Small parts of the prompt, and output (own scale)"): Cache write, Fresh input, Output and Reasoning on their own left axis, no right axis. Under the chart a text line "Input mix: cache read X% · cache write Y% · fresh input Z%" gives the shares of the prompt over the window (`inputMix(chart)`, shown only when there is input; a share that rounds to 0.0% shows as "<0.1%"). `chartModel(chart, width, height, panel)` takes the panel (`{ flows, context }`), default the main one. X axis: window start to window end, labelled with local `h:mm` times at start, middle, end. One polyline per series. Colours: Cache read `#3b82f6`, Context `#f59e0b`, Cache write `#8b5cf6`, Fresh input `#14b8a6`, Output `#22c55e`, Reasoning `#ec4899`. Context is drawn dashed so it reads as the other axis. A legend with a colour swatch per line sits under the chart, with the "(right axis)" hint on Context. Heading "Tokens this session window" and a caption "DSH sessions only, per 5 min". When `window` is null or `enabled` is false, show only the note, no SVG. The first bucket starts at `bucketStart(window start)`, which can precede the window start by up to 5 minutes, so `chartModel` clamps every x to the plot area (`plot.x` .. `plot.x + plot.w`); the data is unchanged. A series with a single point is drawn as a two-point line (the point duplicated) so it still renders.

On shutdown (abort signal) the status service saves the buckets once if any are unsaved, best-effort, so at most the buckets since the last sample are never lost.

## Tests

- `test/usage-chart.test.mjs`: bucketing, provider filter, reasoning kept out of All, context max, pruning, window slicing, null context gaps, persistence round trip and corrupt file.
- `test/usage-chart-status.test.mjs`: status service wiring with a fake `ctx` (assistant/message from a Claude provider counts, other provider and attempt events do not, snapshot has `claudeChart`, `claudeUsage:false` disables).
- `test/usage-chart-client.test.mjs`: `chartModel` geometry and series colours, legend entries, empty/no-window states, loaded through the same `vm` pattern as `sidebar-style.test.mjs`.

README: add `usage-buckets.json` to Files and state, `claudeProviderIds` to the config table.
