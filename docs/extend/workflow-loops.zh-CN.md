# 业务工作流 Loop

[English](workflow-loops.md) | 简体中文

[作者工具包](README.zh-CN.md) · [导入地图](imports.zh-CN.md) · [测试](testing.zh-CN.md)

分阶段业务 Agent 从 `@agnes/plugin-runtime` 的 `defineWorkflowLoop` 开始。作者写具名阶段并返回业务依据；helper 负责 checkpoint 校验、计划批准、Proceed/Cancel 确认、工具审批续接、取消与报告发布。需要自定义调度时，再使用 `defineLoop` 和完整 `LoopContext` 合同。

## 完整示例：复核续约备注

此插件读取客户、起草备注、发布待审内容，再在确认后记录完整备注。将两个连接器工具替换成自己的 `defineTool` 声明，元数据须反映实际效果；记录工具仍经过后端权限与审批。

```ts
import { defineWorkflowLoop, workflowValue } from '@agnes/plugin-runtime'
import { accountLookup, recordNote } from './tools.js'

const workflow = defineWorkflowLoop({
  id: 'acme.renewal',
  version: '1.0.0',
  name: 'Renewal review',
  tools: [accountLookup, recordNote],
  deliverables: {
    directory: 'renewal-output',
    markdown: (state) => String(state.data.note ?? ''),
  },
  stages: [
    {
      name: 'account',
      async run(ctx, _state, signal) {
        return { account: workflowValue(await ctx.tools.execute({
          name: accountLookup.name, args: { id: 'A-100' },
        }, signal)) }
      },
    },
    {
      name: 'draft',
      async run(_ctx, state) {
        return { note: `Review renewal follow-up: ${JSON.stringify(state.data.account)}` }
      },
    },
    {
      name: 'record',
      confirm: () => 'Record the complete reviewed note?',
      async run(ctx, state, signal) {
        return { receipt: workflowValue(await ctx.tools.execute({
          name: recordNote.name, args: { id: 'A-100', text: String(state.data.note ?? '') },
        }, signal)) }
      },
    },
  ],
})

export const main = workflow.main
```

清单声明导出 `main` 的插件行，注入 `tools`、`providers`、`skills`，设置 `apiRange: "^5.0.0"`，并声明连接器和报告目录需要的模型、文件系统能力。在 [profile / preset 配置](bundles-and-profiles.zh-CN.md) 中选择 `providers.loop: { provider: "acme.renewal", version: "1.0.0" }` 和 `providers.tool-policy: { provider: "acme.renewal" }`；安装本身不会选择 Loop。`main` 通过三个公开注册端口注册工具、Loop、配套策略和可选 `skills`，平台负责注册清理。连接器连接仍通过 `ctx.effect()` 绑定生命周期。

helper 首先插入计划关卡。公开 turn view 包含 Plan mode 时，通过 `exit_plan_mode` 请求批准固定阶段清单，再进行业务工作。确认前发布草稿，完成时发布最终文件，均调用官方 `read`、`write`、`present`。路径含会话/输入哈希和阶段序号。注册的策略保留默认策略的拒绝，只允许指定生成报告路径，并单独要求业务写操作审批。`readOnly: true` 禁止源数据变更；可选 `policy` 在这些固定约束之后补充业务规则。

## 阶段与确认

阶段实现 `run(ctx, state, signal)`，返回的 JSON 字段合并到 `state.data`。状态提供原始文本 `input`、已校验的 `settings`、`index`、`stageCount`、`outputKey` 和可选 `stageInput`。`validateSettings` 同时校验新会话配置和恢复配置。工具可能停驻等待审批的阶段设置 `approval: true`；有业务确认的动作阶段也自动获得此处理。每个审批阶段支持一个精确工具调用；不同调用拆成不同阶段。所有异步工作传递给定 signal。

`confirm(state)` 返回问题或 `undefined`。默认确认使用会话 `DecisionPort`，重新打开时保留原 handle，与下一 checkpoint 一起消费答复。等待连接断开时继续停驻。Cancel、停止、过期、不可用、失效均停止动作；业务选择不授予工具权限。

工作流设置 `confirm: 'surface'` 可保留官方 `ask_user_question` 的 Proceed/Cancel 表面。只有 Host 认证的 `agnes/intelligent-ui` / `action-result` 系统输入，且表面匹配、`ui_submit` 成功、恰好包含一个合法答复，才能推进。普通文本、显示摘要、无关通知和失败回执均不能批准动作。[业务智能体示例](../../examples/fde/README.zh-CN.md) 使用此呈现并保留原工具与表面。

`workflow.factory` 和 `workflow.createFactory(settings)` 提供 Loop，供直接测试或自行组合插件；`workflow.policy` 提供业务策略。JSON 工具可使用 `workflowTool`、`workflowResult`、`workflowValue`、`workflowText`、`workflowChecked`；`workflowModelText` 用给定业务依据发起窄指令、无工具的公开 prepared request，也可继续使用普通 `defineTool` 和 `LoopContext` 方法。

