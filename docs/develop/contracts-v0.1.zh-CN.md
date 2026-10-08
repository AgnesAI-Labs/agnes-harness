# v0.1 公开合同冻结候选

[English](contracts-v0.1.md) | 简体中文

[插件架构](architecture-plugins.zh-CN.md) · [作者指南](../extend/README.zh-CN.md) · [版本规则](../maintainers/versioning.zh-CN.md)

本文是首个**产品 v0.1** 标签的公开合同清单与就绪评估，描述本分支候选，包括构造生命周期加固与默认 provider 特例移除。此前仅文档清单对应源码 `cbb0eefa99e0218e5c6fac6e87ab50c9a7f71eae`。Extension API 保持 **1.4.0**。本候选不代表已发行，也不代表 provider 可以无条件冻结：下文未关闭项仍需验收。

## 稳定性与兼容政策

**stable** 表示已建立、拟在 v0.1 中给予兼容保护的作者合同；**experimental** 表示仍演进的合同，使用时必须对齐源码、示例与 testkit 版本。两种标签都不代表生产就绪、平台支持、任意插件隔离或 npm 可用。候选政策在维护者接受产品冻结时生效；已有预览版本仍遵循[预览版本政策](../maintainers/versioning.zh-CN.md)。

已接受的 stable 合同在公开包中遵循 semver：不兼容签名、删除、缩小可接受输入或改变可观察保证须升主版本；兼容新增升次版本；兼容修复升补丁版本。产品 `v0.1` 不会将 extension API `1.4.0` 重新编号。experimental 修改也必须给出变更与迁移说明，即使预览版本号暂不变。仓库的已发布包 semver 规则也适用于 experimental 出口，本候选不新增已发布包例外。已发布的 stable 接口不能靠改标 experimental 来绕过主版本规则。

弃用说明必须在 API changelog 与双语指南中写明旧名称、替代方案、兼容窗口和迁移办法。stable 别名至少保留至后续一个次版本发行，且只能在主版本中删除。安全原因的例外须明确发行说明与恢复步骤。本文不为 `ModelAdapter.api`（改用 `wireApi`）、目录 `api`、`defineProviderKind` 输入 `restartRequired`（改用 `scope`；重启要求由它推导）指定删除日期。现有顶层配置拼法继续支持。插件 checkpoint 和数据迁移需要各自的兼容决定；升级包或迁移 generation 不会自动迁移 schema。

| 身份 | 含义与准入 |
| --- | --- |
| 包名/版本 | 分发身份与依赖兼容，独立于 provider 身份 |
| Provider `id` / `version` | 算法身份，版本必须可解析为 semver；Loop 支持多个 `id@version` 注册 |
| `apiRange` / `API_VERSION` | 作者合同兼容；文件系统普通插件导入前从静态包元数据检查 |
| `codecVersion` | Loop 自有 JSON 状态格式；恢复执行前解码，不支持则拒绝 |
| 完整性/code digest、generation id、composition hash | 已校验内容与会话绑定，不是 semver 或权限授予 |
| `wireApi` | 模型传输格式；`Route.api` 选择 adapter 注册 id，不是 extension API 兼容版本 |

`satisfiesApiRange` 支持精确 semver、空白分隔的比较符（交集）、`^`、`~`、`*` 和数字 `x`/`*` 通配。不实现 npm 的完整范围语法：不支持并集、连字符范围与预发行版本准入。使用经过测试的范围，例如 `^1.4.0`。见[实现](../../packages/extension-api/src/api-range.ts)。

## 公开合同清单

作者通过声明的包出口导入合同。[Extension API 根入口](../../packages/extension-api/src/index.ts)维护类型出口与[运行时快照](../../packages/extension-api/api-surface.json)；Protocol 维护 wire schema 与生成参考。仅类型出口也是公开 API，即使不出现在 `Object.keys()` 和运行时快照中。

