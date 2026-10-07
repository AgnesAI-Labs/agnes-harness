# 子代理提供者

[English](child-agents.md) | 简体中文

[作者工具包](README.zh-CN.md) · [测试指南](testing.zh-CN.md) · [插件管理](../guide/packages.zh-CN.md)

子代理提供者代表父会话开始工作，并返回一个句柄。句柄提供事件、后续消息、打断和最终结果。内置提供者 id 是 `in-process`，就是 `subagent_fork` 和 `subagent_spawn` 已经使用的子会话。第二个提供者 `acp` 运行一个说换行分隔 ACP 的外部进程。

## 合同

通过公开包出口实现 [ChildAgentProvider](../../packages/extension-api/src/child-agent.ts)。`start(task, options)` 返回 [ChildAgentHandle](../../packages/extension-api/src/child-agent.ts)。

`options` 带父会话 `sessionKey`、`AbortSignal`，以及可选的 `cwd`、`model`、`isolation`、`budget`、`fork`、`toolFilter` 和 `generation`。`sendMessage` 在消息被接受时完成，不等子代理回答。`interrupt` 停止当前回合，可继续的子代理仍然开着。`result` 在子代理进入终态时完成。`dispose` 释放子代理。

能力是 `continuable`、`interrupt`、`modelSelection`、`inheritsParentContext` 和 `worktree`，另有可选的 `budget`、`toolFilter`；省略可选标志表示不支持。`false` 的能力在 start 时被拒绝。不要收下选项再悄悄忽略。

| 提供者 | continuable | interrupt | modelSelection | inheritsParentContext | worktree | budget | toolFilter |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `in-process` | 是 | 是 | 是 | 是 | 否 | 是 | 是 |
| `acp` | 是 | 是 | 否 | 否 | 否 | 否 | 否 |
| `codex` | 否 | 是 | 否 | 否 | 否 | 否 | 否 |
| `claude-code` | 否 | 是 | 否 | 否 | 否 | 否 | 否 |
| `sdk` | 否 | 是 | 否 | 否 | 否 | 否 | 否 |

直接调用进程内提供者会拒绝 worktree 隔离，因为它不创建 git worktree。官方 fork/spawn 工具先准备 worktree，再恢复延迟启动的子代理；创建失败会取消子代理并返回错误。明确请求 `isolation: shared` 才共享工作目录。

## 注册提供者

Host 用 `defineProviderKind` 定义 `child-agent` 类型。`childAgents` 是该注册表的类型化外观。从注入 `childAgents` 的普通 Cordis 插件注册：

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

也可以走统一入口：

```ts
ctx.providers.register('child-agent', '@example/agents', provider)
```

在 `package.json` 的 `agnes.plugins` 里声明 `main` 和相同的注入。重复 id 会被拒绝。卸载插件会移除目录项，先中止并等待启动任务，再等待通过该服务启动的句柄释放。注销函数返回幂等 Promise，并传播清理失败。`catalog()` 提供 id、版本、来源包和能力。`ctx.providers.catalog()` 列出同一提供者，能力名只包含值为 true 的项。Host 也提供 `Assembled.childAgentCatalog()`。

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

- `subagent_fork` 在后台启动继承父历史的子代理并返回 key。
- `subagent_spawn` 在后台启动子代理并返回 key。fork 和 spawn 都保留子代理以接受后续消息。
- `subagent_collect` 读取当前结果；空闲子代理可以继续接受消息。
- `subagent_cancel` 停止已启动的子任务及其子树。

可继续的子代理还可以：

- `subagent_list` 列出会话里的进程内子代理和已跟踪的外部子代理。
- `subagent_send_message` 送出后续消息，在消息被接受时返回。
- `subagent_interrupt` 停止当前回合，子代理保持打开。

`subagent_collect` 在可继续回合停住后报告 `idle`。`list_subagent_models` 列出父会话允许选择的模型。fork/spawn 接受 `toolFilter: { allow?, deny? }`，按工具名精确匹配，deny 优先；披露、执行、后续注册和后代都受限制。官方工具默认拒绝四个 `schedule_*` 管理工具。

## 父会话外观

