# 插件开发：把你的能力接入 AGH

[English](plugins.md) | 简体中文

[文档导航](../README.zh-CN.md) · [后端工具教程](backend.zh-CN.md)

把业务函数变成 Agent 工具，把任务方法整理为 Skill，或为工作台加上自己的界面。AGH 为这些能力提供扩展入口与包生命周期，帮助你从一个插件逐步组合出应用。本文先帮你选入口，再解释依赖与运行方式。

## 在会话中创建第一个插件

默认启用的 `@agnes/plugin-helper` 可以帮助你把需求变成 AGH 工具、Skill 或皮肤插件。例如：

> 帮我写一个 AGH 插件，统计文本字数，并安装到当前 AGH。

助手读取与版本匹配的模板，保存私有候选，经显式批准运行作者测试，再将测试通过的内容提交人工审阅。在“设置 → 插件 → 候选”核对文件、测试结果与权限。批准后按正常包治理发布这份精确内容。新会话获得插件代码，已有会话保留原版本；批准的技能作为动态资源刷新。[候选审阅指南](../extend/agent-built-plugins.zh-CN.md)说明工具、摘要、更新冲突与拒绝路径。

创建候选不等于安装、信任或启用。作者测试执行受信 JavaScript，不隔离恶意代码。助手支持有上限的自包含文本 ESM 工具/技能包和 CSS/token 皮肤；依赖与复杂界面使用下方作者流程。禁用助手不会删除已发布的包。

为工作台定制纯 CSS 与 token 外观，阅读[皮肤开发](skins.zh-CN.md)。

## 选择扩展方式

| 你准备增加什么 | 适合的起点 | 完成后可以验证什么 |
| --- | --- | --- |
| 一项可被 Agent 调用的能力 | [后端工具插件](backend.zh-CN.md) | 参数、工具记录与结构化结果 |
| 一套任务方法和背景知识 | [工作区 Skill](../guide/skills.zh-CN.md) | 来源、信任和会话中的使用 |
| 已有的外部工具服务 | [MCP 接入](../guide/mcp.zh-CN.md) | 连接、目录和授权后的工具调用 |
| 工作台中的一块界面 | [前端面板](frontend.zh-CN.md) | 挂载、版本更新和卸载恢复 |
| 能读取后端业务结果的界面 | [前后端联动](fullstack.zh-CN.md) | 当前会话下的受限服务查询 |

选择最贴近需求的一条路径。包的安装和信任过程统一见[插件管理](../guide/packages.zh-CN.md)，无需为每种界面重新实现后台。

物理设备接入的方向介绍见[MHS 与设备接入](../guide/mhs.zh-CN.md)，已有模拟巡检组合包，真实硬件仍需验证；上表列出的是当前已有的软件扩展入口。

## Cordis 在其中做什么

AGH 使用仓内 `@agnes/cordis` 的 Context、服务依赖和 fiber 生命周期组织可替换组件；Host 再施加安装、信任、快照和能力约束。上游 Cordis/DeepSeek 文档可解释框架思想，不能直接替代 AGH 的加载声明或接口。

## 一个插件包的形状

现行普通插件入口是 `package.json` 的 `agnes.plugins`，指向包模块的命名导出：

```json
{
  "name": "example-plugin",
  "version": "1.0.0",
  "private": true,
  "type": "module",
  "exports": "./index.mjs",
  "agnes": {
    "plugins": [
      { "apiRange": "^1.4.0", "export": "example", "id": "ext:example/plugin", "inject": ["skills"] }
    ]
  }
}
```

这是示例自己的身份，不是可从 npm 安装的地址。`index.mjs`：

```js
export const example = {
  inject: ['skills'],
  apply(ctx) {
    ctx.skills.register({
      name: 'review-notes',
      description: '只读检查说明文件',
      body: '列出说明中的矛盾并引用文件，不修改内容。',
    })
  },
}
```

依赖名称必须在静态声明与导出元数据中一致，后端加载器在不执行任意模块的阶段就需知道依赖图。`provide` 同样要两边一致。模块需包含全部必要产物；直接把本机 TypeScript 深路径或未打包依赖交给不可变快照不构成可移植分发。

## 配置、依赖与清理

