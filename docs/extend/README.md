# Plugin author kit

English | [简体中文](README.zh-CN.md)

[Documentation](../README.md) · [Choose a type by role](choose-a-plugin-type.md) · [Five-step tool tutorial](quickstart.md) · [Test your plugin](testing.md) · [Import map](imports.md)

Plugins are fully trusted code running with the user's rights. Capability declarations are reviewed at admission; they do not restrict arbitrary JavaScript or enforce a hook allowlist. `ctx.hooks.register` accepts the supported observe, transform and intercept hooks regardless of the declared `hooks` list. Use only code you intend to authorize.

[Streams and managed services](transports.md) · [Tool runtime and policies](tool-runtime.md) · [Loop events](loop-events.md) · [Business workflows](workflow-loops.md)

Choose the smallest starter that owns your behavior. All five [templates](../../templates/) are independent packages with build/test scripts and imports through public package exports. This SDK is a source preview; the quickstart includes local SDK links until public packages are distributed.

| Kind | Starter | Contribution |
| --- | --- | --- |
| Tool | [tool](../../templates/tool/) | TypeBox input/result schemas, execution signal and unload cleanup |
| Tool with panel | [tool-with-panel](../../templates/tool-with-panel/) | Shared to-do tool/store, profile services and an interactive React page |
| MCP and Skills | [mcp-skills](../../templates/mcp-skills/) | MCP definition and a packaged Skill registered through the Skills service |
| Model adapter | [model-adapter](../../templates/model-adapter/) | Structural adapter registered through `ctx.providers.register` |
| Loop | [loop](../../templates/loop/) | Official staged business workflow with confirmation and checkpoint recovery |
| Compaction engine | [sliding-window](../../examples/compaction/sliding-window/) | Context replacement through `ctx.providers.register`; see [Compaction engines](compaction-engines.md) |
| Seam provider | [Seams](seams.md) | Approval, principals, billing, checkpoint, artifacts, verifier and repair through `ctx.providers.register` |
| Child agent | [ACP child](../../examples/child-agents/acp/) | Continuable children through `childAgents`; see [Child agent providers](child-agents.md) |
| Persistence | [JSONL](../../examples/persistence/) | Full Host persistence without SQL; see [Persistence providers](persistence.md) |

Tools add operations to an existing loop. Loops own scheduling and state through [LoopContext](../../packages/extension-api/src/loop.ts) ports. Adapters translate wire protocols into the [model-adapter contract](../../packages/extension-api/src/model-adapter.ts). Panels have a separate browser lifecycle and declare slots through client descriptors.

An MCP bundle does not automatically start, install or trust an external server. Edit its definition, start the intended server and follow [MCP management](../guide/mcp.md). Skills provide instructions rather than tool implementation; see [Skills](../guide/skills.md). The adapter starter emits a deterministic development reply; replace it before real inference.

## Hook failures

The session context adapter treats `context` contributions as optional guidance. If a contributor times out, throws, or returns invalid data, its contribution is dropped for that request and `x/core/hook-failed` records the source and failure kind. Other contributors continue; the failed registration is retried on the next context refresh. Previous guidance from that contributor is dropped too. The dispatch table still rejects invalid transformations; the adapter owns this fallback. A deliberate block from the trusted bundled prompt adapter remains blocking.

Authorization directives (`before_step`, `tool_call`, `approval_request`) remain closed on failure. `before_request` also stays closed because patches can constrain output spend and deployment metadata. `before_compact` stays closed because its plan determines the history being replaced. Observation hooks and optional `tool_result` transformations retain their existing open behavior.

## Public helpers

Import these from `@agnes/plugin-runtime`:

- `defineAgnesPlugin(plugin)` preserves a Cordis function, constructor or object.
- `defineTool(def)` accepts the input-only shape, or accepts `result: TypeBoxSchema` to infer and validate successful `structured` output.
- `toolError(message)` expresses an expected business failure; errors may omit `structured`.
- `toolCancelled(signal)` throws the cancellation reason. Cancellation and unexpected faults stay exceptions.
- `defineWorkflowLoop(options)` owns staged business workflow recovery; start with the [worked example](workflow-loops.md).
- `defineLoop(factory)` and `defineModelAdapter(adapter)` preserve declarations satisfying their public contracts.