Host/Core 调用一次 `childAgents.forSession(parent)`，把返回的 `ChildAgentSessionService` 交给循环。它提供 `start(task, options?)`、`list()`、`sendMessage(id, text, signal?)`、`interrupt(id)`、`result(id)`、`events(id)` 和 `dispose(id?)`。省略提供者 id 时使用配置的默认提供者。

父作用域包含 `sessionKey`、`signal`、`cwd`，以及可选的代码 `generation`、剩余 `budget` 和 `toolFilter`。启动选项不能替换父身份或代码代际；子预算和工具名单只能收紧继承约束。每次启动检查当前模型/提供者允许名单。外观拒绝控制不归自己所有的句柄。父 signal 中止会请求取消；调用方必须等待 `dispose()`，才能确认启动和清理已结束，并观察失败。`result()` 是终态结果，不是每一轮回答；轮次状态通过事件和列表观察。

Core 的旧 `runLoopChild` 出口保留为同步进程内兼容函数，不选择外部提供者。

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

## Codex、Claude Code 与通用引擎

`@agnes/base` 声明三行普通插件，每一行都是 `default: false`、`apiRange: "^1.4.0"`、`inject: ["childAgents"]`、`runtime: "in-process"`：

| 行 | 导出 |
| --- | --- |
| `child-agent:codex` | `codexChildAgentsPlugin` |
| `child-agent:claude-code` | `claudeCodeChildAgentsPlugin` |
| `child-agent:sdk` | `sdkChildAgentsPlugin` |

插件行解析器拒绝 `capabilities` 字段，所以这三行不带该字段。如实能力写在提供者对象上：Codex、Claude Code 和 SDK 模式都是单轮（`continuable: false`，`interrupt: true`，其余子代理标志为 false）。SDK 协议选 `acp` 时注册现有的可继续 `acp` 提供者，并保留该提供者的标志。各扩展清单声明的 hooks、slots、events、resources、network 都是空的。包本身不加包级 `agnes.capabilities`。测试里仍可用 `childEnginePlugins(settings)` 做显式进程内挂载。

设置里的「子代理引擎」通过宿主配置服务读写配置档的 `configuration.json`。守护进程方法是 `_agnes/v1/config.childEngines.get` 和 `_agnes/v1/config.childEngines.save`。网页调用 `GET` 与 `PUT /admin/api/child-engines`。保存的文档包含 `enabled`、`command`、`args`、`allow`，SDK 行另有 `protocol`。文档不保存 `env`。已启用的命令必须非空，并且与允许名单中的某一项完全一致。加载时如果 `childEngines` 字段损坏，会丢掉该字段，账号和会话默认值仍然可以打开。

保存时，如果当前期望运行时制品、pin coordinator、运行时探针和 `@agnes/base` 的包完整性都存在，就把这三行内置插件替换进该制品。返回效果是 `new-sessions`：新会话使用头部这一代，已经打开的会话留在它们启动时的那一代。打开会话的子代理继承该会话的代。无法发布，或当前没有期望制品时，文件仍然保存，效果是 `restart-required`。进程启动会把同一份文件读进普通插件层，因此即使期望制品没有收到覆盖，重启后也会与文件一致。启用一行会改变运行时代码修订。

`codex` 用 `codex exec --json`（或你放行的命令）跑一轮。`claude-code` 用 Claude Code 的 `stream-json` 打印模式跑一轮。`interrupt` 会停掉进程。它们不接受父会话的模型、预算、工具过滤、fork 或工作树。CLI 自己的配置仍然有效。子进程只收到 `PATH`、`HOME` 和 `USERPROFILE`。

`sdk` 使用固定的换行协议 `agnes.child-engine`：`initialize`、`run`、`text` 通知和 `cancel`。它是单轮的。协议选 `acp` 时改为注册可继续的 `acp` 提供者，并使用同一份命令允许名单。不要把它和另一个 `acp` 提供者同时挂载。这个引擎不说 DeepSeek SDK 的线路协议。

提供者的 `events()` 和 `updateExternalChild` 只更新进程内的子代理列表。项目界面只在 `tool/result` 事件到达时写入子代理卡片的 `resultPreview`。`subagent_spawn` 返回开始通知。`subagent_collect` 返回最终文本。卡片在这些工具结果落地时更新。没有 `tool/progress` 事件，也没有把子代理提供者事件推到网页的 websocket，所以进程还在跑的时候卡片不会显示文本。
