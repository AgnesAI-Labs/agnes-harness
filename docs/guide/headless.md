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

Optional run flags are `--profile`, `--preset`, `--permission LEVEL` (`read-only`, `workspace-write`, `full-access` or `default`; see [permissions and presets](security.md#permissions-and-presets)), `--loop ID@VERSION`, `--model primary=ROUTE/MODEL` and `--cwd`. Options go after `run`. Input is UTF-8 text, limited to 4 MiB; bundle JSON is limited to 1 MiB. `--batch` reads regular files immediately inside the folder in filename order, one session per file, without recursion or symlink traversal. Every record also carries the input path so results can be grouped by input and `runId`. Full-access permission requests are allowed automatically; other permissions retain unattended refusal when no approval handler is available.

The exit code is 0 for completed runs, 1 for errors or incomplete event drains, 2 for usage/startup failures, 3 for parked, 4 for blocked/budget, 5 for max steps, and 130/143/129 for SIGINT/SIGTERM/SIGHUP. Batch continues after an individual failure and returns the first nonzero status. A signal cancels the current prompt and stops the batch; shutdown has a five-second grace period.

Schedules and webhook sessions use their effective permission level. Full access automatically allows and records permission requests before unattended handoff/refusal policy, so no approval prompt parks the run. Other permission levels retain their unattended policy. Explicitly chosen plan/read-only modes retain their behavior.

## Unattended turns

`agh run`, `runHeadless` and `agh -p` (every `--mode`) send their prompt as unattended (`session.prompt(input, { unattended: true })` in the SDK): nobody can answer a question before the run ends. The turn that prompt opens offers the model no tool that waits on or addresses a person who is present (`ToolMeta.requiresUser`): `ask_user_question` and the UI surface tools `ui_render`, `ui_update`, `ui_close` and `ui_guide` are left out of its schemas and discovery, and a call to one is refused as an unknown tool. The model also receives a context note saying that the run is unattended and that it should finish the task on its own judgment and state its assumptions in the final reply. The system prompt is unchanged. The flag belongs to the one prompt: the next turn in the same session, for example after `agh --resume ID` in the TUI or in the Web, is attended again and has every tool back, and its note says the earlier one no longer applies. Approvals are a separate matter: with full access none are asked, and under other levels a one-shot run with no approval handler refuses or parks as described above; it does not wait silently. A daemon that predates the flag ignores it.

The same holds for the work such a turn delegates: a sub-agent or child session opened from an unattended turn (through the child-agent tools, a workflow or a role delegation) is unattended too, so it cannot ask a person either. A child opened from an attended turn keeps every tool as before.

Background jobs that such a turn started outlive its answer, and nobody is there to stop them. So when the turn is about to finish with jobs it started still running (`shell` jobs and terminals), the model is shown each one, by job ID and command, once, before the turn may end: it stops with `job_kill` those the task does not need and leaves running what the task asks to stay up, such as a server. Nothing is stopped automatically, because a job does not say whether it is such a server. Plugin hooks see the same fact as `HookContext.unattended`; the built-in browser, for example, does not repeat its "failed" or "off" note into an unattended turn, since nobody can re-enable it there.

A schedule or webhook trigger whose unattended policy is **Refuse** (`--unattended refuse`) declares that nobody will answer, so its turns are unattended in the same way. Under the default **Hand off and notify** the owner can answer later in the Web or a bound channel, so those turns stay attended and keep `ask_user_question` and the UI surface tools.

## Turn limits

When a prompt carries a limit of its own, the model is told about the turn's limits in a context note, so it can plan to finish inside them. A prompt's limits are a wall-clock time limit (`agh -p --timeout`, `session.prompt(input, { timeLimitMs })`), a step cap (`--max-turns`, `maxSteps`) and a credit limit (`--max-budget`, `creditLimit`); once one is set, the note reports the effective step ceiling, which includes the preset's `budget.max_steps`. The first request of the turn states every limit that is set, with the deadline as a UTC time. When about 50%, 75% and 90% of the limit nearest its end has been used, the note is replaced once each with how much of it remains and an instruction to put the core requirement in place and verify it, then to finish, then to wrap up with a short summary. With a time limit, every request also ends with a short `[turn time]` note giving the time measured when that request was assembled: how much of the limit is used and how much is left, to the nearest 10 seconds, and that this figure replaces any earlier one, so the model does not conclude from its own estimate that the time is up. Because it is the newest message of the request, it is framed as harness context in a `<system-reminder>` block that says it is not a message from the user, so the model does not answer it as the user's latest turn. The note belongs to that request only and is never written to the conversation, so a long turn does not collect one stale figure per request in its history. The provider adapter keeps its prompt-cache breakpoint on the conversation before the note, so the cached prefix stays intact. A recovered turn reads its deadline back from the ledger and measures against it at its next request. A later turn without a time limit carries no such note. A foreground `shell` command, or a `job_output` wait, in such a turn also stops before the deadline (see [default tools](../reference/default-tools.md)). The notes depend only on time, steps and credits. The limit notes are live context notes: the system prompt and its cache are unchanged, and a recovered turn rebuilds its limits from the ledger (`x/core/turn-time-limit`, `x/core/turn-step-cap`) without repeating a note it already sent. A turn whose prompt sets none of these limits, such as an ordinary interactive turn, gets no note (a preset's step ceiling alone adds none), and the next such turn clears an earlier note. Core does not stop a turn at its time limit: the client that set it cancels the turn at the deadline, as `agh -p` does. These Core notes are in English; each one that asks the model to do or write something (the limit and time notes, a progress check, the unattended-run and child-receipt notes) ends with a line naming the language of the turn's prompt, for example `The user writes in English; keep working and replying in English.`, so answering a note does not switch the model's working language. The language is read from the prompt's script alone (Chinese, Japanese, Korean or English, with code skipped); when the prompt is empty, mixed or in another language, the line is `Keep working and replying in the language the user and the task use.`

### Progress checks

Progress checks are off by default. A preset turns them on with `loop: { progress_check_steps: N }` (a positive N; absent or 0 means off). Once on, a turn that runs unattended or under a prompt limit (time, steps or credits) is asked now and then to review its progress, so a model that is going in circles notices it. Before its next action the model gets a `[progress check]` note asking for three short lines: the check that proves the request is done and whether it passes now, what changed in that result since the last check, and a decision to FINISH, CONTINUE (with the next concrete step) or SWITCH to a more direct approach, with the reason. A check is due every N model steps, or earlier, at least three steps after the last one, when the official write tool has created 8 new files, 5 tool results in a row have failed, or the loop-hygiene step check has seen the same change repeated or replies that bring no new results; in such a turn that check reads the turn's last few steps. Triggers are ledger facts only, never the model's wording. A check never ends the turn or blocks a tool call. It is never sent once the time-limit note has reached its wrap-up, and a recovered turn finds the checks it already sent in the ledger and does not repeat them. Ordinary interactive turns get none.

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

`write` is awaited in stream order. Supply a Promise that resolves after your sink accepts the record; a rejected write cancels the turn and rejects the run. `preset`, `permission`, `loop`, `model` and `runId` are optional. `drainMs` defaults to 1000: if terminal ledger notifications do not arrive within that bound after the RPC settles, the result declares `eventsComplete: false`.

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

Choose `api: replay` and `compat: { file: /absolute/responses.jsonl }` in a configured model route. Keep the model's normal context and tool declarations. Default `match: strict` compares kind, slot, system, messages, tools and sampling; it ignores route/model ids, session id and derived hash. Use explicit `match: sequence` to feed identical replies to changed loops or compaction prompts. This measures those strategies against fixed replies, not whether a live model would produce those replies for changed context. Exhaustion, mismatch and concurrent calls return non-retryable model errors. There is no live-model fallback or latency simulation. Replay reproduces model responses; tools and other effects still execute through their normal backend policies. Whole-session comparisons need controlled workspaces and fixtures for those effects.

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
