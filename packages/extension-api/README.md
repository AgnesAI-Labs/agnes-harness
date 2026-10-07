# Extension API

## Agent loops

A `LoopFactory` identifies a loop by `id` and `version`, declares `capabilities`,
and creates or resumes a session-owned `LoopDriver`. Register it with the Cordis
`loops` service using `register(sourcePackage, factory)`; dispose the returned
callback when the plugin unloads. A plugin can use
`registerLoopPlugin(ctx, sourcePackage, factory)` to attach that cleanup to Cordis
automatically; declare an injection of `loops`. `catalog()` returns installed identities,
capabilities and source packages for administration. New sessions select an exact
identity through `Kernel.session(key, { ...options, loop: { id, version } })`.
For a profile default, set `config.loop: { id, version }` on one enabled package
entry. An assembled `PresetView.loop` overrides the Kernel default; an explicit
session choice overrides the preset. Existing sessions keep their persisted identity. Legacy sessions use
`agnes.default@1.0.0`. A missing pinned loop is an error.

The driver implements `step(signal)`, `cancel()`, `dispose()` and `checkpoint()`.
Each step returns a phase name and optionally a terminal reason. It receives a
small `LoopContext`: model streaming/completion with multimodal `RequestBody`,
approved single/batch tool execution, input acceptance, event emission and turn
completion, checkpoint storage, and park/wake. Compaction and children are
optional ports. Core retains the Session facade and owns execution, approvals,
ledger ordering and lifecycle; the driver chooses what to do next.

Checkpoints contain JSON `state` and a `codecVersion`. The factory owns its codec
and must validate it before resuming. `loopCheckpointCodec(version, parse)` clones
state and rejects mismatched versions; `parse` validates the loop-specific state.
Persist progress through `ctx.checkpoints.write(driver.checkpoint())` at a safe
boundary. A codec upgrade needs an explicit migration rather than silent reset.

## Persistence contracts

Persistence providers use `ChildControlStore` and its child identity, budget and
workspace records from this package. Core re-exports the same types for existing
consumers; the durable data format and store methods are unchanged.

The general `@agnes/extension-api/testkit` and
`@agnes/plugin-runtime/testkit` entries work with Node's test runner.
Vitest persistence suites are available separately from
`@agnes/extension-api/testkit/persistence-contract`.
