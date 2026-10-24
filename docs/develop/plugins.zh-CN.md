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
      { "apiRange": "^5.0.0", "export": "example", "id": "ext:example/plugin", "inject": ["skills"] }
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

每一步显式返回 `outcome: 'running' | 'idle' | 'turn-ended' | 'parked'`；`phase` 仅用于展示。`until: 'turn-end'` 在首个轮次结束时停止；`until: 'idle'` 在正常完成后继续处理输入，直到无输入、挂起或其他结束原因。生产 runner 与 `driveLoop` testkit 采用相同规则。用 `ctx.events.finish(reason)` 结束轮次，并返回它给出的结果。关闭轮次的是 Core，不是 driver：`finish('completed')` 先经过所有 Loop 共用的停止门（`turn_stopping` 钩子、verifier 与 repair 决策）。停止门不放行时返回 `running`，原因已写入历史；再走一步（通常是一轮模型）之后才能再次请求完成。没有新的一步就再次请求，轮次以 `blocked`（`STOP_GATE_HELD`）结束，这对没有后续步骤可走的 Loop 是如实的结局。校验发现内容问题后最多自动修正一次，再次未通过则 `blocked`，不会询问人是否接受完成。修复策略明确返回的 `complete` 会保留，并如实记录未通过的校验；校验或修复服务不可用时结束本轮并标记未能校验。业务决策仍可通过自己的决策端口挂起。模型或工具端口打开的 step 同样是准入边：步数与额度预算、`before_step` 钩子在这里判定，被拒绝时 Core 结束轮次并抛出带 `detail.reason` 的 `E_BUDGET`。

`ctx.input.claim('next-turn')` 打开或恢复轮次；轮次结束前重复调用返回当前输入。`claim('next-step')` 消费本轮 steer。输入含稳定 `id`、`turnId`、`kind`、`trust`、`actor` 与内容。`ctx.turn.view()` 返回独立且深度冻结的视图：压缩后的可见历史、本轮工具目录与 JSON schema、有效模型及能力、system/runtime 提示词与预算。视图还有 `toolMeta`，即目录里每个工具静态的只读、破坏性与开放世界事实，外加 `offered`（点名这个工具的请求是否会为当前模型保留它）；以及 `disclosedTools`，即此刻一个不带 `tools` 的请求会发送的名字。`disclosedTools` 的顺序就是请求发送它们的顺序。两个字段在类型上都是可选的，所以视图的测试替身可以不填；Core 总会填。执行仍受策略和审批约束。

