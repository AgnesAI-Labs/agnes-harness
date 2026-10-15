# 插件开发：把你的能力接入 AGH

[English](plugins.md) | 简体中文

[文档导航](../README.zh-CN.md) · [后端工具教程](backend.zh-CN.md)

插件是完全受信任的代码，以用户权限运行。能力声明用于准入审核，不限制任意 JavaScript，也不强制 hook 白名单。`ctx.hooks.register` 接受受支持的 observe、transform、intercept hooks，不按声明的 `hooks` 列表限制注册。只授权你愿意执行的代码。

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
      { "apiRange": "^4.0.0", "export": "example", "id": "ext:example/plugin", "inject": ["skills"] }
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

插件注入什么只在 `agnes.plugins` 条目里声明一次：`inject` 列出全部服务名，`optionalInject` 标出可缺省的那部分。后端加载器在不执行任意模块的阶段就需知道依赖图，导出本身不再带清单（重复列出的必须一致）。`provide` 仍须与导出一致。模块需包含全部必要产物；直接把本机 TypeScript 深路径或未打包依赖交给不可变快照不构成可移植分发。

## 配置、依赖与清理

`defineAgnesPlugin()` 是保留类型的辅助函数，不给插件增加权限。插件可声明 Standard Schema `Config`，由加载器验证配置。现成的[cordis-greeting](../../examples/packages/cordis-greeting/index.ts)展示配置校验、`provide` 和服务值；[hot-service](../../examples/packages/hot-service/v1/index.mjs)展示无外部 import 的可安装 ESM。

`ctx.provide('name', value)` 的值属于当前 Context 服务空间，消费者声明 `inject`。加载顺序由服务依赖决定，不以数组顺序替代。手工申请的定时器、连接和监听器应登记到 `ctx.effect(() => disposer)`。卸载时 disposer 撤下资源，不把已经完成的外部业务动作当作可自动回滚。

## 模型适配器包

受信的普通插件可以注入 `providers` 并调用 `ctx.providers.register(modelAdapterKind, adapter)`；在 `agnes.plugins` 清单中声明相同的依赖。[公共 ModelAdapter 合同](../../packages/extension-api/src/model-adapter.ts) 包装现有 WireAdapter 形状：id、版本、`wireApi` 线路格式、能力（含图片输入），以及返回 wire 实例的 `create({ routes })`。[测试样例包](../../packages/host/test/fixtures/model-adapter/index.ts) 演示了不依赖 Host 或 Core 的注册方式。

在配置档的 `providers.model-adapter.provider` 中填写注册 id 或已启用的来源包名，并将路由的 `api` 设置为注册 id。`compat` 可携带适配器专用配置。现有的 `@agnes/ai` 选择与 pi API 名继续有效，API-key 和托管订阅 OAuth 路径保持兼容。

实例输出 wire 事件；现有 AI facade 继续负责 stamp、工具调用恢复与用量计费。有凭据的结构化实例须实现 `bindCredential`，Host 在推理前解析密钥。实例的 `dispose()` 释放实例资源，可选的注册级 `cleanup()` 释放共享资源；插件卸载时均会执行。重复 id 与不可用的选择会被拒绝。

