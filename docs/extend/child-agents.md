# Child agent providers

English | [简体中文](child-agents.zh-CN.md)

[Author kit](README.md) · [Testing](testing.md) · [Plugin management](../guide/packages.md)

A child agent provider starts work on behalf of a parent session and returns a handle. The handle exposes events, a follow-up message, an interrupt, and a terminal result. The built-in provider id is `in-process`. It is the same child session that `subagent_fork` and `subagent_spawn` already use. A second provider, `acp`, runs an external process that speaks newline-delimited ACP.

## Contract

Implement [ChildAgentProvider](../../packages/extension-api/src/child-agent.ts) through public package exports. `start(task, options)` returns a [ChildAgentHandle](../../packages/extension-api/src/child-agent.ts).

`options` carries the parent `sessionKey`, an `AbortSignal`, and optional `cwd`, `model`, `isolation`, `budget`, and `fork`. `sendMessage` resolves when the message is accepted, not when the child answers. `interrupt` stops the current turn and leaves a continuable child open. `result` settles when the child reaches a terminal state. `dispose` releases the child.

Capabilities are `continuable`, `interrupt`, `modelSelection`, `inheritsParentContext`, and `worktree`. A `false` flag is refused at start. Do not accept an option and ignore it.

| Provider | continuable | interrupt | modelSelection | inheritsParentContext | worktree |
| --- | --- | --- | --- | --- | --- |
| `in-process` | yes | yes | yes | yes | yes |
| `acp` | yes | yes | no | no | no |

## Register a provider

Register from an ordinary Cordis plugin that injects `childAgents`:

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

Declare `main` and the same injection in `package.json`'s `agnes.plugins`. Duplicate ids are refused. Unloading the plugin removes the catalog entry and disposes handles started through the service. `catalog()` exposes id, version, source package, and capabilities. Host also exposes `Assembled.childAgentCatalog()`.

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

- `subagent_fork` runs one inherited turn and returns its text.
- `subagent_spawn` starts a detached child for `subagent_collect`.
- `subagent_collect` reads a spawned child. It remains the one-shot observer.
- `subagent_cancel` stops a spawned child and its subtree.

Continuable children also accept:

- `subagent_list` lists in-process children and external children tracked for the session.
- `subagent_send_message` delivers a follow-up. It resolves when the message is accepted.
- `subagent_interrupt` stops the current turn and leaves the child open.

`subagent_collect` can still report a continuable child as running after its turn has parked. Use `subagent_list` for idle, running, and continuable.

## Custom loops

`LoopContext.children` is optional. When the session has the in-process factory, `children.run(input, signal)` runs one in-process fork. `input` is a non-empty string or `{ task, model? }`. The result is `{ text, childKey, providerId: 'in-process' }`. The same allowlist applies. Aborting the signal cancels that child. This port does not start the ACP provider; call `childAgents.start('acp', task, options)` for an external agent.

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
