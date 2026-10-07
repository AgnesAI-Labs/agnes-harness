# 程序化工具调用与工作流

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

工作流按顺序执行阶段，每阶段最多并行运行 4 个成员。
子任务使用官方 subagent_spawn 工具，继承深度、扇出、预算和 worktree 策略。
后续阶段收到上一阶段的有界结果；成员失败后停止工作流。

保留返回的 runId，通过 `workflow_status({ runId })` 查看持久状态，
或 `workflow({ runId })` 恢复中断的运行。会话 ledger 保存子会话身份，
恢复时复用已创建的 children 和已完成成员。如果中断发生在创建 child
与保存身份之间，系统拒绝再次自动派发；先核对不确定的 child，再创建新运行。
取消会取消已接受的 children；失败或取消的运行不可恢复。

Web 运行卡按阶段分组。展开阶段可查看成员状态、跳转子会话。
卡片展示记录下来的状态，可调用 workflow_status 刷新。
有界 projection 可淘汰较早的终态运行，ledger 中的事件仍保留。

本地 provider 在 macOS 和 Linux 支持桥；其他 provider 必须声明
`capabilities.programmatic: true` 并实现 JSON 请求／响应管道。
不支持的 provider 会拒绝执行。Windows 和远程 sandbox 当前不支持 PTC。
自定义 preset 可设置 `code_runtime.language: python` 使用实验性的独立
CPython cell，需要安装 Python 3。它支持顶层 await/return 和相同的工具桥，
不提供持久 kernel、snapshot 或 restore。
