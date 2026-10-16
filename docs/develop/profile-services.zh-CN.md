# Profile 服务与绑定通知

[English](profile-services.md) | 简体中文

[文档](../README.zh-CN.md) · [全栈插件](fullstack.zh-CN.md)

Profile 服务不依赖聊天会话。后端服务声明 `scope: 'profile'`，所属客户端模块的 `services` 列表声明准确服务名。既有服务默认属于 session，原来的调用接口仍必须传入 `sessionId`。

```ts
ctx.services.register({
  name: 'reports.publish', scope: 'profile', kind: 'effect',
  inputSchema, outputSchema, timeoutMs: 30000, maxResultBytes: 65536,
  effectPolicy: {
    isDestructive: true, isOpenWorld: true, replay: 'never',
    requiresApproval: 'always', approvalScopes: [],
  },
  async prepare(input, context) {
    return { input, resourceRevision: 'reviewed-resource-revision', presentation: { action: '发布报告' } }
  },
  async handler(input, context) {
    // scope、actor、source 和已消费的审批证明均由 Host 注入。
    return publishReviewedReport(input, context.signal)
  },
})
```

准备阶段必须只读且有界，使用 query 权限。Host 将原始输入、准备结果、资源 revision、已审核策略、操作者、来源、包完整性和当前 activation 绑定到审批主体。主体变化后须使用新的操作 id 重新审批。不要把输入里的 `approved`、`role`、`actor` 当成权限。

客户端模块使用 `ctx.profile.services.query(name, input)`、`effect(name, input, { operationId })` 和 `readOperation(name, operationId)`。同源代理核对当前 ready 行及其准确服务白名单；profile 和后端 owner 由服务端决定。Node 客户端通过 `client.extensions.callScoped` 和 `readOperation` 调用，仍受已认证来源的 grant 限制。

Effect 返回 `approval-required`、`running`、`completed`、`refused`、`cancelled` 或 `unknown` 回执。需要审批时返回既有持久化 DecisionRequest 的 handle。在 Web 左侧栏底部打开**操作审批**，没有选中会话也可使用；宿主审批卡显示不可变主体，提供**允许一次**和**拒绝**。批准后，用同一个操作 id 重试原 effect。插件自己的确认弹窗不授予执行权限。Profile 审批复用原生持久化决定，并采用保守的人工风险策略，不继承某个聊天会话的 full-access 设置。

审批消费与 dispatch intent 在既有账本中原子提交。已完成回执直接重放，不重复执行；dispatch 后缺少终态回执，重启后变为 `unknown`，即使声明幂等也不会自动重发。先核对外部结果，再决定是否发起新操作。相同 id、不同参数会被拒绝。禁用、撤销信任、行配置变化和更换包会撤销旧权限；恢复 pinned 会话不会发布全局 activation，也不会恢复控制授权。

Profile 上下文没有 session、workspace、子任务取消、进程或任意 jobs 端口；文件系统和 artifact 变更接口拒绝访问。网络仍受包声明及部署白名单限制；query 网络只允许没有 body 的 GET/HEAD。

经审核的 effect 可以声明 `priority: 'urgent'`，使用独立、有界的执行队列，但审批要求不变。建立临时控制的 effect 可声明 1–30,000 毫秒的 `controlLeaseMs`；Host 将绑定主体的 grant 和过期时间与 dispatch 原子记录，并通过 `context.admission.controlGrant` 提供给 handler。可信 stream 网关使用该操作授权控制前，必须携带已认证来源凭据调用 `Host.profileServices.authorizeControl`。资源限制、释放、过期处理和安全停止仍由插件负责。

查询会话所属记录时，可通过 `query(name, input, { sessionReads: [sessionId] })` 请求读取范围。已认证入口逐项复用现有持久 session-owner gate 校验；这些 id 是访问请求，不是授权证明。handler 在使用此类过滤条件前必须调用 `context.sessionAccess.requireRead(sessionId)`，缺失、越权或未请求的 id 都会被拒绝。最多准入 16 个 id，且只适用于 query，不打开会话或提供会话修改接口。Node `callScoped` 使用同名 `sessionReads` 请求；可信 embedding 必须从其已认证的所有权检查取得范围。

## Owner 状态和通知

声明 `capabilities.store: true` 后，profile 服务和已准入的插件工具可使用有界的 `context.store`。键值限制在 loader 选定的 owner/profile 命名空间内；单值最多 64 KiB，每个命名空间最多 10,000 个键和 16 MiB。`transaction` 同步提交；返回 Promise 会回滚，其后续异步代码也不能继续写入。Query 和准备阶段只能读取。接口不暴露 SQL 或其他 owner 的选择器。同步 `OwnedStore` 与 `ManagedServiceInit` 提供的异步修订号存储 `ManagedOwnedStore` 各有独立语义；managed 进程直接使用其 runtime 所有的存储。

