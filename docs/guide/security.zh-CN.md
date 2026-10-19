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

普通第三方 Cordis 插件默认是进程内受信代码，信任它可能允许其使用进程能访问的 Node 能力。插件 facet 约束的是注册行为，不隔离任意 Node 代码。安装第三方包前，应同时审核代码来源和声明的能力。

## 审批

默认交互流程在有需要时显示工具和可选决定。一次允许、会话允许、持久授权和拒绝的范围不同；后台根据当前凭据和策略作最终裁决。审批过期、断线或多客户端竞争时，以后台保存的决定为准。

回答者绑定到已认证连接，或由后端配置的 verifier 核验来源凭据。答案中的 actor 或未核验凭据不能冒充其他审批人。会话记录用 `answeredBy` 单独保存回答者，不覆盖请求者。后端只接受实际提供的选项：记忆文件变更与退出 Plan 只提供单次批准和拒绝。发送失败（`transport`）、界面断开（`detached`）、到期（`deadline`）、SDK 无处理器（`no-handler`）和停止任务（`stopped`）都不会记成人工拒绝（`user-rejected`）。刷新后的合格连接可以重新收到尚未回答的工具或管理问题。停止会话或 worker 会撤销其 offer，晚到答案不能触发执行。

退出 Plan 必须由人对当前精确 revision 作单次确认，即使使用完全权限、`off`、自动 review 或已有 grants。清除状态使用工作区文件的比较并交换；旧答案不能清除已改写的计划。损坏或不可读的计划文件会保持阻塞，直到人修复文件或明确执行 `/plan off`。

Web 审批卡先显示路径、命令等定位字段，超长的内容会注明已显示的字符数。“本会话允许”的范围是该会话内同一工具的全部后续调用，按钮上会写明工具名。调用的内容无法在卡片上完整显示时，卡片会提示，并且不提供“本会话允许”，只能“仅允许这次”或“拒绝”。

未获批准的调用会说明原因，会话记录和模型都能看到：用户拒绝、无人在期限内答复、没有客户端可询问、等待期间任务被停止、被命令策略拦截，或委派的子代理请求了其固定范围之外的操作。没有人可询问的调用记为“无法审批”而不是“已拒绝”，且不会执行。

