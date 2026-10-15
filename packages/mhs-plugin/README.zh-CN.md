# MHS Harness 插件（预览）

[English](README.md)

`@agnes/mhs` 将 profile 所有的 `@agnes/mhs-hub` 接入公开扩展 API，导出七工具、有界 context hook、profile 服务与流适配器，以及 managed-service runtime factory。设备语义和 schema 留在 MHS 包。

七工具为 `list_devices`、`read_device`、`call_device`、`set_device`、`stop_device`、`watch_device`、`unwatch_device`。调用与设置声明 `requiresApproval: always`、`replay: never`，分发前还需可信 admission 绑定实际参数与设备 revision。Stop 属于降低风险的操作，回执明确已确认或未知。watch 绑定真实调用会话和 lane，不能选择其他会话。静帧使用 `ToolContext.session.imageInput` 及当前模型策略，原始媒体字节和视频不进入文字结果或 ledger。

`createMhsPlugin(connector)` 对已有当前 Hub 注册会话工具与 context。`startMhsHub(init)` 仅由 profile managed-service supervisor 调用一次，先检查存储、恢复未知结果、安装 shutdown、绑定设备监听，再报告 ready。多个会话不持有各自监听器。`mhsServices` 将可信服务 context 与用户输入分开，`mhsStreams` 提供事件、有界媒体帧和绑定后端 lease 的控制。

安装级部署尚需组合 managed-service connector、当前 activation admission 与 gateway 注册链路。在该部署组合安装前，默认 `mhsPlugin` 以 `E_MHS_MANAGED_CONNECTOR_REQUIRED` 拒绝启用，不开裸 North WebSocket，也不凭调用者提供的 role 授权。runtime factory 可接受显式注入的端口，包括合成测试 fixture。宣称普通插件安装或浏览器验收通过前必须关闭此限制。

这是源码预览，不承诺公开发行或真实设备兼容。UI、随包示例、部署 supervision、原生批准呈现与 Windows 进程验收属于后续集成职责。参阅 [Hub 合同](../mhs-hub/README.zh-CN.md)与[设备 SDK](../mhs-device/README.zh-CN.md)。

`startManagedMhsHub(runtime, { authority, wakes })` 使用通用 `ManagedServiceInit & ManagedServiceRuntime` 的真实 `ManagedOwnedStore`、device 监听端口、私有 ready 与 shutdown 生命周期。`registerMhsStreams(north, streams, bindControl)` 通过 `PluginStreamsPort` 注册 `mhs.media`、`mhs.events` 与 `mhs.control`；可信 binder 将已验证 grant 映射到确切设备与 Hub lease，浏览器输入不能选择控制目标。媒体恢复每条流每秒最多请求一次关键帧，控制断线会停止已绑定设备。进程内测试使用真实 Hub、通用存储和 gateway broker；当前默认插件仍因缺少安装级可信 connector 而拒绝激活，不代表已通过完整安装或浏览器验收。

`createMhsNativeProfileAdapter(assertActive)` 将真实 Hub 接到原生 profile 服务：`authority` 只接受 Host 已消费批准所绑定的有效参数及设备修订号，`definitions(north)` 返回严格的 `mhs.*` 服务，Stop 使用独立优先通道，手动控制有租期上限；`register(ctx, north)` 通过公共 services facet 注册。将 `adapter.bindControl` 传给 `registerMhsStreams`，它只解析原生 lease handler 生成且仍有效的 grant，核对相同 actor、source 和 profile，再绑定其确切设备与 Hub lease。gateway 先用已认证凭据调用当前 profile authority 的 `authorizeControl`。派生控制绑定不会在进程重启后恢复。`mhsOwnedStore(store)` 将 Host 的 owner store 适配为 Hub 的 CAS 修订号和分页扫描。受管理组合负责提供当前 activation 校验、生命周期内的 owner store 和已认证的 bound-wake SDK。默认插件仍等待受管理连接器和 gateway 的真实组合，不使用伪造批准。

浏览器贡献由 [`@agnes/mhs-ui`](../mhs-ui/README.zh-CN.md) 实现，声明在 `agnes.client.json`，使用 profile 生命周期、primary MHS 入口和公开工具卡片槽。运行 `pnpm --filter @agnes/mhs build:client` 生成插件内的客户端资源。该构建不启动 Hub，也不替代当前 managed connector 与原生批准；缺少合同能力时仍拒绝激活。