Import `defineTool` only from `@agnes/plugin-runtime`. It accepts input-only tools and optional result schemas.

A tool plugin injects `tools`; Loop and adapter plugins inject `providers`. Use `Context` from `@agnes/plugin-runtime` for these Cordis callbacks; it includes the provider service contract. `ProviderPluginContext` alone describes that service without the Cordis context. Type declarations do not install services.

Bind registrations and long-lived resources to the plugin fiber lifecycle. Bind per-call I/O to the supplied signal and release resources in `finally`. Update tool metadata for actual side effects, approvals and replay behavior. A plugin tool that does not state `replay` is `never` rerun after a crash; `replay: 'safe'` is accepted only from a read-only tool, and `idempotent` is the choice for a write that tolerates a rerun.

## Runtime adoption

A Host must supply the corresponding registration service before a loop/adapter plugin can load. Installing a package differs from selecting its loop or adapter for a session. Existing sessions and restart requirements follow the Host's integration and generation support.

Use [plugin management](../guide/packages.md) to inspect, install, trust and enable a built package. Author tests use deterministic ports and do not establish real-model behavior, remote MCP connectivity or browser rendering.

## Community examples

The [community examples](../../examples/community/) are standalone packages that
build and run their own small tests after installing preview tarballs outside
the repository, with an isolated HOME and no workspace links. Start with
[tool-panel](../../examples/community/tool-panel/) for schemas, configuration and
a tool-result client slot, or [mcp-skills](../../examples/community/mcp-skills/)
for a local stdio MCP server, resources and a packaged Skill.
[dag-loop-adapter](../../examples/community/dag-loop-adapter/) combines a
checkpointed DAG driver with a deterministic model adapter and documents the
matching new-session Loop/model selection. Their READMEs cover
installation, activation, new-session checks and cleanup.

Run `pnpm release:external-examples --keep` from a checkout
to pack the public author APIs, testkit dependencies and harness, then verify the
external author path. `--author-only` skips the harness build for a light check.
The package script uses the pinned tsx runner, as does `pnpm release:npx-smoke`.

## Local authoring

Drop a source plugin into the [local plugins folder](local-plugins.md), or [build a plugin by asking the agent](agent-built-plugins.md). Both paths use the same package states and immutable source snapshots.
[Bundles and profiles](bundles-and-profiles.md) describes reusable profile patches, presets and configuration provenance.

[Developing plugins with hot reload](hot-reload.md) covers manual reload, session pins and restart requirements.

[Schema-driven configuration UI](configuration-ui.md) · Shared settings forms, validation and controlled actions.

[Session workbench panels](workbench-panels.md) describes registered right/bottom dock contributions.

[Memory providers](memory.md) · Single selected memory with multiple knowledge sources.

## Proposals


[Purpose metadata](plugin-metadata.md) defines optional localized plugin purpose text.

[Short UI author guide](../develop/ui-author-guide.md): shared buttons, contextual panels, settings groups, surface summaries and token rules.

Register tools, Skills and providers with `ctx.tools.register(tool)`, `ctx.skills.register(skill)` and `ctx.providers.register(kind, provider)`. Declare the corresponding injection; the platform owns cleanup without an extra `ctx.effect`. Connections and subscriptions you create still need lifecycle cleanup.

Omit `ToolMeta.costHint`, `deferLoading` and `requiresApproval` for no cost estimate, initial discovery and approval inferred from `isDestructive`. Import the `readOnlyTool` / `writeTool` metadata presets from plugin-runtime: use `meta: readOnlyTool`, or spread a preset and override fields. `modelVisible: false` hides model discovery/schemas while preserving internal calls; `requiresImageInput: true` limits discovery/execution to models with native image input.

[Four-step Loop tutorial](first-loop.md) · [Application contract](applications.md) · [Acme reference application](../../examples/acme/README.md)