`defineAgnesPlugin()` 是保留类型的辅助函数，不给插件增加权限。插件可声明 Standard Schema `Config`，由加载器验证配置。现成的[cordis-greeting](../../examples/packages/cordis-greeting/index.ts)展示配置校验、`provide` 和服务值；[hot-service](../../examples/packages/hot-service/v1/index.mjs)展示无外部 import 的可安装 ESM。

`ctx.provide('name', value)` 的值属于当前 Context 服务空间，消费者声明 `inject`。加载顺序由服务依赖决定，不以数组顺序替代。手工申请的定时器、连接和监听器应登记到 `ctx.effect(() => disposer)`。卸载时 disposer 撤下资源，不把已经完成的外部业务动作当作可自动回滚。

## 模型适配器包

受信的普通插件可以注入 `modelAdapters` 并调用 `ctx.modelAdapters.register(adapter)`；在 `agnes.plugins` 清单中声明相同的依赖。[公共 ModelAdapter 合同](../../packages/extension-api/src/model-adapter.ts) 包装现有 WireAdapter 形状：id、版本、协议/API 名、能力（含图片输入），以及返回 wire 实例的 `create({ routes })`。[测试样例包](../../packages/host/test/fixtures/model-adapter/index.ts) 演示了不依赖 Host 或 Core 的注册方式。

在 `provider.adapters` 中填写注册 id 或已启用的来源包名，并将路由的 `api` 设置为注册 id。`compat` 可携带适配器专用配置。现有的 `@agnes/ai` 选择与 pi API 名继续有效，API-key 和托管订阅 OAuth 路径保持兼容。

实例输出 wire 事件；现有 AI facade 继续负责 stamp、工具调用恢复与用量计费。有凭据的结构化实例须实现 `bindCredential`，Host 在推理前解析密钥。实例的 `dispose()` 释放实例资源，可选的注册级 `cleanup()` 释放共享资源；插件卸载时均会执行。重复 id 与不可用的选择会被拒绝。