| 合同 / 所属源码 | 标签 | 合同边界 |
| --- | --- | --- |
| [工具定义与元数据](../../packages/extension-api/src/tool.ts)：`ToolDef`、`ToolMeta`、`ToolResult`、`ResolvedToolCallPolicy`、`defineTool`、校验与策略解析 | stable | 参数/结果 schema、调用安全分类、replay/risk、并发元数据和输出上限；分类不能签发 Host 权限 |
| [工具调用上下文](../../packages/extension-api/src/tool.ts)：`ToolContext`、FS/exec/net/artifact/授权/session 端口 | stable | Host 绑定的 actor/工作区、审批、lease、取消与输出限制；缺失能力就是不支持 |
| 工具上下文可选 `runtime`/`codeRuntime`、流式 `sandbox.openProcess`、子代理后续消息、`net.fetchPublic` | experimental | 各功能独立的可用性与生命周期；声明不等于已装配后端 |
| [扩展构造](../../packages/extension-api/src/extension.ts)、[普通插件 facade](../../packages/extension-api/src/plugin-extension.ts)、[清单校验](../../packages/extension-api/src/manifest.ts) | stable | `defineExtension`/`ExtensionAPI` 受控注册；普通 `ctx.extension()` 提供工具、全部支持的 hooks 与账本事件，通过该 facade 注册 slots/services/projections/resources 仍被拒绝 |
| [Hooks](../../packages/extension-api/src/hooks.ts)、[slots](../../packages/extension-api/src/slots.ts)、生成的 hook/slot/theme 表、[JSON payload 校验](../../packages/extension-api/src/json-payload.ts) | stable | 类型化 payload/return、白名单与大小校验；生成表为权威；浏览器组件 slot 是独立版本目录 |
| [服务](../../packages/extension-api/src/services.ts)、[投影](../../packages/extension-api/src/projections.ts) | stable | Schema 校验调用、Host 身份绑定、owner 读取与显式 unavailable；查询服务不能获得效果权限，效果服务的进程访问须经过已装配授权路径 |
| [公共类型](../../packages/extension-api/src/common.ts)、[资源](../../packages/extension-api/src/resources.ts)、[工作区 hook 快照](../../packages/extension-api/src/workspace-hooks.ts) | stable | Session/lease/logger/platform/enforcement 事实、资源种类与不可变调用配置；事实不是授权 |
| [Extension 错误](../../packages/extension-api/src/errors.ts)、[版本](../../packages/extension-api/src/version.ts)、[范围 helper](../../packages/extension-api/src/api-range.ts) | stable | 闭合 `EXTENSION_ERROR_CODES`、`ExtensionError`/guard、版本常量与支持的范围语法；不是 provider 或基础设施失败的统一包装 |
| [Loop 高低层端口](../../packages/extension-api/src/loop.ts)、[注册 helper](../../packages/extension-api/src/loop-plugin.ts)、[类型化事件](../../packages/extension-api/src/loop-events.ts) | experimental | Factory/driver/codec、输入、视图、请求、效果、工具、children、jobs、等待、checkpoint 与调度 outcome；下文详述 |
| [模型 adapter](../../packages/extension-api/src/model-adapter.ts) | experimental | 注册、路由/模型、凭据、stream/count/probe/refresh、异步创建与清理 |
| [压缩引擎](../../packages/extension-api/src/compaction-engine.ts) | experimental | 可见对话、预算、pair-closed 摘要/替换或 plan、校验与实例清理 |
| [持久化](../../packages/extension-api/src/persistence.ts)、[child-control 记录/store](../../packages/extension-api/src/child-control.ts) | experimental | 账本事务/lease、元数据、integrity、reclaim、child/budget/workspace 控制与可选 SQLite；不隐式迁移跨 provider 数据 |
| [Sandbox provider](../../packages/extension-api/src/sandbox-provider.ts)、[进程句柄](../../packages/extension-api/src/process.ts) | experimental | 每调用授权策略与真实 enforcement、能力拒绝、进程归属与工作区/配置实例 |
| [工具 runtime](../../packages/extension-api/src/tool-runtime.ts)、[policy](../../packages/extension-api/src/tool-policy.ts) | experimental | 会话调度与 generation 决策策略分离；Core 维护 dispatch/审批/授权/效果 |
| [子代理](../../packages/extension-api/src/child-agent.ts) | experimental | 类型化父会话绑定 start/adopt/list/message/result/event/interrupt/dispose 及约束 |
| [Provider kinds、注册与目录](../../packages/extension-api/src/provider-kind.ts)、`ProviderError` | experimental | 内置 `KindMap`、精确自定义 token、来源归属、semver 准入、不可变元数据、等待式 unregister 与生命周期 scope |
| [搜索 provider](../../packages/extension-api/src/search-provider.ts)、[Skill 安装请求端口](../../packages/extension-api/src/skill-install.ts) | experimental | 部署拥有的搜索、经审批的 prepare/commit/status/cancel 安装；请求元数据不是授权 |
| [普通包元数据](../../packages/package-manager/src/plugin-manifest.ts)、[能力声明](../../packages/package-manager/src/plugin-capabilities.ts)、bundles 与 profile composition | experimental | 静态声明、独立 trust/enablement、确定性选择与可见性；下文详述 |
| 插件管理、SDK 会话选择、generation 迁移/发布 API | experimental | 认证操作与后台持久绑定；浏览器模块不获得 Node 凭据 |
| Extension fixtures、transport cases、provider/persistence conformance、plugin-runtime 作者 helper/testkit | experimental | 可复用校验、受控 probe 与真实 Host 集成；mock 不是部署资格验证 |

stable 工具上下文包含 `tools.invoke/list`、`artifacts.put/get/submitJob/poll/cancel`、兼容 `subagent.fork/spawn/collect/cancel/resume`、`plan.set`、`requestCompaction`、`progress`、`signal`、deadline、lease/log 视图。可选的新端口保持上表 experimental 标签。`Disposer = () => void` 属于同步扩展注册；provider unregister 独立为 `() => Promise<void>`。[生成的工具元数据参考](../../packages/extension-api/docs/tools-meta.md)记录上限：description 4096 UTF-16 单元，参数 schema 262144 字节/深度 32，文本输出默认 32768 字节、范围 4096–1048576。

## Loop 操作与恢复

`LoopFactory` 包含 `id`、`version`、`capabilities`、`codec`、可选 `checkpointMode: 'driver' | 'ledger'`，以及同步或异步 `create(ctx, signal?)` / `resume(ctx, checkpoint, signal?)`。Driver 实现 `step(signal)`、`cancel()`、`dispose()`、`checkpoint()`。Core/Host 等待构造并传入协作式 signal；现有单参数同步 factory 仍兼容，调用者须 await 结果。Kernel 关闭时停止创建新会话，排空在途会话创建后才关闭 storage。旧账本解析为 `agnes.default@1.0.0`；缺失精确 pin 或不支持 codec 时拒绝执行。无版本选择必须唯一解析到一个 Loop 版本。

高层可恢复操作包括 `turn.continuation/checkpoint/finishCancelled/finishFailure`、`model.respond`、`tools.drain`、`compaction.run`、`wait.poll`。Driver 选择下一条边；这些操作维护 Core 所有的账本 continuation。`@agnes/loop-default` 使用同一组公开端口，采用 `checkpointMode: 'ledger'`；无状态 codec 接受历史 version-1 checkpoint，不暴露私有程序计数器形状。

低层作者使用 `input.accept/claim('next-turn' | 'next-step')`、`turn.view/endStep`、`prepareRequest/estimateRequest`、`model.stream/complete`、`tools.execute/batch/resume`、`events.assistant/finish/emit`、`effects.status`、`checkpoints.read/write`、`wait.park/wake/delay`、`jobs.status/join`、可选 `children`。`next-turn` 在结束前重返已接收输入；`next-step` 在该轮 claim steering。冻结的 turn view 包含压缩后历史、工具 schema、有效模型能力、prompt/runtime sections 与预算。Prepared request 绑定当前轮及原始对象；克隆请求或手工提供 stamps 被拒绝。估算仅供参考，可以 unknown，不发送、不预留预算。

