# 编写 IM 渠道插件

[English](channel-plugins.md) | 简体中文

后端提供统一渠道桥接，各个平台分别发布独立插件。仅安装 Harness 不会连接任何 IM 账号。

从 `@agnes/plugin-runtime/channel-contract` 导入适配器合同、`channelKind` 和
`CHANNEL_CONFIG_SCHEMA`。在包清单中将此模块声明为宿主提供的 external，保持 kind token
唯一。Extension API 5.5 增加可选入口
`ctx.profileRuntime.registerChannel(provider, { instances: [] })`。

提供者包含 `id`、`version`、通过校验的协议 `ChannelManifest`，以及返回 `ChannelAdapter` 的
`create({ config })`。适配器只处理平台协议与呈现，必须响应取消并在 `disconnect` 释放连接。
底座登记时保存清单及能力上限的不可变快照，不接受实例返回不同清单或超出声明的能力。

声明 `inject: ['profileRuntime', 'services', 'providers']`、`store: true`、审核过的网络范围、
明确的 `secrets` 范围（精确引用或 `secret://namespace/*`），以及 ID 为 `channel`、scope 为
`profile`、artifact 为 in-process 且启停超时有限的 `managedServices`。
同时声明 `managedServiceCapabilities('channel', CHANNEL_CONFIG_SCHEMA)` 返回的服务。
单独登记目录中的提供者不会创建连接，应使用 `registerChannel` 取得受管生命周期。
未装配 daemon 渠道桥接的嵌入式 Host 会拒绝登记。

每个实例须指定唯一 ID、存在的绝对工作区、可用智能体引用（或 `default` 表示通用助手）、`allowFrom`、`requireMention`，
以及凭据名到 `secret://` 的映射。只有平台清单声明的凭据名和插件审核范围内的引用才能解析。
适配器的 `config` 只存非敏感参数，密钥须放入凭据系统。
包配置是初值；通过原生 `channel.configure` 提交的受管覆盖值优先，应继续从同一入口维护。
标准插件配置界面和 `agh plugins config` 命令都可提交初始配置。

后端持有会话命名空间、智能体启动授权、SDK 发现及日志、持久化出站回执、排队重连、
身份及审批转发和关闭确认。退役时立即停止接收，并拒绝退役后调用适配器。
无法确认关闭时进入原生受管资源恢复流程，不能盲目重放结果未知的外部操作。

先使用假网关验证生命周期和拒绝路径，再分别完成真实平台核验。
参见[架构及兼容性](../develop/channel-plugins.zh-CN.md)。
Extension API 5.6 提供“插件 → 渠道”连接总览，按渠道展示多个机器人连接、会话名称、聊天对象及连接状态。
输入框旁的“渠道绑定”打开紧凑弹窗，动态列出已启用的渠道插件；新增插件无需改动前端。
在弹窗中选择渠道、填写凭据与平台参数、完成原生审批，再确认聊天对象，即可绑定。
实例标识、工作区和智能体由后端根据所选会话自动生成，不需要用户填写。
已有连接可在总览中配置、解绑、换绑到其他会话；换绑会替换旧连接，原聊天目标须重新确认。
提供者可声明 `configSchema` 展示非敏感的平台参数；额外审核并声明 `channelServiceCapabilities()`
提供的三个 session 服务后，Host 自动注册当前会话绑定入口。新会话草稿须先发送消息创建会话。
先向机器人发送消息（群聊需 @），再刷新目标列表。绑定只允许相同工作区与已确认目标，
只同步绑定后的新消息。未绑定聊天不会自动创建会话，原生审批保留在 AGH 中处理。
通用助手会话可直接绑定，无需安装角色智能体插件。绑定始终沿用所选会话的智能体；如需官方默认智能体，先用通用助手创建会话再绑定。
重连后目标显示“等待确认”，收到机器人消息后恢复；待核对状态须显式解绑，不自动重放未知操作。

卸载渠道插件会在停止运行并提交卸载后，清理该插件在当前 profile 的渠道实例覆盖配置、聊天目标和绑定记录。
重新安装使用插件的初始配置（钉钉插件为空实例列表）。禁用、更新与重启保留配置；凭据及其他插件存储不会被清理。
已有会话的渠道绑定管理使用当前启用插件的服务，继续校验原会话身份与工作区，不切换会话的智能体或插件快照。
