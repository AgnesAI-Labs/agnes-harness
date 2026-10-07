# Child agent providers

English | [简体中文](child-agents.zh-CN.md)

[Author kit](README.md) · [Testing](testing.md) · [Plugin management](../guide/packages.md)

A child agent provider starts work on behalf of a parent session and returns a handle. The handle exposes events, a follow-up message, an interrupt, and a terminal result. The built-in provider id is `in-process`. It is the same child session that `subagent_fork` and `subagent_spawn` already use. A second provider, `acp`, runs an external process that speaks newline-delimited ACP.

## Contract

Implement [ChildAgentProvider](../../packages/extension-api/src/child-agent.ts) through public package exports. `start(task, options)` returns a [ChildAgentHandle](../../packages/extension-api/src/child-agent.ts).

`options` carries the parent `sessionKey`, an `AbortSignal`, and optional `cwd`, `model`, `isolation`, `budget`, `fork`, `toolFilter`, and `generation`. `sendMessage` resolves when the message is accepted, not when the child answers. `interrupt` stops the current turn and leaves a continuable child open. `result` settles when the child reaches a terminal state. `dispose` releases the child.

Capabilities are `continuable`, `interrupt`, `modelSelection`, `inheritsParentContext`, and `worktree`, plus optional `budget` and `toolFilter` flags. An omitted optional flag means unsupported. A `false` flag is refused at start. Do not accept an option and ignore it.

| Provider | continuable | interrupt | modelSelection | inheritsParentContext | worktree | budget | toolFilter |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `in-process` | yes | yes | yes | yes | no | yes | yes |
| `acp` | yes | yes | no | no | no | no | no |
| `codex` | no | yes | no | no | no | no | no |
| `claude-code` | no | yes | no | no | no | no | no |
| `sdk` | no | yes | no | no | no | no | no |

The direct in-process provider refuses worktree isolation because it does not prepare git worktrees. The official fork/spawn tools prepare a worktree before resuming their deferred child; creation failure cancels that child and returns an error. Request `isolation: shared` explicitly to share the working directory.

## Register a provider

The host defines the `child-agent` kind with `defineProviderKind`. `childAgents` is the typed facade over that registry. Register from an ordinary Cordis plugin that injects `childAgents`:

```ts
import type { ChildAgentPluginContext } from '@agnes/extension-api'
import { defineAgnesPlugin, type Context } from '@agnes/plugin-runtime'

export const main = defineAgnesPlugin({
  inject: ['childAgents'],
  apply(ctx: Context & ChildAgentPluginContext) {
    ctx.childAgents.register(provider)
  },
})
```

The same provider can be registered through the shared entry point:

```ts
ctx.providers.register('child-agent', '@example/agents', provider)
```

Declare `main` and the same injection in `package.json`'s `agnes.plugins`. Duplicate ids are refused. Unloading the plugin removes the catalog entry and aborts and joins starts, then awaits disposal of handles started through the service. The unregister function returns an idempotent Promise and propagates cleanup failures. `catalog()` exposes id, version, source package, and capabilities. `ctx.providers.catalog()` lists the same provider with the capability names that are true. Host also exposes `Assembled.childAgentCatalog()`.

The in-process provider is installed with the `@agnes/base` package. Its plugin row id is `child-agent:in-process` and its provider id is `in-process`.

## Allowlist

The preset schema does not carry a child allowlist. Set it from the subagent extension config, or replace one session at runtime:

```ts
ctx.childAgents.setSessionAllowlist(sessionKey, {
  models: ['fast'],
  providers: ['in-process'],
})
```

Extension config has the same shape under `allow`, plus `sessions` for individual session keys. An omitted list is unrestricted. An empty list refuses every request of that kind. When `models` is set, the caller must name the model, so an inherited model cannot bypass the list. A refused provider raises `E_UNSUPPORTED`. A refused or omitted model raises `E_MODEL_UNKNOWN`. `setSessionAllowlist(sessionKey, undefined)` clears that session's override.

`subagent_fork` and `subagent_spawn` check this allowlist before the depth and fan-out limits. They start the in-process provider.

## Tools

These tools keep their current names:

- `subagent_fork` starts a background child seeded from parent history and returns its key.
- `subagent_spawn` starts a background child and returns its key. Both fork and spawn stay open for follow-ups.
- `subagent_collect` reads the current result; an idle child can accept another message.
- `subagent_cancel` stops a spawned child and its subtree.

Continuable children also accept:

- `subagent_list` lists in-process children and external children tracked for the session.
- `subagent_send_message` delivers a follow-up. It resolves when the message is accepted.
- `subagent_interrupt` stops the current turn and leaves the child open.

`subagent_collect` reports `idle` when a continuable turn parks. `list_subagent_models` lists model selectors available to this parent, filtered by its allowlist. Fork and spawn accept `toolFilter: { allow?, deny? }` with exact tool names. Deny takes precedence, and filters apply to both disclosure and execution, including late registrations and descendants. The official tools deny the four `schedule_*` management tools by default.

## Parent-bound facade

