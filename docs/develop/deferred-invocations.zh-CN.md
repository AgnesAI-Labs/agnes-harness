# 延后工具调用

[English](deferred-invocations.md) | 简体中文

[Intelligent UI](intelligent-ui.zh-CN.md) · [Loop 合同](plugins.zh-CN.md)

生产方可将预校验的工具 invocation 入队，供 Loop 在下一个安全边界执行。该唯一通用公开合同位于 `@agnes/plugin-runtime/deferred-contract`，UI 动作、webhook 规则、schedule 均可使用。队列不接受可执行函数、权限决定或另一条 Agent 输入通道。Core 保持不变。

`DeferredToolInvocation` 绑定 `id`、`sessionKey`、`lane`、`source`、`sourceSeq`、已认证 `actor`、已声明 `tool`、JSON `args`。Host 绑定一个会话范围的队列，以及每个 owner 一个生产方回调。生产方通过自己的队列门面提交，只能读取和推进自己的 invocation。它的 `notify` 只确认自己的回执。校验包括所选会话工具目录成员、业务/任务约束，不授予权限。后台适配器在构造 invocation 前必须认证并解析 actor/session。

Host 用 `withDeferredToolInvocations(factory, resolve)` 把队列接到通用 `LoopContext.services` 读取器，保留所选 factory 的身份、能力、codec 与 driver 生命周期。生产方后来卸载时，已绑定的会话队列仍然可读；没有生产方时新的入队仍然失败关闭。支持该合同的 Loop 声明 `deferred-invocations` 能力，在普通步骤边界调用 `drainDeferredToolInvocations(ctx, signal)`。队列为空或没有读取器时，默认 Loop 的调度不变。自定义 Loop 使用同一 drain，不获得 UI 专用方法。

每一步最多处理一个 invocation。新 queued 工作在普通 checkpoint 之后的 `model` 边界开始，不中断模型已规划的工具批次或 compaction。原审批 continuation 可在 `tools` 边界恢复。Failure 边界只恢复既有回执或报告未派发/不确定结果。取消向上传播，不将中断效果伪装成可安全重试的失败。空闲唤醒使用普通 SC1 queued input 开启 turn；生产方结果也通过 SC1 投递，采用持久去重键。Loop 仍负责用 `input.resumeParked` 打开原停驻 turn；队列不得窃取普通输入。

| 队列状态 | 持久证据与行为 |
| --- | --- |
| `queued` | `x/agnes/deferred-invocations/state` 在唤醒前记录完整不可变 invocation。相同 id 与规范化绑定再次入队时返回首次回执，不再复查源事件；新的或不同的绑定必须引用可接受的源事件，改变绑定则拒绝。 |
| `executing` | 状态事实先于 `ctx.tools.execute({invocationId: id, name: tool, args})`。既有 tool policy、approval、auto review、deny-list、sandbox 仍是权威。 |
| `pending-approval` | `PARKED` 保存该状态；原 turn 打开后，`ctx.tools.resume(id)` 只恢复原票据。`E_LANE_BUSY` 继续停驻。 |
| `succeeded` | 必须引用原始持久 tool-result 序号；队列事实只保存引用，不复制完整输出。 |
| `failed` | 保留安全错误与重试资格。`effects.status: may-have-sent` 不重放效果，转为未知/不可重试。已知工具响应可无派发恢复。 |
| 通知 | 生产方 `changed` 收到持久状态/回执关联。`x/agnes/deferred-invocations/notified` 确认通知。确认前崩溃会重复回调，因此回调必须幂等。失败回调不能重跑终态工具。 |

终态不可改变；重试是新的 invocation，通过生产方业务事实关联。延后 artifact job 使用原 `ctx.jobs.join(id)` 合同加入，包括其取消和持久回执。该队列与既有 artifact-job 的 `deferred` continuation 不同。

`DeferredToolInvocationQueue` 提供 `enqueue`、`next`、`read`、比较并写入的 `transition`、`notify`。`DeferredInvocationLedgerPort` 提供有界会话 ledger scan/append、原结果查询和去重 SC1 唤醒。这些是 Host 适配器，不是权限 API。实现保持单写者顺序、最多八个未结束 invocation、32 KiB invocation envelope、session/lane 范围、重启后仍基于 ledger 的命令身份。未知生产方或缺失效果证据默认拒绝。队列通知重试独立于展示/投影缓存保留策略。后台业务回执可以设置更严格的限制。

Host 适配器使用现有会话 lease 和公开 scan/append/enqueue 接口。关闭会话释放其队列绑定。锁定会话保留生产方 generation。不新增 worker 定时器、数据库或 Core 程序计数器变更。生产方必须能根据自身持久接纳事实修复 enqueue，并通过既有 queued-input 路径投递结果；不能把入队成功当成业务执行成功。

通用 drain 在没有活动 turn 且该 invocation 有原审批 ticket 时，通过公开 `input.resumeParked` 恢复该 ticket。拒绝审批可能只补记 tool/result 而不打开 turn；drain 仍会读取原工具回执、写 failed 并通知生产方。普通输入和非队列审批仍由 Loop 自己处理，queue 不领取它们。

可执行的 drain 与 factory 装饰器由 `@agnes/plugin-runtime` 导出。队列和回执类型位于 `@agnes/plugin-runtime/deferred-contract`。账本端口仍是 Host 适配器。Loop 插件从公开作者运行库命名空间导入 helper，并用 `deferredQueueKind` 读取队列。
