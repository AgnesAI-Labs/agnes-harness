# Compaction engines

English | [简体中文](compaction-engines.zh-CN.md)

[Author kit](README.md) · [Testing](testing.md) · [Plugin management](../guide/packages.md)

An engine chooses when to compact and how to replace older conversation context. The default engine preserves AGH's existing summary planner, warm-cache deferral, overflow recovery, summary retries, usage accounting and elision fallback. Fixed system sections remain outside every replacement range.

## Register an engine

Implement [CompactionEngine](../../packages/extension-api/src/compaction-engine.ts) through public package exports. Its `create()` returns an instance with `shouldCompact(budget)` and asynchronous `compact(input, { signal, model })`. Register it from an ordinary Cordis plugin that injects `compactionEngines`:

```ts
import type { CompactionEnginePluginContext } from '@agnes/extension-api'
import { defineAgnesPlugin, type Context } from '@agnes/plugin-runtime'

export const main = defineAgnesPlugin({
  inject: ['compactionEngines'],
  apply(ctx: Context & CompactionEnginePluginContext) {
    ctx.compactionEngines.register(engine)
  },
})
```

Here `engine` is your implementation. Declare `main` and the same injection in `package.json`'s `agnes.plugins`. Registrations belong to the plugin fiber; duplicate ids are refused, unloading removes catalog entries and aborts pending engine operations. Bind other resources to the plugin's effects. `catalog()` exposes id, version and source package; Host also exposes `Assembled.compactionEngineCatalog()`.

`input.conversation` contains the visible nodes, turn numbers, pin flags, estimated tokens and event payloads. Masked ledger rows are excluded. `input.system` is the fixed system text; it cannot be replaced. The budget includes the live reserve and retained-token target. `input.beforeCompact` preserves the existing planner vocabulary, including the trigger reason and manual instructions.

Return `null` when no safe reduction exists, `{ kind: 'replacement', range: [startSeq, endSeq], text, mode: 'summary' | 'elision' }` for a completed replacement, or `{ kind: 'plan', plan }` to use Core's existing summary executor. The `before_compact` hook still takes precedence over an engine for that attempt.

Core refuses ranges that cross pins, split tool calls/results, remove the entire conversation, or produce text that is not smaller than the replaced span. It commits the replacement and compaction events together, retaining original ledger rows and the existing fork projection behavior. Pass cancellation signals to asynchronous work and check cancellation before returning.

For your own summary policy, call `model.summarize({ range, system, instruction, maxTokens }, optionalSignal)`. Core derives the safe summary request, uses the session's compaction model slot, checks its window, reserves tree budget, retries a reasoning cutoff once and records actual usage even when the engine later refuses a replacement. Errors and cancellation propagate to the compaction failure path. Returning a plan additionally uses the default executor's classified failure/backoff and elision policy.

## Select an engine

Install and enable the engine package through [plugin management](../guide/packages.md), then select its registered id in the runtime profile:

```json
{ "compaction": { "engine": "sliding-window" } }
```

Omitting this field selects `default`. An explicit missing id fails Host startup with `compaction engine is not registered: <id>`. Selection happens during Host assembly; reassemble after changing it. Existing preset controls such as `compaction.enabled`, reserve size and agent-callable compaction continue to apply.

Custom loops use the same selected engine through `await ctx.compaction?.run(signal)` at an accepted-input step boundary. This port is present only when a runnable engine is available; custom loops decide when to invoke it.

## Try sliding-window

The independent [sliding-window example](../../examples/compaction/sliding-window/) retains the last N turns, keeps pinned system context and makes no model call. Its default is four turns; set its plugin row config to `{ "keepTurns": 2 }` to change retention. It conservatively retains extra context around conversation pins and tool/result boundaries. Elided facts remain in the ledger but leave future model requests.

The package has standalone build/test scripts and no workspace imports. For this source preview, build the SDK declarations, copy the example outside the workspace, and use the same [local linking workflow](quickstart.md) before building/testing it. Its small test supplies a model port that throws if called.