调度依据 `outcome: 'running' | 'idle' | 'turn-ended' | 'parked'`，不依赖展示 `phase` 或单独 reason。`loopShouldStop(result, until)` 由生产和 testkit 共用。`until: 'turn-end'` 在任意轮结束时停止；`until: 'idle'` 可在 completed 后继续消费队列，但遇其他结束原因、idle 或 parked 停止。`events.finish` 关闭可观察轮次。审批 park 在兄弟调用排空后关闭本轮；先用 `input.resumeParked` 重开，再以 `tools.resume` 恢复**原始** invocation。仍等待另一个审批时返回 `E_LANE_BUSY`；不确定执行拒绝重放。

Core 经公开效果路径实施 step/credit 准入、principal 授权、审批绑定与媒体/请求校验。Batch 按输入顺序返回；仅声明 concurrency-safe 的调用可在 runtime 策略下重叠。低层模型响应不会自动成为 assistant 历史行：用 `events.assistant(message, checkpoint)` 原子保存两者。`events.emit(type, data)` 仍是宽泛账本 append 端口，保持 experimental，不能替代请求派生或授权。

恢复应使用显式、稳定的 `invocationId`。状态为 `not-sent`、`may-have-sent`、`responded`（也可能是错误结果）。同一身份用于不同操作被拒绝；已有响应可以无 redispatch 返回。外部 dispatch 前写入不确定性 fence。`checkpoints.write(checkpoint, {invocationIds})` 记录关联，不是外部效果的原子提交。工具响应已提交、Loop 回执未写时崩溃，可恢复原响应；模型没有耐久完整回执时崩溃，仍是不确定。没有外部效果 exactly-once 或受管网络 send fence 保证。 **稳定 invocation 身份、三态 effect status 与 checkpoint association 已被接受为 v0.1 足够合同，整体 reconciliation 仍标为 experimental。** 更强的跨 provider 对账或原子外部效果事务不是 v0.1 要求。

Child start status/adopt 只重连原父级创建。不支持 adoption 或原身份缺失时拒绝用旧身份重新 start。Job status/join 要求原始耐久 deferred-job marker；join 原子发布该工具结果，不推进 scheduler edge。取消 join 不会取消外部 job。`await wait.wake()` 提交 lane-local、可合并唤醒；取消不消费，checkpoint 确认防止重启后再次投递。`wait.delay` 是协作式延迟，不是耐久 timer schedule。

### 事件 waterfall

Core 操作路径触发 `before_model_request`、`after_model_response`、`before_tool_call`、`after_tool_result`、`turn_end`。对应的现有 request/tool hooks 先运行一次，再执行 Loop listeners；listener 按注册顺序处理脱离原状态的 payload。Before-model patches 合并（sampling/metadata 按字段）；before-tool deny 终止链；有效 after-tool result transform 传给下一个 listener。观察者失败/超时跳过；before-request/before-tool 失败终止操作。当前 listener timeout 为 2000 ms。见[dispatch](../../packages/core/src/loop/events.ts)。

Dispatch 按操作/attempt 触发，不保证跨重试或崩溃全局一次。结构端口中的 `events.dispatch` 仍可选，作者手动 dispatch 可导致重复通知。不能宣称耐久 exactly-once 事件，也不应把手动 dispatch 与 Core 自动操作通知混用。

## 八种 provider 操作合同

| Kind | 必需操作、拒绝与清理规则 |
| --- | --- |
| `loop` | 上述 factory/driver/codec 与公开端口；恢复前验证持久化精确身份与 codec |
| `model-adapter` | `create(config, signal?)` 可 await；实例必需 `routes/models/stream`，可选 `complete/bindCredential/count/refresh/probe/dispose`；注册 `cleanup` 独立。带凭据的社区 adapter 必须实现 `bindCredential`，在路由边界调用。Stream options 包含 signal/session key/tool names/timeouts、可选 `retry: false`/`reportSent`；adapter 不签发 Core sent stamp。AI 包装并验证终结事件；成功 Core stream 需匹配 sent 与 done 记录。Count 可以 unavailable。官方 API-key/订阅 adapter 使用相同公共 factory。Config 可带 `id/providerId` 与实时 `credentials.resolve/recoverRejected`，返回字符串或 `ModelAdapterCredential {apiKey?, headers?, baseUrl?}`；null header 移除继承 header。凭据在请求时解析，OAuth 拒绝可触发一次失效/刷新。`bindCredential` 保留 API-key 路由绑定。凭据端口不能进入 catalog/checkpoint。 |
| `compaction` | 可异步 `create(signal?)`；实例 `shouldCompact`、`compact(input, {signal, model})`，返回 null、plan 或 replacement。输入含可见对话、pinned nodes、system context、预算；`model.summarize` 为 pair-closed range 安全派生请求并记 usage。Core 验证 replacement/range 后修改 surface，不授予任意账本写权限。实例 `dispose`、注册 `cleanup` 可 await。 |
| `tool-runtime` | 可异步 `create({maxParallel}, signal?)`；`execute/batch` 仅通过 `execution.dispatch` 调度。Call `id` 是 Core runtime 身份，与作者恢复 `invocationId` 不同。不安全/未知调用独占；安全调用遵守并行上限；batch 保留输入顺序；cancel/dispose 排空已开始调用；注册 `cleanup` 可 await。 |
| `tool-policy` | `decide(input, signal)` 返回 `allow/ask/deny` 与 reason；拒绝/失败不能扩大 principal 权限、preset 策略或 sandbox 约束。Policy `dispose` 先于注册 `cleanup`，两者可 await。权限声明与 provider 功能能力是不同概念。 |
| `persistence` | 可异步 `open({dataDir, clock?, signal?})`，随后 `open/commit/renew/release/scan/registers/close`。Commit 检查 writer lease/CAS，原子分配 seq、物化 registers/integrity 与可选 op state。Scan 必须有界：页上限 500；超大完整读取拒绝，不静默截断。Metadata transaction 是同步原子 callback，不接受 Promise。独立端口为 metadata/child-control/reclaim/integrity、可选 SQLite dialect/tables/schema。完整 Host 要求 ledger/metadata/child-control/reclaim/integrity 及 `createChild`；SQL 可选，缺失时表调用被拒绝。Provider 必须保证 reopen 耐久性、正确 lease/reclaim；构造带协作式 signal；SQLite 与 JSONL 在同步打开前检查。Store 操作及同步文件系统/SQL 无中途取消，卸载须等待完成后 close。不提供跨 store 迁移。 |
| `sandbox` | 可异步 `create({workspaceRoot?, options?}, signal?)`，可选实测 `probe`；实例 `exec/capabilities/dispose`、可选 `openProcess`。Host 每调用传 workspace/digest、read/write allow/deny、network mode/hosts、required enforcement，deny 优先。Local 与第三方都使用选定实例；缺 policy/能力/平台/enforcement 时 spawn 前拒绝；结果报告真实 enforcement。Backend id 启动期固定，实例按 workspace/options 复用。Host 将 owner/caller signal 传给 probe/create。同一工作区/options 共享构造；后续等待者取消不会取消现有共享实例。Process `close` 杀进程树并等待退出；PTY/JSON bridge 须明确声明支持。 |
| `child-agent` | `start(task, options)`、可选 `adopt/list`；handle 的 `events/sendMessage/interrupt/result/dispose`。Follow-up 回执表示已接收，不是已回答。父级 facade 固定 session/cwd/generation，实施 provider/model allowlists、tool deny/allow、credit ceiling；子级 options 只能收窄。空 allowlist 全拒绝；不支持能力则拒绝。父 abort 请求取消；facade/unregister 排空 creating children 与 handles，保留清理失败并幂等。默认 `in-process`，可选 ACP 默认不加载；旧 subagent 操作保留显式 in-process 路径。 |