Host/Core binds `childAgents.forSession(parent)` once and passes the resulting `ChildAgentSessionService` to the loop. It exposes `start(task, options?)`, `list()`, `sendMessage(id, text, signal?)`, `interrupt(id)`, `result(id)`, `events(id)`, and `dispose(id?)`. Omitting the provider id uses the configured default.

The parent scope carries `sessionKey`, `signal`, `cwd`, and optional code `generation`, remaining `budget`, and `toolFilter`. Start options cannot replace parent identity or generation; a child budget or tool allowlist can only narrow inherited constraints. Starts check the live session model/provider allowlist. A facade refuses controls for handles it does not own. Parent abort requests cancellation. The caller must await `dispose()` to join starts and cleanup and observe failures. Handle `result()` is terminal completion, not the answer to each continuable turn; use events or listings for turn status.

The legacy `runLoopChild` Core export remains a synchronous in-process compatibility helper. It does not select an external provider.

## ACP children

`acp` is not part of the default extension list. Import it from `@agnes/base`:

```ts
import { acpChildAgentProvider, acpChildAgentsPlugin } from '@agnes/base'

acpChildAgentsPlugin({
  command: 'agh',
  args: ['acp'],
  agnesWorkspace: true,
})
```

`command` is any ACP agent. `agnesWorkspace: true` sends `_agnes/v1/workspace.add` before `session/new`. Another agh needs that call. A generic ACP agent does not. The child process receives `PATH`, `HOME`, and the `env` you pass. It does not receive the rest of the parent environment.

The provider speaks newline-delimited JSON-RPC: `initialize`, `session/new`, `session/prompt`, and `session/cancel`. Text arrives as `session/update` `agent_message_chunk`. `session/request_permission` is rejected. Any other inbound request gets a method-not-found response so the process does not wait forever. `session/cancel` asks the child to stop the current turn. A child that ignores it keeps running; `interrupt` still reports `accepted: true` when a turn was in flight.

`result` settles when the process exits or the handle is disposed. A completed turn leaves the child idle so a later `sendMessage` can prompt it again.

In-process events carry turn status and the turn's text. They are not a token stream. `subagent_list` does not include cached text for in-process children. The ACP listing includes text received so far.

## Codex, Claude Code, and the generic engine

`@agnes/base` declares three ordinary plugin rows, each `default: false`, `apiRange: "^1.4.0"`, `inject: ["childAgents"]`, and `runtime: "in-process"`:

| Row | Export |
| --- | --- |
| `child-agent:codex` | `codexChildAgentsPlugin` |
| `child-agent:claude-code` | `claudeCodeChildAgentsPlugin` |
| `child-agent:sdk` | `sdkChildAgentsPlugin` |

The plugin-row parser rejects a `capabilities` field, so these rows do not carry one. Honest flags live on the provider objects: Codex, Claude Code, and SDK mode are one-shot (`continuable: false`, `interrupt: true`, and every other child-agent flag false). SDK protocol `acp` registers the existing continuable `acp` provider and keeps that provider's flags. Each extension manifest declares empty hooks, slots, events, resources, and network. The package does not add a package-wide `agnes.capabilities` entry. `childEnginePlugins(settings)` remains available for an explicit in-process mount in tests.

Settings → Child engines reads and writes the profile `configuration.json` document through the host configuration service. The daemon methods are `_agnes/v1/config.childEngines.get` and `_agnes/v1/config.childEngines.save`. The web UI calls `GET` and `PUT /admin/api/child-engines`. The saved document has `enabled`, `command`, `args`, `allow`, and `protocol` for the SDK row. It does not store `env`. An enabled command must be non-empty and match one allowlist entry exactly. A corrupt `childEngines` field is dropped on load so accounts and session defaults still open.

A save publishes replacement builtin rows onto the current desired runtime target when that artifact, the pin coordinator, the runtime probe, and the `@agnes/base` package integrity are all available. The reply effect is `new-sessions`: new sessions use the head generation, and open sessions stay on the generation they started with. Children of an open session inherit that session's generation. When the publication cannot run, or there is no current desired artifact, the file is still saved and the effect is `restart-required`. A process start reads the same file into ordinary plugin layers, so a restart matches the file even when the desired artifact did not receive the overlay. Enabling a row changes the runtime code revision.

`codex` runs `codex exec --json` (or the command you allow) for one turn. `claude-code` runs Claude Code `stream-json` print mode for one turn. `interrupt` stops the process. They do not accept a parent model, budget, tool filter, fork, or worktree. Native CLI configuration remains authoritative. The child receives `PATH`, `HOME`, and `USERPROFILE` only.

`sdk` speaks the pinned newline protocol `agnes.child-engine`: `initialize`, `run`, `text` notifications, and `cancel`. It is one shot. Choosing protocol `acp` registers the continuable `acp` provider instead, with the same command allowlist. Do not mount that row beside another `acp` provider. This engine does not speak the DeepSeek SDK wire.

Provider `events()` and `updateExternalChild` update the in-process child listing only. The project UI writes a child card's `resultPreview` when a `tool/result` event arrives. `subagent_spawn` returns a start notice. `subagent_collect` returns the final text. The card updates when those tool results land. There is no `tool/progress` event and no websocket of child provider events, so the card does not show text while the process is still running.
