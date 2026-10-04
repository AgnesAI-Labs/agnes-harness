# 账务与可选 Trace provider

[English](billing-trace.md) | 简体中文

[文档](../README.zh-CN.md) · [API](api.zh-CN.md)

Host 提供 `agh.billing` 和 `agh.trace` 的工厂实现、独立 reference 与公开合同场景。这些工厂可用于 Runtime 装配开发；当前会话和 CLI 启动路径尚未选择它们。

工厂分别声明 `post`、`refund`、`reconcile` 和 `record`、`export`。它们没有实现或声明 authority transfer 方法。

Trace `record` 是有界的本地通知，不取得外部效果端口。同一 batch 返回原始 accepted/dropped 计数；同身份异内容明确拒绝。owner 诊断可查询累计丢弃、已提交 cursor 与重放边界。容量耗尽时拒绝新 batch，不降低 Host 强制审计要求。

Trace `export` 是 leaf action，在调用受限 `agh.network.request` 端口前核对会话持久同意与当前部署授权。DISABLED/LOCAL 不发送；ANON 从结构化 span 去掉内容；FULL 要求已验证的显式同意。单独配置的轨迹投影复用相同 export action 与会话回执链；任意字节和 schema 不能取得匿名上传许可。导出不追踪自己的网络请求。

账务发送前固定账户、usage 引用、原 quote 和价格版本。同 charge/refund key 不能用于变化的输入。退款要求原 charge 已 posted、同币种且有足够可退余额；pending/unknown 退款仍占用余额。未知价格、重复 usage、跨币种与矛盾回执明确拒绝；核对证据必须经受信部署端口验证。

账务部署必须注入受信 accounting adapter：`readUsage` 读取所选 C33 公开 query，`reservation` 定位原接纳 reservation，`pricing` 端口供应原接纳定价选择并调用所选 C34 公开 quote，`settle` 用该引用与精确 usage 引用调用 C32。缺 accounting 或 pricing 端口时拒绝新 post。连接器核验 fact 摘要及原 attempt/外部请求身份，再要求已知的 settledAmount、原 priceVersion、账户和 usage 集与报价一致。未知 usage 仍交给 Budget，但不补造 quote 或价格、不 post；连接器在 Budget settle 前核验精确报价输入摘要、行数量、原版本和币种，并要求所选 provider 的官方 quote 与 post 中的 quote 完全一致；更正不能为同一 origin 创建第二次 charge。这些 adapter 不新增 Pricing 合同或计算替代价格。

已完成请求先从 outbox 读取，再考虑当前价格或 accounting 来源。缺 origin 元数据的旧 outbox 仍可重读原结果；该 outbox 的新 charge 在受信元数据迁移完成前明确拒绝。

两类 provider 均先持久 outbound intent 再发送。已完成重试返回原回执；中断或不确定请求不自动重发。取消与释放关闭新操作，已发送请求仍保留核对责任。这不代表跨外部系统的 exactly-once。

验收夹具以真实进程运行 OTLP/HTTP JSON receiver 与账务 receipt endpoint，并通过受管 Network 实现通信。公开套件覆盖选择、正常、拒绝、取消、进程冷启与释放；账务场景还经 Core 的公开 Usage/Budget 工厂、`@agnes/ai/runtime` 的所选目录 Pricing 公开工厂及官方 quote codec 操作隔离 SQLite owner，验证原目录价格和独立替代 Pricing provider 的实际目录价格进入同一结算链，保留模型计费及零 credits 证据。进程测试在 usage 提交、quote 持久化、预算结算、发送意图、对端接收和 callback 提交后杀死消费进程，冷恢复保留一个 usage fact 与原 settledAmount。夹具明确合成的目录/current-source owner 及受限 effects 不证明生产目录、凭据、State/Effects 已安装；会话装配及既有轨迹上传器迁移仍属后续集成。

源码：[Host Trace](../../packages/host/src/runtime/providers/trace.ts)、[Host Billing](../../packages/host/src/runtime/providers/billing.ts)、[Trace 合同](../../packages/extension-api/testkit/runtime/contracts/trace.ts)、[Billing 合同](../../packages/extension-api/testkit/runtime/contracts/billing.ts)。