创建归准入 owner，实例与调用归 generation/workspace/process owner。已接受启动 store 移交进程引用 owner，普通 registry 卸载不会关闭它；会话释放 lease 且最后一个 Host 关闭后才释放：先停止准入，再在支持时 abort，join 已准入工作，dispose 实例，最后清理注册资源；释放依赖前 await unregister。Session close 请求取消，生产者排空后才关闭 hooks、ledger、workspace lease；保留/聚合清理失败。取消是协作请求：provider 不结束可能使卸载持续等待。Loop/sandbox/persistence 构造均可异步并接收 signal。Host 在接受结果前拥有资源：取消后迟到或无效结果须 dispose，factory 失败不发布实例，unregister 等待构造完成后 cleanup。进程 persistence 按数据目录/provider 身份共享，首个打开者拥有构造 signal；此构造取消使所有等待者失败并允许重试。后续获取者取消只释放自身引用。不可中断 store I/O 会排空，不会被丢弃。

## 注册、选择与重启 scope

`ctx.providers.register(kind, sourcePackage, provider)` / `resolve(kind, selection)` 经 `KindMap` 推断内置类型；自定义 kind 必须使用服务安装的精确 `defineProviderKind<T>()` token。同名但不同身份 token 被拒绝。经验证的 plugin owner 决定来源身份，冲突声明拒绝。不可变目录含 kind/id/version/source/capabilities/scope/restartRequired/active/selectedFor，不含 factory/凭据。Active 表示配置选中，不表示活动会话数。具名 service facade 继续存在。

`ProviderError` codes 为 `E_PROVIDER_DUPLICATE/E_PROVIDER_UNKNOWN/E_PROVIDER_INVALID/E_PROVIDER_INCOMPATIBLE/E_PROVIDER_UNAVAILABLE`，字段为 `kind`、可选 `provider`、`operation`、默认 false 的 `retryable`、可选 `hint` 和原始 `cause`。应按 code 分支，不依赖文本。八种具名 Host facade 与独立 Core Loop/tool registry 对注册、解析、选择、能力不兼容和无效构造结果统一使用这些码；provider 自己抛出的操作错误和 AbortSignal reason 保持原样，不自动包装为准入错误。

已有消费边界保留兼容码：

| 边界 | 保留的 code / 含义 |
| --- | --- |
| Core/Host 打开会话缺少精确 Loop | `E_LOOP_MISSING`；直接 `loops.resolve` 为 `E_PROVIDER_UNKNOWN` |
| Sandbox 执行/已释放进程实例/enforcement 拒绝 | `SANDBOX_UNAVAILABLE`；registry 选择/构造使用 ProviderError |
| Persistence 账本/lease/CAS/恢复及已关闭本地 Host store handle | `E_WRITER_LEASE/E_CLOSED/E_STORAGE_FAULT/E_CAS/E_BUDGET/E_SCAN_UNBOUNDED/E_SCAN_TRUNCATED/E_FORMAT`，bridge 保留 CoreError 识别 |
| Profile/package 准入、已验证来源声明与 principal 授权 | 相应配置/安全边界保留 `E_PROFILE_FRAGMENT_KEY/E_API_RANGE/E_DEP_MISSING/E_EXT_LOAD/E_AUTH`；不是 provider registry 错误别名 |

v0.1 不指定这些兼容码的删除日期。Provider errors 保持 experimental；本次收尾不重命名配置或授权失败。

Canonical provider config 位于启用包的 `config`：`<kind>: {provider, version?}`。现有根 `loop: {id, version}`、`compaction: {engine}`、`persistence/sandbox: {provider}`、模型 `provider.adapters`、preset `tools.runtime`、`approval.policy` 继续支持。显式顶层选择覆盖包 config；冲突包选择、缺身份/版本、Loop 版本歧义拒绝，不 fallback。Composition patch 有下文单独的类型字段；包 canonical blocks 不等于任意新增 root keys。其他当前 provider kind 即使版本不同也拒绝重复 id。

| Kind | Scope | 生效边界 |
| --- | --- | --- |
| loop、tool-runtime、child-agent | session | 新会话采用选中代码 generation，旧会话保持绑定 |
| model-adapter、compaction、tool-policy | generation | 重建 generation 注册表/runner；旧会话保持代码，下文 live model config 为例外 |
| persistence、sandbox | process | 使用兼容后端重启进程/worker，不搬迁已打开 store/process |
| 自定义 workspace kind | workspace | 重启/重建所属工作区部署，目录推导 restart-required |