声明 `capabilities.wake: true` 后，已准入的 session 工具获得 `context.wake.bind()`。Host 持久绑定 owner、包完整性、activation、session、原 lane 和 generation，返回值只含 `bindingId`。插件须把 target 与已接受的操作一起持久保存，并通过 owner store 的一个事务记录终态结果和 outbox 项。

已认证的生产者通过 Node SDK 提交通知：

```ts
await client.extensions.wakes.enqueue({
  target,
  idempotencyKey: `${operationId}/result-1/${target.bindingId}`,
  event: { name: 'report.completed', summary: '已审核的报告已完成。', data: { operationId } },
})
```

生产者需要准确授权到自己的 owner 和 `wake.enqueue`；仅持有 binding id 不足以投递。这个入口不开放 jobs 管理和任意 session 选择器。通知复用既有持久 jobs 队列，在入队和投递时复核 activation，并以稳定 command id 对原 session 输入原子去重。缺失 lane 或 generation 变化会拒绝投递。摘要最多 2,048 字符，以不可信系统事实进入会话；当前统一使用 `next-turn`，请求 `follow-steer` 时也回落到该方式。

目标被撤销后返回终态拒绝，不转移到其他 session 或 activation。普通 jobs API 拒绝内部通知 payload。操作安全回执和未投递 outbox 不应随活动展示窗口一起清理。

这些接口面向可信插件，不隔离任意 JavaScript。Scope、风险、lease、store 和 wake 都是严格 schema 声明，旧 Host 会拒绝不认识的声明，不会静默放宽权限。

`context.admission.prepared` 是 Host 固定并冻结的准备结果，供领域适配器核对最终下发的参数与资源修订号。`store.scan({ prefix, limit, cursor? })` 按键分页返回 1–256 行，查询与准备阶段仍只有只读权限。

准备结果和完整的原生审批请求各有 128 KiB 上限；合并后的原始参数、准备参数和展示数据超限时，会在 dispatch 前拒绝。审批卡显示完整的有界主体。

## 当前 profile 的受管理资源

已安装且受信任的插件可注入 `profileRuntime`，声明 profile 范围的 `managedServices`、`artifact: { kind: 'in-process' }`、经审查的回环监听地址和有界启停期限。`ctx.profileRuntime.register({ id, configSchema, defaultConfig, start, check? })` 只注册 factory；staged 与 pinned 树不启动资源，只有当前 profile 发布后才在共享 Host worker 中启动。替换先完成旧资源停机，`handle.get()` 拒绝过时或未就绪的资源。此路径属于受信任的进程内执行；Node/OCI artifact 仍使用独立进程 supervisor。

`start(init)` 接收 owner 隔离存储、绑定通知、选定监听端口、已校验配置及生命周期 signal。绑定监听前须安装 `init.onShutdown`，恢复与绑定完成后才调用 `init.ready()`。Host 会先排空受管停机，再撤销插件注册与流，并持久化已确认的收敛结果。未确认停机仅在记录的 worker PID 与启动身份能证明旧进程内资源的 owner 已消失（包括 PID 被复用）时自动恢复；owner 仍存活、身份缺失或核验失败时仍拒绝重新启动。这只核实资源存活状态：结果未知的操作保持 unknown，绝不自动重放。通用 `listenerPorts` 配置仅能为 `auto` 监听选择端口，不能改变 host 或覆盖已审查的固定端口。

Host 将 `<id>.status`、`<id>.configuration`、`<id>.check`、`<id>.retry`、`<id>.configure` 注册为普通 profile 服务，客户端须逐项列入 allowlist。状态只暴露公开监听地址；配置和重试保留原生批准。插件提供的 check 通过同一接口报告领域健康。

流声明通过 `ctx.profileRuntime.streams.register(name, handler)` 注册。本地 launcher 将同源 stream gateway 经私有连接转接到共享 worker，分发前校验当前 roster、scope、输入 schema、actor 和原生控制 grant。浏览器不会获得 worker 私有端点及连接证明。通用传输实现位于 `@agnes/plugin-streams`，`@agnes/daemon-rpc/streams` 保留兼容入口。

示例 facade 分开展示安装状态与受管理运行就绪状态。Stop 经插件管理禁用选中的已安装子示例；关系元数据仅筛选候选，不将父插件服务权限授予子插件。

Profile 数据 producer 可在 events 或 media 通道的 inbound profile stream 上声明 `producer: true`。它保留认证 roster、精确 owner、activation、有界缓冲和撤销检查，不取得运动或控制权限。可信后端仅可按精确的 `managedServices.requires` grant（backend owner、stream 名称、range `*`）调用 `profileRuntime.connectProducer`。每次转接帧都复查 child 与 parent activation；现有 inbound control stream 仍要求已消费的原生 effect grant。

`local-dev` 模板允许经审核的 store、wake、stream 与 managed-service 声明。现有 profile 已保存的能力上限仍然有效，不自动扩权，也不绕过包信任与 effect 批准。
