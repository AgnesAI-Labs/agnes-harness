# Plugin author kit

English | [简体中文](README.zh-CN.md)

[Documentation](../README.md) · [Five-minute quickstart](quickstart.md) · [Testing](testing.md)

[Tool runtime and policies](tool-runtime.md) · [Loop events](loop-events.md)

Choose the smallest starter that owns your behavior. All five [templates](../../templates/) are independent packages with build/test scripts and imports through public package exports. This SDK is a source preview; the quickstart includes local SDK links until public packages are distributed.

| Kind | Starter | Contribution |
| --- | --- | --- |
| Tool | [tool](../../templates/tool/) | TypeBox input/result schemas, execution signal and unload cleanup |
| Tool with panel | [tool-with-panel](../../templates/tool-with-panel/) | The same tool plus a separate browser sidebar slot |
| MCP and Skills | [mcp-skills](../../templates/mcp-skills/) | MCP definition and a packaged Skill registered through the Skills service |
| Model adapter | [model-adapter](../../templates/model-adapter/) | Structural adapter registered through `modelAdapters` |
| Loop | [loop](../../templates/loop/) | Independent one-turn driver, checkpoint codec and `loops` registration |
| Compaction engine | [sliding-window](../../examples/compaction/sliding-window/) | Context replacement through `compactionEngines`; see [Compaction engines](compaction-engines.md) |
| Child agent | [ACP child](../../examples/child-agents/acp/) | Continuable children through `childAgents`; see [Child agent providers](child-agents.md) |
| Persistence | [JSONL](../../examples/persistence/) | Full Host persistence without SQL; see [Persistence providers](persistence.md) |

Tools add operations to an existing loop. Loops own scheduling and state through [LoopContext](../../packages/extension-api/src/loop.ts) ports. Adapters translate wire protocols into the [model-adapter contract](../../packages/extension-api/src/model-adapter.ts). Panels have a separate browser lifecycle and declare slots through client descriptors.

An MCP bundle does not automatically start, install or trust an external server. Edit its definition, start the intended server and follow [MCP management](../guide/mcp.md). Skills provide instructions rather than tool implementation; see [Skills](../guide/skills.md). The adapter starter emits a deterministic development reply; replace it before real inference.

## Public helpers

Import these from `@agnes/plugin-runtime`:

- `defineAgnesPlugin(plugin)` preserves a Cordis function, constructor or object.
- `defineTool(def)` preserves the legacy input-only shape, or accepts `result: TypeBoxSchema` to infer and validate successful `structured` output.
- `toolError(message)` expresses an expected business failure; errors may omit `structured`.
- `toolCancelled(signal)` throws the cancellation reason. Cancellation and unexpected faults stay exceptions.
- `defineLoop(factory)` and `defineModelAdapter(adapter)` preserve declarations satisfying their public contracts.

The original input-only `defineTool` in `@agnes/extension-api` remains compatible. Avoid importing both with the same local name.

A tool plugin injects `extension`; use `Context` for its callback. Loop and adapter callbacks use `LoopPluginContext` and `ModelAdapterPluginContext` with corresponding injections. These types describe required services; a type declaration does not install a service.

Bind registrations and long-lived resources to the plugin fiber lifecycle. Bind per-call I/O to the supplied signal and release resources in `finally`. Update tool metadata for actual side effects, approvals and replay behavior.

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
