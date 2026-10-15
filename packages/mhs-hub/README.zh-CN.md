# Agnes MHS Hub（预览）

[English](README.md)

`@agnes/mhs-hub` 拥有设备连接与物理集成语义。`South` 是命令与 Nerve 分离的 loopback 设备监听器，`North` 是进程内服务门面，不是公开控制 socket。`Hub` 拥有设备视图、地图、有界观测、健康、人工 lease、停止、耐久操作、watch 和通知 outbox。

构造时注入绑定 owner/profile 的事务存储、bound wake producer 与可信 authority 适配器，不提供生产宽松适配器，fake 仅位于 `test/`。适配器必须检查当前 activation，并消费绑定 operation、action、设备描述 revision 与实际参数的原生授权。浏览器传入的 actor、role、approval 不构成证明。managed-service supervisor 持有每 profile 唯一的 Hub，会话插件只连接该实例。

分发前先持久接受记录。相同 operation id 返回同一回执，主体改变则冲突。设备结果在同一事务中写终态和稳定 outbox。重启时未结束动作变为 `unknown`，不会再次分发。bound 通知以相同幂等 key 重试。存储版本 1 是新格式，不支持的版本拒绝启动。耐久回执、watch、outbox 与展示活动分开；活动保留最近七天且最多 10,000 条，先触及者裁剪，提供最早时间与游标。

人工 lease 最多 30 秒，重复 operation id 不续期，重启后失效。Stop 先撤销待执行控制与现有 lease，再向目标设备发送人工归零和命令 Stop。设备离线或缺少确认时返回 `unknown`；最近停止结果独立于活动窗口持久保留。shutdown 拒绝新任务、停止设备、关闭流并记录未确认操作。设备本地 deadman 仍为必需。

每源最多保留 32 条 JSON 观测和一份二进制样本，每 profile 二进制总量最多 16 MiB。高频遥测、视频帧不写活动表。视频不进入模型；模型适配器经会话 request-media 处理静帧。gateway 媒体帧将长度前缀 JSON 与二进制放在同一帧，最大 1 MiB；丢帧后请求关键帧。设备协议的头/二进制配对仅在同一 Nerve socket 内完成。

真实 Harness admission、managed-service 生命周期与浏览器 gateway 集成依赖对应的公开作者 API。本包不会用本地 role 字段、裸 Node socket 或任意 jobs/admin 访问替代这些 API。合成单测与 socket 测试仅证明本地软件行为；真实硬件与 Windows 服务仍需部署验收。

浏览器查询提供可选的 `DeviceView.sourceStates`（true/false；尚未确认时为 null）及操作的 `startedAt`/`endedAt`、`phase` 和 `progress`。源状态由设备观测或 configure 确认回执更新；进度只能细化同一设备的既有活动操作，不能重新打开终态。SDK 在运动到达静止检查点后才报告暂停。这些是向后兼容的 MHS 投影，不改变原生批准或通用 Harness wire schema。