`approvals.mode` 接受 `manual`、`auto-review`、`off`。`off` 跳过普通工具审批，不等于 `full-access` 权限，不会扩大文件范围或取消命令隔离。TUI `/yolo` 只跳过当前会话的普通审批，保留权限、预设、命令表、隔离及[领域确认](#full-access-exceptions)；它不会把会话变成完全访问，也不会改写新会话的权限选择。`manual` 是“策略要求时问人”，不是每次调用都问。

完全权限下，Agnes 主目录的私有状态——包括 `secrets/`、`auth/`、`profiles/` 以及显式指定的 secrets 目录——普通文件工具仍不可读取或写入。即使这些路径位于所选工作区内，硬拒绝也继续生效。授权管理应通过对应的设置与凭据服务；会话不能读取密钥，也不能改写 `profile.yaml` 将更弱的审批带到之后的会话。命令访问范围独立遵循所选权限：macOS/Linux 的 `workspace-write` 下，shell 写入受 OS 沙箱允许目录约束，Windows 命令没有系统隔离；显式选择 `full-access` 后，shell 可写工作区外，但 macOS/Linux 已安装的记忆 provider 仍保留 Host 私有文件隔离底线；没有可用 OS 边界就拒绝执行，见[记忆](memory.zh-CN.md)。应用权限不能代替系统隔离：获准的 Windows 命令以当前系统账户执行，可以访问该账户有权访问的文件和网络。

Web「工作区内修改」将文件访问限制在所选工作区内，执行命令仍遵循审批策略。访问工作区外路径时会拒绝操作，并提示切换「完全权限」或将目标目录选为工作区，不额外弹出审批。

默认验证器根据每次调用已记录的策略区分重复写入和只读调用。只读轮询不会触发 `repeated_write`；策略缺失或无法校验时仍保守处理，独立的无进展检查继续生效。MCP 工具须声明 `readOnlyHint: true` 才会被识别为只读。在当前运行中允许交互式验证器审批后，AGH 接受当前完成结果并结束本轮，不再要求模型重复宣布完成，也不会跳过后续轮次的验证。审批等待期间追加的指令会保留到新一轮，保留原有发送者和信任属性。

不要把“用户请求编辑文件”当成插件可任意执行的授权。插件应准确声明只读/破坏性、开放网络、可重放性及审批需求；这些元数据应与实际执行一致。

### 自动审查

自动审查是在“每个风险调用都手动批准”和“跳过批准”之间的选择。在 Web **设置 → 安全** 中启用策略卡，选择已配置的 `fast`（默认低成本档位）或 `verifier` 模型。它只审查默认策略原本会询问人工的调用；自定义和只读策略继续独立裁决。完全权限与 `off` 保持原有语义，缺少审查模型不会偷偷改用主模型。可信用户 profile 也可配置 `approvals.mode: auto-review`，工作区配置不能启用它。

无需编写代码：打开 **设置 → 模型账户 → 辅助模型**，或点击自动审查卡的 **配置辅助模型**。从已有目录选择 `fast` 和／或 `verifier` 的路由与模型，然后保存。区域显示当前选择或 **未设置**，不可用的旧选择仍可见。这些 profile 默认值适用于 **新会话**。在 **设置 → 安全** 选择同一审查档位，卡片会显示该 profile 默认值是否可用。

已有会话可从输入区的模型选择器打开 **辅助模型（高级）**，显式选择路由与模型，再为当前会话保存对应档位。此操作复用会话模型接口，重新打开会话后仍保留，不改变主模型或 profile 默认值。清除 profile 档位只影响新会话；已有会话保留已保存的选择。切换会话预设仍按既有行为重置模型覆盖。未设置或不可用的审查模型会转交人工，绝不静默借用付费主模型。配置本身不调用模型，后续实际审查可能产生供应商费用。

模型返回决定、风险和理由。默认只自动允许低风险；可显式选择允许中风险。高风险放行、低风险拒绝属于无效模型输出。格式错误、矛盾输出、异常、超时、不可信上下文、工具或类别不在范围内，以及预算耗尽，都交回人工批准。默认每会话最多 20 次审查尝试（包括失败和恢复前的尝试），超时 10 秒；设为 0 则使用人工审批。设置不可读时也使用零预算，直到修复。身份授权拒绝、命令拒绝规则、计划/只读限制、私有文件边界与沙箱始终有效，并先于审查执行。

每次审查在工具执行前写入账本，包含模型、策略提示词哈希、决定、风险、理由、延迟、成本和成本来源。工具卡、Trace 和**执行依据**均可查看。失败流拿不到实际用量时保留成本估算。审查放行不替代独立的身份授权审批。

执行依据可以显式设定未来同工具、参数、工作区、操作者、定义与策略的调用为允许、拒绝或人工审批；高风险审查不能创建自动放行规则。上下文受不可信内容污染时，即使命中「以后完全相同的调用」人工允许规则，也须交回人工；匹配规则仅作为上下文展示。未污染调用继续按规则执行。历史事实不改写，不会从批准回复中静默学习。策略卡显示规则数量并支持清除；设置按 profile 保存，只能由拥有配置权限的用户修改。插件端口见[工具运行时与策略](../extend/tool-runtime.zh-CN.md)。

## 平台与进程

在 `workspace-write`、`read-only` 权限下，随附的预设请求 L1，使用 `required: false` 和 `on_unavailable: allow-if-unimplemented`。可信本机后端声明系统隔离是否已实现。macOS/Linux 已实现，必须实际通过 Seatbelt/bubblewrap 探测；缺少程序、namespace 禁用或策略拒绝仍以 `E_SANDBOX_WORKSPACE` 拒绝初始化，不能当作“未实现”。Windows 本机后端声明尚未实现，所以允许原生命令，不探测 POSIX 后端。未知能力、远程目标不能借此自动放行。`required: true` 始终要求真正隔离。

Windows 保留工具审批、只读限制、文件工具的工作区与保护路径检查，以及用户明确设置的审批模式。获准命令使用当前系统账户执行，应用检查不能隔离任意 shell 的文件或网络操作。设置页、会话运行信息和输入框分别显示权限与实际隔离状态。

<a id="permissions-and-presets"></a>

### 权限与预设

会话有两项相互独立的选择。**权限**决定会话能做什么：文件范围、普通审批和命令隔离。**预设**（preset）是会话怎样工作的配方：模型能看到的工具、提示词、模型槽位和预算。任何允许的预设都可以搭配任何允许的权限，例如 `agh --preset ptc --permission full-access`，例外见下文。权限不改变预设的工具。

| 权限 | 文件范围 | 普通审批 | 持久能力 | OS 隔离 |
| --- | --- | --- | --- | --- |
| **只读**（`read-only`） | 查看允许范围的文件和公开网页 | 修改与命令执行会被拒绝 | Agent 不写入；管理信任独立 | macOS/Linux 需通过 L1 探测；Windows 此平台命令未隔离 |
| **可修改工作区**（`workspace-write`，默认） | 文件工具可改工作区和明确授权的额外目录；官方记忆经受控提供方访问 | 命令需审批；范围内文件修改预批准，仍服从明确拒绝 | 记忆 off 拒绝，ask 精确 diff 确认，auto 保留归属、大小和 CAS 校验；其他工作区及用户记忆对 Agent 只读 | 命令隔离取决于平台：macOS/Linux 实测 L1；Windows 此平台命令未隔离 |
| **完全访问**（`full-access`） | 工作区内外普通文件；保护目录仍拒绝 | 普通操作不再逐次审批 | 计划/记忆规则及安装信任确认仍生效，见[例外](#full-access-exceptions) | 配置 L0；macOS/Linux 注册记忆提供方时仍保留私有文件隔离；Windows 无 OS 隔离 |

| 预设 | 设定内容 |
| --- | --- |
| `standard`（默认） | 标准工具集，模型直接调用工具 |
| `minimal` | 只向模型展示 `read`、`grep`、`find`、`ls`，其他工具（包括扩展和 MCP 工具）都不可见。这只限制模型能看到什么，这些工具能做什么仍由权限决定 |
| `ptc` | 程序化工具调用：模型编写代码，通过 `run_code` 调用工具，见[程序化工具调用与工作流](code-workflows.zh-CN.md) |
| `channel` | 聊天频道的部署配方：回复适合聊天场景，审批以卡片形式在会话中等待 |
| `claw` | 无人值守的部署配方：无人能回答的审批会停等。它要求 L1 隔离，因此 `claw` 搭配 `full-access` 会被拒绝 |

创建会话时分别选择：CLI 与无头运行使用 `--preset NAME` 和 `--permission LEVEL`，SDK 使用 `createSession({ cwd, preset, permission })`，Web 输入区提供预设菜单（「默认」项跟随管理员设置的默认预设，以及「最小工具集」「编程工具集」）和独立的权限选择。管理员在 **设置 → 权限与安全** 设置新会话的默认权限和默认预设。profile 的 `presets` 与 `permissions` 列出可选项：

```yaml
presets: { default: standard, allowed: [standard, minimal, ptc] }
permissions: { default: workspace-write, allowed: [read-only, workspace-write, full-access] }
```

本地与企业模板都带这两项（企业模板允许 `standard` 和 `ptc`）。没有 `permissions` 的 profile 由 `presets.allowed` 推导允许的权限级别；用户或工作区层只写了 `presets` 而没写 `permissions` 时，内置模板的 `permissions` 不再保留，因此收窄 `presets` 也会收窄权限。`--permission default` 或 `permission: 'default'` 表示跟随部署默认值。

旧的预设名 `read-only`、`workspace-write`、`full-access` 仍可用作 `--preset` 值和 `presets.allowed` 条目，各自表示该权限下的 `standard` 预设，因此 `agh --preset read-only` 等同于 `agh --preset standard --permission read-only`。把它们与不同的 `--permission` 组合会报错。只指定预设的请求（如 `--preset ptc`）继续以 `workspace-write` 运行，即使管理员之后修改了默认权限，已有脚本和计划任务的行为也不变。`--agent` 不能与 `--permission` 组合，由智能体自己的 launch 决定。

已打开的会话保持原有权限。`/preset NAME` 切换预设并保留权限；会改变沙箱约束的切换（包括任何权限变化）会被拒绝，须新建会话。自定义预设若自行写入沙箱或命令审批设置，就固定了自己的权限，会拒绝 `--permission` 选择。

### 无人值守审批

计划任务和 Webhook 触发器使用明确的无人值守策略，不切换完全访问，也不关闭审批。**遇到审批时 → 转人工并通知（默认）**：无人可回答时，运行停为 `waiting_approval`，自动化历史标记“需要处理”。通过 Web 通知及审批收件箱通知 owner；属于已绑定频道会话的运行也向该频道通知。人可以稍后通过正常审批界面回答，运行随后继续。待决期间不派发副作用。

沿用现有 pending TTL。过期后本次为“失败 / 需要处理”，不能显示“已运行”；下次仍可执行，并保留“上次审批已过期”的需处理提示，即使本次成功也可见。上次仍待审批时，下次会在历史明确标记，不静默堆积新的停等会话。每个计划任务/触发器也可选择 **直接拒绝**：无人回答时以 `unattended-refused` 结束该步骤，不伪造人为拒绝或授权。缺失 handler、断线都不代表允许执行。

### 完全相同的后续调用规则

自动审核的 **以后完全相同的调用（同身份/目录/工具定义）** 绑定全部参数、cwd、actor 身份、工具策略和定义指纹。卡片预览参数（可能截断）、目录和审批模式；绑定值变化后需重新决定，同身份同目录的不同会话可复用。这与会话级工具授权不同。上下文受污染时，即使命中精确人工允许规则也返回人工处理；未污染调用仍可复用该规则。人工规则和模型放行都不能跳过这项检查。

<a id="full-access-exceptions"></a>

### 完全访问的例外

macOS 和 Linux 上的候选作者测试通过 Host 的 OS 沙箱执行，仅可写独立的候选副本；保护路径和 AGH 私有 home 拒绝访问，网络权限沿用会话隔离规则。POSIX 沙箱不可用时拒绝运行。**可修改工作区** 只显示一张确认卡，展示包名、短摘要、执行方式、风险与范围；批准仅授权这个精确摘要运行一次，摘要变化后拒绝旧授权。**完全访问（full-access）** 仅在有效会话策略允许且 OS 隔离实际生效时免除此确认。**Windows** 无 OS 隔离，即使完全访问也必须确认，并提示「此平台未隔离，将在本机直接运行候选代码」。运行前请到 **设置 → 插件 → 候选** 审阅源码。精确摘要决定写入私有 resource-control 目录的 `candidate-test-audit.jsonl`。测试不发布、不信任、不启用代码；只读和计划限制仍生效。

完全访问仍要求明确确认候选、插件及 Skill 的安装、信任、启用，以及能力范围变更；不会跳过「写入前询问」模式的记忆写入审批或凭据管理确认。保护路径保留原有硬拒绝，完全访问不能批准普通文件工具访问凭据或应用私有状态。Skill 导入安装和 MCP 注册／启动的审批保持不变；人工维护的本地插件和可信磁盘 Skill 仍遵循各自文档中的信任路径。

即使使用 `full-access`，`edit` 和使用 `write` 覆盖已有文件也要求同一会话中已有该文件的观察记录，可来自读取或成功创建。其他写入者修改文件后，`write` 会拒绝过期的读取记录；必须重新读取再覆盖。创建新文件无需预先读取。

需要允许工作区外文件时，显式使用 `agh --permission full-access`（旧写法 `agh --preset full-access` 仍可用）。macOS/Linux 没有可用 L1 时，受控文件工具仍可用，但记忆 provider 会拒绝未隔离命令。Windows 使用可信本机后端的“未实现”例外，保留记忆 API 权限。可在 profile 中设为新会话默认：

```yaml
permissions:
  default: full-access
  allowed: [read-only, workspace-write, full-access]
```

若要保留审批，可在自定义配方明确覆盖 `sandbox: { level: L0, required: false, on_unavailable: allow }`，这样的配方固定自己的权限设置；没有已安装 provider 要求私有文件隔离，或可信 Windows 本机后端声明未实现时，才可执行未隔离命令。L0 不允许搭配新条件值。仅修改 `on_unavailable` 不会覆盖 `required: true`。Web「完全权限」和 `/yolo` 不会取消所选预设的 OS 沙箱。当前 L1 后端拒绝非空命令网络主机白名单；`web_fetch` 使用独立的公网访问策略。Profile 可以在启动时选择另一个沙箱提供者，见[沙箱提供者](sandbox-providers.zh-CN.md)。当前进程会保持这个选择，直到再次启动。

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

仓库 `.agh/plugins` 初次发现时禁用且未信任。设置 → 运行详情 → 本地插件 提供含数量的确认，绑定当前插件快照与 `.agh/hooks.json` 摘要。信任记录存于用户 profile，不在仓库。执行输入编辑后须再次审核。Skill 是指令文本，附带代码、仓库 package 脚本与 MCP 配置不会仅因启动会话而执行。命令 hooks 除沙箱检查外，还要求精确内容信任。

Windows 使用 PowerShell 时，没有进程隔离的命令 Hook 还须取得 `commandHooks.trustedUnconfined` 授权，精确匹配配置来源、内容摘要和规范化工作区。Hook 使用当前工作区绑定的 Host 执行接口，由 Host 判断能否执行，包括 `allow-if-unimplemented`、显式拒绝和 `required: true`；授权按每次调用的规范化工作区核对，覆盖其他工作区中的会话。Hook 信任不能覆盖这项判断。未受信任的工作区 Hook 不会进入本次调用；受信任但执行被拒的 Hook 仍按对应事件原有的失败规则处理。macOS/Linux 的隔离要求、工具审批，以及前述 Windows 记忆保护限制均不改变。
