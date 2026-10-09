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

`approvals.mode` 接受 `manual`、`smart`、`auto-review`、`off`。Web「完全权限」和 TUI `/yolo` 会跳过当前会话余下审批，并允许文件工具读写所选工作区之外的文件。工作区仍是相对路径的默认目录。只读预设仍拒绝修改。明确的安全禁令、受保护的密钥路径、操作系统权限和命令沙箱约束仍然生效。不建议把跳过审批写入新手示例或自动化默认配置。

完全权限下，Agnes 主目录的私有状态——包括 `secrets/`、`auth/`、`profiles/` 以及显式指定的 secrets 目录——普通文件工具仍不可读取或写入。即使这些路径位于所选工作区内，硬拒绝也继续生效。授权管理应通过对应的设置与凭据服务；会话不能读取密钥，也不能改写 `profile.yaml` 将更弱的审批带到之后的会话。命令访问范围独立遵循所选预设：`workspace-write` 下，shell 写入仍受 OS 沙箱允许目录约束；显式选择 `full-access` 后，shell 可写工作区外，但已安装的记忆 provider 仍保留 Host 私有文件隔离底线；没有可用 OS 边界就拒绝执行，见[记忆](memory.zh-CN.md)。完全权限不授权命令访问受保护的安装状态。

Web「工作区内修改」将文件访问限制在所选工作区内，执行命令仍遵循审批策略。访问工作区外路径时会拒绝操作，并提示切换「完全权限」或将目标目录选为工作区，不额外弹出审批。

默认验证器根据每次调用已记录的策略区分重复写入和只读调用。只读轮询不会触发 `repeated_write`；策略缺失或无法校验时仍保守处理，独立的无进展检查继续生效。MCP 工具须声明 `readOnlyHint: true` 才会被识别为只读。在当前运行中允许交互式验证器审批后，AGH 接受当前完成结果并结束本轮，不再要求模型重复宣布完成，也不会跳过后续轮次的验证。审批等待期间追加的指令会保留到新一轮，保留原有发送者和信任属性。

不要把“用户请求编辑文件”当成插件可任意执行的授权。插件应准确声明只读/破坏性、开放网络、可重放性及审批需求；这些元数据应与实际执行一致。

### 自动审查

自动审查是在“每个风险调用都手动批准”和“跳过批准”之间的选择。在 Web **设置 → 安全** 中启用策略卡，选择已配置的 `fast`（默认低成本档位）或 `verifier` 模型。它只审查默认策略原本会询问人工的调用；自定义和只读策略继续独立裁决。完全权限与 `off` 保持原有语义，缺少审查模型不会偷偷改用主模型。可信用户 profile 也可配置 `approvals.mode: auto-review`，工作区配置不能启用它。

模型返回决定、风险和理由。默认只自动允许低风险；可显式选择允许中风险。高风险放行、低风险拒绝属于无效模型输出。格式错误、矛盾输出、异常、超时、不可信上下文、工具或类别不在范围内，以及预算耗尽，都交回人工批准。默认每会话最多 20 次审查尝试（包括失败和恢复前的尝试），超时 10 秒；设为 0 则使用人工审批。设置不可读时也使用零预算，直到修复。身份授权拒绝、命令拒绝规则、计划/只读限制、私有文件边界与沙箱始终有效，并先于审查执行。

每次审查在工具执行前写入账本，包含模型、策略提示词哈希、决定、风险、理由、延迟、成本和成本来源。工具卡、Trace 和**执行依据**均可查看。失败流拿不到实际用量时保留成本估算。审查放行不替代独立的身份授权审批。

执行依据可以显式设定未来同工具、参数、工作区、操作者、定义与策略的调用为允许、拒绝或人工审批；高风险审查不能创建自动放行规则。历史事实不改写，不会从批准回复中静默学习。策略卡显示规则数量并支持清除；设置按 profile 保存，只能由拥有配置权限的用户修改。插件端口见[工具运行时与策略](../extend/tool-runtime.zh-CN.md)。

## 平台与进程

`standard` 配方与默认 `workspace-write` 预设要求 L1 OS 隔离：Linux 使用 bubblewrap，macOS 使用 Seatbelt。Host 在发布会话运行时前，针对工作区策略实际运行受隔离的子进程探测。缺少程序、禁用 namespace、Seatbelt 策略被拒绝时，初始化以 `E_SANDBOX_WORKSPACE` 拒绝，并说明所需后端；后续执行拒绝返回 `SANDBOX_UNAVAILABLE`。未创建会话的 Host 启动成功不证明沙箱可用。Windows 尚无已验证的 L1 后端，默认同样拒绝；见[限制](../reference/limitations.zh-CN.md)。

