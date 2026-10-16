# MHS Harness 插件（预览）

[English](README.md)

`@agnes/mhs` 将 profile 所有的 `@agnes/mhs-hub` 接入公开扩展 API，导出七工具、有界 context hook、profile 服务与流适配器，以及 managed-service runtime factory。设备语义和 schema 留在 MHS 包。

七工具为 `list_devices`、`read_device`、`call_device`、`set_device`、`stop_device`、`watch_device`、`unwatch_device`。调用与设置声明 `requiresApproval: always`、`replay: never`，分发前还需可信 admission 绑定实际参数与设备 revision。Stop 属于降低风险的操作，回执明确已确认或未知。watch 绑定真实调用会话和 lane，不能选择其他会话。静帧使用 `ToolContext.session.imageInput` 及当前模型策略，原始媒体字节和视频不进入文字结果或 ledger。

`createMhsPlugin(connector)` 对已有当前 Hub 注册会话工具与 context。`startMhsHub(init)` 仅由 profile managed-service supervisor 调用一次，先检查存储、恢复未知结果、安装 shutdown、绑定设备监听，再报告 ready。多个会话不持有各自监听器。`mhsServices` 将可信服务 context 与用户输入分开，`mhsStreams` 提供事件、有界媒体帧和绑定后端 lease 的控制。

默认 `mhsPlugin` 通过公开 `profileRuntime` facet 在共享 profile worker 中启动一个受管理 Hub，接入真实 owner store、原生 profile 服务、认证流及绑定通知。会话实例解析当前 Hub；禁用撤销 admission、停止运动并关闭监听，profile 客户端入口随之隐藏。停机未确认时保留失败状态并拒绝重启。

接入页消费通用 `hub.status`、`hub.configuration`、`hub.check`、`hub.retry`、`hub.configure` 服务。设备端点来自真实监听绑定；可经原生配置批准为自动监听选择明确端口。重新配置会停止旧 Hub 并关闭它的流；UI 重连当前 Hub，设备 SDK 则需使用选定的设备端点。浏览器不直接打开 North 控制 WebSocket，也不凭角色字段授权。

这是源码预览，不承诺公开发行或真实设备兼容。物理设备、浏览器媒体/GPU、随包示例及 Windows 验收仍需各自验证。原生 profile 审批显示在 Web 侧栏的**操作审批**区，参阅 [profile 服务指南](../../docs/develop/profile-services.zh-CN.md)。参阅 [Hub 合同](../mhs-hub/README.zh-CN.md)与[设备 SDK](../mhs-device/README.zh-CN.md)。

`startManagedMhsHub(runtime, { authority, wakes })` 使用通用 `ManagedServiceInit & ManagedServiceRuntime` 的真实 `ManagedOwnedStore`、device 监听端口、私有 ready 与 shutdown 生命周期。`registerMhsStreams(north, streams, bindControl)` 通过 `PluginStreamsPort` 注册 `mhs.media`、`mhs.events` 与 `mhs.control`；可信 binder 将已验证 grant 映射到确切设备与 Hub lease，浏览器输入不能选择控制目标。媒体恢复每条流每秒最多请求一次关键帧，控制断线会停止已绑定设备。进程内测试使用真实 Hub、通用存储和 gateway broker；默认插件已接入该通用生命周期；源码级集成测试不代表完整发行或浏览器验收。

`createMhsNativeProfileAdapter(assertActive)` 将真实 Hub 接到原生 profile 服务：`authority` 只接受 Host 已消费批准所绑定的有效参数及设备修订号，`definitions(north)` 返回严格的 `mhs.*` 服务，Stop 使用独立优先通道，手动控制有租期上限；`register(ctx, north)` 通过公共 services facet 注册。将 `adapter.bindControl` 传给 `registerMhsStreams`，它只解析原生 lease handler 生成且仍有效的 grant，核对相同 actor、source 和 profile，再绑定其确切设备与 Hub lease。gateway 先用已认证凭据调用当前 profile authority 的 `authorizeControl`。派生控制绑定不会在进程重启后恢复。`mhsOwnedStore(store)` 将 Host 的 owner store 适配为 Hub 的 CAS 修订号和分页扫描。受管理组合负责提供当前 activation 校验、生命周期内的 owner store 和已认证的 bound-wake SDK。默认插件使用此组合，不使用伪造批准。

浏览器贡献由 [`@agnes/mhs-ui`](../mhs-ui/README.zh-CN.md) 实现，声明在 `agnes.client.json`，使用 profile 生命周期、primary MHS 入口和公开工具卡片槽。运行 `pnpm --filter @agnes/mhs build:client` 生成插件内的客户端资源。该构建不启动 Hub；启用已安装插件时才启动，缺少 profile runtime 合同时拒绝激活。

已安装 Hub 还通过 `mhs.producer` 与 `mhs.producer.media` 接受经审核的后端 producer bridge。子包必须在 managed `requires` 中声明精确 grant，通用 profile runtime 为每条转接流绑定当前 child 权限；浏览器直连不能冒充该 bridge。设备命令仍来自经原生批准的 Hub 操作，媒体使用独立有界通道。

Profile 客户端还声明审批保护的 `mhs.pause` 与 `mhs.clip`。音频字节通过独立 `mhs.clip` control stream，绑定该服务的原生 grant，其他媒体/控制通道不能替代。含 string 类型 `clip` 参数的工具可上传有界 PCM16 WAV，仅在缓存确认后填写参数。Context 先放地图（最多 3000 UTF-8 字节），并在总计 6000 字节内提供位置、区域和工具参数 Schema。`read_device` 支持 `since`、values 历史与分页；profile 查询还支持取消/期限和事件重放。

音频上传使用有序 2 KiB 二进制分块，遵守现有 control 通道 4 KiB/每秒 30 帧合同；浏览器按 40 ms 间隔发送。Hub 按审批的 hash 聚合最多 1 MiB 后再发送给设备；部分、超量、过期和重复上传不能触发设备工具。

高级外部 Hub 模式保留本机 profile 的批准、日志和受管生命周期，通过 `hub.configure` 的 `externalHub: { address, allowlist }` 选择远端 `mhs-peer/v1` 设备接入。要求数值 IP、精确标准化白名单与有效 TLS 的 `wss:`，仅回环开发允许 `ws:`；拒绝凭据、查询、片段、重定向和 DNS 名称。浏览器仍只连接同源网关。`mhs.connection` 返回本机/外部及真实连接状态，断开后需重试。

远端适配器在 TLS/VPN 边界验证服务端 WebSocket 的调用方身份后，调用 `@agnes/mhs-hub` 的 `serveExternalHubPeer(socket, devices, signal)`。这些 SDK 设备应由此连接独占；它接管状态与观测回调并在掉线时停车。没有自动开放的远端监听器，也不兼容旧 North 免审批通路。切换配置会排空旧连接；停用只停止所接 fleet 并关闭本 profile 的 socket，不终止远端服务，未确认停车仍记 unknown。

对等适配器保留暂停/继续、资源持有者与调用方信息及审批保护的音频上传。音频分块复用有界 hash 校验聚合器，仅在远端 SDK 确认缓存后完成。

工具文字提供最多 6000 UTF-8 字节的人类可读摘要，保留既有结构化结果。摘要解释状态、声明字段的角色/单位/告警、图片与数据或无新鲜数据、位置可信度/区域/年龄，以及任务和 Stop 回执。设备文字经过引用和限长，并标为不可信；内嵌媒体不进入摘要。未知任务结果不能确认完成或停止；读取图片仍走 request-media 通道。
