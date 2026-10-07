# ACP child agent

This is a usage note for the `acp` child provider. The implementation ships in `@agnes/base` and is not part of the default extension list.

`acp` runs an external process that speaks newline-delimited JSON-RPC. It can continue after a turn and it can be interrupted. It does not select a model, inherit the parent transcript, or create a git worktree. Those requests fail at start.

```ts
import type { ChildAgentPluginContext } from '@agnes/extension-api'
import { acpChildAgentProvider } from '@agnes/base'
import { defineAgnesPlugin, type Context } from '@agnes/plugin-runtime'

export const main = defineAgnesPlugin({
  inject: ['childAgents'],
  apply(ctx: Context & ChildAgentPluginContext, config: { command?: string; args?: string[] }) {
    ctx.childAgents.register(
      acpChildAgentProvider({
        command: config.command ?? 'agh',
        args: config.args ?? ['acp'],
        agnesWorkspace: true,
      }),
    )
  },
})
```

Set `agnesWorkspace: true` when the child is another agh. That sends `_agnes/v1/workspace.add` before `session/new`. Leave it unset for a generic ACP agent. Pass only the environment the child should see; `PATH` and `HOME` are added for you. The parent process environment is not copied.

`session/request_permission` is rejected. `session/cancel` asks the child to stop the current turn. See [Child agent providers](../../../docs/extend/child-agents.md).
