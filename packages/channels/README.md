# External channel infrastructure / 外部渠道基础设施

This package contains the channel adapter contract, manifest validation and generic SDK-backed runner. It does not bundle an IM vendor adapter or expose an `agnes-channel` executable.

本包保留渠道适配器契约、清单校验与基于 SDK 的通用 Runner，不内置 IM 平台适配器，也不提供 `agnes-channel` 命令。

DingTalk is supplied by an independently installed AGH plugin. Review its artifact, then install it with `agh plugins add <plugin.tgz>`. Follow that plugin's configuration and deployment instructions. It must declare its capabilities and use the supported plugin lifecycle; installing the Harness alone does not start an IM connection.

钉钉通过独立 AGH 插件提供。审核插件安装包后，用 `agh plugins add <plugin.tgz>` 安装，按插件说明配置和运行。插件须声明能力并使用标准生命周期；仅安装 Harness 不会启动 IM 连接。

The backend-owned bridge is exported at `@agnes/channels/bridge`. Plugin authors use
`@agnes/plugin-runtime/channel-contract` and `ctx.profileRuntime.registerChannel`; see the
[channel plugin contract](../../docs/develop/channel-plugins.md). Daemon discovery lives in the
daemon package so this package remains a lower-layer, platform-independent forwarding engine.

迁移前先停止旧渠道进程或服务并备份状态；新插件使用 AGH 凭据引用和实例配置，不自动导入旧 YAML
或旧消息回执库。不要让新旧实现同时连接一个机器人。旧会话和文件仍保留，不会因移除适配器而删除。