`providerRestartRequired(scope)` 对 workspace/process 为 true。元数据不能覆盖 generation publisher 限制：已装配 backend/platform 修改、不兼容 bundled 实现替换仍可能需重启。刷新浏览器仅重载 client assets，不能替换会话固定的后端代码。改变启动 API surfaces、保存的 admin bundle 选择或非模型后端配置需要重启。

## 固定代码，实时资源

会话同时持久化 code generation 与 composition。只要精确 snapshot 与兼容部署可用，包、Loop 身份、provider/工具实现、按 generation 路由的 client modules 在 close、休眠、冷重启后仍保持绑定。新会话使用当前发布 generation。禁用代码停止新绑定；旧代码在耐久 pins 释放后排空。禁用代码与撤销当前资源/授权是不同操作，pin 不赋予持续权限。

MCP definitions、Skills 是 live 资源，按会话 composition 与 trust 过滤。变化在**下一轮**可见，当前轮保留快照。禁用/移除 MCP server 后，旧会话后续轮也不再看到它。同一 worker、opener/policy/credential 边界内，相同有效 MCP transport 配置共享引用计数连接；不承诺跨 worker/凭据 scope 共享。冷恢复读取 pinned code 与当前资源，并以有界超时等待初始 MCP catalog 同步（当前 20 秒）。历史资源归档只是证据，不是 live 读取来源。

Model routes/catalogs/credential-store 配置通过 `Host.applyModelProfile` 实时广播到保留的代码容器，每个容器仍拥有 pinned adapter registry。冷重建容器从当前配置启动；这不热替换 adapter 实现或非模型后端。

Composition 发布是**独立收敛**，不是全局原子事务。Runtime-target/row 更新返回 `publication`；composition 的 `refreshSkillRow/applyModelProfile` 返回 `HostPublicationReport`（普通 Host 仍返回 void）。报告含 operation、逐 composition `applied/failed`、`ok`、`recovery: 'retry-same-input'`，尝试所有容器。成功者保留新状态，失败者可能保持旧状态或部分应用，新容器使用最新 desired 输入。检查 `ok`，以同一完整输入重试。`compositionPublicationStatus()` 读取最近报告；`assertHostPublication` 抛携报告的 `HostPublicationError`；worker 命令在确认成功前执行该断言。

历史耐久 pins 没有时间过期。关闭/休眠不回收代码；删除释放 composition 与 generation pins。显式迁移只适用于已关闭会话的现有 composition，保持账本与精确 Loop 身份，检查两端 snapshot/部署兼容，围栏阻止并发准入，并且幂等。已打开/正在打开会话、缺 snapshot、不兼容 pinned loop 在替换 pin 前拒绝；不隐含插件状态迁移。最后一个 pin 释放后可回收旧容器/snapshot；其他活跃 worker owner 仍受保守保护。见[generation 实现](../../packages/host/src/runtime-generation-host.ts)、[composition 发布](../../packages/host/src/profile/composition-runtime.ts)、[MCP pool](../../packages/worker-runtime/src/mcp-connection-pool.ts)。

## 包清单与 composition

普通包声明 `package.json` name/version/exports、依赖/许可元数据，以及经[inspection](../../packages/package-manager/src/inspect.ts)校验的 `agnes` 字段。安装不执行、不启用插件。每个文件系统 `agnes.plugins` row 都必需 `apiRange`，独立于 `hostProvidedExternals`；embedding 创建的旧 row 在 TypeScript 形状中仍可省略。

| 清单字段 | 接受的含义/默认值 |
| --- | --- |
| `agnes.plugins[].export`、`apiRange` | 必需导出名称与已测试合同范围；不兼容在代码导入前拒绝 |
| `id`、`runtime`、`default`、`config` | 可选 row id（默认 `ext:<package-id>/<export>`，`web:` 保留）；runtime 默认 `in-process`；default-enabled 声明默认 true；detached JSON config；声明不能绕过包 enablement |
| `provide`、`inject`、`services` | 可选、有界且唯一的 service 名称列表；提供/注入元数据须与 export 一致；Surface service 名在 dispatch 时再次检查 |
| `agnes.kinds` | 可选唯一值 `tool`、`loop`、`model-adapter`、`mcp`、`skills`、`ui`、`bundle`；包类别不是八种 provider kind 名称 |
| `agnes.capabilities` | 可选 network/exec/secrets/credentials scope 数组、filesystem read/write 数组、model/childAgents/ui/device 布尔值；能力 atoms 经审阅及 allow/deny ceilings，deny 优先；省略是未声明，不证明无效果 |
| `agnes.hostProvidedExternals` | 受控 external 依赖兼容声明，不能替代 row `apiRange` |
| `agnes.bundles` | 静态命名文档 `extends/profile/presets`，要求 kind `bundle`；引用不安装 companion packages |
| `agnes.contributions`、`surfaces`、`clientDescriptors` | 声明资产/API surfaces/浏览器贡献；loader 校验路径/schema/containment/允许服务；不可变 public client config 不得含凭据 |
| `agnes.extensions` / `agnes.extension.json` | 文件系统第三方后端准入已退役，迁移至 ordinary plugin rows；builtin/embedding extension types 仍导出 |

导出的 `ExtensionManifest` schema 仍有必需 `id/version/apiRange/entry/capabilities`，可选 `contributes/provides/lease/runtime.supports`。能力词汇为 tools prefix/names、`tools.invoke`、hooks、slots、events、UI skin/client、resources、network/publicRead、artifacts、subagent、services、projections。Skin 含 `id/name/css/tokens`；client 含 `id/entry/styles/slots/slotCatalogVersion/services/projections/legacyRowIds/publicConfig`（projections 保留但不授予权限）。它与普通包权限声明不同。见[schema](../../packages/protocol/schema/extension-manifest.json)、[皮肤](skins.zh-CN.md)、[前端模块](frontend.zh-CN.md)。

