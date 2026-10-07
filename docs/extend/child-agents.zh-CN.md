# 子代理提供者

[English](child-agents.md) | 简体中文

[作者工具包](README.zh-CN.md) · [测试指南](testing.zh-CN.md) · [插件管理](../guide/packages.zh-CN.md)

子代理提供者代表父会话开始工作，并返回一个句柄。句柄提供事件、后续消息、打断和最终结果。内置提供者 id 是 `in-process`，就是 `subagent_fork` 和 `subagent_spawn` 已经使用的子会话。第二个提供者 `acp` 运行一个说换行分隔 ACP 的外部进程。

## 合同

通过公开包出口实现 [ChildAgentProvider](../../packages/extension-api/src/child-agent.ts)。`start(task, options)` 返回 [ChildAgentHandle](../../packages/extension-api/src/child-agent.ts)。

`options` 带父会话 `sessionKey`、`AbortSignal`，以及可选的 `cwd`、`model`、`isolation`、`budget` 和 `fork`。`sendMessage` 在消息被接受时完成，不等子代理回答。`interrupt` 停止当前回合，可继续的子代理仍然开着。`result` 在子代理进入终态时完成。`dispose` 释放子代理。

能力是 `continuable`、`interrupt`、`modelSelection`、`inheritsParentContext` 和 `worktree`。`false` 的能力在 start 时被拒绝。不要收下选项再悄悄忽略。

| 提供者 | continuable | interrupt | modelSelection | inheritsParentContext | worktree |
| --- | --- | --- | --- | --- | --- |
| `in-process` | 是 | 是 | 是 | 是 | 是 |
| `acp` | 是 | 是 | 否 | 否 | 否 |

## 注册提供者

从注入 `childAgents` 的普通 Cordis 插件注册：

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

在 `package.json` 的 `agnes.plugins` 里声明 `main` 和相同的注入。重复 id 会被拒绝。卸载插件会移除目录项，并释放通过该服务启动的句柄。`catalog()` 提供 id、版本、来源包和能力。Host 也提供 `Assembled.childAgentCatalog()`。

`in-process` 随 `@agnes/base` 安装。插件行 id 是 `child-agent:in-process`，提供者 id 是 `in-process`。

## 允许名单

预设 schema 没有子代理允许名单。从 subagent 扩展配置设置，或在运行时替换某一个会话：

```ts
ctx.childAgents.setSessionAllowlist(sessionKey, {
  models: ['fast'],
  providers: ['in-process'],
})
```

扩展配置在 `allow` 下使用同一形状，并用 `sessions` 指定单个会话。省略名单表示不限制。空名单拒绝这一类的全部请求。设置了 `models` 时，调用方必须写出模型名，继承来的模型不能绕过名单。被拒绝的提供者抛出 `E_UNSUPPORTED`。被拒绝或未写出的模型抛出 `E_MODEL_UNKNOWN`。`setSessionAllowlist(sessionKey, undefined)` 清除该会话的覆盖。

`subagent_fork` 和 `subagent_spawn` 在深度和扇出限制之前检查这份名单。它们启动的是 `in-process`。

## 工具

这些工具保持原名：

- `subagent_fork` 跑一轮继承父上下文的回合并返回文本。
- `subagent_spawn` 启动一个分离的子任务，交给 `subagent_collect`。
- `subagent_collect` 读取已启动的子任务，仍然是一次性观察器。
- `subagent_cancel` 停止已启动的子任务及其子树。

可继续的子代理还可以：

- `subagent_list` 列出会话里的进程内子代理和已跟踪的外部子代理。
- `subagent_send_message` 送出后续消息，在消息被接受时返回。
- `subagent_interrupt` 停止当前回合，子代理保持打开。

可继续的子代理在回合停住之后，`subagent_collect` 仍可能把它报成 running。空闲、运行中和是否可继续，看 `subagent_list`。

## 自定义循环

`LoopContext.children` 是可选端口。会话有进程内工厂时，`children.run(input, signal)` 跑一轮进程内 fork。`input` 是非空字符串或 `{ task, model? }`。结果是 `{ text, childKey, providerId: 'in-process' }`。同一份允许名单适用。中止 signal 会取消这个子代理。这个端口不启动 ACP 提供者；外部代理调用 `childAgents.start('acp', task, options)`。

## ACP 子代理

`acp` 不在默认扩展列表里。从 `@agnes/base` 导入：

```ts
import { acpChildAgentProvider, acpChildAgentsPlugin } from '@agnes/base'

acpChildAgentsPlugin({
  command: 'agh',
  args: ['acp'],
  agnesWorkspace: true,
})
```

`command` 可以是任何 ACP 代理。`agnesWorkspace: true` 会在 `session/new` 之前发送 `_agnes/v1/workspace.add`。另一个 agh 需要这次调用。普通 ACP 代理不需要。子进程只收到 `PATH`、`HOME` 和你传入的 `env`，收不到父进程环境的其余部分。

提供者使用换行分隔的 JSON-RPC：`initialize`、`session/new`、`session/prompt` 和 `session/cancel`。文本来自 `session/update` 的 `agent_message_chunk`。`session/request_permission` 会被拒绝。其他入站请求得到 method not found，避免进程一直等。`session/cancel` 要求子代理停止当前回合。子代理如果忽略它，回合会继续；只要当时有回合在进行，`interrupt` 仍返回 `accepted: true`。

`result` 在进程退出或句柄被 dispose 时完成。一个回合结束只让子代理进入空闲，之后的 `sendMessage` 可以再发一轮 prompt。

进程内事件是回合状态和该回合的文本，不是 token 流。`subagent_list` 不带进程内子代理的缓存文本。ACP 列表带上已经收到的文本。
