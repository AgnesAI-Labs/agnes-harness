# 插件流与受管理服务

[English](transports.md) · [扩展指南](README.zh-CN.md)

可选的 `streams.v1` 与 `services.managed.v1` 适配器提供认证流与 daemon 持有的单例进程。现有会话服务和 Surface HTTP 合同保持兼容。能力必须经过审核并由 profile ceiling 明确允许；旧会话 pin 不能重启旧全局进程。

在 `capabilities.streams` 声明流，在 `contributes.client.streams` 列出浏览器可用的精确名称。每条声明选择 profile 或 session 作用域、lane、方向和字节上限。入站帧必须使用 control lane，并绑定同 owner 的 effect `controlService`。授权适配器必须验证当前 activation、不可变客户端 roster、认证主体、作用域、allowlist 和有效 effect grant；缺少适配器时拒绝访问。Surface 的 source-auth 仍须同时具备用户主体和明确的服务授权。

通过同源 JSON POST `/_agnes/plugin-stream/open` 开流，由宿主适配器验证认证和 CSRF。返回的单次 ticket 十秒过期。连接固定同源 `/_agnes/plugin-stream` WebSocket，五秒内发送首条文本消息 `{ticket}`。ticket 不得进入 URL、日志或 publicConfig。缺失、null、外部 Origin 均拒绝。每个 socket 只有一个 lane，重连必须重新授权。

二进制帧使用 20 字节网络序头：`AGS1` magic、版本字节 `1`、kind 字节 `1`、两个零保留字节、uint32 stream ID、uint32 sequence、uint32 payload 字节数，然后在同一消息内附上 payload。整帧最多 1 MiB。JSON 帧包含 `version`、`streamId`、`sequence`、`kind: "json"`、`data`，最多 4 KiB。双向 sequence 各从零开始；允许媒体序号间隙供恢复，拒绝输入重放或乱序。

媒体拥塞丢帧并通知生产者。可靠事件过载关闭并提示重新订阅，不能默丢。控制使用独立 socket、32 KiB 缓冲和每秒 30 条/120 KiB 上限。取消、撤权、过期、handler 失败和网络关闭均中止 handler，并且只通知一次 disconnect。插件负责资源清理和物理 watchdog；终止进程不能证明外部效果已完成清理。

在 `capabilities.managedServices` 声明不可变服务。daemon 只运行经过审核的 artifact，以 installation/profile/package/service lease 管理单例，不受会话 generation 影响。profile 是默认隔离边界；installation scope 必须显式管理员授权。listener 只绑定 loopback；固定端口冲突立即失败，auto 最多分配三次。健康握手须回显私有 incarnation、精确 API 版本、已绑定 listener 名称、storageReady 和 shutdownReady。PID 或其他程序的 HTTP 200 均不能证明就绪。

禁用先撤权，再 shutdown。冷升级先排空并终止旧进程，再启动新版本；失败不恢复旧进程、不重放历史动作。未确认 shutdown 保留诊断。运行时和存储适配器负责其资源，`OwnedStore` 只暴露命名空间内的 key 与事务，不提供 SQL 或调用方选择的路径。
