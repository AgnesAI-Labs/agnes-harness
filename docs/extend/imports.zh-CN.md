# 插件作者应该从哪里导入

[English](imports.md) | 简体中文

[作者工具包](README.zh-CN.md) · [快速上手](quickstart.zh-CN.md) · [测试](testing.zh-CN.md)

插件代码只从一个包导入：`@agnes/plugin-runtime`。它提供作者 helper，并转出 `@agnes/extension-api` 的全部合同（kind、Loop 端口、provider 类型、错误），所以下表里写 `@agnes/extension-api` 的行也都能从它导入。**作者测试统一使用 `@agnes/host/author-testkit`**。`@agnes/extension-api/host` 是 Host 的后端端口，不是作者入口。所有 kind（无论注册还是绑定）都是同一种 token 类型；只有需要某项 Host 服务时，才从对应合同包导入 token。当前没有统一 SDK 包，也没有公开 npm 发行；请使用匹配的源码 checkout 与[本地 SDK linker](quickstart.zh-CN.md#5-可选的构建和测试)。

下文的**作者面**表示预览版支持的公开作者入口，不代表 API 已冻结。**专用合同**用于明确的合同或集成任务。**内部/旧入口——不要使用**表示新作者模板应避开该入口，现有导出仍保留。

## 任务 → 包 → 符号

标为“类型”的符号使用 `import type`。注册方法由 Host context 提供，不是独立导入的函数。

| 任务 | 导入包 | 导出符号 | 入口与用法 |
| --- | --- | --- | --- |
| 定义工具及其插件 | `@agnes/plugin-runtime` | `defineAgnesPlugin`、`defineTool`、`readOnlyTool`、`writeTool`、`toolError`、`toolCancelled`；类型 `Context`、`TypedToolDef`、`TypedToolResult` | 作者面。注入 `tools`，调用 `ctx.tools.register(tool)`；见[工具模板](../../templates/tool/src/index.ts)。 |
| 描述工具输入、结果与调用端口 | `@agnes/extension-api` | 类型 `ToolDef`、`ToolMeta`、`ToolContext`、`ToolResult`、`PluginContextFacets` | 作者合同。官方和社区作者共用 `@agnes/plugin-runtime` 唯一导出的 `defineTool`。 |
| 构造 TypeBox schema | `@sinclair/typebox` | `Type`；类型 `Static`、`TSchema` | 作者面。工具输入 schema 必须带 TypeBox Kind 符号，普通 JSON Schema 不够。 |
| 校验或编译 schema | `@sinclair/typebox/value`、`@sinclair/typebox/compiler` | 分别为 `Value`、`TypeCompiler` | 作者面，按需使用。它们是独立子路径，不是 Agnes helper 的导出。 |
| 添加浏览器面板或 UI 资产 | `@agnes/web-client` | 类型 `ClientContext`、`ClientModule`；`workbenchPanels` | 作者面，仅浏览器。导出 `apply(ctx, config)`，通过 `ctx.slots` 或 `workbenchPanels` 注册，在客户端描述文件声明 entry/styles/slots。简单 JS 侧栏无需导入 SDK；见[前端模块](../develop/frontend.zh-CN.md)和[工作台面板](workbench-panels.zh-CN.md)。 |
| 描述客户端资产 manifest | `@agnes/extension-api` | 类型 `ExtensionManifest` | 描述文件 `client` 部分的作者合同。`agnes.clientDescriptors` 将描述文件绑定到后端 row；路径必须位于包内。 |
| 定义 Agent Loop | `@agnes/plugin-runtime` | `defineWorkflowLoop`、`defineLoop`、`defineAgnesPlugin` | 作者面。注入 `providers`，通过 `ctx.providers.register(loopKind, loop)` 注册。 |
| 实现 Loop 步骤与 checkpoint | `@agnes/extension-api` | `loopCheckpointCodec`；类型 `LoopFactory`、`LoopContext`、`LoopDriver`、`LoopCheckpoint`、`ProviderPluginContext` | 作者合同；见 [Loop 模板](../../templates/loop/src/index.ts)。使用受控模型/工具端口和传入的取消信号。 |
| 定义模型适配器 | `@agnes/plugin-runtime` | `defineModelAdapter`、`defineAgnesPlugin` | 作者面。注入 `providers`，调用 `ctx.providers.register(modelAdapterKind, adapter)`。 |
| 实现适配器配置和流式输出 | `@agnes/extension-api` | 类型 `ModelAdapter`、`ModelAdapterConfig`、`ModelAdapterInstance`、`ModelAdapterEvent`、`ProviderPluginContext` | 作者合同；见[适配器模板](../../templates/model-adapter/src/index.ts)。 |
| 打包 MCP + Skills | `@agnes/plugin-runtime`、`@agnes/protocol` | 分别为 `defineAgnesPlugin`、类型 `Context`；类型 `McpServerDefinitionInput` | 作者面。MCP 定义和 `SKILL.md` 是包数据，不是工具 helper。注入 `skills`，调用 `ctx.skills.register(...)`；源码模板导入 `@agnes/resource-control-runtime` 以获得 context 类型。该包不是 Host 提供的 external；候选 creator 会省略此导入。见[模板](../../templates/mcp-skills/src/index.ts)和 [MCP 管理](../guide/mcp.zh-CN.md)。 |
| 声明包 capabilities / scopes | `@agnes/protocol` | 类型 `PluginCapabilities` | 作者面。描述 `package.json` → 各 `agnes.plugins[].capabilities`（文件系统路径、网络主机、exec 命令、model/UI 标记）。见[能力格式](../guide/packages.zh-CN.md#能力声明)；metadata 不授予授权。 |
| 描述扩展能力 / 工具审批策略 | `@agnes/extension-api` | 类型 `ExtensionCapabilities`、`ExtensionManifest`、`ToolMeta`、`ResolvedToolCallPolicy` | 作者合同。描述文件能力与包能力的形状不同。使用调用时的 `ToolContext` 端口执行已授权 I/O；见[工具策略](tool-runtime.zh-CN.md)。 |
| 通过 kind token 使用 Host 服务 | 下表中的所属合同包 | 从 `@agnes/extension-api` 导入类型 `BindableKind`、`LoopServiceReader` | 专用合同。使用实际提供的服务端口；导入 token 不会安装、选择或授权 provider。 |
| 测试工具、Skills、Loop 和适配器 | `@agnes/host/author-testkit` | `createPluginTestHost`、`driveLoop`、`scriptedModel`、`runModelAdapter` | 作者面，仅测试文件。自动提供 Host 注册桥；轻量合同测试可显式提供服务替身。 |
| 测试会话、代际绑定、模型回放或 HTTP/SSE 故障 | `@agnes/host/author-testkit` | `createAuthorTestkit`、`recordModelFixture`、`replayModelFixture`、`startModelFaultServer`、`ScriptedProvider`、`fakeModel`、`fakeRequest` | 作者面，仅测试文件；[测试指南](testing.zh-CN.md)解释 fixture 的边界与清理。 |
| 检查专用 provider 生命周期合同 | `@agnes/extension-api/testkit` | `runProviderConformance`、`loopConformance`、`modelAdapterConformance`、`compactionConformance`、`toolRuntimeConformance`、`toolPolicyConformance`、`persistenceConformance`、`sandboxConformance`、`childAgentConformance` | 专用合同。需要真实 Host 注册/会话 probe，不是第二套 starter testkit。可选 Vitest 持久化 suites 位于 `@agnes/extension-api/testkit/persistence-contract`。 |

profile 页面从 `react` 导入 React，通过 `ctx.profile.services.query/effect/readOperation` 调用已声明的后端服务，参见[浏览器作者参考](../reference/plugin-author-api.zh-CN.md)和可运行的[面板模板](../../templates/tool-with-panel/)。Node DOM 测试从 `@agnes/web-client/testkit` 导入 `createClientPanelTestHost`，仅替换 `profileCaller` 参数。`createPluginTestHost` 支持隔离的 `storeDir` 验证重建后的持久化，`invokeProfileService` 验证已注册 handler 的合同；原生准入和审批不在此轻量 fixture 范围内。

## Kind token

kind 是用 `defineKind` 创建的同一种 token，自己声明支持 `ctx.providers.register`、`ctx.providers.bindOwn` 还是两者都支持（带 `bind` 选项即可绑定）。`ctx.providers.register(kind, provider)` 与 `ctx.providers.bindOwn(kind)` 接受同一种 token 类型，Host 会拒绝 kind 未声明的操作。

Host 安装的 provider kind 由 `@agnes/extension-api` 导出（`@agnes/plugin-runtime` 同样再导出）：`loopKind`、`modelAdapterKind`、`compactionKind`、`persistenceKind`、`sandboxKind`、`toolRuntimeKind`、`toolPolicyKind`、`childAgentKind`、`referenceResolverKind`、`memoryKind`、`systemPromptKind`、`webhookTriggerKind`；七个 seam kind（`approvalKind`、`principalsKind`、`billingKind`、`checkpointKind`、`artifactsKind`、`verifierKind`、`repairKind`）来自 `@agnes/extension-api/seams`。

Host 提供的公开作者命名空间共有以下六个可绑定 kind。请从准确的所属路径导入，以保留重载时的 token 身份；不要复制 token 或用 `defineKind` 重建它。

| 服务 | 导入包 | 导出 token | 合同源码 |
| --- | --- | --- | --- |
| 任务遥测 | `@agnes/observability/contract` | `observabilityKind` | [contract](../../packages/observability/src/contract.ts) |
| 智能 UI | `@agnes/intelligent-ui-contract` | `intelligentUiKind` | [index](../../packages/intelligent-ui-contract/src/index.ts) |
| UI 数据源 | `@agnes/intelligent-ui-contract` | `uiDataSourceKind` | [index](../../packages/intelligent-ui-contract/src/index.ts) |
| Git worktree | `@agnes/git-worktree-contract` | `gitWorktreeKind` | [index](../../packages/git-worktree-contract/src/index.ts) |
| 延迟工具队列 | `@agnes/plugin-runtime/deferred-contract` | `deferredQueueKind` | [contract](../../packages/plugin-runtime/src/deferred-contract.ts) |
| 延迟调用 producer | `@agnes/plugin-runtime/deferred-contract` | `deferredProducerKind` | [contract](../../packages/plugin-runtime/src/deferred-contract.ts) |

当提供了该端口时，`ctx.providers.bindOwn(kind)` 绑定已准入 owner 的实例。Loop 使用可选的 `LoopContext.services.get(kind)` reader，并必须处理服务缺失。普通插件通过 `ctx.providers.register(kind, provider)` 注册，通过 `ctx.providers.bindOwn(kind)` 绑定；两者都受 Host 准入、owner 和来源包校验约束。部分 token 属于 Host 自有服务；出现在公共命名空间不代表任意插件均可调用其所有实例。

## 新作者代码应避开的入口

| 入口 | 状态 | 改用 |
| --- | --- | --- |
| `@agnes/plugin-runtime/testkit` + `@agnes/host/testkit`（`createPluginTestHost` + `createPluginTestRegistration`） | 旧组合，新作者模板不要使用。保留供已有集成测试及显式注册桥使用。 | 从 `@agnes/host/author-testkit` 导入 `createPluginTestHost(plugin)`。 |
| `@agnes/plugin-runtime/testkit` 的 provider conformance 重导出 | 旧别名，新文档不要使用。 | 所属合同入口 `@agnes/extension-api/testkit`。 |
| `@agnes/plugin-runtime/host`、`@agnes/plugin-runtime/provided-externals`、Host 实现路径、Core/daemon 私有模块 | 内部入口，插件不要使用。基础设施的导出不等于作者合同。 | 公开作者 helper、合同与受控 context 端口。 |
| Host 内部 `feedbackKind` | 内部入口，不要使用；不是公开合同导出。 | 受支持的工具/服务；此内部绑定没有可供作者导入的 token。 |

生产后端加载仅提供[列出的公开 externals](quickstart.zh-CN.md#host-提供的依赖)，不提供 testkit 或浏览器模块。testkit 导入应留在测试文件中。浏览器资产使用受支持的浏览器 externals 或打包其依赖。固定的候选测试 runner 单独提供 `@agnes/host/author-testkit`，也支持 bounded helper 的 `.mjs` 测试。

Bounded helper 仍只接受其自包含的 tool/Skill/skin 格式。它的 manifest/文件白名单与普通 scaffold 不同；更换 testkit 导入不会使该格式接受 `kinds`、`capabilities`、dependencies、scripts 或高级客户端贡献。见 [Agent 创建插件](agent-built-plugins.zh-CN.md)。

## 导入定义在哪里

包的 `exports` 映射选择入口，入口的导出选择符号。复制导入前应同时核对：

- [plugin-runtime 包](../../packages/plugin-runtime/package.json)与[作者 index](../../packages/plugin-runtime/src/index.ts)。
- [extension-api 包](../../packages/extension-api/package.json)与[合同 index](../../packages/extension-api/src/index.ts)。
- [protocol 包](../../packages/protocol/package.json)与 [index](../../packages/protocol/src/index.ts)。
- [web-client 包](../../packages/web-client/package.json)与 [index](../../packages/web-client/src/index.ts)。
- [Host 包](../../packages/host/package.json)与[作者 testkit index](../../packages/host/testkit/author/index.ts)。
- [observability 包](../../packages/observability/package.json)、[智能 UI 合同包](../../packages/intelligent-ui-contract/package.json)、[Git worktree 合同包](../../packages/git-worktree-contract/package.json)。

TypeBox 来自声明的 `@sinclair/typebox` 依赖；它自己的包导出提供根入口、`/value` 和 `/compiler`。[运行时模块表](../../packages/plugin-runtime/src/provided-externals.ts)提供相同命名空间。

## 会话决策

`ToolContext.decisions`、`LoopContext.decisions` 和获准的 `ServicePorts.decisions` 共用 `DecisionPort`（`request`、`get`、`wait` 及可选的 `admit`）。其类型及 `APPROVAL_DEFAULTS` 从 `@agnes/extension-api` 导入。spec 声明 owner 命名空间中的 key、purpose、完整不可变 JSON subject、prompt、实际提供的 options 及可选的有界 JSON response schema；Host 派生会话、作者和原操作，purpose 不授予权限。

可选 `presentation` 按语言标签保存 `{ title, fields: [{ label, value, href? }], responseValue? }`。字段为纯文本；链接仅支持以单个 `/` 开头的同源路径。Web 依次选择精确语言、语言前缀和英语，并原样提交该项 `responseValue`（省略时为 null）。保留 `prompt` 供旧客户端回退。具有业务签名意义的展示值也应放入 `subject`，通过 `responseSchema` 校验答复，并在执行前验证宿主记录的真人结果；保存本次所见的精确签名含义，不在签署后翻译。展示字段不授予权限，也不改变可选决策。

请求先落 ledger 再返回 handle。同 owner/key 的相同 spec 返回原 ID 和期限，内容变化则冲突。`wait` 返回 resolved snapshot 或断开后的 pending handle；断线和取消本地 waiter 都保留持久 pending。答复只能经认证的后台入口接收。

工具收到批准后可调用 `admit(handle)` 单次消费该精确操作，取得私有 `PermissionEffectAdmission`。准备写入前调用 `verify()`，并将凭证作为第二个参数传入 `store.transaction(work, admission)`；宿主在同步事务内开始工作前及提交前检查凭证。嵌套调用加入根事务：内层成功返回后，其准入凭证仍登记在根事务，真实根提交前逐一复核；提交或回滚后清空该登记。完全访问的业务确认保留真人主体、presentation 声明的精确值、授权 epoch 和明确的自动确认模式，见[安全指南](../guide/security.zh-CN.md#full-access-exceptions)。缺少 `admit` 的旧宿主不能执行自动业务签署。

Loop 将 handle 放入既有 checkpoint，恢复时调用 `get`。真人答复后推进纯阶段时，向 `checkpoints.write` 传入 `{ decisionRefs: [handle] }`，消费标记与下一 checkpoint 同批提交。该端口不能在重启后恢复任意工具 JavaScript。BindableKind 的最大 ports 和 Host descriptor 都须授予 `decisions`；缺少当前会话准入时 fail-closed。

工具权限与计划审核先持久化再展示。原生客户端使用
`client.approval.decide({ sessionId, id, revision, commandId, response: { option, value } })`
答复，以 `client.approval.list(sessionId)` 查询未消费请求。身份来自已认证连接，答复 body
不包含 actor 或 credential。无 handler、断线或本地等待超时让原请求继续 pending。
计划仅提供真人、单次答复，并展示完整不可变内容。普通工具保留 once、session 及同步持久化的 permanent 授权。
