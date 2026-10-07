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

Web 审批卡先显示路径、命令等定位字段，超长的内容会注明已显示的字符数。“本会话允许”的范围是该会话内同一工具的全部后续调用，按钮上会写明工具名。调用的内容无法在卡片上完整显示时，卡片会提示，并且不提供“本会话允许”，只能“仅允许这次”或“拒绝”。

未获批准的调用会说明原因，会话记录和模型都能看到：用户拒绝、无人在期限内答复、没有客户端可询问、等待期间任务被停止、被命令策略拦截，或委派的子代理请求了其固定范围之外的操作。没有人可询问的调用记为“无法审批”而不是“已拒绝”，且不会执行。

`approvals.mode` 接受 `manual`、`smart`、`off`。Web「完全权限」和 TUI `/yolo` 会跳过当前会话余下审批，并允许文件工具读写所选工作区之外的文件。工作区仍是相对路径的默认目录。只读预设仍拒绝修改。明确的安全禁令、受保护的密钥路径、操作系统权限和命令沙箱约束仍然生效。不建议把跳过审批写入新手示例或自动化默认配置。

完全权限下，Agnes 主目录自身的状态——`secrets/`、`auth/`、`profiles/`——文件工具仍可读取，但不可写入：`write`、`edit` 等修改文件的操作会被拒绝并提示 `denied by policy`，因此会话无法改写 `profile.yaml`（例如写入 `approvals.mode: off`）并把改动带到之后的会话。所选工作区本身包含这些目录时同样拒绝。命令访问范围独立遵循所选预设：`workspace-write` 下，shell 写入仍受 OS 沙箱允许目录约束；显式选择 `full-access` 后，shell 没有 OS 隔离，可以修改进程有权访问的文件，包括 Agnes 主目录。

Web「工作区内修改」将文件访问限制在所选工作区内，执行命令仍遵循审批策略。访问工作区外路径时会拒绝操作，并提示切换「完全权限」或将目标目录选为工作区，不额外弹出审批。

默认验证器根据每次调用已记录的策略区分重复写入和只读调用。只读轮询不会触发 `repeated_write`；策略缺失或无法校验时仍保守处理，独立的无进展检查继续生效。MCP 工具须声明 `readOnlyHint: true` 才会被识别为只读。在当前运行中允许交互式验证器审批后，AGH 接受当前完成结果并结束本轮，不再要求模型重复宣布完成，也不会跳过后续轮次的验证。审批等待期间追加的指令会保留到新一轮，保留原有发送者和信任属性。

不要把“用户请求编辑文件”当成插件可任意执行的授权。插件应准确声明只读/破坏性、开放网络、可重放性及审批需求；这些元数据应与实际执行一致。

## 平台与进程

`standard` 配方与默认 `workspace-write` 预设要求 L1 OS 隔离：Linux 使用 bubblewrap，macOS 使用 Seatbelt。Host 在发布会话运行时前，针对工作区策略实际运行受隔离的子进程探测。缺少程序、禁用 namespace、Seatbelt 策略被拒绝时，初始化以 `E_SANDBOX_WORKSPACE` 拒绝，并说明所需后端；后续执行拒绝返回 `SANDBOX_UNAVAILABLE`。未创建会话的 Host 启动成功不证明沙箱可用。Windows 尚无已验证的 L1 后端，默认同样拒绝；见[限制](../reference/limitations.zh-CN.md)。

可在管理页的会话默认预设、创建会话时用 CLI `--preset <name>` 选择。存量会话变更沙箱权限须新建会话，`/preset` 会明确拒绝该类切换。可选项由 profile 的 `presets.allowed` 决定；本地与企业模板默认使用 `workspace-write`，`standard` 保留兼容名称。

| 预设 | 命令沙箱 | 审批与文件行为 |
| --- | --- | --- |
| `read-only` | 实测 L1；没有可写目录；禁止命令联网 | 仅披露读取工具；即使启用 `/yolo` 或关闭审批，也拒绝非读取效果及文件写入 |
| `workspace-write`（默认） | 实测 L1；允许工作区和显式额外目录写入；禁止命令联网 | 工作区编辑沿用审批规则；shell 和其他风险调用仍需审批 |
| `full-access` | 显式 L0；不做 OS 命令隔离 | 普通工具策略放行；文件工具可访问工作区外；主体授权拒绝及保护路径仍生效 |

即使使用 `full-access`，`edit` 和使用 `write` 覆盖已有文件也要求同一会话中已有该文件的观察记录，可来自读取或成功创建。其他写入者修改文件后，`write` 会拒绝过期的读取记录；必须重新读取再覆盖。创建新文件无需预先读取。

明确接受无 L1 执行时，显式使用 `agh --preset full-access`，或保存：

```yaml
presets:
  default: full-access
  allowed: [standard, read-only, workspace-write, full-access]
```

若要保留审批，可在自定义配方明确覆盖 `sandbox: { level: L0, required: false, on_unavailable: allow }`；命令将不受 OS 隔离。仅修改 `on_unavailable` 不会覆盖 `required: true`。Web「完全权限」和 `/yolo` 不会取消所选预设的 OS 沙箱。当前 L1 后端拒绝非空命令网络主机白名单；`web_fetch` 使用独立的公网访问策略。Profile 可以在启动时选择另一个沙箱提供者，见[沙箱提供者](sandbox-providers.zh-CN.md)。当前进程会保持这个选择，直到再次启动。

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

持久化合同分别声明账本、metadata/KV、耐久子任务控制、reclaim 和 integrity 能力。同步 SQL 仅通过可选 `sqlite` 端口（`dialect: sqlite`）提供；审批授权的 schema 检查也是 SQLite 专用操作。官方 SQLite 注册这些公开端口，Host 与其他提供者一样消费该合同。当前 Host 仍有依赖 SQL 的包 seam，启动时要求上述完整能力；缺失时明确列出缺失项并拒绝。JSONL 示例仅演示账本，不是完整替代。切换提供者需要重启，不自动迁移已有数据。

作者需要声明 `capabilities: { ledger: true, ... }`，将 SQL 移到 `store.sqlite.tables(owner)`，并显式提供 `metadata`、`childControl`、`reclaim` 和 `scanIntegrity`。旧的通用 `store.tables` 与伪造的 SQLite 诊断字段已移除；已有 SQLite 文件及审批授权 schema 格式保持兼容。

实现依据：[默认 profile](../../packages/host/templates/local-dev.yaml)、[普通行 API](../../packages/host/src/ext-host/row-extension-api.ts)、[MCP 参数策略](../../packages/resource-control-cli/src/resources.ts)、[Web server](../../packages/web-server/src/server.ts)。
