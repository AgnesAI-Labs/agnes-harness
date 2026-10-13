# Extension API

## Agent loops

A `LoopFactory` identifies a loop by `id` and `version`, declares `capabilities`,
and creates or resumes a session-owned `LoopDriver`. Inject `providers` and register
with `ctx.providers.register(loopKind, factory)`. The platform owns cleanup.
`ctx.providers.catalog()` returns installed identities,
capabilities and source packages for administration. New sessions select an exact
identity through `Kernel.session(key, { ...options, loop: { id, version } })`.
For a profile default, set `providers.loop: { provider, version }` in the profile
entry  An assembled `PresetView.loop` overrides the Kernel default; an explicit
session choice overrides the preset. Existing sessions keep their persisted identity. Legacy sessions use
`agnes.default@1.0.0`. A missing pinned loop is an error.

Factories may return a driver or Promise and receive an optional construction signal.
Always await create/resume; cancellation is cooperative and owners drain late results.
The driver implements `step(signal)`, `cancel()`, `dispose()` and `checkpoint()`.
Each step returns an explicit `running`, `idle`, `turn-ended` or `parked` outcome;
`phase` is display metadata. `LoopContext` provides high-level recoverable operations
and low-level turn views, request preparation/estimation, model streaming/completion,
approved single/batch tool execution, effect receipts, typed events, child/job ports,
checkpoints and durable park/wake. Core retains the Session facade and owns execution,
approvals, ledger ordering and lifecycle; the driver chooses what to do next.
See the bilingual [v0.1 contract inventory](../../docs/develop/contracts-v0.1.md)
for stability labels, operation semantics, restart scopes and remaining freeze gates.

Checkpoints contain JSON `state` and a `codecVersion`. The factory owns its codec
and must validate it before resuming. `loopCheckpointCodec(version, parse)` clones
state and rejects mismatched versions; `parse` validates the loop-specific state.
Persist progress through `ctx.checkpoints.write(driver.checkpoint())` at a safe
boundary. A codec upgrade needs an explicit migration rather than silent reset.

## Persistence contracts

Persistence providers use `ChildControlStore` and its child identity, budget and
workspace records from this package. Core re-exports the same types for existing
consumers; the durable data format and store methods are unchanged.

Author tests use `@agnes/host/author-testkit`; see the [import map](../../docs/extend/imports.md).
Specialist contract tests use `@agnes/extension-api/testkit` with Node's test runner.
Vitest persistence suites are available separately from
`@agnes/extension-api/testkit/persistence-contract`.
