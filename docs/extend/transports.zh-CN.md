# 插件流与受管理服务

[English](transports.md) | 简体中文

[扩展指南](README.zh-CN.md)

可选的 `streams.v1` 与 `services.managed.v1` 适配器提供认证流与 daemon 持有的单例进程。现有会话服务和 Surface HTTP 合同保持兼容。能力必须经过审核并由 profile ceiling 明确允许；旧会话 pin 不能重启旧全局进程。

在 `capabilities.streams` 声明流，在 `contributes.client.streams` 列出浏览器可用的精确名称。每条声明选择 profile 或 session 作用域、lane、方向和字节上限。入站帧必须使用 control lane，并绑定同 owner 的 effect `controlService`。浏览器 open 还携带不可变客户端 `rowId`、`revision` 和 `contentDigest`；这些是用于核对当前 roster 的选择器，不是自称身份的凭据。授权适配器必须验证当前 activation、不可变客户端 roster、认证主体、作用域、allowlist 和有效 effect grant；缺少适配器时拒绝访问。Surface 的 source-auth 仍须同时具备用户主体和明确的服务授权。

通过同源 JSON POST `/_agnes/plugin-stream/open` 开流，由宿主适配器验证认证和 CSRF。返回的单次 ticket 十秒过期。连接固定同源 `/_agnes/plugin-stream` WebSocket，五秒内发送首条文本消息 `{ticket}`。ticket 不得进入 URL、日志或 publicConfig。缺失、null、外部 Origin 均拒绝。每个 socket 只有一个 lane，重连必须重新授权。

二进制帧使用 20 字节网络序头：`AGS1` magic、版本字节 `1`、kind 字节 `1`、两个零保留字节、uint32 stream ID、uint32 sequence、uint32 payload 字节数，然后在同一消息内附上 payload。整帧最多 1 MiB。JSON 帧包含 `version`、`streamId`、`sequence`、`kind: "json"`、`data`，最多 4 KiB。双向 sequence 各从零开始；允许媒体序号间隙供恢复，拒绝输入重放或乱序。

媒体拥塞丢帧并通知生产者。可靠事件过载关闭并提示重新订阅，不能默丢。控制使用独立 socket、32 KiB 缓冲和每秒 30 条/120 KiB 上限。取消、撤权、过期、handler 失败和网络关闭均中止 handler，并且只通知一次 disconnect。插件负责资源清理和物理 watchdog；终止进程不能证明外部效果已完成清理。

在 `capabilities.managedServices` 声明不可变服务。daemon 只运行经过审核的 artifact，以 installation/profile/package/service lease 管理单例，不受会话 generation 影响。profile 是默认隔离边界；installation scope 必须显式管理员授权。listener 只绑定 loopback；固定端口冲突立即失败，auto 最多分配三次。健康握手须回显私有 incarnation、精确 API 版本、已绑定 listener 名称、storageReady 和 shutdownReady。PID 或其他程序的 HTTP 200 均不能证明就绪。

禁用先撤权，再 shutdown。冷升级先排空并终止旧进程，再启动新版本；失败不恢复旧进程、不重放历史动作。未确认 shutdown 保留诊断。运行时和存储适配器负责其资源，`OwnedStore` 只暴露命名空间内的 key 与事务，不提供 SQL 或调用方选择的路径。

## 适配器入口

daemon 集成从 `@agnes/daemon-rpc/streams` 导入 `createPluginStreamBroker`、`bindPluginStreams`、`createPluginStreamGateway` 和 `createSourcePluginStreamGateway`，通过 `createWebServer({ pluginStreams })` 接入。未配置认证时没有回退路由。Node 专用 source 网关使用 `/_agnes/plugin-stream/source` 与 `/_agnes/plugin-stream/source/open`，拒绝浏览器 Origin，适配器须验证 source-auth、防重放与用户主体授权，不能只有 source 身份。两类路径不共享认证捷径。

从 `@agnes/sdk/streams` 使用 `createPluginStreamsClient`，由宿主绑定 owner、scope、精确名称与生命周期 signal。Node Surface 选择 `source: true` 并提供认证后的 `open` 和 `socket` 适配器；普通浏览器客户端使用同源 fetch 与 WebSocket。不能从任意页面配置生成 allowlist 或主体。

daemon 从 `@agnes/daemon-surfaces/managed` 导入 `createManagedServiceSupervisor`，resolver 负责当前已审 package、activation、能力上限、依赖服务授权和不可变 artifact。每个 installation controller 持有一个 supervisor，不能每次 session apply 新建。`ensure(selector, apiMajor)` 合并并发启动；`signal(selector)` 在 shutdown 前撤销 live connector；`status(selector)` 只公开安全诊断。存储目录须由宿主选择且为私有目录。

Node artifact 使用 `@agnes/sdk/managed-service` 的 `createManagedServiceRuntime`，从 supervisor 环境接收私有初始化，打开自己的命名空间存储，安装 `onShutdown`，绑定业务 listener，检查存储格式，然后调用 `ready({ apiVersion, listeners })`。OS bind 冲突须用退出码 **98** 报告；固定 listener 立即失败，auto 最多尝试三次。启动不重发历史效果。POSIX guardian 在 artifact 退出或父进程失联时终止自有进程组；Windows 复用 Surface Job Object 适配器。显式 detached 的外部进程仍由受信插件负责。

无法回收的进程保留 lease 并显示 `shutdown-unconfirmed`。daemon 崩溃会留下耐久 active 标记；新 supervisor 在操作者核实旧进程及私有状态前拒绝重启。保守拒绝不能作为外部效果已经停止的证明。