可在管理页的会话默认预设、创建会话时用 CLI `--preset <name>` 选择。存量会话变更沙箱权限须新建会话，`/preset` 会明确拒绝该类切换。可选项由 profile 的 `presets.allowed` 决定；本地与企业模板默认使用 `workspace-write`，`standard` 保留兼容名称。

| 预设 | 命令沙箱 | 审批与文件行为 |
| --- | --- | --- |
| `read-only` | 实测 L1；没有可写目录；禁止命令联网 | 仅披露读取工具；即使启用 `/yolo` 或关闭审批，也拒绝非读取效果及文件写入 |
| `workspace-write`（默认） | 实测 L1；允许工作区和显式额外目录写入；禁止命令联网 | 工作区编辑沿用审批规则；shell 和其他风险调用仍需审批 |
| `full-access` | 配置 L0；已安装的记忆 provider 仍要求私有文件 OS 隔离 | 普通工具策略放行；文件工具可访问工作区外；主体授权拒绝及保护路径仍生效 |

即使使用 `full-access`，`edit` 和使用 `write` 覆盖已有文件也要求同一会话中已有该文件的观察记录，可来自读取或成功创建。其他写入者修改文件后，`write` 会拒绝过期的读取记录；必须重新读取再覆盖。创建新文件无需预先读取。

需要允许工作区外文件时，显式使用 `agh --preset full-access`。没有可用 L1 时，受控文件工具仍可用，但已安装的记忆 provider 会拒绝未隔离命令。可保存：

```yaml
presets:
  default: full-access
  allowed: [standard, read-only, workspace-write, full-access]
```

若要保留审批，可在自定义配方明确覆盖 `sandbox: { level: L0, required: false, on_unavailable: allow }`；只有没有已安装 provider 要求私有文件隔离时，才可执行未隔离命令。仅修改 `on_unavailable` 不会覆盖 `required: true`。Web「完全权限」和 `/yolo` 不会取消所选预设的 OS 沙箱。当前 L1 后端拒绝非空命令网络主机白名单；`web_fetch` 使用独立的公网访问策略。Profile 可以在启动时选择另一个沙箱提供者，见[沙箱提供者](sandbox-providers.zh-CN.md)。当前进程会保持这个选择，直到再次启动。

本地 Web 的安全边界是回环监听及精确 Origin/Host 校验，不是互联网用户认证。不要直接把它暴露到公网。手动 `--connect` 必须明确指定目标；Windows 命名管道还核对所属进程与发现记录。

Computer Use 是另一个高权限面：本地 profile 有启用配置，但仍需要运行组件、可用模型和操作系统授权。`computer-use permissions grant` 会触发授权流程，`install/restart` 会改变运行组件；只读排查先用 `computer-use status` 和 `doctor computer-use`，不要为文档自动授予系统权限。

## Skill 管理的删除边界

永久删除和优先级变更需要服务端 admin authority 与 `resources.skills.write`，通过 Web 管理 BFF 或 Node SDK 执行。用户优先级覆盖不授予信任或启用，不改变普通插件 API 权限。

