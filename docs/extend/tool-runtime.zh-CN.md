# 工具运行时与权限策略

[English](tool-runtime.md) | 简体中文

`@agnes/extension-api` 提供两个合同：`ToolRuntimeProvider.create({ maxParallel })` 创建会话级运行时，支持单次执行、批量执行、取消和销毁；`ToolPolicy.decide(input, signal, ports?)` 返回带原因的 `allow`、`ask` 或 `deny`。

普通 Cordis 插件注入 `toolRuntimes` 或 `toolPolicies`，通过 `register(sourcePackage, provider)` 注册；对应的公开注册辅助函数绑定插件生命周期。两个服务都提供只读目录，列出 id、版本和来源包。卸载选中的提供方会取消其生命周期，后续调用明确失败。

```yaml
tools:
  runtime: default
  max_parallel: 4
approval:
  policy: default
```

预设可配置 `tools.runtime: default`、`tools.max_parallel: 4`、`approval.policy: default`。省略字段保持默认行为；并发上限为 1–64。默认运行时并行执行相邻的并发安全工具，独占工具等待前面的调用完成，返回结果保持输入顺序。取消或失败会停止启动新调用并等待已经启动的调用结束。

Core 继续负责主体授权、审批票据、沙箱、效果记录和恢复；单次执行端口不允许修改已授权的参数或重复派发。策略的拒绝和主动审批要求不会被完全访问模式覆盖。默认策略由现有审批扩展注册，命令规则和人工审批沿用审批 seam。实例保留到会话关闭，避免预设切换销毁正在执行的批次。

参见[只读策略示例](../../examples/policies/read-only/)和[循环事件](loop-events.zh-CN.md)。

工具可以通过公开 `ToolMeta` 合同声明 `meta.paths: [{ arg: 'path', access: 'read' | 'write' }]`。每项指定顶层字符串参数，可选 `default` 指定省略参数时的路径，`nonWorkspaceSchemes` 将声明的 URI scheme 交给工具自身的资源服务。Core 在选择策略之前通过实时工作区文件系统预检这些路径，manual、smart、auto-review、off 模式使用相同检查，不认识官方工具名或参数名。没有此元数据的工具保持原有行为。预检不替代执行时的文件系统限制；资源 scheme 不扩大文件系统权限。元数据会被快照并纳入工具定义指纹。

## 模型辅助策略

官方 `@agnes/base` 注册 `auto-review` 策略。可选择 `approval.policy: auto-review`，或在默认策略的 Web 设置卡中启用；可信 profile 也支持 `approvals.mode: auto-review`。设置卡不会替换自定义、只读或完全访问策略。

输入可带 `config: AutoReviewConfig`、`read/write/external` 类别、保留的可信人工 `instructions`，以及待调用工具的说明、参数 schema 和定义指纹。工具参数与说明属于数据，不能授予权限。可选 `ToolPolicyPorts` 提供会话级持久尝试预算 `reserve(limit)` 与无工具模型操作 `model({ slot: 'fast' | 'verifier', prompt }, signal, onUsage?)`。模型返回 `{ text, model, cost, costSource? }`；不会自动重试，遵守当前请求成本上限，并记录用量。用量回调返回 `{ model, cost, costSource }`，中断时可提供估算。中断的预算预留不退还；传播取消，端口不可用时转为 `ask`。

策略结果可以携带协议拥有的 `ToolReviewFact`：模型、提示词哈希、参数/范围哈希、`allow/deny/escalate` 决定、风险、理由、延迟、成本、成本来源，以及 `model/human-override/fallback` 来源。决定必须与 effect 一致（`escalate` 对应 `ask`）。Core 在副作用之前保存并复用绑定事实。公开 `_agnes/v1/autoReview.get` 与 `.save` 使用 `AutoReviewConfig`；Node SDK 提供 `client.autoReview.get()` 和 `.save(config)`，浏览器通过同源管理接口操作。

输出一致性、工具范围、自动放行风险和显式未来规则由策略插件拥有；Core 仅提供模型执行、预算预留与事实持久化，不内置审查算法。硬拒绝与私有状态限制不可由模型推翻。默认值和操作流程见[安全与信任](../guide/security.zh-CN.md#审批)。
