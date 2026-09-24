# 安全与信任：让执行有边界

[English](security.md) | 简体中文

[文档导航](../README.zh-CN.md) · [恢复](sessions.zh-CN.md) · [报告漏洞](../../SECURITY.md)

**以可信为根基**，落在具体选择上：信任哪一版代码、允许什么操作、执行到哪里、结果如何检查。本页帮助你理解这些选择及其边界，适用于首次试用、插件开发和 FDE 集成。

AGH 可以执行工具、写文件和连接外部系统。模型文本、网页、MCP 结果、Skill 与插件配置都不是用户授权本身。先选择工作目录和可接受的能力，再批准具体操作。

## 三类不同的信任

| 边界 | 含义 | 不代表什么 |
| --- | --- | --- |
| 包信任 | 接受指定内容摘要与能力声明的代码 | 不是对所有未来版本的授权 |
| 工具审批 | 允许本次或当前选项所述范围的行为 | 不是操作系统沙箱已成功建立 |
| 沙箱/执行约束 | 由实际平台探测与策略限制执行 | 不是恶意进程内插件的隔离保证 |

普通第三方 Cordis 插件默认是进程内受信代码，信任它可能允许其使用进程能访问的 Node 能力。`ctx.extension()` 约束的是扩展 API，不隔离任意 Node 代码。安装第三方包前，应同时审核代码来源和声明的能力。

## 审批

默认交互流程在有需要时显示工具和可选决定。一次允许、会话允许、持久授权和拒绝的范围不同；后台根据当前凭据和策略作最终裁决。审批过期、断线或多客户端竞争时，以后台保存的决定为准。

`approvals.mode` 接受 `manual`、`smart`、`off`。TUI `/yolo` 会跳过当前会话余下审批且不能在该会话撤销；它不撤销其他权限与沙箱约束。不建议把跳过审批写入新手示例或自动化默认配置。

不要把“用户请求编辑文件”当成插件可任意执行的授权。插件应准确声明只读/破坏性、开放网络、可重放性及审批需求；这些元数据应与实际执行一致。

## 平台与进程

默认命令执行要求可用的沙箱；Linux 使用 bubblewrap，macOS 使用 Seatbelt。不可用且策略要求拒绝时返回 `SANDBOX_UNAVAILABLE`。宿主启动成功不代表所有工具可执行。Windows 的部分安全能力仍有外部验证与实现边界，见[限制](../reference/limitations.zh-CN.md)。

本地 Web 的安全边界是回环监听及精确 Origin/Host 校验，不是互联网用户认证。不要直接把它暴露到公网。手动 `--connect` 必须明确指定目标；Windows 命名管道还核对所属进程与发现记录。

Computer Use 是另一个高权限面：本地 profile 有启用配置，但仍需要运行组件、可用模型和操作系统授权。`computer-use permissions grant` 会触发授权流程，`install/restart` 会改变运行组件；只读排查先用 `computer-use status` 和 `doctor computer-use`，不要为文档自动授予系统权限。

## Skill 管理的删除边界

永久删除和优先级变更需要服务端 admin authority 与 `resources.skills.write`，通过 Web 管理 BFF 或 Node SDK 执行。用户优先级覆盖不授予信任或启用，不改变普通插件 API 权限。

磁盘 Skill 的永久删除覆盖所选目录的全部文件；用户级来源可能被其他应用共用。package/runtime 来源不能通过这个接口删文件。删除先核对登记来源、修订及文件身份，受理后不支持取消；部分失败仍保留删除标记、阻止重新启用，允许显式受限重试。同名候选可能接替，仍以其自己的授权状态判断是否可用。完整操作及限制见[Skills](skills.zh-CN.md#永久删除一个磁盘-skill)。

## 密钥和持久数据

Provider 密钥经配置服务存入凭据后端；公开配置只保留 `secret://...` 引用。MCP CLI 拒绝明文 `--token`/`--env` 等参数，只接受受限引用。引用也不是任意读取密钥的权限。

`AGH_HOME` 包含会话、配置、授权、审计和缓存。日志经过限缩不代表会话正文没有敏感信息；导出、截图或公开错误时仍要检查用户输入、工具参数与路径。不要提交 `secrets/`、`auth/`、完整 home、真实 trace 或凭据文件。`publicConfig` 会到浏览器，绝不能装入密钥或 secret 引用。

工作区 `.agh/secrets` 与旧 `.agnes/secrets` 均受文件工具/沙箱防护。不要把 AGH 的 home 指到其他产品的数据目录；旧 `AGNES_HOME` 是兼容项，没有自动迁移。

恢复未知副作用前先核对目标系统，再决定重试。后台数据库恢复并不能撤销已发出的邮件、网络写入或物理设备动作。

实现依据：[默认 profile](../../packages/host/templates/local-dev.yaml)、[普通行 API](../../packages/host/src/ext-host/row-extension-api.ts)、[MCP 参数策略](../../packages/resource-control-cli/src/resources.ts)、[Web server](../../packages/web-server/src/server.ts)。
