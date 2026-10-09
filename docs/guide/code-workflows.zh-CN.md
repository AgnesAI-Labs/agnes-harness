# 程序化工具调用与工作流

[English](code-workflows.md) | 简体中文

创建本地会话时选择 **ptc** preset。它继承 workspace-write 权限策略，
向模型展示 `run_code`，并提供工具参数的 TypeScript 类型声明。
每个 cell 运行在所选 sandbox provider 管理的独立 Node 进程中，
支持顶层 await 和 return；变量不会跨 cell 保留。

```ts
return await tools.workflow({
  name: 'review',
  stages: [
    { name: '检查', members: [
      { name: '测试', task: '检查测试覆盖，不修改文件。' },
      { name: '设计', task: '检查模块边界，不修改文件。' },
    ] },
    { name: '汇总', members: [
      { name: '报告', task: '汇总上一阶段的检查结果。' },
    ] },
  ],
})
```

普通审批策略要求批准 cell；嵌套工具仍经过后端的参数校验、审批、
预算和深度检查。每个 cell 最多接受 256 次桥调用，同时最多运行 4 次，
并受执行时间和输出限制。取消会终止进程并取消未完成的桥调用。
代码中的直接进程操作也受当前权限 preset 的隔离限制。

官方 preset 设置 `raw_io: false`，Node 权限模式禁止直接文件访问和创建子进程；
这些操作需要使用受审批的工具。自定义 preset 可显式设置
`code_runtime.raw_io: true`，此时按整个 cell 审批，结果标记为
`ioEnforcement: cell-approval`，进程仍遵守 preset 的 OS 沙箱。

工作流按顺序执行阶段，每阶段最多并行运行 4 个成员。
子任务使用官方 subagent_spawn 工具，继承深度、扇出、预算和 worktree 策略。
后续阶段收到上一阶段的有界结果；成员失败后停止工作流。

`ctx.subagent.collect()` 可返回可选的 `receipt`：工作区隔离信息、最多 32 条近期工具结果（名称、账本序号和错误状态），以及 `truncated` 标记。旧版本或外部子代理 provider 可省略该字段；缺失的证据不能视为执行成功回执。

Workflow 回执区分后端工具结果和子代理自行撰写的报告。父代理及后续阶段通过上下文 section 收到当前执行事实，包含工作区隔离方式，以及工具证据是否不完整或不可用。worktree 产物仍留在子工作区，Workflow 不会将子分支合并到主工作区，Web 卡片会明确标注。另行验证集成操作后才能声称文件已进入主工作区；子代理说“已经合并”不构成集成回执。

保留返回的 runId，通过 `workflow_status({ runId })` 查看持久状态，
或 `workflow({ runId })` 恢复中断的运行。会话 ledger 保存子会话身份，
恢复时复用已创建的 children 和已完成成员。如果中断发生在创建 child
与保存身份之间，系统拒绝再次自动派发；先核对不确定的 child，再创建新运行。
取消会取消已接受的 children；失败或取消的运行不可恢复。

进程内 spawn 子代理从独立任务对话开始。账本保留父会话 ancestry 供审计，但模型不会收到父代理正在执行的工具调用或此前对话。fork 子代理继承在委派工具调用前捕获的上下文前缀；新任务会明确其子代理身份。两者继续遵守已选代码 generation、工具过滤、工作区隔离和权限限制。工作流将上一阶段带成员名的结果明确写入下一子代理任务，不依赖对话继承传递结果。

Web 运行卡按阶段分组。展开阶段可查看成员状态和子会话链接。
进程内子会话尚未接入 daemon 会话登记和 ownership 注册，因此通过 daemon
打开这些链接仍待完成该层集成。
卡片展示记录下来的状态，可调用 workflow_status 刷新。
有界 projection 可淘汰较早的终态运行，ledger 中的事件仍保留。

本地 provider 在 macOS 和 Linux 支持桥；其他 provider 必须声明
`capabilities.programmatic: true` 并实现 JSON 请求／响应管道。
不支持的 provider 会拒绝执行。Windows 和远程 sandbox 当前不支持 PTC。
自定义 preset 可设置 `code_runtime.language: python` 使用实验性的独立
CPython cell，需要安装 Python 3 并设置 `raw_io: true`；Python 的
`raw_io: false` 在 I/O 桥完成前会明确拒绝。它支持顶层 await/return 和相同的工具桥，
不提供持久 kernel、snapshot 或 restore。
