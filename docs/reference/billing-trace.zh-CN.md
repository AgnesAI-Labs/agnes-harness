# 账务与可选 Trace provider

[English](billing-trace.md) | 简体中文

[文档](../README.zh-CN.md) · [API](api.zh-CN.md)

Host 提供 `agh.billing` 和 `agh.trace` 的工厂实现、独立 reference 与公开合同场景。这些工厂可用于 Runtime 装配开发；当前会话和 CLI 启动路径尚未选择它们。

工厂分别声明 `post`、`refund`、`reconcile` 和 `record`、`export`。它们没有实现或声明 authority transfer 方法。

Trace `record` 是有界的本地通知，不取得外部效果端口。同一 batch 返回原始 accepted/dropped 计数；同身份异内容明确拒绝。owner 诊断可查询累计丢弃、已提交 cursor 与重放边界。容量耗尽时拒绝新 batch，不降低 Host 强制审计要求。

Trace `export` 是 leaf action，在调用受限 `agh.network.request` 端口前核对会话持久同意与当前部署授权。DISABLED/LOCAL 不发送；ANON 从结构化 span 去掉内容；FULL 要求已验证的显式同意。单独配置的轨迹投影复用相同 export action 与会话回执链；任意字节和 schema 不能取得匿名上传许可。导出不追踪自己的网络请求。

账务发送前固定账户、usage 引用、原 quote 和价格版本。同 charge/refund key 不能用于变化的输入。退款要求原 charge 已 posted、同币种且有足够可退余额；pending/unknown 退款仍占用余额。未知价格、重复 usage、跨币种与矛盾回执明确拒绝；核对证据必须经受信部署端口验证。

两类 provider 均先持久 outbound intent 再发送。已完成重试返回原回执；中断或不确定请求不自动重发。取消与释放关闭新操作，已发送请求仍保留核对责任。这不代表跨外部系统的 exactly-once。

验收夹具以真实进程运行 OTLP/HTTP JSON receiver 与账务 receipt endpoint，并通过受管 Network 实现通信。公开套件覆盖选择、正常、拒绝、取消、进程冷启与释放；受限 effect 夹具不证明生产 Budget/Usage/Effects 链已接通。会话装配、权威价格与用量消费，以及既有轨迹上传器迁移仍属后续集成。

源码：[Host Trace](../../packages/host/src/runtime/providers/trace.ts)、[Host Billing](../../packages/host/src/runtime/providers/billing.ts)、[Trace 合同](../../packages/extension-api/testkit/runtime/contracts/trace.ts)、[Billing 合同](../../packages/extension-api/testkit/runtime/contracts/billing.ts)。
