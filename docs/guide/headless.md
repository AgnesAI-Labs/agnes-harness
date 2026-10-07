# Headless runs and model replay

English | [简体中文](headless.zh-CN.md)

[Documentation](../README.md) · [CLI reference](../reference/cli.md) · [Use a local model](local-model.md)

Run one fresh session without a TUI, browser, web listener or shared daemon:

```sh
agh run --bundle PACKAGE_ID#BUNDLE_ID --input prompt.txt --json > events.jsonl
cat prompt.txt | agh run --bundle ./bundle.json --input - --json
agh run --bundle ./bundle.json --input ./prompts --batch --json > batch.jsonl
```

`agh` means the CLI from your source build (see [installation](install.md)). The selected profile must already contain the installed, trusted plugins and model route needed by the bundle. Bundle ids come from Host's installed bundle catalog. A path is a JSON **BundleDocument**, with the same `extends`, `profile` and `presets` fields as a package's `agnes.bundles` entry. For example, a read-only patch:

```json
{ "profile": { "toolPolicy": { "readOnly": true } } }
```

The CLI sends transient profile inputs through Host composition and its normal validation. It does not save admin bundle selection. Unknown ids and missing dependencies fail before a session starts; no plugins are auto-installed. A Host without bundle composition refuses `--bundle`.

Optional run flags are `--profile`, `--preset`, `--loop ID@VERSION`, `--model primary=ROUTE/MODEL` and `--cwd`. Options go after `run`. Input is UTF-8 text, limited to 4 MiB; bundle JSON is limited to 1 MiB. `--batch` reads regular files immediately inside the folder in filename order, one session per file, without recursion or symlink traversal. Every record also carries the input path so results can be grouped by input and `runId`. Permission requests are rejected in unattended runs; configure an appropriate backend policy before running.

The exit code is 0 for completed runs, 1 for errors or incomplete event drains, 2 for usage/startup failures, 3 for parked, 4 for blocked/budget, 5 for max steps, and 130/143/129 for SIGINT/SIGTERM/SIGHUP. Batch continues after an individual failure and returns the first nonzero status. A signal cancels the current prompt and stops the batch; shutdown has a five-second grace period.

## SDK

Use the public `@agnes/sdk` helper against a client connected to the profile/bundle you assembled through Host. The caller owns client boot, workspace admission and `client.close()`; the helper owns a fresh session, subscription, permission refusal and detach.

```ts
import { runHeadless } from '@agnes/sdk'

await client.workspace.add(cwd)
try {
  const result = await runHeadless(client, {
    cwd,
    input: 'Explain the result.',
    signal: controller.signal,
    write: async (record) => output.write(JSON.stringify(record) + '\n'),
  })
  if (result.reason !== 'completed' || !result.eventsComplete) throw new Error('run failed')
} finally {
  await client.close()
}
```

`write` is awaited in stream order. Supply a Promise that resolves after your sink accepts the record; a rejected write cancels the turn and rejects the run. `preset`, `loop`, `model` and `runId` are optional. `drainMs` defaults to 1000: if terminal ledger notifications do not arrive within that bound after the RPC settles, the result declares `eventsComplete: false`.

## JSONL schema v1

The public TypeScript contract is [`HeadlessRecord`](../../packages/sdk/src/headless.ts). Every session record has `schemaVersion: 1`, `runId`, `sessionId` and one of these `type` values:

| Type | Payload |
| --- | --- |
| `start` | Fresh session identity |
| `event` | `event`: the original durable `LedgerEvent`, including `seq`, `ts`, `type`, `data`, optional lane and SDK `_meta`; its payload follows the existing session-v1 protocol |
| `turn-metrics` | `metrics`: `turn`, `lane` (string or null), `reason`, `durationMs` (number or null), `toolCalls`, `tokens` (object or null), `usageRecords` |
| `result` | `reason`, `lastSeq`, `eventsComplete`, optional `error`; `reason` is a protocol turn-end reason or `failed` |

The CLI adds `input` to each row. Failures before the SDK can produce a session result emit an `error` row with `schemaVersion`, `runId`, `input`, `error`, and no invented session id. Command-level startup/usage failures go to stderr with a nonzero exit code.

Metrics cover each lane between its observed `turn/start` and `turn/end`. Duration is the nonnegative difference between ledger timestamps, not adapter playback timing. Tool calls count `tool/call` rows. Tokens sum observed non-adjustment `cost/ledger` rows for that lane/turn, including inference and compaction. Token fields are `input`, `output`, `cacheRead`, `cacheWrite`, `reasoning`; `usageRecords` counts included rows. No usage gives `tokens: null`. Late/background rows after the turn closes remain in the event stream and are not retroactively added to its summary. Child-session costs are available in raw `subagent/cost` rows, not automatically included. Text previews are not durable events and are excluded.

## Record, replay and teach

The optional [`@agnes/model-adapters`](../../packages/model-adapters/README.md) plugin registers `local-openai`, `replay` and `scripted` using `defineModelAdapter`. Recording wraps the **model adapter boundary**, preserving text/thinking deltas, tool calls, media, usage and terminal events. It does not reconstruct replies from UI previews.

For an existing adapter instance:

```ts
import { recordModelResponses } from '@agnes/model-adapters'
const recording = await recordModelResponses(instance, '/absolute/responses.jsonl')
// Use recording in place of instance; await recording.dispose() when done.
```

For a local-compatible route, set `compat.recordFile` as described in [local models](local-model.md). The file is created exclusively with permission 0600; an existing file is never overwritten. JSONL rows carry `schemaVersion: 1`, `sessionKey`, invocation `index`, `request`, raw adapter `events`, and `complete`. Prompts and model content may be sensitive; adapter credentials and auth headers are not recorded. An interrupted invocation writes `complete: false`, which replay refuses. Files are bounded to 64 MiB on read.

Choose `api: replay` and `compat: { file: /absolute/responses.jsonl }` in a configured model route. Keep the model's normal context and tool declarations. Default `match: strict` compares kind, slot, system, messages, tools and sampling; it ignores route/model ids, session id and derived hash. Use explicit `match: sequence` to feed identical replies to changed loops or compaction prompts. This measures those strategies against fixed replies, not whether a live model would produce those replies for changed context. Exhaustion, mismatch and concurrent calls return non-retryable model errors. There is no live-model fallback or latency simulation.

A transcript contains one model route. Each new session starts at reply zero; if the recording has several sessions, set `compat.recordedSession`. Auxiliary calls on that route are part of invocation order. Other routes need their own recordings.

For teaching, use `api: scripted` with `compat.file` pointing to a JSON document:

```json
{
  "schemaVersion": 1,
  "replies": [[
    { "type": "text_delta", "delta": "Hello, class." },
    { "type": "usage", "tokens": { "input": 1, "output": 3, "cacheRead": 0, "cacheWrite": 0 }, "creditSource": "estimated" },
    { "type": "done", "reason": "stop" }
  ]]
}
```

The lesson author supplies usage explicitly, labeled `estimated`. Successful replies require one usage event and one terminal `done`; errors may end with `error` instead. This adapter is part of the runtime package and does not import testkit.