Bundle 父先于子、每次解析只应用一次；循环/未知 id 拒绝；后选 bundle 后应用。优先级：profile bundles → 直接 profile composition → 兼容顶层 provider 选择 → preset bundles/composition → 已保存 admin bundles → 显式 session patch。Row 层保留 deployment → composition → 显式 user/workspace overrides。Patch 接受 `loop`、`modelAdapters`、`compaction`（null 禁用）、`persistence`、`sandbox`、`packages`、`plugins`、`toolPolicy`、`tools`、`mcp`、`skills`、`uiModules`、`surfaces`、`shell`。数组替换，package refs 按 id 合并，toolPolicy/plugin rows 按字段合并，row config 整体替换。空 tools/MCP/Skills 保留默认，空 surfaces 为 headless，显式空 shell modules/slots 不加载任何模块。Deny 优先，不能启用 untrusted/disabled 包。执行准入前做 catalog 校验；静态 `agh config dump` 不证明 runtime 可用。会话/子会话保留 composition，运行中 preset 切换若改变 generation 所属选择会拒绝。详见[bundles 与 profiles](../extend/bundles-and-profiles.zh-CN.md)、[编译器](../../packages/host-common/src/profile/composition.ts)。

## 插件使用的管理与 SDK 会话 API

| 入口 | 合同 |
| --- | --- |
| SDK `client.createSession` / `client.session.new` | `{cwd, preset?, bundles?, sessionKey?, loop?: {id, version}}` 选择新会话；load/reconnect 保留后台 workspace/composition/generation，调用方提示不能重绑定 |
| SDK `client.sessionSelection` | Loop/adapter/preset/default 选择目录；选择不是准入或激活证据 |
| SDK `client.packages`（Node） | Inspect/install/trust/enable/disable/update/rollback/remove/operation/pins/generation 使用 protocol DTO 与 operation receipts；须检查回执中的实际状态/错误 |
| `client.packages.publicationStatus({profile})` | `_agnes/v1/plugins.publicationStatus` → `{publication: report \| null}`；null 表示该 worker 尚无记录，重启后也可能如此 |
| `client.packages.migrateSession({profile, clientId, commandId, sessionId})` | `_agnes/v1/sessions.migrate` → `{previousGenerationId, generationId, changed}`；验证 ownership/activation 并围栏准入；传输失败后先检查再显式重试，pin 可能已提交 |
| Admin `GET /admin/plugins/api/publication-status`、对应 scoped POST | 只读、launcher 绑定 profile、GET 不接受 query；需 `packages.read`，只读恢复模式可用；插件异常文本脱敏 |
| Admin `POST /admin/plugins/api/sessions/migrate` | Migration DTO、activation 权限、可写模式；安全 409 拒绝如 `E_GENERATION_SESSION_OPEN`；Web helper `PluginAdminApi.migrateSession(sessionId)` 补齐命令 envelope |
| Admin bundle/composition API | `GET/PUT /admin/api/bundles`（写 `{revision,bundles}`，乐观冲突拒绝）、`GET/POST /admin/api/composition`（POST `{preset}`）；read/activation grants 与 exact-origin/Host 检查；保存选择需重启 |
| 浏览器插件调用 | `clientModules.callService/callEffect` 使用 generation/session 绑定的声明服务访问；launcher 保管 Node 凭据；query/effect 权限仍由后台拥有 |

源码权威：[SDK 会话创建](../../packages/sdk/src/client.ts)、[Node 包客户端](../../packages/package-admin-client-node/src/package-admin.ts)、[Web admin helper](../../packages/web/src/admin/plugins/api.ts)、[前端模块合同](frontend.zh-CN.md)。CLI 对应 `agh sessions migrate`、`agh plugins publication-status`。这些 API 为 experimental，公开 SDK 包集合尚未发行。

## 作者 helper、testkit 与出口审计

`@agnes/plugin-runtime` 导出 `defineProvider`、`defineLoop`、`defineModelAdapter`、`defineToolRuntime`、`defineToolPolicy`、`defineCompactionEngine`、`defineSandboxProvider`、`definePersistenceProvider`、`defineChildAgentProvider` 及 tool/plugin helpers。早期定义校验保留类型推断；Host 仍重新执行准入。

`@agnes/extension-api/testkit` 导出 `defineFixture`、`serviceFixture`、`projectionFixture`、`NEGATIVE_ACTIONS`、`TRANSPORT_CONTRACT_CASES`、`runProviderConformance` 与八个具名 runner：`loop/modelAdapter/compaction/persistence/sandbox/toolRuntime/toolPolicy/childAgentConformance`。Probe 必须从隔离真实 Host 捕获注册入口，打开真实 service/session 路径，报告 operation ready/cancel/drain；loop/persistence 必需 cold resume。Persistence store-I/O probe 显式报告不支持取消；构造取消另由 Host 生命周期回归覆盖。这些 runner 不自动验证全部 crash/upgrade/platform 路径。

`@agnes/extension-api/testkit/persistence-contract` 独立导出 Vitest suites：`persistenceContract`、`persistenceHostContract`、`persistenceSqliteContract`，使用隔离目录 factory。General testkit 不需导入 Vitest。`@agnes/plugin-runtime/testkit` 重导出 provider runners，并提供 `driveLoop`、`scriptedModel`、`runModelAdapter`、`createPluginTestHost`、`createVerifiedTestRoot`。`driveLoop` 共用 stop rule，可接真实 context；默认 fake context 明确拒绝受控 ledger 操作，不能证明 budget/授权/cold durability/drain 等价。

该版本直接运行时出口比较得到 **63 个根出口**，与 `api-surface.json` 精确一致；API 常量、包版本、changelog heading 均为 `1.4.0`。General testkit 的 14 个运行时出口与上述列表一致。快照新增 experimental 公共默认算法 `createCompactionThreshold` 与 `defaultToolPolicy`，Core/Base 共用；此未发行候选不升版本。下表覆盖全部根运行时出口，前述源码清单覆盖相应公开类型。