通过 `await ctx.prepareRequest({ system, messages, tools, sampling, invocationId, tailNote })` 准备请求，再交给 `ctx.model.stream(request, signal)` 或 `complete(request, signal)`。省略 messages 时使用可见历史；tools 指定冻结目录中的精确工具名（每次请求传同一组名字，目录就保持稳定），`tailNote` 在请求末尾加一条尾注，见[从循环塑造请求](#从循环塑造请求)。Core 负责 route、contract、哈希派生、媒体校验和本轮身份绑定；作者不填写 `contractId`、`derivedHash` 或 `route`。所有循环的模型/工具端口都经过 Core 的最大步数、请求上限及 quote/deny 准入。批量结果保持输入顺序，策略决定可并行的调用。

为请求和工具调用分配稳定 `invocationId`。`ctx.effects.status(id)` 返回 `not-sent`、`may-have-sent` 或含持久响应的 `responded`。通过 `ctx.checkpoints.write(driver.checkpoint(), { invocationIds })` 关联检查点与副作用。重开可复用持久响应；不确定的调用拒绝自动重放。responded 不代表工具成功，也不保证进程外副作用恰好执行一次。

循环还可以向另一个模型发一次性请求，而不触碰对话；见[循环的旁路模型调用](#循环的旁路模型调用)。循环自己选定、没有模型回复在背后的工具调用，可以连同它自己的助手消息一起记录；见[公告一次工具调用](#公告一次工具调用)。

`LoopContext` 由两个有文档的面合成。`GenericLoopPorts` 是可替换循环所需的全部端口（模型、带 `announce` 选项的工具、通过 `sideCall.prepare/invoke/status` 发起的旁路模型调用、决策、副作用回执、输入、事件、检查点、等待/唤醒、作业、子代理、压缩）；把工厂声明为 `GenericLoopFactory` 即证明它不依赖其他端口。`DefaultLoopConvenience`（`turn.continuation`/`checkpoint`/`finishCancelled`/`finishFailure`、`model.respond`、`tools.drain`、`wait.poll`）是绑定 Core ReAct 阶段的粗粒度边，只有默认循环应当依赖。

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

## 从循环塑造请求

底层循环有三个选项，决定模型请求列出什么、历史怎样记录：请求的 `tools` 名字、请求末尾的尾注，以及对一次工具调用的公告。三者都是可选的。不使用它们的循环，发出的请求与这些选项出现之前逐字节相同。下面的片段在 driver 的某一步里运行；`ctx` 是循环的 `GenericLoopPorts`，`turnId`、`round`、`signal` 等名字代表循环自己的值。

### 稳定的工具目录

Core 在回合开始时取得工具目录，并在这个回合内冻结。之后注册或移除的工具（例如连上的 MCP 服务器、加载的插件）从下一个回合起才出现。回合进行到一半时进程重启，目录会按当时已注册的工具重新取得。

请求列出什么，取决于 `tools`：

- 不传 `tools` 时，请求列出此刻已披露的工具：可见且未延迟的工具，加上本会话里 `tool_describe` 已加载的每个延迟工具，再按预设的 `disclosure` 设置收窄。加载会跨回合保留，重开之后也保留。模型在两次请求之间加载了一个工具，第二次请求就多列一个工具，之后不传 `tools` 的每次请求也都列出它，本回合和之后的回合都是如此。工具字节随之改变，`tool_schema_hash` 也变，提供方缓存的前缀不再匹配。
- 传了 `tools` 时，请求恰好列出这些名字。Core 按名字排序，所以你传入的顺序无关紧要。在同一个回合内，传同一组名字的每次请求，工具字节和 `tool_schema_hash` 都逐次相同，不论模型在其间加载了什么。跨回合时，只要这些工具各自的名字、描述和参数 schema 没有变，它们同样保持相同。

```ts
// 每个回合一次：从本回合的目录里选定名字，并存进你的检查点。
const view = await ctx.turn.view()
const catalog = new Set(view?.tools.map((tool) => tool.name))
const toolNames = ['read', 'tool_search', 'tool_describe'].filter((name) => catalog.has(name))

// 本回合的每次请求：传同一组名字。
const request = await ctx.prepareRequest({ tools: toolNames, invocationId })
```

`'read'` 代表你自己的工具。`ctx.turn.view()` 列出本回合的整个目录，包括延迟工具，所以请挑选要发送的名字，不要全部传入。

想提供默认循环提供的那些工具，就从 `view.disclosedTools` 出发，而不是自己列一份：它已经略去了尚未加载的延迟工具、对模型不可见的工具，以及模型不接受图片时的 computer-use 工具。模型用 `tool_describe` 加载一个延迟工具后，它会多出这个名字；把新名字加进你的那组名字，工具字节改变一次。内置的 `ls`、`find` 和 `grep` 还会在 `structured` 里返回它们显示的路径（`ToolPathReferences`，schema 为 `agh.path-references/1`），循环不必解析文本就能把它们作为目标提供；模型只看到文本。任何工具的结果只要 `structured` 带这个 schema，`run_code` 脚本拿到的就是它的文本。列表的限制见[默认工具](../reference/default-tools.zh-CN.md#path-references)。

名字不在本回合目录里时，`prepareRequest` 抛出 `E_ENVELOPE`。目录是冻结的，所以回合进行中被注销的工具仍留在本回合的目录里，请求还可以点它的名字。这个错误出现在之后的回合里，或回合进行到一半时进程重启之后，因为那时会重新取得目录。循环要自己处理它，例如从 `ctx.turn.view()` 重新选名字。名字在目录里、但不向模型提供的工具会被请求略去，例如标记为对模型不可见的工具，或模型不接受图片时的 computer-use 工具。回合中途由模型通过 `tool_describe` 加载的工具，不会加进你已固定名字的请求；想让它被提供，就把它的名字加进这组名字，这会让字节改变一次。这条保证以同一个槽位和同一个模型为前提：computer-use 过滤取决于该槽位的模型，换模型可能改变列表。

这条保证针对请求的 `tools`。系统提示列出整个目录里的延迟工具，并告诉模型使用 `tool_search` 和 `tool_describe`。这份列表来自目录，而不是 `tools`，所以传名字不会改变它，它在同一回合内也不会改变。如果目录里有延迟工具，而你的名字漏掉了这两个发现工具，提示就会把模型指向它调用不了的工具。把两个名字都包含进去，或者接受这处不一致。

### 尾注

`tailNote` 在请求的最末尾追加一条用户侧消息，位于可见历史之后，也位于 Core 自己的每请求附注（运行时上下文、钩子上下文和技能附注）之后。系统提示、工具、`prompt_prefix_hash` 和 `tool_schema_hash` 与没有尾注时相同。

```ts
const request = await ctx.prepareRequest({
  tools: toolNames,
  tailNote: { text: `Round ${round} of ${maxRounds}: answer with JSON only.`, commit: true },
})
```

| 字段 | 含义 |
| --- | --- |
| `text` | 1 到 32768 个 UTF-8 字节。清洗之后不得以 Core 附注前缀开头：`[runtime context]`、`[hook context]`、`[hook data]`、`[nested result]` 或 `[skill loaded]`，后面各跟一个换行。 |
| `commit` | 缺省 `false`：尾注只属于这一次请求。`true`：尾注同时写入历史，见下文。与自带的 `messages` 同时使用会被拒绝。 |

无效的尾注使 `prepareRequest` 在写入任何内容之前抛出 `E_ENVELOPE`。`driveLoop` 的假 `prepareRequest` 不会把尾注加进它记录的请求；要测试尾注，请用完整会话 fixture。

**信任级别。** Core 像清洗 `system` 文本一样清洗尾注：零宽字符、聊天模板的特殊 token 和任何写法的不可信信封标签，都会被移除或替换。Core 从不把尾注包进不可信信封。模型把尾注当作循环自己的指令来读，这正是尾注的用途。如果循环在尾注里引用不可信内容（工具结果、文件名、抓取的文本），这部分内容由循环负责：Core 不会把引用标记为数据。请自己把引用标明为数据，或者不要把它放进尾注。

**不带 `commit`** 时，尾注只随这一次请求发送。下一次请求的历史不含它，所以下一次请求从尾注起不再延续这一次，提供方的缓存在那里不再匹配。

**带 `commit: true`** 时，Core 在把请求记为已发送的同一个事务里，把尾注写成一行历史。之后的请求把它当作普通的用户轮次，放在同一个位置，因此每个请求都是下一个请求的前缀。请求之后即使失败，这一行也保留，因为请求已被记为已发送。Core 在发送之前就拒绝的请求（例如预算拒绝）不写尾注。请求一旦发送，用同一个 `invocationId` 再次发送同一个已准备的请求，返回已记录的结果，什么也不写。等没有工具调用还在运行时再发送带 `commit` 的尾注：在尾注之后记录的结果，在之后的请求里会排到尾注之前。

**提交尾注之后续跑。** 已提交的尾注现在是历史的一部分，所以用同一个 `invocationId` 再次准备请求，得到的是另一个请求，发送它会抛出 `E_RELATION`。重启之后，先读 `ctx.effects.status(invocationId)`。状态是 `responded` 时，使用已记录的 `result`，不要再次准备请求。状态是 `may-have-sent` 时，请求可能已经到达模型，Core 拒绝用同一个 id 再次发送，所以也在这里停下。

```ts
const recorded = await ctx.effects.status(invocationId)
if (recorded.status === 'responded') return recorded.result
// 请求可能已经到达模型：不要用这个 id 再次准备或发送。
if (recorded.status === 'may-have-sent') return undefined
const request = await ctx.prepareRequest({ invocationId, tailNote: { text: note, commit: true } })
return ctx.model.complete(request, signal)
```

**其他槽位。** 发往 `primary` 以外槽位（例如 `fast`、`verifier` 或 `compaction`，用 `slot` 指定）的请求，带 `commit: true` 的尾注照样写进主对话历史。Core 自己的运行时上下文附注和钩子附注在这类请求上也是这样。Core 不做检查，由循环作者负责。必须留在对话之外的请求应该走 [`ctx.sideCall`](#循环的旁路模型调用)，它不接受尾注。

### 公告一次工具调用

`ctx.tools.execute(call, signal, options)` 和 `ctx.tools.batch(calls, signal, options)` 接受可选的第三个参数。不传时，循环自己选定的调用独立记录。它被挂到本回合最近的一条助手消息上，而那条消息并没有要求过它；本回合还没有助手消息时，则挂到本回合的输入上。传 `announce` 时，Core 把这次调用（或整批调用）记成一条新的、要求了它的助手消息。你用 `ctx.events.assistant` 提交的模型回复所要求的调用，不需要公告。

```ts
// 循环自己选定了这次调用：一条没有文本的助手消息，加上这次调用。
const result = await ctx.tools.execute(
  { invocationId: `check-${turnId}-${attempt}`, name: 'read', args: { path } },
  signal,
  { announce: true },
)

// 模型在调用旁边写了一段文本，循环解析出调用并自己派发。
const results = await ctx.tools.batch(calls, signal, {
  announce: { content: [{ type: 'text', text: reply }] },
})
```

`announce: true` 写入一条没有文本的助手消息。`announce: { content }` 保留模型在调用旁边产生的文本块和思考块；不允许其他块类型，否则 Core 抛出 `E_ENVELOPE`。`content` 是受信助手框架里的模型输出：Core 在渲染请求时清洗它，不把它包成不可信数据。

**一个事务。** Core 先写助手消息，再写调用行，全部在一个账本事务里，且在任何东西运行之前。历史里不会出现没有调用的消息，也不会出现没有消息的调用。

**写入之前先拒绝。** Core 先检查每一次调用：工具在本回合目录里且主模型可以使用，参数符合它的 schema，策略可以解析，预算允许。任何一次调用没通过检查，就什么都不写。同一批里两次使用同一个 `invocationId`，也会在写入任何内容之前被 `E_RELATION` 拒绝。回合里还有调用或效果没有结算时，新的公告会被 `E_RELATION` 拒绝：先结算前面的调用。

**审批和策略不变。** 每个被公告的调用仍然经过审批、工具策略、钩子和沙箱，与其他调用一样。使回合停驻的审批照常工作：调用抛出 `PARKED`，`input.resumeParked()` 之后用 `tools.resume(invocationId, signal)` 完成它。

**重放。** 给每个被公告的调用一个稳定的 `invocationId`，并用相同的名字、参数和 `announce` 选项重放。回执只覆盖这三者，不覆盖 `content`。如果进程死在公告已提交、工具尚未派发之前，这个调用就是已规划但从未派发：

- 先重放它，也就是在准备请求或进行任何其他模型调用、工具调用之前，它会根据已记录的调用运行一次，运行在规划它的那个步骤里。规划行不会再写一遍。
- 否则 Core 用一个错误结果把它收尾。这发生在它的步骤结束时，或下一次模型请求准备之前，所以历史里不会出现没有结果的调用。历史里的 `tool/result` 行带有错误码 `TOOL_NOT_STARTED`，模型读到的文本是 `<name> was announced but did not run`。之后再重放这个 id，不会运行工具；它返回一个 `ToolResult`，内容就是这段文本，`isError: true`。`ToolResult` 没有 `code`，所以要到历史里找这个错误码，不要找 `result.code`。仍想执行这次调用，就用新的 `invocationId` 再公告一次。

已经派发的调用不受上述规则影响：它遵循不确定调用的通常规则，在 Core 的恢复把它结算之前，`ctx.effects.status` 报告 `may-have-sent`，重放被拒绝。如果回执已写入、而消息和调用行没有写入（进程死在这两者之间），这个 id 一直被拒绝；当时什么都没运行，换一个新的 `invocationId` 重新开始。

**测试。** `@agnes/host/author-testkit` 的 `driveLoop` 以简单的方式支持 `announce`：它先把这次调用（或这一批）在 `events` 里记成一个 `assistant/message` 事件，`stopReason` 为 `'tool_use'`，并把选项连同每次调用传给你的测试编写的 `tools.execute`。它不模拟重放、未结算调用的检查和审批。

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
| `system`、`messages`、`sampling` | 原样发出。`system` 至多 1,048,576 个 UTF-16 码元。只允许 `user` 和 `assistant` 消息；assistant 消息不带 `toolCalls`，`tool_result` 块被拒绝。图片要求目标模型记录的 `input` 列表包含 `image`。 |
| `payload` | 结构化 JSON，作为 `RequestBody.payload` 原样交给适配器。只接受普通 JSON 数据：规范 JSON 至多 1 MiB，嵌套不超过 32 层，不能含 `Date` 或类实例。违反其中任何一条，都以 `payload-size` 拒绝。 |
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

`invoke` 返回一个结果。厂商、时钟或调用方对一次调用做的任何事，都以状态返回；`invoke` 只在用法错误时抛出，而此时什么都没有写入；`E_CLOSED` 除外，循环的作用域被撤销时，它也可能终结一个已经发出的调用，替换后的上下文用 `status` 读回该调用。

| `status` | 含义 |
| --- | --- |
| `ok` | `text`；`output` 为 `'json'` 时还有解析后的 `json`；以及 `usage`、`latencyMs` 和厂商回报的 `response` id 与模型。 |
| `failed` | `reason` 为 `deadline`、`cancelled`、`adapter-error` 或 `invalid-output`。有 AI 错误码时带 `code`。厂商要求等待时（例如限流的 `retry-after`），`adapter-error` 带 `retryAfterMs`：先等这么多毫秒，再用新的 `invocationId` 重试。它是整数毫秒，至多一小时，向上取整；更长或无效的提示会被丢弃，所以没有 `retryAfterMs` 并不表示厂商没有要求等待。`dispatch` 为 `not-sent` 或 `may-have-sent`。调用经正常终态结算时带 `usage`：观察到的用量，或没有观察到用量且目录有价格时的估算（`creditSource: 'estimated'`）。因循环的执行作用域被撤销而收尾的调用不带 `usage`，但它的成本行已写入。 |
| `refused` | `reason` 为 `budget` 或 `usage-unrecorded`。什么都没写：没有意图行、没有成本行、没有调用适配器。 |
| `unknown` | `reason` 为 `interrupted`：进程在记录结果之前停止，调用可能到达厂商，也可能没有。它不会被再次发送。 |

`failed` 结果的 `retryable`：`deadline` 为 true，`cancelled` 和 `invalid-output` 为 false，`adapter-error` 沿用适配器自己的标志。

后续版本中 Core 可能为 `SideCallResult` 新增状态或原因，所以遇到不认识的值要当作错误处理，不要依赖穷尽式 `switch`。

`prepare` 的错误，以及 `invoke` 在发送之前的错误，都在写入任何内容之前抛出，所以这样的抛出意味着什么都没有记录。调用一旦发出，怎样结束都以结果返回，不再抛出，有两个例外：一是 `E_CLOSED`（见下面的列表），二是账本本身写入失败，会话重开后调用读回为 `unknown`：

- `prepare` 对越界的选项抛出 `E_ENVELOPE`（`detail.reason`：`label`、`deadline`、`payload-size`、`messages`、`image-input` 或 `invocation-id`），目标不在 provider 目录里时抛出 `E_MODEL_UNKNOWN`（`target-unknown`）。`payload-size` 也用于嵌套超过 32 层的 payload，以及不是普通 JSON 数据的值，例如 `Date` 或类实例。另有几个 `E_ENVELOPE` 原因：`output`（既不是 `'text'` 也不是 `'json'`）、`system`（不是至多 1,048,576 个 UTF-16 码元的字符串）和 `sampling`（键或值超出请求 schema 的范围）。
- `invoke` 的 signal 不是 `AbortSignal` 时抛出 `E_ENVELOPE`（`signal`）。`status` 收到不符合调用 id 格式、或像凭据的 id 时抛出 `E_ENVELOPE`（`invocation-id`）。
- 不在已打开的回合内时，`prepare` 和 `invoke` 抛出 `E_RELATION`（`no-turn`）。只有回合结束时发现还有调用在进行、正在等它们结算的那段时间，`invoke` 才抛出 `E_RELATION`（`turn-closing`）；回合结束之后再发起的调用找不到回合，抛出 `no-turn`。
- 调用由另一个上下文或回合准备时，`invoke` 抛出 `E_REQUEST_FROZEN`（`foreign`、`turn`）；`prepare` 之后目录记录、路由的 base URL 或适配器身份变了，同样抛出（`target-changed`）。`invocationId` 已有记录但 `requestHash` 不同时抛出 `E_RELATION`（`invocation-reused`），本进程内正在运行时也抛出 `E_RELATION`（`invocation-in-flight`）。会话暂停时抛出 `E_LANE_BUSY`（`CONTROL_PAUSED`），已准备的调用不被消耗，可以再次 `invoke`。
- 会话正在关闭，或循环的执行作用域已被撤销后，每个方法都抛出 `E_CLOSED`。这是唯一可能在调用已发出之后才出现的错误：调用进行中作用域被撤销时，Core 仍会记录这次调用（意图行、迟到回执和估算成本行），替换后的上下文用 `status` 读回它。决定是否再次调用之前先读回；换一个新 id 重试，会为同一次调用付两次钱。
- 还有调用没有结算时，`ctx.events.finish`（`E_RELATION`，`side-call-in-flight`）、`ctx.turn.endStep`（不带 `detail.reason` 的 `E_RELATION`）、`ctx.events.assistant`，以及带 `announce` 的 `tools.execute` / `tools.batch` 都会被拒绝。同一回合内的调用可以并发；结束步骤或回合之前，先等每个调用完成。

### 调用 id、时限与重试

调用 id 让调用幂等。用同一个 id 和同一个请求再次 `invoke`，返回已记录的结果（`replayed: true`），不再发送。同一个 id 配不同的请求，抛出 `invocation-reused`。恢复前后保持 id 稳定；决定是否再次调用之前，先看 `ctx.sideCall.status(id)`（`absent`、`in-flight` 或 `finished`）。进程停止时仍在进行的调用，读回来是 `unknown`，原因 `interrupted`，不会再次发送。

`deadlineMs` 限定整次调用。时限由 Core 计时，所以忽略取消的适配器也会在时限到时被切断：结果是 `failed`，原因 `deadline`，错误码 `TIMEOUT`。

Core 和适配器都不重试旁路调用。重试由循环决定：换一个新的 `invocationId` 再调用（旧 id 一直返回它已记录的失败），只对 `retryable` 的失败重试，把尝试次数控制得很小，本步骤没有时间时回落到循环自己的行为。

### 平台处理的部分

每个已发送的调用留下一行用途为 `side-call` 的成本行，计入额度和预算。它记录观察到的用量；没有观察到花费时（时限到、被取消、没有用量的适配器错误），记录 `prepare` 给出的估算价。账本保存摘要和审计元数据（标签、路由、适配器、端点主机），不保存请求内容。

会话额度和目标额度只在步骤之间检查，所以拦不住同一步骤内的多次旁路调用。发送之前，Core 只在估算超过单次请求上限、或树预算已没有余量时拒绝调用，结果是 `refused`，原因 `budget`。一旦设置了单次请求上限，没有目录价格的目标一定被拒绝，因为无法证明它的估算在上限之内。在一个步骤里发多次调用的循环，应自己计数或设上限，或者配置树预算。

撤销、用户 Stop、会话关闭和回合结束，不需要循环写任何代码。它们都会切断仍在进行的调用并记录。调用进行中回合结束时（例如步骤抛出异常，或循环把回合作为取消结束），回合先等这条记录写完再结束，最多等五秒。如果调用进行中循环的执行作用域被撤销（例如循环被替换），Core 用迟到回执收尾，旧上下文的方法抛出 `E_CLOSED`。替换后的新一代用 `status` 读回这条记录。把 `E_CLOSED` 和 `cancelled` 结果都当作本步骤的结束。

### 测试使用旁路调用的循环

`@agnes/host/author-testkit` 的 `driveLoop` 接受 `sideCall` 选项：由你的测试编写的假 `LoopSideCallPort`。不传时 `ctx.sideCall` 是 `undefined`。要在真实执行路径上检查循环，调用 `verifyLoopExecutionContract(factory, { sideCall: true })`。它通过循环自己的上下文，对它自己定义的只接受 payload 的适配器发起旁路调用，覆盖成功、时限、循环取消与会话 Stop 取消、被撤销的循环代际，以及估算成本行。
