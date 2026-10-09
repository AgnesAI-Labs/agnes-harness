# 延后工具调用

[English](deferred-invocations.md) | 简体中文

[Intelligent UI](intelligent-ui.zh-CN.md) · [Loop 合同](plugins.zh-CN.md)

生产方可将预校验的工具 invocation 入队，供 Loop 在下一个安全边界执行。该唯一通用公开合同位于 `@agnes/extension-api`，UI 动作、webhook 规则、schedule 均可使用。队列不接受可执行函数、权限决定或另一条 Agent 输入通道。Core 保持不变。

`DeferredToolInvocation` 绑定 `id`、`sessionKey`、`lane`、`source`、`sourceSeq`、已认证 `actor`、已声明 `tool`、JSON `args`。Host 绑定每 generation 的 `DeferredInvocationRegistryPort` 和每会话的 ledger ports。生产方注册 `validate`、幂等的 `changed` 回调，通过 `forSession(sessionKey, lane).enqueue` 提交。校验包括所选会话工具目录成员、业务/任务约束，不授予权限。后台适配器在构造 invocation 前必须认证并解析 actor/session。

Host 用 `withDeferredToolInvocations(factory, resolve)` 添加可选 `LoopContext.deferredInvocations` 端口，保留所选 factory 的身份、能力、codec 与 driver 生命周期。没有注册生产方时，`forSession` 不提供端口。支持该合同的 Loop 声明 `deferred-invocations` 能力，在普通步骤边界调用 `drainDeferredToolInvocations(ctx, signal)`。默认 Loop 在无插件时行为不变。自定义 Loop 使用同一 drain，不获得 UI 专用方法。

每一步最多处理一个 invocation。新 queued 工作在普通 checkpoint 之后的 `model` 边界开始，不中断模型已规划的工具批次或 compaction。原审批 continuation 可在 `tools` 边界恢复。Failure 边界只恢复既有回执或报告未派发/不确定结果。取消向上传播，不将中断效果伪装成可安全重试的失败。空闲唤醒使用普通 SC1 queued input 开启 turn；生产方结果也通过 SC1 投递，采用持久去重键。Loop 仍负责用 `input.resumeParked` 打开原停驻 turn；队列不得窃取普通输入。

| 队列状态 | 持久证据与行为 |
| --- | --- |
| `queued` | `x/agnes/deferred-invocations/state` 在唤醒前记录完整不可变 invocation。相同 id/规范化绑定返回首次回执；改变绑定拒绝。 |
| `executing` | 状态事实先于 `ctx.tools.execute({invocationId: id, name: tool, args})`。既有 tool policy、approval、auto review、deny-list、sandbox 仍是权威。 |
| `pending-approval` | `PARKED` 保存该状态；原 turn 打开后，`ctx.tools.resume(id)` 只恢复原票据。`E_LANE_BUSY` 继续停驻。 |
| `succeeded` | 必须引用原始持久 tool-result 序号；队列事实只保存引用，不复制完整输出。 |
| `failed` | 保留安全错误与重试资格。`effects.status: may-have-sent` 不重放效果，转为未知/不可重试。已知工具响应可无派发恢复。 |
| 通知 | 生产方 `changed` 收到持久状态/回执关联。`x/agnes/deferred-invocations/notified` 确认通知。确认前崩溃会重复回调，因此回调必须幂等。失败回调不能重跑终态工具。 |

终态不可改变；重试是新的 invocation，通过生产方业务事实关联。延后 artifact job 使用原 `ctx.jobs.join(id)` 合同加入，包括其取消和持久回执。该队列与既有 artifact-job 的 `deferred` continuation 不同。

`DeferredToolInvocationQueue` 提供 `enqueue`、`next`、`read`、比较并写入的 `transition`、`notify`。`DeferredInvocationLedgerPort` 提供有界会话 ledger scan/append、原结果查询和去重 SC1 唤醒。这些是 Host 适配器，不是权限 API。实现保持单写者顺序、最多八个未结束 invocation、32 KiB invocation envelope、session/lane 范围、重启后仍基于 ledger 的命令身份。未知生产方或缺失效果证据默认拒绝。队列通知重试独立于展示/投影缓存保留策略。后台业务回执可以设置更严格的限制。

Host 适配器使用现有会话 lease 和公开 scan/append/enqueue 接口。关闭会话释放其队列绑定。锁定会话保留生产方 generation。不新增 worker 定时器、数据库或 Core 程序计数器变更。生产方必须能根据自身持久接纳事实修复 enqueue，并通过既有 queued-input 路径投递结果；不能把入队成功当成业务执行成功。