| 运行时出口组 | 名称 |
| --- | --- |
| 兼容/错误 | `API_VERSION`, `parseSemver`, `satisfiesApiRange`, `checkApiRange`, `EXTENSION_ERROR_CODES`, `ExtensionError`, `isExtensionError`, `PROVIDER_ERROR_CODES`, `ProviderError`, `isProviderError` |
| 扩展/清单 | `defineExtension`, `checkManifest`, `extEventType`, `EXTENSION_ID_PATTERN`, `EVENT_NAME_PATTERN`, `NETWORK_HOST_PATTERN` |
| Hooks/UI/JSON | `HOOK_EVENTS`, `HOOK_TABLE`, `SLOT_NAMES`, `SLOT_TABLE`, `THEME_TOKEN_NAMES`, `SLOT_PAYLOAD_MAX_BYTES`, `isJsonPayload` |
| 工具校验/策略 | `defineTool`, `checkToolDef`, `checkToolMeta`, `checkResolvedToolCallPolicy`, `resolveToolCallPolicy`, `TOOL_META_KEYS`, `RESOLVED_TOOL_CALL_POLICY_KEYS`, `TOOL_NAME_PATTERN`, `TOOL_POLICY_VERSION_PATTERN`, `APPROVAL_SCOPE_PATTERN`, `MAX_APPROVAL_SCOPES`, `TOOL_DESCRIPTION_MAX_LENGTH`, `TOOL_PARAMETERS_MAX_BYTES`, `TOOL_PARAMETERS_MAX_DEPTH`, `DEFAULT_OUTPUT_MAX_BYTES`, `MIN_OUTPUT_MAX_BYTES`, `MAX_OUTPUT_MAX_BYTES` |
| 服务/投影/资源 | `checkServiceDef`, `unavailableProjections`, `RESOURCE_KINDS` |
| Loop/provider 注册 | `DEFAULT_LOOP`, `LOOP_EVENTS`, `loopCheckpointCodec`, `loopShouldStop`, `registerLoopPlugin`, `registerToolRuntimePlugin`, `registerToolPolicyPlugin`, `defineProviderKind`, `PROVIDER_LIFECYCLE_SCOPES`, `providerRestartRequired` |
| 公共默认算法 | `createCompactionThreshold`、`defaultToolPolicy`（experimental，不依赖 Core） |
| 持久化/sandbox | `DEFAULT_PERSISTENCE_PROVIDER_ID`, `PERSISTENCE_EFFECT`, `PERSISTENCE_SCAN_PAGE_MAX`, `definePersistenceProvider`, `persistenceRegisterKey`, `isPersistenceTombstone`, `LOCAL_SANDBOX_PROVIDER_ID`, `sandboxUnavailable` |

AI 根出口另新增 experimental `createApiKeyProviderConfigs(): Promise<readonly {id: string; routes: ManualRoute[]}[]>`，为公共模型 factory 提供无凭据的官方 catalog 输入；[独立快照](../../packages/ai/test/api-surface.snapshot.json)记录此新增。`createApiKeyProviderAdapters` 继续支持。

以下公开暴露仍需审阅，本次保留而不删除：

- `LoopRequest` 仍是带品牌的 `Readonly<RequestBody>`，route/hash/contract 字段可读，但不能提交伪造 stamps；`events.emit` 接受任意事件名。这些宽泛低层接口保持 experimental。
- `ChildControlStore` 与 CAS/budget/workspace records 是持久化要求，不是普通 child-agent 作者要求。`persistenceRegisterKey` 与 tombstone 规则有意暴露耐久 register layout，须遵循数据格式兼容规则。
- `SearchProvider`、`SkillInstallPort`、可选 `CodeRuntime`、`SandboxProcess`、`ServiceContext.sandbox` 超出八 kind catalog。本文已明确列出，统一的功能专属 conformance 尚未建立。
- `ExtensionAPI.latestExtEvent` 是可选 legacy reader；第三方文件系统 extension loading 虽已退役，导出的 extension manifests/fixtures 对 builtin/embedder 仍有用。不能将 `Disposer` 当作异步 provider cleanup。
- 运行时快照不含类型、testkit 子路径或签名/语义变更；仍需类型测试与 conformance，JSON 不变不足以证明完整冻结。
- 当前 API changelog 记录了早期未发布预览的不升版本破坏性修改。本候选不会追溯使旧 `1.4.0` 源码彼此兼容；发行兼容基线建立前应固定源码 revision。

## 冻结就绪清单

**done** 表示所查源码提供该边界，不表示本候选执行了全部引用测试。**partial** 表示存在实现/证据，但列出的要求仍未解决。**open** 表示验收义务缺少证据。编号保留完整九项冻结范围。

