# Agnes MHS Hub（预览）

[English](README.md)

`@agnes/mhs-hub` 拥有设备连接与物理集成语义。`South` 是命令与 Nerve 分离的 loopback 设备监听器，`North` 是进程内服务门面，不是公开控制 socket。`Hub` 拥有设备视图、地图、有界观测、健康、人工 lease、停止、耐久操作、watch 和通知 outbox。

构造时注入绑定 owner/profile 的事务存储、bound wake producer 与可信 authority 适配器，不提供生产宽松适配器，fake 仅位于 `test/`。适配器必须检查当前 activation，并消费绑定 operation、action、设备描述 revision 与实际参数的原生授权。浏览器传入的 actor、role、approval 不构成证明。managed-service supervisor 持有每 profile 唯一的 Hub，会话插件只连接该实例。

分发前先持久接受记录。相同 operation id 返回同一回执，主体改变则冲突。设备结果在同一事务中写终态和稳定 outbox。重启时未结束动作变为 `unknown`，不会再次分发。bound 通知以相同幂等 key 重试。存储版本 1 是新格式，不支持的版本拒绝启动。耐久回执、watch、outbox 与展示活动分开；活动保留最近七天且最多 10,000 条，先触及者裁剪，提供最早时间与游标。

人工 lease 最多 30 秒，重复 operation id 不续期，重启后失效。Stop 先撤销待执行控制与现有 lease，再向目标设备发送人工归零和命令 Stop。设备离线或缺少确认时返回 `unknown`；最近停止结果独立于活动窗口持久保留。shutdown 拒绝新任务、停止设备、关闭流并记录未确认操作。设备本地 deadman 仍为必需。

每源保留最新观测，另有有界 values 历史，每 profile 二进制总量最多 16 MiB。高频遥测、视频帧不写活动表。视频不进入模型；模型适配器经会话 request-media 处理静帧。gateway 媒体帧将长度前缀 JSON 与二进制放在同一帧，最大 1 MiB；丢帧后请求关键帧。设备协议的头/二进制配对仅在同一 Nerve socket 内完成。

真实 Harness admission、managed-service 生命周期与浏览器 gateway 集成依赖对应的公开作者 API。本包不会用本地 role 字段、裸 Node socket 或任意 jobs/admin 访问替代这些 API。合成单测与 socket 测试仅证明本地软件行为；真实硬件与 Windows 服务仍需部署验收。

浏览器查询提供可选的 `DeviceView.sourceStates`（true/false；尚未确认时为 null）及操作的 `startedAt`/`endedAt`、`phase` 和 `progress`。源状态由设备观测或 configure 确认回执更新；进度只能细化同一设备的既有活动操作，不能重新打开终态。SDK 在运动到达静止检查点后才报告暂停。这些是向后兼容的 MHS 投影，不改变原生批准或通用 Harness wire schema。

`DeviceView.jobs` 是可选的有界投影，每台设备最多提供八条近期操作回执；恢复时从既有日志重建，并通过事件通道发布变化。摘要只包含标签、状态、时间、数值进度及终态状态/原因，参数、结果载荷与 session/wake 身份保留在所属记录中。内存索引最多保留 512 台设备。

读取的第三参数支持 `{since, history, cursor, limit, timeoutMs, signal}`。`since` 与历史游标采用 Hub 接收时间（毫秒）；只返回严格更新的样本，默认等待 2 秒、最多 10 秒，并支持取消。超时项为 `data.state: "timeout"`。values 历史按 1 Hz 保留最多 120 秒/120 条，默认每页 32 条，使用 `nextCursor` 翻页；最新媒体单独保存，全局 JSON 上限为 8 MiB。事件重放采用不透明的 generation 游标，最多保留 10 分钟、512 条、1 MiB；游标过期或重启后显式报告 `gap`，独立于 7 天活动。完成唤醒按 1 秒窗口合并，入队前持久化批次身份，重试保持原会话/lane 绑定。

读取、source watch、媒体订阅合并需求；订阅可指定 `hz`，生产者取声明范围内的最大需求。无订阅时 pose 保持 1 Hz，其他 source 关闭；审批后的手动关闭优先。视频订阅首次与丢帧时请求关键帧，在收到关键帧前不转发 delta；模型读取仍拒绝视频。

原生 `pause/resume/cancel` 只针对批准设备上的现存运行任务。Pause 必须在设备确认静止后才投影为暂停。接收期限 2 秒；执行期限为工具声明时间加 5 秒结果宽限。超时先 Cancel（500 ms），再 Stop（1500 ms）；Stop 未确认则关闭连接，unknown 不重放。

固定安装位置在线可用时可信；动态位置超过 3 秒为 uncertain、10 秒为 lost，设备 `ok`、协方差误差（默认阈值 0.5 m）、里程计不一致也会降级。World 返回 fixed 和最小包含区域。合法新地图声明更新坐标框架、按 id 合并 places，仍拒绝无效 bounds/places；断线后保留地图。

音频通过独立的原生审批 `mhs.clip` 能力发送，绑定设备 revision、clip id、PCM16 采样率/声道、字节数与 SHA-256。二进制 stream 只可用一次，最多 1 MiB，30 秒过期；Stop、断线和替换撤销。South 有序发送 Nerve 头与 payload，并在 2 秒内等待 SDK 的 `mhs/clip-received`。`sent` 仅确认缓存，播放与工具完成另有回执。不支持 clip 的 reviewed producer bridge 会拒绝。

音频上传使用有序 2 KiB 二进制分块，遵守现有 control 通道 4 KiB/每秒 30 帧合同；浏览器按 40 ms 间隔发送。Hub 按审批的 hash 聚合最多 1 MiB 后再发送给设备；部分、超量、过期和重复上传不能触发设备工具。