管理端可调用 Host 的 `modelAdapterCatalog(root)` 或装配对象的 `modelAdapterCatalog()`，读取 id、版本、来源包、API 名和能力。目录不暴露配置、凭据或工厂。适配器实现固定到会话的代码版本；模型路由、目录与凭据配置在保留的容器间更新，在途请求保留准入时的设置。见[固定代码与动态资源](architecture-plugins.zh-CN.md#pinned-code-live-resources)。

## 持久化提供者

完整 Host 提供器实现账本、metadata、子任务控制、回收与完整性五个端口，SQL 可选。内置 `sqlite` 与 [JSONL 示例](../../examples/persistence/)均提供这些端口。安装包后在用户配置档选择 `persistence: { provider: jsonl }`。缺少必要能力会拒绝启动，子任务控制不会回退 SQLite。选择需要重启，不迁移文件。合同、一致性验证及受支持的导出/导入迁移见[持久化作者指南](../extend/persistence.zh-CN.md)。

## 子代理提供者

提供者启动子代理，并返回带事件、`sendMessage`、`interrupt` 和 `result` 的句柄。类型名是 `child-agent`，用 `defineProviderKind` 定义。通过 `ctx.providers.register('child-agent', sourcePackage, provider)` 或 `childAgents` 外观注册。内置 id 是 `in-process`。`acp` 运行外部 ACP 进程，默认不加载。标成 false 的能力在 start 时被拒绝。作者说明见[子代理提供者](../extend/child-agents.zh-CN.md)。

预设 schema 没有子代理允许名单。在 subagent 扩展上设置 `allow` 和 `sessions`，或调用 `childAgents.setSessionAllowlist`。省略名单表示不限制。空名单拒绝这一类。设置了模型名单时，调用方必须写出模型名。

`ToolContext.subagent` 的可选控制方法（`list`、`models`、`sendMessage`、`interrupt`）仅在扩展声明 `subagent: true` 且 Host 提供方法时暴露。没有该能力时，`job_list` 跳过子代理同步，仍可列出 shell jobs；其他子代理调用继续受能力检查约束。

可选 `LoopContext.children` 使用绑定父会话的 `ChildAgentSessionService` facade，按配置选择 provider 并提供可继续对话的子代理。

## 不同 API 不可混用

| 接口 | 可以做什么 | 边界 |
| --- | --- | --- |
| 普通 Cordis Context | 插件、服务、事件、effect 生命周期 | 进程内服务，不自动变成跨进程 RPC |
| `ctx.extension()` / PluginExtensionAPI | 工具、`on` 观察 hook、`registerHook` 的 transform/intercept hook、受约束事件 | 不能通过这个 API 注册 Service/Projection/Slot/Resource；结果仍受运行时权限与顺序约束 |
| `ctx.skills` | 运行时 Skill 贡献与 provider | 不能读取/枚举其他 Skill；与磁盘治理分离 |
| 行上的 `ctx.services` / `ctx.slots` / `ctx.projections` / `ctx.resources` | 在已验证行上注册对应贡献，随行 fiber 清理 | 不是无条件全局对象；服务调用仍受身份、会话和客户端 allow-list 约束 |
| 浏览器 ClientContext | 已声明槽位、前端服务/命令与受限 backend service relay | 没有 Host Context、Node 系统能力或 daemon 管理凭据 |

[联动教程](fullstack.zh-CN.md)使用同一受信 Cordis 行上的 `ctx.services.register()` 和 `agnes.clientDescriptors`。它不把 `ctx.provide()` 伪装成远程方法，也不让 `ctx.extension().registerService()` 绕过限制。

当前源码已开放 16 类 hook 的 `registerHook`，并收敛第三方后端插件到 `agnes.plugins` 行；旧 `agnes.extensions` 不能继续作为第三方普通后端入口。内置兼容清单与第三方作者入口的规则不同。具体注册和授权仍以当前源码、包预览与实际行状态为准。

## 前后端生命周期

Host 普通树与 Web 页面分别创建 Context。`web:` 是平台合成的客户端行命名空间，包作者不得在 `agnes.plugins` 中声明该前缀；这些行保留在完整 runtime target 中，但不作为 Host 普通行执行。

第三方运行来源要求受信不可变快照；不能把任意文件路径当作已安装受信行。Host 维护受限活树事务，Web 根据名册按 revision 对账；不支持的静态组件替换、孤立依赖、失效租约和越权操作应拒绝。

下一步：[后端工具](backend.zh-CN.md) · [前端面板](frontend.zh-CN.md) · [联动](fullstack.zh-CN.md) · [安装与更新](../guide/packages.zh-CN.md)。

事实源：[作者类型](../../packages/plugin-runtime/src/author.ts)、[manifest 解析](../../packages/package-manager/src/plugin-manifest.ts)、[PluginExtensionAPI](../../packages/extension-api/src/plugin-extension.ts)、[行 API](../../packages/host-extensions/src/ext-host/row-extension-api.ts)、[ClientContext](../../packages/web-client/src/client-module.ts)。

## 编写 Agent Loop

Agent Loop 负责调度与自身检查点状态。通过 `@agnes/extension-api` 导出 `LoopFactory`（`id`、`version`、`capabilities`、版本化 `codec`、`create(ctx)`、`resume(ctx, checkpoint)`），驱动实现 `step(signal)`、`cancel()`、`dispose()` 与 `checkpoint()`。在插件 apply 中调用 `registerLoopPlugin(ctx, '包名', factory)`；`agnes.plugins` 的入口声明 `inject: ["loops"]`。注册归插件 fiber 所有，卸载时移除；`kernel.loops.catalog()` 返回身份、能力与可信来源包。

每一步显式返回 `outcome: 'running' | 'idle' | 'turn-ended' | 'parked'`；`phase` 仅用于展示。`until: 'turn-end'` 在首个轮次结束时停止；`until: 'idle'` 在正常完成后继续处理输入，直到无输入、挂起或其他结束原因。生产 runner 与 `driveLoop` testkit 采用相同规则。返回结束结果前先调用 `ctx.events.finish(reason)`。

`ctx.input.claim('next-turn')` 打开或恢复轮次；轮次结束前重复调用返回当前输入。`claim('next-step')` 消费本轮 steer。输入含稳定 `id`、`turnId`、`kind`、`trust`、`actor` 与内容。`ctx.turn.view()` 返回独立且深度冻结的视图：压缩后的可见历史、本轮工具目录与 JSON schema、有效模型及能力、system/runtime 提示词与预算。执行仍受策略和审批约束。

通过 `await ctx.prepareRequest({ system, messages, tools, sampling, invocationId })` 准备请求，再交给 `ctx.model.stream(request, signal)` 或 `complete(request, signal)`。省略 messages 时使用可见历史；tools 指定冻结目录中的精确工具名。Core 负责 route、contract、哈希派生、媒体校验和本轮身份绑定；作者不填写 `contractId`、`derivedHash` 或 `route`。所有循环的模型/工具端口都经过 Core 的最大步数、请求上限及 quote/deny 准入。批量结果保持输入顺序，策略决定可并行的调用。

为请求和工具调用分配稳定 `invocationId`。`ctx.effects.status(id)` 返回 `not-sent`、`may-have-sent` 或含持久响应的 `responded`。通过 `ctx.checkpoints.write(driver.checkpoint(), { invocationIds })` 关联检查点与副作用。重开可复用持久响应；不确定的调用拒绝自动重放。responded 不代表工具成功，也不保证进程外副作用恰好执行一次。

受控的 `turn.checkpoint`、`model.respond`、`tools.drain`、压缩与延迟等待端口维护 Core 的账本和恢复不变量。调度器通过 `ctx.turn.continuation()` 选择下一条边，无须接触私有程序计数器。`@agnes/loop-default` 只使用公共上下文，由 Base 发行包的普通插件行注册。`checkpointMode: 'ledger'` 使用 Core 恢复并接受没有驱动检查点的历史会话。有状态驱动默认使用 `'driver'` 模式，恢复前校验 codec 版本。Host 为 `ctx.children` 绑定父会话的 `ChildAgentSessionService`，提供 start/list/message/interrupt/result/events/dispose。省略 providerId 使用 child-agent 配置；每次 start 都检查当前允许名单，继承父工作区、固定代码 generation、预算和工具过滤，子选项只能收窄这些约束。会话关闭会取消并等待已启动或正在启动的子代理清理完成。

有两种调度方式：

| 方式 | 操作与职责 |
| --- | --- |
| 粗粒度边 | 官方默认循环通过 `turn.continuation()` 选择 `turn.checkpoint`、`model.respond`、`tools.drain`、压缩和延迟等待。Core 执行既有模型、工具、门控策略及账本恢复。 |
| 底层端口 | 第三方循环通过输入领取、回合视图、`prepareRequest` + `model.stream`、`tools.batch`、副作用回执、压缩、子代理和等待/唤醒自行管理状态机、响应解析及调度。准入、审批绑定及副作用仍由 Core 管理。[独立 ReAct 示例](../../examples/loops/react-loop/README.md) 不调用任何粗粒度调度边。 |

底层驱动使用 `ctx.events.assistant(message, nextCheckpoint)` 原子提交解析后的助手消息及下一检查点，Core 同时建立工具调用的助手归属。调度前保存稳定工具 id 和停驻意图。工具端口等待同批任务结束、关闭审批停驻回合后抛出 `code: 'PARKED'`，驱动应返回 parked 结果。恢复时 `input.resumeParked()` 打开原审批续点，`tools.resume(invocationId, signal)` 使用既有授权执行原调用。`E_LANE_BUSY` 表示另一张审批票据仍需单独续接：保留调用 id，把当前续点以 parked 结束并等待该票据。不确定的外部发送拒绝自动重放。压缩前等待副作用结束，并用 `turn.endStep()` 关闭当前步骤。这些操作只执行账本转移，不选择下一调度动作。

可继续的子代理通过事件中的 `idle` 分隔每轮响应；`result()` 等待其生命周期终止。`wait.park` 返回后检查取消并领取 steer。子代理启动回执、上下文估算、唤醒持久性和后台任务结果等待等接口边界，见 ReAct 示例的[底层端口发现清单](../../examples/loops/react-loop/README.md#low-level-port-findings)。

遵守取消信号，dispose 必须幂等。会话关闭先停止准入，再取消并等待活跃驱动/工具工作，允许最终写入，然后关闭 hooks、账本与工作区租约。释放非活跃的账本续点会保留其恢复能力。

新会话选择优先级为显式参数、管理端默认值、profile 顶层 `loop: { id, version }`、`agnes.default@1.0.0`。SDK 使用 `client.createSession({ cwd, loop })` 或 `client.session.new({ cwd, loop })`，CLI 使用 `agh -p "提示词" --loop example.dag@1.0.0`。开始记录固定循环身份；默认值变更仅影响新会话。旧会话映射到默认身份，缺失时明确失败，不会替换循环。参见[独立 DAG 示例](../../examples/loops/dag-loop/README.md)：模型规划、并行波次、依赖汇合与恢复均只依赖公共端口。