管理端可调用 Host 的 `modelAdapterCatalog(root)` 或装配对象的 `modelAdapterCatalog()`，读取 id、版本、来源包、API 名和能力。目录不暴露配置、凭据或工厂。适配器实现固定到会话的代码版本；模型路由、目录与凭据配置在保留的容器间更新，在途请求保留准入时的设置。见[固定代码与动态资源](architecture-plugins.zh-CN.md#pinned-code-live-resources)。

## 持久化提供者

完整 Host 提供器实现账本、metadata、子任务控制、回收与完整性五个端口，SQL 可选。内置 `sqlite` 与 [JSONL 示例](../../examples/persistence/)均提供这些端口。安装包后在用户配置档选择 `providers.persistence: { provider: jsonl }`。缺少必要能力会拒绝启动，子任务控制不会回退 SQLite。选择需要重启，不迁移文件。合同、一致性验证及受支持的导出/导入迁移见[持久化作者指南](../extend/persistence.zh-CN.md)。

## 子代理提供者

提供者启动子代理，并返回带事件、`sendMessage`、`interrupt` 和 `result` 的句柄。类型名是 `child-agent`，用 `defineKind` 定义。通过 `ctx.providers.register(childAgentKind, provider)` 注册。内置 id 是 `in-process`。`acp` 运行外部 ACP 进程，默认不加载。标成 false 的能力在 start 时被拒绝。作者说明见[子代理提供者](../extend/child-agents.zh-CN.md)。

预设 schema 没有子代理允许名单。在 subagent 扩展上设置 `allow` 和 `sessions`，或调用 `childAgents.setSessionAllowlist`。省略名单表示不限制。空名单拒绝这一类。设置了模型名单时，调用方必须写出模型名。

`ToolContext.subagent` 的可选控制方法（`list`、`models`、`sendMessage`、`interrupt`）仅在扩展声明 `subagent: true` 且 Host 提供方法时暴露。没有该能力时，`job_list` 跳过子代理同步，仍可列出 shell jobs；其他子代理调用继续受能力检查约束。

可选 `LoopContext.children` 使用绑定父会话的 `ChildAgentSessionService` facade，按配置选择 provider 并提供可继续对话的子代理。

## 不同 API 不可混用

| 接口 | 可以做什么 | 边界 |
| --- | --- | --- |
| 普通 Cordis Context | 插件、服务、事件、effect 生命周期 | 进程内服务，不自动变成跨进程 RPC |
| `ctx.tools` | `register(tool)`，由调用插件生命周期清理 | 与官方工具共用验证和权限边界 |
| `ctx.hooks`、`ctx.eventLog`、`ctx.self` | `hooks.register(event, handler)` 覆盖全部 16 类 hook、写入插件自己命名空间的账本事件、插件身份/日志/信号 | 观察类事件忽略 handler 返回值；结果仍受运行时权限与顺序约束 |
| `ctx.skills` | 运行时 Skill 贡献与 provider | 不能读取/枚举其他 Skill；与磁盘治理分离 |
| `ctx.services` / `ctx.slots` / `ctx.projections` / `ctx.resources` | 注册对应贡献，随插件清理 | 不是无条件全局对象；服务调用仍受身份、会话和客户端 allow-list 约束 |
| 浏览器 ClientContext | 已声明槽位、前端服务/命令与受限 backend service relay | 没有 Host Context、Node 系统能力或 daemon 管理凭据 |

[联动教程](fullstack.zh-CN.md)使用同一受信 Cordis 行上的 `ctx.services.register()` 和 `agnes.clientDescriptors`。它不把 `ctx.provide()` 伪装成远程方法。

官方包和第三方包共用一种插件形态：`defineAgnesPlugin({ inject, apply })`，按名字注入上表的 facet。内置包由 Host 在后端 API 之上挂载，安装的包作为 Cordis 行挂载，但 `apply` 是同一份代码。具体注册和授权仍以当前源码、包预览与实际行状态为准。

## 前后端生命周期

Host 普通树与 Web 页面分别创建 Context。`web:` 是平台合成的客户端行命名空间，包作者不得在 `agnes.plugins` 中声明该前缀；这些行保留在完整 runtime target 中，但不作为 Host 普通行执行。

第三方运行来源要求受信不可变快照；不能把任意文件路径当作已安装受信行。Host 维护受限活树事务，Web 根据名册按 revision 对账；不支持的静态组件替换、孤立依赖、失效租约和越权操作应拒绝。

下一步：[后端工具](backend.zh-CN.md) · [前端面板](frontend.zh-CN.md) · [联动](fullstack.zh-CN.md) · [安装与更新](../guide/packages.zh-CN.md)。

事实源：[作者类型](../../packages/plugin-runtime/src/author.ts)、[manifest 解析](../../packages/package-manager/src/plugin-manifest.ts)、[插件 context facet](../../packages/extension-api/src/plugin-context.ts)、[行 API](../../packages/host-extensions/src/ext-host/row-extension-api.ts)、[ClientContext](../../packages/web-client/src/client-module.ts)。

## 编写 Agent Loop

固定业务流程从 [`defineWorkflowLoop`](../extend/workflow-loops.zh-CN.md) 和 [Loop 模板](../../templates/loop/) 开始，由 helper 负责分阶段 checkpoint、确认与审批续接。下面的底层 factory 合同用于自定义调度。

Agent Loop 负责调度与自身检查点状态。通过 `@agnes/extension-api` 导出 `LoopFactory`（`id`、`version`、`capabilities`、版本化 `codec`、`create(ctx)`、`resume(ctx, checkpoint)`），驱动实现 `step(signal)`、`cancel()`、`dispose()` 与 `checkpoint()`。在插件 apply 中调用 `ctx.providers.register(loopKind, factory)`；`agnes.plugins` 的入口声明 `inject: ["providers"]`。注册归插件 fiber 所有，卸载时移除；`kernel.loops.catalog()` 返回身份、能力与可信来源包。

每一步显式返回 `outcome: 'running' | 'idle' | 'turn-ended' | 'parked'`；`phase` 仅用于展示。`until: 'turn-end'` 在首个轮次结束时停止；`until: 'idle'` 在正常完成后继续处理输入，直到无输入、挂起或其他结束原因。生产 runner 与 `driveLoop` testkit 采用相同规则。用 `ctx.events.finish(reason)` 结束轮次，并返回它给出的结果。关闭轮次的是 Core，不是 driver：`finish('completed')` 先经过所有 Loop 共用的停止门（`turn_stopping` 钩子、verifier 与 repair 决策）。停止门不放行时返回 `running`，原因已写入历史；再走一步（通常是一轮模型）之后才能再次请求完成。没有新的一步就再次请求，轮次以 `blocked`（`STOP_GATE_HELD`）结束，这对没有后续步骤可走的 Loop 是如实的结局。停止门需要询问人时返回 `parked`：Loop 在本轮的工作已经结束，答复到达后由 Core 结束轮次（批准则 `completed`，否则 `blocked`），不会再次执行 driver 的业务步骤。模型或工具端口打开的 step 同样是准入边：步数与额度预算、`before_step` 钩子在这里判定，被拒绝时 Core 结束轮次并抛出带 `detail.reason` 的 `E_BUDGET`。

`ctx.input.claim('next-turn')` 打开或恢复轮次；轮次结束前重复调用返回当前输入。`claim('next-step')` 消费本轮 steer。输入含稳定 `id`、`turnId`、`kind`、`trust`、`actor` 与内容。`ctx.turn.view()` 返回独立且深度冻结的视图：压缩后的可见历史、本轮工具目录与 JSON schema、有效模型及能力、system/runtime 提示词与预算。执行仍受策略和审批约束。

通过 `await ctx.prepareRequest({ system, messages, tools, sampling, invocationId })` 准备请求，再交给 `ctx.model.stream(request, signal)` 或 `complete(request, signal)`。省略 messages 时使用可见历史；tools 指定冻结目录中的精确工具名。Core 负责 route、contract、哈希派生、媒体校验和本轮身份绑定；作者不填写 `contractId`、`derivedHash` 或 `route`。所有循环的模型/工具端口都经过 Core 的最大步数、请求上限及 quote/deny 准入。批量结果保持输入顺序，策略决定可并行的调用。

为请求和工具调用分配稳定 `invocationId`。`ctx.effects.status(id)` 返回 `not-sent`、`may-have-sent` 或含持久响应的 `responded`。通过 `ctx.checkpoints.write(driver.checkpoint(), { invocationIds })` 关联检查点与副作用。重开可复用持久响应；不确定的调用拒绝自动重放。responded 不代表工具成功，也不保证进程外副作用恰好执行一次。

循环还可以向另一个模型发一次性请求，而不触碰对话；见[循环的旁路模型调用](#循环的旁路模型调用)。

`LoopContext` 由两个有文档的面合成。`GenericLoopPorts` 是可替换循环所需的全部端口（模型、工具、决策、副作用回执、输入、事件、检查点、等待/唤醒、作业、子代理、压缩）；把工厂声明为 `GenericLoopFactory` 即证明它不依赖其他端口。`DefaultLoopConvenience`（`turn.continuation`/`checkpoint`/`finishCancelled`/`finishFailure`、`model.respond`、`tools.drain`、`wait.poll`）是绑定 Core ReAct 阶段的粗粒度边，只有默认循环应当依赖。

受控的 `turn.checkpoint`、`model.respond`、`tools.drain` 与延迟等待便捷端口，以及压缩，维护 Core 的账本和恢复不变量。调度器通过 `ctx.turn.continuation()` 选择下一条边，无须接触私有程序计数器；Core 可能新增 continuation 阶段，因此循环必须把未知的 `LoopContinuation` 值视为错误，不能依赖穷尽式 switch。`@agnes/loop-default` 只使用公共上下文，由 Base 发行包的普通插件行注册。`checkpointMode: 'ledger'` 使用 Core 恢复并接受没有驱动检查点的历史会话。有状态驱动默认使用 `'driver'` 模式，恢复前校验 codec 版本。Host 为 `ctx.children` 绑定父会话的 `ChildAgentSessionService`，提供 start/list/message/interrupt/result/events/dispose。省略 providerId 使用 child-agent 配置；每次 start 都检查当前允许名单，继承父工作区、固定代码 generation、预算和工具过滤，子选项只能收窄这些约束。会话关闭会取消并等待已启动或正在启动的子代理清理完成。

有两种调度方式：

| 方式 | 操作与职责 |
| --- | --- |
| 粗粒度边 | 官方默认循环通过 `turn.continuation()` 选择 `turn.checkpoint`、`model.respond`、`tools.drain`、压缩和延迟等待。Core 执行既有模型、工具、门控策略及账本恢复。 |
| 底层端口 | 第三方循环通过输入领取、回合视图、`prepareRequest` + `model.stream`、`tools.batch`、副作用回执、压缩、子代理和等待/唤醒自行管理状态机、响应解析及调度。准入、审批绑定及副作用仍由 Core 管理。[独立 ReAct 示例](../../examples/loops/react-loop/README.md) 不调用任何粗粒度调度边。 |

底层驱动使用 `ctx.events.assistant(message, nextCheckpoint)` 原子提交解析后的助手消息及下一检查点，Core 同时建立工具调用的助手归属。调度前保存稳定工具 id 和停驻意图。工具端口等待同批任务结束、关闭审批停驻回合后抛出 `code: 'PARKED'`，驱动应返回 parked 结果。恢复时 `input.resumeParked()` 打开原审批续点，`tools.resume(invocationId, signal)` 使用既有授权执行原调用。`E_LANE_BUSY` 表示另一张审批决策请求仍需单独续接：保留调用 id，把当前续点以 parked 结束并等待该决策请求。不确定的外部发送拒绝自动重放。压缩前等待副作用结束，并用 `turn.endStep()` 关闭当前步骤。这些操作只执行账本转移，不选择下一调度动作。

可继续的子代理通过事件中的 `idle` 分隔每轮响应；`result()` 等待其生命周期终止。`wait.park` 返回后检查取消并领取 steer。子代理启动回执、上下文估算、唤醒持久性和后台任务结果等待等接口边界，见 ReAct 示例的[底层端口发现清单](../../examples/loops/react-loop/README.md#low-level-port-findings)。

遵守取消信号，dispose 必须幂等。会话关闭先停止准入，再取消并等待活跃驱动/工具工作，允许最终写入，然后关闭 hooks、账本与工作区租约。释放非活跃的账本续点会保留其恢复能力。

新会话选择优先级为显式参数、管理端默认值、配置档的 `providers.loop: { provider, version? }`、`agnes.default@1.0.0`。SDK 使用 `client.createSession({ cwd, loop })` 或 `client.session.new({ cwd, loop })`，CLI 使用 `agh -p "提示词" --loop example.dag@1.0.0`。开始记录固定循环身份；默认值变更仅影响新会话。旧会话映射到默认身份，缺失时明确失败，不会替换循环。参见[计划-执行示例](../../examples/loops/plan-execute-loop/README.md)：非 ReAct 状态机，声明为 `GenericLoopFactory`，通过 `DecisionPort` 请求真人批准，吸收结构化 child-completed `system` 输入，并在拒绝、取消或结果未知时如实结束，其测试是通用端口的一致性参照。参见[独立 DAG 示例](../../examples/loops/dag-loop/README.md)：模型规划、并行波次、依赖汇合与恢复均只依赖公共端口。

`await ctx.plugin(...)`（及 prepared awaitable fiber）在所需服务尚未就绪时以 `DEPENDENCY_UNAVAILABLE` 拒绝，包括循环依赖。fiber 保持 pending，服务到达后仍可激活。`Fiber.await()` 等待当前生命周期迁移稳定，可能返回 pending fiber；判断已加载前须检查状态。异步事件的脱离等待失败通过监听器所属 logger 记录；被等待的分派仍传播错误。

## 循环的旁路模型调用

`ctx.sideCall` 向你指定的路由和模型发一次请求，发生在对话之外。请求不带主系统提示、对话历史、工具，也不套不可信信封，答案也不进入上下文。循环在两步之间需要咨询另一个模型时使用它：决策模型、分类器或第二意见。这个成员在 `LoopContext` 类型里是可选的，测试替身可以不提供；Core 总会提供。

一次调用分两步。`prepare` 校验选项，返回冻结的 `PreparedSideCall`，其中带估算，循环可以在花钱之前先看价格。`invoke` 发送调用。`status` 读回已记录的调用。

```ts
const sideCall = ctx.sideCall
if (!sideCall) return fallback()
const prepared = await sideCall.prepare({
  label: 'jev.decide',
  target: { route: 'jev', model: modelId },
  payload: { state, questions },
  output: 'json',
  deadlineMs: 10_000,
  invocationId: `decide-${turnId}-${attempt}`,
})
if ((prepared.estimate.projectedCredits ?? 0) > creditLimit) return fallback()
const result = await sideCall.invoke(prepared, signal)
if (result.status === 'ok') return useAnswers(result.json)
if (result.status === 'failed' && result.retryable) return retryWithNewId()
return fallback()
```

`state`、`questions`、`modelId`、`turnId`、`attempt`、`creditLimit`、`signal`、`fallback`、`useAnswers` 和 `retryWithNewId` 代表循环自己的值和辅助函数。超出范围的选项在 `prepare` 时被拒绝，不会被截断。

| 选项 | 含义 |
| --- | --- |
| `label` | 你自定的用途标签，随调用一起记录，例如 `jev.decide`。匹配 `/^[a-z][a-z0-9._-]{0,63}$/`。 |
| `target` | `{ route, model }`，二者都必须在已装配的模型目录里。不接受槽位名。 |
| `deadlineMs` | 整次调用的时限，由 Core 竞速。100 到 120000 毫秒，缺省 10000。 |
| `system`、`messages`、`sampling` | 原样发出。`system` 至多 1 MiB。只允许 `user` 和 `assistant` 消息；assistant 消息不带 `toolCalls`，`tool_result` 块被拒绝。图片要求目标模型记录的 `input` 列表包含 `image`。 |
| `payload` | 结构化 JSON，作为 `RequestBody.payload` 原样交给适配器。规范 JSON 至多 1 MiB。 |
| `output` | `'json'` 让 Core 把返回文本解析成 `result.json`。缺省 `'text'`。 |
| `invocationId` | 稳定 id，效果编号为 `side:<invocationId>`。匹配 `/^[A-Za-z0-9][A-Za-z0-9._:@-]{0,122}$/`，且不得像凭据。省略时由 Core 生成。 |

### 目标与适配器能力

目标路由背后的适配器在注册时用 `capabilities` 声明请求可以带什么（见[模型适配器包](#模型适配器包)）：

| 标志 | 对旁路调用的含义 |
| --- | --- |
| `imageInput` | 适配器读取图片块。`prepare` 检查的是目标模型记录，不是这个标志：带图片块的旁路调用要求模型记录的 `input` 列表包含 `image`，否则 `prepare` 抛出 `E_ENVELOPE`，`detail.reason` 为 `image-input`。 |
| `tools` | 适配器处理工具调用。旁路调用从不发送工具。 |
| `streaming` | 适配器边生成边流式返回事件。旁路调用对流式和非流式适配器都适用，答案完整后返回一次。 |
| `payload` | 适配器读取 `RequestBody.payload`。没有它时，AI 门面在发送前就拒绝带 payload 的请求：结果是 `failed`，`reason: 'adapter-error'`，`code: 'CONTRACT_MISMATCH'`，`dispatch: 'not-sent'`。 |
| `payloadOnly` | 适配器只接受 payload，不接受消息。要求 `payload: true`。对话模型选择入口不列出这类适配器的模型，所以只有旁路调用能到达它们。 |

内置的 Jev 适配器注册为 `typesafe-systemone`，声明 `imageInput: false`、`tools: false`、`streaming: false`、`payload: true` 和 `payloadOnly: true`。把路由的 `api` 设为 `typesafe-systemone`，在 `target` 里写这条路由和它的一个模型，发送 `payload: { state, questions }`，不带 `system` 和 `messages`。适配器每次调用只发一个 HTTP 请求，把答案作为 JSON 文本返回，所以请求 `output: 'json'`，即可在 `result.json` 里拿到答案。路由的 `baseUrl` 和凭据来自你的配置档，不由循环提供。

### 结果与错误

`invoke` 返回一个结果。厂商、时钟或调用方对一次调用做的任何事，都以状态返回；`invoke` 只在用法错误时抛出，而此时什么都没有写入。

| `status` | 含义 |
| --- | --- |
| `ok` | `text`；`output` 为 `'json'` 时还有解析后的 `json`；以及 `usage`、`latencyMs` 和厂商回报的 `response` id 与模型。 |
| `failed` | `reason` 为 `deadline`、`cancelled`、`adapter-error` 或 `invalid-output`。有 AI 错误码时带 `code`。`dispatch` 为 `not-sent` 或 `may-have-sent`。调用经正常终态结算时带 `usage`：观察到的用量，或没有观察到用量且目录有价格时的估算（`creditSource: 'estimated'`）。因循环的执行作用域被撤销而收尾的调用不带 `usage`，但它的成本行已写入。 |
| `refused` | `reason` 为 `budget` 或 `usage-unrecorded`。什么都没写：没有意图行、没有成本行、没有调用适配器。 |
| `unknown` | `reason` 为 `interrupted`：进程在记录结果之前停止，调用可能到达厂商，也可能没有。它不会被再次发送。 |

`failed` 结果的 `retryable`：`deadline` 为 true，`cancelled` 和 `invalid-output` 为 false，`adapter-error` 沿用适配器自己的标志。

错误都在写入任何内容之前抛出，所以抛出意味着什么都没有记录：

- `prepare` 对越界的选项抛出 `E_ENVELOPE`（`detail.reason`：`label`、`deadline`、`payload-size`、`messages`、`image-input` 或 `invocation-id`），目标不在 provider 目录里时抛出 `E_MODEL_UNKNOWN`（`target-unknown`）。另有几个 `E_ENVELOPE` 原因：`output`（既不是 `'text'` 也不是 `'json'`）、`system`（不是至多 1 MiB 的字符串）和 `sampling`（键或值超出请求 schema 的范围）。
- `invoke` 的 signal 不是 `AbortSignal` 时抛出 `E_ENVELOPE`（`signal`）。
- 不在已打开的回合内时，`prepare` 和 `invoke` 抛出 `E_RELATION`（`no-turn`）。
- 调用由另一个上下文或回合准备时，`invoke` 抛出 `E_REQUEST_FROZEN`（`foreign`、`turn`）；`prepare` 之后目录记录或适配器身份变了，同样抛出（`target-changed`）。`invocationId` 已有记录但 `requestHash` 不同时抛出 `E_RELATION`（`invocation-reused`），本进程内正在运行时也抛出 `E_RELATION`（`invocation-in-flight`）。会话暂停时抛出 `E_LANE_BUSY`（`CONTROL_PAUSED`），已准备的调用不被消耗，可以再次 `invoke`。
- 会话正在关闭，或循环的执行作用域已被撤销后，每个方法都抛出 `E_CLOSED`。
- 还有调用没有结算时，`ctx.events.finish` 抛出 `E_RELATION`（`side-call-in-flight`）。同一回合内的调用可以并发；结束回合之前先等它们完成。

### 调用 id、时限与重试

调用 id 让调用幂等。用同一个 id 和同一个请求再次 `invoke`，返回已记录的结果（`replayed: true`），不再发送。同一个 id 配不同的请求，抛出 `invocation-reused`。恢复前后保持 id 稳定；决定是否再次调用之前，先看 `ctx.sideCall.status(id)`（`absent`、`in-flight` 或 `finished`）。进程停止时仍在进行的调用，读回来是 `unknown`，原因 `interrupted`，不会再次发送。

`deadlineMs` 限定整次调用。时限由 Core 计时，所以忽略取消的适配器也会在时限到时被切断：结果是 `failed`，原因 `deadline`，错误码 `TIMEOUT`。

Core 和适配器都不重试旁路调用。重试由循环决定：换一个新的 `invocationId` 再调用（旧 id 一直返回它已记录的失败），只对 `retryable` 的失败重试，把尝试次数控制得很小，本步骤没有时间时回落到循环自己的行为。

### 平台处理的部分

每个已发送的调用留下一行用途为 `side-call` 的成本行，计入额度和预算。它记录观察到的用量；没有观察到花费时（时限到、被取消、没有用量的适配器错误），记录 `prepare` 给出的估算价。账本保存摘要和审计元数据（标签、路由、适配器、端点主机），不保存请求内容。

撤销、用户 Stop 和会话关闭，不需要循环写任何代码。Stop 和关闭会切断调用并记录；如果调用进行中循环的执行作用域被撤销（例如循环被替换），Core 用迟到回执收尾，旧上下文的方法抛出 `E_CLOSED`。替换后的新一代用 `status` 读回这条记录。把 `E_CLOSED` 和 `cancelled` 结果都当作本步骤的结束。

### 测试使用旁路调用的循环

`@agnes/host/author-testkit` 的 `driveLoop` 接受 `sideCall` 选项：由你的测试编写的假 `LoopSideCallPort`。不传时 `ctx.sideCall` 是 `undefined`。要在真实执行路径上检查循环，调用 `verifyLoopExecutionContract(factory, { sideCall: true })`。它通过循环自己的上下文，对它自己定义的只接受 payload 的适配器发起旁路调用，覆盖成功、时限、循环取消与会话 Stop 取消、被撤销的循环代际，以及估算成本行。