## 接收系统通知

`inputStage: true` 阶段在安全步骤边界等待，将完整 `LoopInput` 放入 `state.stageInput`。helper 先持久化此输入，再让通用 turn checkpoint 消费它。返回 `{ waitingForInput: true }` 可丢弃无关输入并继续等待，不推进阶段：

```ts
{
  name: 'await-child',
  inputStage: true,
  async run(_ctx, state) {
    const input = state.stageInput
    const notice = input?.system
    const data = notice?.data
    if (input?.origin !== 'system' || notice?.source !== 'agnes/child' ||
        notice.type !== 'child-completed' || !data || typeof data !== 'object' ||
        Array.isArray(data) || data.childKey !== state.data.childKey)
      return { waitingForInput: true }
    // 前一个 spawn 阶段将预期 childKey 保存到 state.data。
    return { childResult: data }
  },
}
```

此 hook 接受任意结构化系统输入，包括后台子代理完成通知；不依赖 UI 回执字段，也不解析摘要。Host 认证来源，业务阶段校验类型、身份和载荷。通知数据对模型策略仍不可信，不能授权工具。财务示例通过此入口读取已有 UI 动作回执；它的 `guardToolCall`、`recordToolResult` 分别在执行/恢复前校验已提交依据，返回后持久化已处理交易。延迟调用共用这些 hook。

## 恢复与测试

审批续接只连接原 invocation，保留身份与回执。未答票据和忙碌审批 lane 继续停驻；blocked 续接停止。阶段存在不确定 pending 结果时，恢复拒绝重放，须先对照原依据核实，再启动新工作。helper 不承诺外部效果恰好一次；Stop 取消 driver，通过正常后端取消合同处理清理。

工作流 checkpoint 使用 codec 1，并绑定工作流身份与阶段数。改变阶段、设置或依据含义时须更新 Loop 版本。FDE 现在选择 5.0.0，旧 codec 被拒绝，已有会话保留 pinned 代码；不提供旧 checkpoint 转换。

从 `@agnes/host/author-testkit` 调用 `driveLoop(workflow.factory, { inputs, replies, tools })` 做确定性 fast 测试；真实会话决策、授权和延迟队列使用完整 author testkit。进程测试放 heavy tier。官方 helper 单测覆盖阶段推进、两种确认、审批停驻/恢复、停止、未知结果、结构化通知和幂等恢复。从 [Loop 模板](../../templates/loop/) 开始。

每个 `LoopContext` 绑定一个执行代。超时、替换或释放会永久撤销其写端口（`E_CLOSED`）；保留旧 context 不能获得后续轮次的执行权限。Core 在账本最终提交入口再次检查排队的写操作。晚到的真实 effect 回执仍关联原 effect；替代 Loop 可通过 `effects.status(invocationId)` 读取，冷恢复后同样可读。晚到回执不会重开旧轮次，也不会提交旧 driver 的助手消息或检查点。

默认 Loop 与通用 `model.stream()` / `model.complete()` 共用 Core 的模型传输及结算机制。每个已派发请求都会产生一条费用记录和一次计费写入，包括提供方错误及取消。缺少 usage 时采用相同的 token 估算及 `creditSource: estimated`；usage 表示请求累计总量，重复报告以最后一次为准。即使提供方忽略信号，取消也会停止等待。计费记录不可用时，同一轮次的后续模型派发会被拒绝。Loop 仍自行选择重试、压缩及后续调用。


### 执行契约套件

Loop 作者可以运行与默认 Loop 相同、由真实 Core 执行的检查：

```ts
import { verifyLoopExecutionContract } from '@agnes/host/author-testkit'
import { myLoopFactory } from './my-loop.js'

await verifyLoopExecutionContract(myLoopFactory)
```

套件使用合成 provider、工具和存储，检查取消、审批拒绝、usage 与缺失 usage 的结算、
未知结果、冷恢复、过期 scope 拒绝以及两代 Loop 并存。工厂需处理普通文字提示和模型工具调用；
自定义规划语言可在传入的工厂中适配。过期 scope 场景等待真实 deadline，请放在 heavy 测试层运行。
这是 Host testkit 的新增出口，不改变 extension-api 契约版本。

发送旁路模型调用（`ctx.sideCall`）的 Loop 可以用
`verifyLoopExecutionContract(myLoopFactory, { sideCall: true })` 加上旁路调用检查，报告随之多出
`side-call`、`side-call-deadline`、`side-call-cancel`、`side-call-revocation` 和
`side-call-estimated-cost`。这些检查通过 Loop 自己的上下文，对套件自己定义的只接受 payload 的适配器
发起旁路调用，不需要账号或外部服务。不传该选项时，检查与报告都不变。参见
[循环的旁路模型调用](../develop/plugins.zh-CN.md#循环的旁路模型调用)。