| # | 要求 | 状态 | 当前证据与剩余义务 |
| --- | --- | --- | --- |
| 1 | 独立身份、静态准入、canonical/旧配置选择与拒绝 | done | [Manifest parser](../../packages/package-manager/src/plugin-manifest.ts)、[range parser](../../packages/extension-api/src/api-range.ts)、[provider selection](../../packages/host/src/assemble/provider-selection.ts)、[Loop selection tests](../../packages/host/test/loop-selection.test.ts)；已说明 embedding-only 省略 |
| 2 | 类型化注册、owner、等待卸载、不可变目录与错误 | done | [KindMap/token](../../packages/extension-api/src/provider-kind.ts)、[registry](../../packages/host-common/src/assemble/provider-registry.ts)、[测试](../../packages/host-common/test/assemble/provider-registry.test.ts)；具名 registry 错误已统一；前文明确列出消费边界兼容码 |
| 3 | 可用高低层 Loop views/input/preparation/typed output | done | [公开端口](../../packages/extension-api/src/loop.ts)、[装配端口](../../packages/core/src/loop/ports.ts)、[独立 ReAct tests](../../packages/core/test/react-loop.test.ts)、[Loop tests](../../packages/core/test/loop-plugin.test.ts)；可读请求 stamps 与宽泛 emit 保留为 experimental 暴露 |
| 4 | 显式 outcome、run/finish/reentry/park/wake 与事件规则 | done | [Stop rule](../../packages/extension-api/src/loop.ts)、[waterfall](../../packages/core/src/loop/events.ts)、[耐久 wake](../../packages/core/src/loop/wait.ts)、[testkit 共用 stop rule](../../packages/plugin-runtime/testkit/loop.ts)；上述按操作通知规则不含 crash exactly-once |
| 5 | 可恢复效果身份/checkpoint 与所有 Loop 的 budget/auth/media 边界 | done | [Invocation receipts](../../packages/core/src/loop/invocations.ts)、[assistant/checkpoint commits](../../packages/core/src/loop/ports.ts)、[crash/budget/wake/child/job cases](../../packages/core/test/react-loop.test.ts)；身份/status/association 保守合同已接受为 v0.1 experimental；外部 exactly-once 排除在保证外 |
| 6 | 所有构造/实例/调用归属、取消/排空、scope/重启 | partial | [Provider lifetime](../../packages/host-common/src/assemble/provider-lifetime.ts)、[session close](../../packages/core/src/step/session.ts)、[owned conformance](../../packages/host/test/assemble/provider-owned-conformance.test.ts)；带 signal 异步构造已共用 owner/drain；[迟到结果回归](../../packages/host-common/test/assemble/provider-registry.test.ts)、[Kernel 构造关闭](../../packages/core/test/loop-plugin.test.ts)覆盖取消、卸载、无效/失败构造。真实 provider 挂起/进程关闭资格与不可取消 store I/O 仍需验收 |
| 7 | Code pins/live resources、共享/撤权、模型广播、cold retention、迁移/发布 | done | [Generation runtime](../../packages/host/src/runtime-generation-host.ts)、[live Skill tests](../../packages/host/test/runtime-generation-host.test.ts)、[pool](../../packages/worker-runtime/src/mcp-connection-pool.ts)、[composition publication](../../packages/host/src/profile/composition-runtime.ts)、[测试](../../packages/host/test/profile/composition-runtime.test.ts)；明确独立收敛与重试，不宣称原子回滚 |
| 8 | 完整八种操作边界 | partial | 前述八种源码合同；[persistence bridge](../../packages/host/src/adapters/storage-provider.ts)要求五个非 SQL 能力并保留可选 SQL；[sandbox binding](../../packages/host/src/adapters/sandbox-providers.ts)传每调用策略。官方 adapter 已走公开 create/credential 端口；后端 durability/enforcement 资格与功能专属 conformance 仍未关闭 |
| 9 | 默认包使用作者端口、八种真实 Host suites、等价与发行验收 | partial | [Default Loop](../../packages/loop-default/src/index.ts)仅导入 extension API，无特权 driver WeakMap；[公开 conformance](../../packages/extension-api/testkit/provider-conformance.ts)、[Host suites](../../packages/host/test/assemble/provider-conformance.test.ts)、[owned suites](../../packages/host/test/assemble/provider-owned-conformance.test.ts)。默认[压缩](../../packages/base/extensions/compaction/src/engine.ts)/[policy](../../packages/base/extensions/approval-policy/src/tool-policy.ts)仅使用公开合同/算法；scripted testkit 不等于完整生产语义，全量验收仍是发行门槛 |

### 剩余未关闭项

本候选已关闭：具名 provider 错误统一并明确消费边界兼容码；Loop/sandbox/persistence 可取消异步构造与迟到清理；官方 adapter create/credential 等价；默认 compaction/policy 不依赖 Core。Receipt/association 模型已接受为 v0.1 experimental。

1. 对各部署后端验收不结束的真实 provider 工作、cleanup 失败与进程关闭。取消仍为协作式，不可中断 store I/O 必须排空（第 6 项）。
2. 验收非 SQL 完整 Host 耐久性/崩溃恢复、真实 sandbox enforcement，以及 fake/memory 之外的功能专属 conformance（第 8–9 项）。
3. 执行最终真实 Host/default 对 independent Loop 验收：拒绝、cancel/drain、冷重启、双 generation、MCP/Skills/model live 更新、publication failure/retry。定向回归/conformance 不等于完整发行验收（第 9 项）。
4. 发布前批准发行包/平台矩阵、类型/签名兼容基线、双语迁移说明及干净环境仓外产物安装；运行时快照不能单独关闭该门（第 9 项）。

## 已知限制与验证范围

已记录的本地开发为 macOS/Node 24；本次收尾使用 Node **24.20.0**、pnpm **10.34.5**。Linux/Windows 需独立 native build、sandbox/process/restart/installation 验收。Seatbelt/bubblewrap/Windows 能力报告须在部署环境实测，provider 声明不证明 enforcement。远程工作区不能选择另一个本地 sandbox provider。不承诺搬迁运行中 process、已打开 file/store，或隔离任意同进程插件。

Persistence 已将可选 SQL 与必需 Host 能力分开。[JSONL 示例](../../examples/persistence/README.md)实现完整 Host 端口，并有[合同测试](../../examples/persistence/test/contract.test.ts)与[进程恢复案例](../../examples/persistence/test/recovery.e2e.test.ts)；定向检查未执行 heavy 进程恢复案例。其内存 journal index 面向小型本地部署，无压缩/日志整理，也未验收网络文件系统/Windows 耐久性。本任务不证明完整生产 non-SQL backend 已具备资格。Strict managed model egress、credential provenance、send-fence 保证不属于本冻结。MCP prompts/resource-image mapping/session OAuth、可配 Skill roots/slash 兼容仍遵循 [MCP/Skills 支持矩阵](../guide/mcp-skills-support.zh-CN.md)。通用端口与示例不证明外部 engine、SSH/PTY、设备或 workflow 产品支持。MHS/设备集成仍未验证。

源码仍为 developer preview。本次收尾**未完成资格验证**包发布、公共 registry 启动、发行产物第三方依赖解析、真实远程模型凭据、完整 daemon/browser 验收、平台隔离、heavy crash/restart suites。现有源码测试仅证明预期覆盖。交付报告记录包 typecheck、定向生命周期/默认算法/凭据测试、必需 related tests、guards、文档验证与定向 lint；最终发行 owner 必须记录该候选 revision 的更广泛实测结果。本次不升版本、不创建 tag、不发布包。