磁盘 Skill 的永久删除覆盖所选目录的全部文件；用户级来源可能被其他应用共用。package/runtime 来源不能通过这个接口删文件。删除先核对登记来源、修订及文件身份，受理后不支持取消；部分失败仍保留删除标记、阻止重新启用，允许显式受限重试。同名候选可能接替，仍以其自己的授权状态判断是否可用。完整操作及限制见[Skills](skills.zh-CN.md#永久删除一个磁盘-skill)。

## 密钥和持久数据

本地模型账户使用 `AGH_HOME/secrets` 下的私有文件（macOS 也一样），会话模型适配器读取同一存储。写入凭据时，AGH 会将当前用户拥有、所有者可写且组和其他用户不可写的 home（例如 0755）收紧至 0700；不会修复现有凭据目录或文件，目录须为 0700、文件须为 0600。存储失败会拒绝账户操作，并在 `AGH_HOME/data/audit/configuration.jsonl` 记录错误类别、原因、受控系统错误码和具体路径，不记录凭据内容。设置界面会区分权限错误、只读文件系统与不安全或无效的存储。

Provider 密钥经配置服务存入凭据后端；公开配置只保留 `secret://...` 引用。MCP CLI 拒绝明文 `--token`/`--env` 等参数，只接受受限引用。引用也不是任意读取密钥的权限。

`AGH_HOME` 包含会话、配置、授权、审计和缓存。日志经过限缩不代表会话正文没有敏感信息；导出、截图或公开错误时仍要检查用户输入、工具参数与路径。不要提交 `secrets/`、`auth/`、完整 home、真实 trace 或凭据文件。`publicConfig` 会到浏览器，绝不能装入密钥或 secret 引用。

文件工具与沙箱保护工作区 `.agh/secrets`。Linux 上 Host 在编译命令沙箱前准备祖先 `.agh`：缺失时只以普通权限创建这个 AGH 自有空目录，不跟随符号链接；若已是链接或非目录，以 `E_SANDBOX_WORKSPACE`（`workspace-ancestor-not-directory`）精确拒绝。祖先保留真实挂载锚点，命令不能通过重命名它暴露凭据。`.agnes/secrets` 属于其他产品，不再享有 AGH 隐式防护，也不自动迁移。不要把 AGH 的 home 指到其他产品的数据目录；旧 `AGNES_HOME` 是兼容项，没有自动迁移。

恢复未知副作用前先核对目标系统，再决定重试。后台数据库恢复并不能撤销已发出的邮件、网络写入或物理设备动作。

持久化合同分别声明账本、metadata/KV、耐久子任务控制、reclaim 和 integrity。完整 Host 要求这五项能力，接受完整非 SQL 提供器，包括 [JSONL 示例](../../examples/persistence/)。同步 SQL 通过可选 `sqlite` 端口（`dialect: sqlite`）提供，依赖 SQL 的第三方扩展须选择支持它的后端。默认包域及 Host 授权/回执存储使用所有者隔离的 metadata。切换需要重启，不自动迁移文件，参见[提供器合同与导出/导入迁移](../extend/persistence.zh-CN.md)。

作者声明 `capabilities: { ledger: true, ... }`，并显式提供 `metadata`、`childControl`、`reclaim` 和 `scanIntegrity`。SQLite 账本和子任务文件保持兼容。旧授权及回执 schema 先严格校验，再复制到 metadata；撤权先持久化后通知。旧 SQL 表保留用于回退核验，新 metadata 更新不反写旧表。

实现依据：[默认 profile](../../packages/host-common/templates/local-dev.yaml)、[普通行 API](../../packages/host-extensions/src/ext-host/row-extension-api.ts)、[MCP 参数策略](../../packages/resource-control-cli/src/resources.ts)、[Web server](../../packages/web-server/src/server.ts)。

<a id="package-provenance-and-source-policy"></a>

## 包来源记录与来源策略

新安装保存解析后的来源和版本、打包文件树 SHA256、可用的发布者证据、安装时间、安装者及信任决定。`agh plugins provenance <id> --json` 读取记录；App Server 的 `_agnes/v1/packages.provenance` 和 `_agnes/v1/packages.sourcePolicy` 是管理只读方法。审阅对话框和插件详情展示相同摘要。验证发布者不等于隔离插件代码：进程内插件仍需审阅其声明的权限。

安装时验证下载内容；加载安装包和不可变代际快照时重新计算文件树摘要。摘要不一致拒绝加载（`E_PACKAGE_INTEGRITY`）；无效来源证据使用 `E_PACKAGE_PROVENANCE`。旧锁记录继续可读，但不会自动获得已验证发布者身份。npm 有 attestation 时通过 Sigstore 验证，并核对精确包名、版本及实际下载档案摘要；证据缺失显示未验证，证据无效则拒绝安装。

管理端来源记录包含已声明来源的解析位置。诊断消息仍使用固定的安全摘要，不暴露无关本地路径。

管理员配置 `<AGH_HOME>/profiles/<profile>/package-sources.json`：

```json
{ "allowedSources": "any-with-confirmation" }
```

默认 `any-with-confirmation` 保留绑定摘要的信任确认。`official-only` 只允许签名官方目录中的精确包；`official+npm-with-provenance` 另外允许已验证发布者证据的 npm 包。获取包及加载安装清单时检查策略。策略变化不会悄悄替换运行会话已经固定的代码。

官方目录预留维护者管理的 Ed25519 公钥槽：`officialKeys` 将密钥 ID 映射到 PEM 公钥；`officialCatalog` 保存 `{ "statement": { "keyId", "issuedAt", "entries" }, "signature" }`。每个签名条目绑定 `id`、`version`、解析后的 `source`、`treeIntegrity` 和 `publisher`。签名是 statement 按键排序的规范 JSON 的 UTF-8 字节上的 Ed25519 签名，以 base64 保存。可选签名字段 `mcpDefinitions` 保存完整 MCP 定义经 JCS 序列化后的 `sha256-<hex>` 摘要，只有精确匹配的已验证定义才能取得官方 stdio 默认配置。管理员配置公钥，不接受下载包自带的公钥。测试动态生成开发密钥；生产官方签名密钥及目录由维护者配置。
