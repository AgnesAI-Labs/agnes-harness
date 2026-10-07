# Test a plugin without a paid model

English | [简体中文](testing.zh-CN.md)

[Author kit](README.md) · [Quickstart](quickstart.md)

Generated packages use Node's test runner: run `npm run build`, then `npm test`. These helpers are exported from `@agnes/plugin-runtime/testkit`; tool registration tests also need matching `@agnes/host`.

## Tools through real registration

```js
import { createPluginTestHost } from '@agnes/plugin-runtime/testkit'
import { main } from './dist/index.js'

const host = await createPluginTestHost(main)
try {
  console.log((await host.invoke('plugin_hello_tool', { message: 'hello' })).structured)
} finally {
  await host.dispose()
}
```

This mounts a verified third-party row, invokes the production Host `ctx.extension()` registration bridge, validates arguments and calls the registered tool. Unloading releases the row, registrations and plugin effects. Duplicate registration and loading failures reject creation.

I/O defaults to refusal. Supply `context` with explicit fake filesystem/network ports when needed. `invoke(name, args, signal)` supports cancellation; disposal aborts active call signals, which tools must cooperate with. These helpers do not implement session approvals, replay, ledger persistence or OS sandboxing. Hook registration can be checked, but hook dispatch is not simulated.

## Scripted loop replies

```js
import { driveLoop } from '@agnes/plugin-runtime/testkit'
import { loop } from './dist/index.js'

const result = await driveLoop(loop, {
  inputs: [{ content: [{ type: 'text', text: 'hello' }] }],
  replies: [[
    { type: 'text_delta', delta: 'Hello!' },
    { type: 'done', reason: 'stop' },
  ]],
})
console.log(result.events, result.checkpoint)
```

`driveLoop` creates or resumes the actual driver, captures model requests/events and disposes it on completion or failure. Pass `checkpoint` to test resume and unsupported codec versions. It uses the production `loopShouldStop` outcome rule with `until` (default `turn-end`); `phase`, reason alone and `events.finish` alone do not stop the driver. Unfinished loops exceeding `maxSteps` (default 20) and exhausted model scripts fail.

Supply `tools.execute` through a plugin test host's `invoke` to exercise tools; the default fake batch delegates to individual executions. The [loop test](../../packages/plugin-runtime/testkit/loop.test.ts) drives scripted model replies into a real Host-registered tool. Missing tool ports refuse execution. A `parked` outcome stops scheduling; the fake wait returns for queued input or cancellation and its wake is a no-op. Supply a real Core `context` for durable waits, approvals, ledger operations and recovery; see the [v0.1 contract inventory](../develop/contracts-v0.1.md).

`scriptedModel(replies)` is available separately for your scheduler. Its `requests` and `remaining` expose missing or extra model interactions.

## Adapter instances

`runModelAdapter(adapter, { config, route, request, signal })` creates an actual instance, captures stream events and route/model catalogs, and disposes it in `finally`. `mode: 'complete'` uses the optional complete method and refuses if absent. Registration-wide `cleanup` remains owned by the registration service, rather than running per request.

The [adapter starter test](../../templates/model-adapter/test/adapter.test.mjs) uses `fakeModel`/`fakeRequest` from `@agnes/ai/testkit` without network I/O. Add provider-specific request/response fixtures when replacing its deterministic reply. Check cancellation, errors and disposal.

## Verification scope

Extend the nearest test when behavior changes. Cover valid input, schema errors, business refusal, cancellation, cleanup and resume as applicable. The panel test checks descriptor/slot/render behavior; browser mounting needs separate verification. MCP bundle tests check packaged assets and Skill registration; real server connectivity needs separate verification.

Author test success establishes contracts with deterministic dependencies. It does not prove compatibility with real providers, browsers, MCP servers or OS sandboxes.


## Provider conformance against Host

`@agnes/extension-api/testkit` and `@agnes/plugin-runtime/testkit` export `loopConformance`, `modelAdapterConformance`, `compactionConformance`, `toolRuntimeConformance`, `toolPolicyConformance`, `persistenceConformance`, `sandboxConformance` and `childAgentConformance`. `runProviderConformance(kind, options)` is their common runner.

Capture `ctx.providers` inside an isolated ordinary Host plugin. Pass that port, the owner package name, a fresh provider declaration and `open(provider)`. The probe uses the Host's public service/session path and returns `start(signal)`, `close()` and, for loop/persistence, `coldResume()`. Each started operation returns `{ ready, result }`: `ready` settles once the controlled operation reaches the provider, and `result` settles after it drains. If the native API returns a cancelled outcome instead of rejecting with AbortError, supply `isCancelledResult(result)` to validate that outcome. The suite refuses unload that returns before the admitted operation settles.

The [Host conformance test](../../packages/host/test/assemble/provider-conformance.test.ts) demonstrates the model/compaction/runtime/policy suites with real assembly and registration. The [owned-resource probes](../../packages/host/test/assemble/provider-owned-conformance.test.ts) cover loop, persistence, sandbox and child-agent, including fresh Host assemblies for loop and persistence cold resume. Together they exercise all eight kinds against Host.

Persistence store operations have no `AbortSignal` parameter. A persistence probe may declare `cancellation: 'unsupported'`; the suite reports `cancel-unsupported` rather than claiming cancellation was verified. Its admitted calls must still drain on unload. Use `unloadStarted()` to release a controlled non-cancellable call after unregister starts, and assert that the store remains open until that call finishes. Other kinds must pass the cancellation check. A loop probe can use public `Session.step()` to observe the admitted driver call, then `Session.run()` in its cold-resume probe to verify the resumed turn and persisted checkpoint.

These suites check the lifecycle contract; use provider-specific observable assertions in cold-resume probes and separate generation tests for publication or upgrades.

The optional Vitest persistence suites are exported separately from `@agnes/extension-api/testkit/persistence-contract`. The general testkit can be imported by Node's test runner without Vitest.
