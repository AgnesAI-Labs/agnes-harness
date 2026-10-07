# 工具运行时与权限策略

[English](tool-runtime.md) | 简体中文

`@agnes/extension-api` 提供两个合同：`ToolRuntimeProvider.create({ maxParallel })` 创建会话级运行时，支持单次执行、批量执行、取消和销毁；`ToolPolicy.decide(input, signal)` 返回带原因的 `allow`、`ask` 或 `deny`。

普通 Cordis 插件注入 `toolRuntimes` 或 `toolPolicies`，通过 `register(sourcePackage, provider)` 注册；对应的公开注册辅助函数绑定插件生命周期。两个服务都提供只读目录，列出 id、版本和来源包。卸载选中的提供方会取消其生命周期，后续调用明确失败。

预设可配置 `tools.runtime: default`、`tools.max_parallel: 4`、`approval.policy: default`。省略字段保持默认行为；并发上限为 1–64。默认运行时并行执行相邻的并发安全工具，独占工具等待前面的调用完成，返回结果保持输入顺序。取消或失败会停止启动新调用并等待已经启动的调用结束。

Core 继续负责主体授权、审批票据、沙箱、效果记录和恢复；单次执行端口不允许修改已授权的参数或重复派发。策略的拒绝和主动审批要求不会被完全访问模式覆盖。默认策略由现有审批扩展注册，命令规则和人工审批沿用审批 seam。实例保留到会话关闭，避免预设切换销毁正在执行的批次。

参见[只读策略示例](../../examples/policies/read-only/)和[循环事件](loop-events.zh-CN.md)。
