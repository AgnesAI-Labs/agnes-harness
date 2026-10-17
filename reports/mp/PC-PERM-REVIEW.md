# PC-PERM-REVIEW：会话权限评审

状态：评审报告；不修改产品代码。基线 `origin/feat/agh-plugin-core` = `469c0185145105523d2252aaf81be158266b9c46`，分支 `review/agh-pc-perm-review`。2026-10-17，macOS arm64，Node 24.20.0，pnpm 10.34.5。

## 给用户的三句话

- **只读 / Read only**：查看允许范围内的文件和公开网页；修改和执行命令直接拒绝，不是“每次修改都问我”。
- **可修改工作区 / Edit workspace**：工作区文件通常直接修改，shell 等风险调用先审批；macOS/Linux 通过可用的 OS 沙箱限制命令，Windows 没有这层隔离。
- **完全访问 / Full access**：工作区内外的普通操作不再逐次审批；应用私有路径、计划模式、记忆写入策略、插件/Skill/MCP 信任管理和操作系统权限仍独立生效。不是无条件控制整台电脑；但候选 Node 测试属于本机代码执行，当前没有套用会话文件沙箱，见 F9。

这三档作为默认体验基本合理；目前最明显的问题是**默认模式的官方记忆访问被命令表误拒绝**、**完全访问的文案承诺过宽**，以及**无人值守审批停等及运行状态表达不足**；另需 owner 审视 full 下免审批候选测试的本机代码执行边界（F9）。不要通过把自动化一律设成 full-access 来修复停等。

## 1. 实际有哪些选项

| 入口 / id | 中文 | English | 实际含义 |
| --- | --- | --- | --- |
| composer `view` → `read-only` | 只读 | Read only | 读策略，不提供“允许这次修改”的升级通道 |
| composer `workspace` → `workspace-write` | 可修改工作区 | Edit workspace | 默认工具策略 + 工作区 edit/write 预批准 + L1 请求 |
| composer `full` → `full-access` | 完全访问 | Full access | full-access 工具策略 + L0 配置；有 memory provider 时 macOS/Linux 仍要求私有文件隔离 |
| 设置默认权限 | 同上三项 | 同上三项 | 保存新会话默认 preset；已有会话不随之改变 |
| 更多配方 `standard` | 标准权限 | Standard permissions | 当前和 workspace-write 使用相同普通审批及文件边界；不是每次询问 |
| profile `approvals.mode` | 非上述三档 | `manual` / `off` / `auto-review` | 另一个轴：普通风险人工审批 / 关闭普通审批 / 默认策略所问调用先交自动审核 |

`permission-picker.tsx:6,77` 定义三个 UI id；`web/src/app.ts:1815` 映射 preset；`web-admin/src/settings/session-choice.ts:15` 还把 standard/default policy 显示成工作区档。配置可允许 minimal、ptc、channel、自定义及插件配方，不能把它们统称为额外的三个权限等级。

当前 composer、设置及 locale 源码没有「每次都提示审批」这一档。`manual` 的含义是“需要审批的调用交人工”，不是所有调用都问。无法据当前版本认定 owner 早先见到的旧标签对应哪一版。

## 2. 裁决顺序与全矩阵

符号：**A** 自动允许；**Q** 需要审批；**D** 拒绝；**G** 独立管理/领域确认；**N** 不存在或未安装。A 仅表示相应策略放行，工具仍可能因内容、不可用组件或系统权限失败。

默认假设：官方 Base/Code、本地 sandbox provider、人工审批 `manual`、无已有 grant、计划模式关闭、无额外路径。文件观察记录、预算和主体授权另行检查。`standard` 与工作区档相同，除特别注明外不重复一列。

| 操作 | read-only | workspace-write / standard | full-access | 证据、条件 |
| --- | --- | --- | --- | --- |
| read/ls/grep/find 工作区普通文件 | A | A | A | `tools-core/src/tools/read.ts:189`；真实 read-inside |
| 文件工具读取工作区外普通文件 | D | D | A | `adapters/fs.ts:153`；明确 extra_paths/Skill 读覆盖另论，但默认命令表仍可能误拒绝（F1） |
| write/edit 工作区文件 | D | A | A | `standard.yaml:29` command_policy；真实 write-inside |
| 文件工具写工作区外 | D | D | A | 审批一次不能扩大 FsPolicy；需要选范围或切换权限 |
| `.git`、工作区 `.agh/secrets`、用户 `.ssh`、应用私有路径 | D | D | D | 普通文件工具硬拒绝；受控 memory 端口是专门例外 |
| shell echo、只读 shell、任意命令 | D | Q | A | shell 作为执行能力整体分类，不解析 echo/cat 的无害程度 |
| shell 写工作区外（普通目录） | D | Q → macOS/Linux OS 拒绝；Windows 批准后可写 | A | 即使有 shell grant，workspace L1 写域仍在；Windows 仅有应用层入口检查 |
| shell 联网 | D | Q → macOS/Linux 网络拒绝；Windows 批准后可联网 | A | full-access 有私有文件隔离时可保留开放网络；不是 web_fetch 的同一网络策略 |
| web_fetch 公开 HTTP(S) 匿名 GET | A | A | A | 真实 example.com 200；不需要 shell 网络权限 |
| web_fetch 回环/私网/带用户名密码 URL | D | D | D | 真实 127.0.0.1 被 `WEB_BLOCKED_URL` 拒绝；不是额外点一下审批就可访问 |
| web_search | 未在 read-only core 列表 | A，需搜索 provider | A，需搜索 provider | `read-only.yaml:4`、`tools-web/src/search.ts:23`；非所有读能力都装载 |
| MCP 已信任、已启用、readOnlyHint=true 且不矛盾 | A | A | A | composition/disclosure 和 MCP 权限还须允许；元数据来自已接入服务 |
| MCP destructive/缺少只读提示 | D | Q | A | `base/src/mcp/register.ts:303`；缺失 destructiveHint 保守当作 destructive |
| MCP 非只读但显式非 destructive + idempotent | D | 普通未污染上下文可 A | A | replay 安全不等于只读；taint 可使工作区模式问审批 |
| memory mode=off | D | D | D | provider 默认 off；不能借 shell/别名跨越 |
| 当前工作区 memory mode=ask 写入 | D | **当前误 D**；预期 G | G：每次精确文件 diff、base/new hash、一次性人工确认 | 真实 memory-write-ask；F1；`memory-approval.ts:11` |
| 当前工作区 memory mode=auto 写入 | D | **当前误 D**；预期 A | A | 仍校验内容、大小、CAS、工作区归属；不是整个 memory 树授权 |
| 其他工作区记忆/用户记忆写入 | D | D | D | `memory-file/src/session.ts:76`，用户层对 Agent 只读 |
| plugin_scaffold / candidate_write / 提交审核 | D | Q（工具 always） | 普通工具 A | 提交只是申请人工发布，不安装/信任/启用 |
| plugin_test / Skill 候选测试 | D（工具层先挡住） | Q；通过后仍有候选摘要绑定的 G | A，仅有效 full-access 策略允许时 | `worker-runtime/src/plugin-manage.ts:20`；真实候选测试另见实测节；不因 /yolo 或 off 自动豁免 |
| 插件/Skill 候选发布、安装、信任、启用、扩大能力 | Agent 不可自批 | G | G | `daemon-admin/src/packages/handler.ts:795`，管理 authority + exact hash；现有受信任磁盘 Skill 等有独立路径，不是每次读取都审批 |
| Skill helper 导入准备/安装 | D | 普通工具 Q + 域确认 G | G | helper 为可选插件；本地越界读取另有确认，安装 commit 确认摘要、目标、trust/enable；`skill-install.ts:275,390` |
| MCP 注册/信任/启用/启动配置 | G 或未提供 Agent 工具 | G | G | `daemon/src/supervisor/mcp-manage-requests.ts:331`；全 profile 共享，可启动第三方程序 |
| 凭据值读取 | D | D | D | 普通文件工具不开放；管理 API 返回引用/metadata，保存值不回显 |
| 凭据管理 | 管理入口独立授权 | 同左 | 同左 | 不因 preset 授予 admin；强删被引用凭据还要求 confirm=true（`credentials.ts:65`），不是每次 create/set 都弹普通工具审批 |
| Computer Use 截屏/查询等 read actions | 策略 A（若能力已提供） | A | A | `computer-use/src/safety.ts:153`；仍受应用类别、截图范围、模型/组件/OS 权限限制 |
| Computer Use 点击/输入/聚焦等变更 | D | Q | A | full 不绕开敏感应用拒绝或 macOS 系统授权；Linux 不可用；本次不调用真实设备 |
| subagent 管理/启动 | read-only 策略拒绝非读的启动；读取状态按 meta | A | A | `extension-api/src/tool-policy.ts:111` 对管理工具免普通风险问答；继承父 preset、深度/扇出/模型 allowlist、工作区及预算限制仍在 |
| schedule_create/update/delete | D | 通常 A；污染上下文可 Q | A | `schedule/src/tools.ts:12` requiresApproval=never；schedule_list 是读；不能认为“其他动作都问” |
| 计划模式中写入/执行（包括 full） | D | D | D | `plan-mode-contract.ts:23`；损坏/缺 revision 则 fail closed |
| 退出计划模式 | Q，一次性 human；不因此得到写权限 | Q，一次性 human | Q，一次性 human | 明确 plan revision；auto-review、grant、yolo 都不能替代 |
| 超预算报价、未知副作用核对、verifier/repair 升级人工 | G | G | G | 与普通工具审批独立；详见第 5 节 |

下表各项的“硬拒绝”针对相应受控端口：**候选 Node 测试与进程内插件 JS 不受通用 FsPolicy/命令沙箱隔离**。候选 runner 只清理环境、限制时间/输出、使用独立进程组；`runAuthoringTests` 直接 spawn Node（`packages/daemon-admin/src/packages/authoring-tests.ts:155` → `packages/package-isolation/src/process.ts:34`），并未调用 Host sandbox。摘要绑定和 SDK 导入白名单不等于 Node 文件/网络隔离。

所有预设的普通工具都保留 principal `deny`、工具可见性/能力、命令表 deny、当前 FsPolicy、取消/撤权及恢复核对。普通权限链见 `core/src/execution/turn/tools.ts:445,491,535`：文件 preflight 可在工具策略之前就拒绝；不是每个 D 都先问 Q。不可将“普通工具 always”误当成不受 full 影响：`full-access` policy 直接 allow，只有额外领域 gate/human-only constraints 才保留确认。

### 平台范围

| 平台 | workspace-write / standard | full-access | 实测状态 |
| --- | --- | --- | --- |
| macOS Seatbelt | 真实 probe 后才声明 file/network/process enforcement；写 workspace、data/tmp 等允许根，阻止私有目录及命令联网；shell 仍需 Q | 配置 L0，但官方 memory provider 即使 mode=off 仍要求隔离：有效写域可扩为 `/`，保留硬拒绝私有文件，网络可开放 | 本机实际运行，见实测节 |
| Linux bwrap | 要求真实 user namespace/boundary probe；失败不降级放行；网络隔离及挂载视图保护私有目录 | 同样受 memory 私有文件 OS 隔离要求；无可用隔离时命令拒绝 | 源码核对，未在 Linux 运行 |
| Windows | 明确 unimplemented 例外可无 OS 隔离运行；普通文件工具仍围栏；批准 shell 后 shell 可访问工作区外及网络 | 无 OS 隔离；普通工具的私有路径拒绝不能约束任意 shell | 源码核对，未在 Windows 运行 |

`host-common/src/workspace-policy.ts:99` 按 memory provider **是否注册**判隔离要求；`host/src/runtime/assemble/workspace-runtime.ts:224` 的可信 unimplemented 例外只在许可条件成立时使用。不能泛化为“full 一定没有沙箱”或“每个平台的保护路径都是 OS 硬拒绝”。Windows 下 shell 对私有状态也没有 OS 防线，这是已披露的限制，并非本次实机证明的绕过。

私有路径来自 `host-common/src/paths.ts:149`：home/secrets、auth、profiles、daemon、memory、data/secrets、data/daemon，以及独立配置的 secrets/profile 路径；workspace `.git`、`.agh/secrets` 和 `.ssh` 在 `workspace-policy.ts:224` 叠加。软 data/preset deny 不等于 hard deny；API 的 full-access 只扩大 no-match，不取消已匹配拒绝。符号链接规范化和每次操作复核仍生效。

## 3. 自动审核和「以后同类调用」

- 自动审核不是第四个文件权限档。`selectAutoReviewSettings` 只替换 default/auto-review policy（`settings.ts:64`）；因此主要作用在 standard/workspace-write。只读、完全访问保持自己的 allow/deny；对 full 保存的 deny rule 也不是通用安全禁令。
- 只审核 baseline=ask 且非 human-only 的调用；baseline allow/deny 直接返回。命令表 deny、文件 preflight、plan/read-only、主体拒绝都不能由审核扩大。预算默认每会话 20 次，超时默认 10 秒；模型不可用、无效输出、超预算、资格不符则回到人工。
- 「同类」实际上是**精确参数**，不是 shell 前缀或同一目录：scopeHash 绑定 cwd、actor id/org、工具名/全部 args、工具 policy、definition fingerprint。换参数、工作区或定义就失配；不绑定 sessionKey，故可跨同身份同目录会话。保存经管理入口（`web-units/src/trace-review.tsx:12`），不是一次点允许就隐式生成规则。
- 匹配 override 时不消耗模型预算；high+allow 降为 escalate；medium 人工 allow 可越过模型默认 low 上限。**tainted 不在 scopeHash 中，匹配的人工作用域 allow 在模型后的 taint 检查之前返回**（`auto-review.ts:54,99,169`）。因此“污染上下文必回人工”只对模型 allowance 成立，不能无条件套在人为持久规则上。报告探针附有这一精确输入的独立复现，需 owner 决定是保留显式人工授权的语义，还是让 taint 无条件优先。
- Session approval / persistent grant 是另一套授权：不能把它和 auto-review exact args rule 合并解释。当前文档明确 session 选项覆盖同工具后续调用，并在卡片完整性不足时隐藏该选项（`security.md:35`）。

## 4. UI / 默认设置 / TUI / SDK / 自动化的一致性

| 入口 | 实际选择、默认与无人响应语义 |
| --- | --- |
| Web composer | 新会话 preset 映射明确；当前会话先 setPreset 再 setYolo（`app.ts:1815,1837`）；Host 可拒绝改变已固定 workspace policy，此时 UI 提供新会话选择。若部署没有目标 preset，部分模式回落到 yolo 兼容路径，故 badge 不足以说明 sandbox。 |
| 设置 → 权限与安全 → 默认权限 | 保存 defaults.preset；full 有一次确认；另列更多配方。`defaultHelp` 声明用于新会话。Host 在新建根会话且未显式给 preset 时读取相同的 session defaults（`host/src/runtime/lifecycle/host.ts:480`），已有会话及显式选择优先。 |
| TUI | `/preset <name>` 调后端；`/yolo` 只调用 setYolo(true)，还把下次 composer selection 记成 full（`cli-tui/src/commands.ts:401`）。当前工作区 sandbox/preset 不因此变成 full-access，候选测试也未取得免确认资格；在 standard 非空命令表下，工作区外文件路径还会被 normalizeArgv 拒绝，即使 yolo 已扩大底层 Fs 访问。TUI 的“双语跳过全部审批”帮助过宽（`locale-extended.ts:167,299`）。 |
| SDK / headless | session.new 可传 preset；省略时由 Host 读取设置页保存的默认 preset，未设置再走 profile default；已有会话和 parent 继承不会被新默认重写。onPermissionRequest 是独立 handler；缺失返回 no-handler（`sdk/src/permission.ts:84`），绝不隐式同意。print 模式附着后运行、显式处理 parked ticket/退出码（`cli/src/modes/print.ts:285`）；CLI 不把 `--preset` 强加到 resumed session。 |
| channels | runner 初始 preset=channel（继承 standard，on_unavailable=park）；不在允许列表时回 profile default（`channels/src/runner/runner.ts:70,337`）。有权限卡和文字/动作响应、连接刷新重投递；不是无人值守 full。 |
| schedule 既有 session | 在原有 session 内运行，沿用其 preset/授权，不能从“无人值守”推导成 off/full。 |
| schedule 新 session | target.preset 可显式保存，省略则普通 session admission 选择当时的设置默认/profile 默认；创建后 SDK 连接关闭（`daemon/src/supervisor/schedule-sessions.ts:110`）。原任务的显式权限未自动固化为每次新运行的 preset。 |
| webhook trigger | rule.agent 被传作 preset，bundles 一起传入（`webhook-sessions.ts:31`）；设置表单初值 workspace-write（`web-admin/src/settings/triggers.tsx:55`）。普通 Core/worker policy，不自动跳过审批；接入 webhook 的鉴权不替代会话操作授权。 |

**无人值守确有停等可能**：canonical tool decision 没有 answeredBy 的有效回答时持久化待决并 park，区别于拒绝；`core/src/step/decision-delivery.ts:85` 不因 on_unavailable=deny 就把每类 canonical 请求销毁。`no-handler`、transport、detached、deadline 的状态必须分别展示。pending 默认 TTL 24 小时（`base.yaml:12`）。这不是永远等不到退出的同步 Promise，但后台任务可以留在无人看到的审批状态。

**运行结果还可能误报已运行**：scheduler 对非 error 的 parked outcome 走 settleSuccess（`daemon-foundation/src/jobs/scheduler.ts:289,303`），schedule `noteSettlement` 把 open run 更新为 ran（`schedule/src/catalog.ts:595`）；虽然类型声明 waiting_approval，当前这条结算路径没有按 parked 分流。影响是：任务显示 ran，实际副作用未执行；重复任务下一次还能继续开新会话。no-handler → parked 已在真实 Host 复现；schedule 状态更新为代码链核对，未在真实调度进程复现，不能称已完成端到端验证。

## 5. Owner 的两个痛点

### full-access 为什么仍然会问

以下是本基线官方代码中绕开普通 tool-policy 的确认/交互面；第三方插件还能声明自己的决策，无法列举任意插件的所有提示。

| 剩余确认 | 是否合理 | 建议 |
| --- | --- | --- |
| memory ask 的每文件 diff/hash、一次性 human | 合理：持久偏好会影响后续会话；明确的用户设置不能被普通 full 覆盖 | 保留；想减少提示在 Memory 设置选 auto，明确范围 |
| plan exit，绑定当前 revision 的 human | 合理：full 不应暗中批准计划 | 保留；卡片注明它来自计划模式 |
| 插件/Skill 发布、安装/信任/启用/扩大能力、workspace hook 内容信任 | 合理：持久代码/权限改变超出一次任务的普通工具授权 | 保留 hash/差异审阅；同一受审包操作可合并一个明确事务确认，避免重复框 |
| Skill 导入读取和最终安装、MCP 注册/启动配置 | 合理：可能接触越界来源，改变 profile 共享能力或运行外部代码 | 保留；清楚区分读取确认、安装确认；不要称普通 full 能免除 |
| 凭据管理中的特殊确认（例如 force delete）及认证/OS consent | 合理；不是普通工具审批 | 保留；凭据值没有通用 Agent 读取权限；Computer Use OS 授权不能代办 |
| budget quote | 合理：额外消费独立于文件权限 | `core/src/step/calibrate.ts:149`；自动化应在开始时设置明确预算及超限失败语义 |
| unknown outcome / verifier fail → repair park | 合理：核对“是否已经发生”，或人工决定失败如何继续，不能从 full 推定事实 | `execution/turn/unknown-outcome.ts:59`、`gate.ts:369`；改用“结果待核对/任务需处理”，避免都叫权限审批 |
| ask_user_question / 自定义业务决策 | 不是工具授权；可能仍需用户补信息 | unattended 应要求输入齐全或显式失败/转人工策略 |
| full-access 下候选测试 | **当前已不应单独问**，前提是有效 full-access 策略允许且非 plan/deny，且工具/候选可用 | 保留精确 hash 审计；/yolo、off 及只读不享受例外。旧提示不代表当前仍有同一缺陷 |

上述保护路径保证针对普通受控工具；不能扩展成任意插件 JavaScript 或候选测试代码都被隔离。保护路径、private network web_fetch、缺失设备权限、观察记录过期等对普通工具是**拒绝或前置条件**，不是继续加一个批准按钮就可绕过的确认。

### “每次都问”是否不可用

当前没有这档。三档 read-inside 实测均为零次审批，web_fetch 公网也不问；默认 write-inside 零次。真正的噪声是每条 shell（echo 也问），而插件作者流程在工作区档可能先普通 plugin_test 工具审批，再候选测试摘要确认。

建议保留普通无害读取零提示；通过范围明确、可撤销的批准或可选 auto-review 降低 shell 噪声。不要仅靠字符串 echo/cat/git 前缀推断任意 shell 无害，也不要为降低噪声把 shell 都标只读。计划模式严格禁 shell 的当前选择更保守，若要引入只读 shell 分类应独立设计。

## 6. 按用户影响排序的问题及改进

| 编号 / 级别 | 证据与影响 | 具体调整 / 规模 / owner 决策 |
| --- | --- | --- |
| **F9 / P1** full 下免审批候选测试未套用会话 OS 文件沙箱 | `packages/daemon-admin/src/packages/authoring-tests.ts:155` 调 `runIsolatedCommand`；`packages/package-isolation/src/process.ts:54` 直接 spawn，隔离仅环境、进程组、时间和输出。候选代码可 import node:fs；普通工具保护目录的硬拒绝不能约束它。绑定 hash 解决版本一致性，不限制该版本代码访问文件。 | **中**：候选测试通过 Host 的隔离执行接口运行，保留取消/子进程清理并验证保护路径；或 **小**：先明确告知这会执行不受会话沙箱限制的本机代码。**需要 owner 决定 full 是否包含此信任边界、是否暂保候选执行专门确认**。 |
| **F1 / P1** 默认模式无法使用官方受控 memory 文件 | 实测 standard/workspace-write 的 memory ask/auto 被 POLICY_DENIED，理由 blocked by command policy；`packages/core/src/command-table/normalize.ts:121` 拒绝非 workspace path，`packages/core/src/command-table/floor.ts:35` 在访问 memory provider 前终止。read-only 的策略拒绝正常；full 空命令表可抵达领域 gate。额外允许根及 read 工具也存在同类适配风险。 | **中**：由 Host 提供受控路径身份/领域分类，命令表不能将 memory/已授予额外根的规范化失败当成通用绕过或自动批准；保留 memory ask/auto/off 与 CAS/隔离。扩展最近的 command-floor + memory 集成用例。**不需 owner 改权限意图**，需安全合同复核。 |
| **F2 / P1** 工作区档标签不足以表达 Windows shell 风险 | UI “越界需切换完全权限”对批准后的 Windows shell 不成立；settings 声称其他动作都问也不成立（web、subagent、schedule）。当前活动会话已可显示“系统沙箱未启用 / OS sandbox off”（`web/src/app/composer-controller.ts:331`），这是有效缓解，但选项说明和新会话草稿仍不足以说明批准后的范围。Windows 缺 OS 隔离是源码事实，非本次实机结论。 | **小** 文案立即标“文件工具限工作区；命令需审批；此平台命令未隔离”，draft 阶段也展示已知平台状态。**中/大** 做 Windows fail-closed 可选策略或实现可证明隔离。**文案不需；收紧 Windows 命令默认需 owner 决策**。 |
| **F3 / P1** 无人值守停等与 schedule ran 状态可能掩盖未执行 | 第 4 节完整调用链；canonical tool gate 持久 park；scheduler 的 parked 非 error 结算与 ran 更新。 | **中**：新增明确 unattended policy=refuse-or-queue-to-human，不等于 full/off；持久 waiting_approval、到期 failed/needs_attention、去重及通知归属；别把 parked 写 ran。**需要 owner 决定默认自动化交互策略**；状态误报修复不应等决策。 |
| **F4 / P2** full 文案过度承诺 | settings 中英“整台电脑、无需审批”；composer “跳过审批”；TUI help “全部审批”；均与第 5 节冲突。`security.md` 又交替称 Full permissions/完全权限，当前 UI 是 Full access/完全访问。 | **小**：三入口统一“普通操作无需审批；保留保护目录、计划/记忆及安装信任确认”；链接列出例外。**不需 owner 决策**。 |
| **F5 / P2** 同名 full、yolo、off 的能力不相等 | `/yolo` 不切 sandbox/policy，却保存下次选择 full；Web 有 preset 缺失时的兼容路径；候选测试只有 full policy 免 G。 | **中**：显示后端 effective preset + approval mode + isolation；/yolo 提示应称“跳过普通审批”，新会话记忆不要制造当前已 full 的误解。**若统一命令语义并改变范围需要 owner 决策**；先修文案。 |
| **F6 / P2** 「以后同类调用」比用户理解窄，同时 taint 语义不透明 | exact args hash，full/read-only/基线 allow 不进入规则；人为 allow 的 tainted 例外见第 3 节。 | **小**：改“以后完全相同的调用（同身份/目录/工具定义）”，提供参数、目录和作用模式预览；**中**：决定 taint 是否优先人工规则、规则何时失效。**taint 优先级需要 owner 决策**，文案不需。 |
| **F7 / P2** 候选测试两次 gate 和描述过时 | 工作区 plugin_test meta=always，daemon 再问 exact candidate；full 工具描述仍写 Ask permission。 | **中**：将工具审批和领域摘要合成一张绑定 hash、风险、执行范围的卡，保留 full 特例和拒绝语义；不要删掉真正的候选执行确认。**需要 owner 选择交互**。 |
| **F8 / P3** 安全指南包含难以同时理解的旧新语义 | `security.md:39,53,83` 同时讨论 yolo、full preset、L0、memory provider；旧 `ownStateRoots` 注释还说 secrets readable，但当前硬拒绝适用。 | **小**：中英同步拆成“文件范围 / 普通审批 / 持久能力 / OS 隔离”四列，补无界 shell 的平台限制、off≠full、无人值守及候选测试例外；更正过时注释。**不需 owner 决策**。 |

建议文案（中英成对，供后续实现）：

| 档位 | 中文说明 | English description |
| --- | --- | --- |
| 只读 | 查看允许范围的文件和公开网页；修改与命令执行会被拒绝。 | Read permitted files and public web pages. Changes and command execution are refused. |
| 可修改工作区 | 文件工具可改工作区；命令需审批。命令隔离取决于平台。 | Edit workspace files. Commands require approval; command isolation depends on the platform. |
| 完全访问 | 普通操作不再逐次审批；保护目录、计划/记忆规则及安装信任确认仍生效。 | Skip routine approvals. Protected paths, plan and memory rules, and installation and trust checks still apply. |

## 7. DSH 与常见实践（只读比较，不移植代码）

本机 DSH 的 `packages/interaction/permission-presets/src/index.ts:189` 把 sandbox 与 approval 两个轴组合成配方，默认 workspace-write+ask、danger-full-access+never；`user-approval` 的 never 是“有审批需求就拒绝”，不是“全部批准”。另有独立 Auto 注册。它的“范围”和“遇到审批怎么办”分离值得借鉴，值名不能直接搬来 AGH：AGH off 是关闭普通风险审批，语义相反。仅阅读 DSH 文档与上述源码，未改动或运行 DSH。

Codex 的源码把文件 sandbox 与审批策略分开配置，workspace-write 模板明确 cwd/writable_roots，外部修改需授权；可借鉴“运行范围”和“授权方式”分别展示的做法。参见 [OpenAI 官方源码：workspace_write 模板](https://github.com/openai/codex/blob/main/codex-rs/prompts/templates/permissions/sandbox_mode/workspace_write.md)。

Claude Code 将人工、接受编辑、计划、自动审核和 dontAsk 等模式分别说明，dontAsk 对需要询问的动作拒绝，适合预先允许的 CI 工作。借鉴点是单独解释无人值守拒绝策略和普通读取无需询问；不需要复制其 shell 分类或审批实现。参见 [Anthropic 官方权限文档](https://code.claude.com/docs/en/permissions)、[模式文档](https://code.claude.com/docs/en/permission-modes)。外部资料于评审当日查询，仅作高层 UX 比较，不作为 AGH 行为证据。

## 8. 真实检查、验证范围与交付

实测脚本：[PC-PERM-REVIEW.repro.mts](PC-PERM-REVIEW.repro.mts)。它使用源码 Host、生产 policy/fence、真实本机 Seatbelt/文件与 HTTP；回环端口由系统分配，无真实模型和密钥。每 preset 新建 home/workspace/outside，显式测试依赖用作者 Host 的 live snapshot authority 挂载仓库自带 Skill helper（不模拟安装信任界面的点击）；candidate 创建是测试夹具准备，不绕过模型运行中的审批。管理 bridge 由脚本在同进程连接，不能冒称真实 daemon/worker/TUI/Web 端到端实测。Computer Use、MCP 远端服务、Linux、Windows 和真实定时触发均未执行。

首轮 44 个 source Host 操作已执行：read/write、shell、public/private web、memory ask、plugin_test、未安装 helper 的 skill import。每轮有真实 HTTP 请求；权限裁决拒绝不是模型自报。该轮 helper import 为 TOOL_NOT_FOUND，candidate full 为管理 bridge 不可用，这两项**不算候选测试或 Skill 安装成功验证**。扩展轮提供真实候选管理/Node 测试及 Skill 安装域，结果补记于下方。

运行命令使用 mise 的 Node 24 **绝对路径**：本机 pnpm 的 shebang/间接启动实际会解析到 Node 26；首次配置探针出现 AUTH，后续一次缺少 provider 初始化依赖出现 TRANSPORT，均未计入行为结论。最终假模型使用仅在内存绑定的公开 fixture 字符串，具备零外部服务权限；不读取任何真实凭据。测试现场结束关闭 Host/回环服务并删除本次精确临时树。

产品代码/API/协议/锁文件：均未修改；无 main 行为移植，main SHA → 实现 commit 不适用。报告与复现是唯一交付。只运行本任务轻量检查，不执行 full fast/heavy/e2e/browser/release suites；重型命令遵守共享 heavy-lock，不改容量。

<!-- Final verification results follow. -->

### 最终实测结果

最终脚本退出 **0**：**84 个 Host 操作、172 次回环 HTTP 模型请求**，另加 1 个自动审核精确规则的独立策略探针。结构化精简证据：[PC-PERM-REVIEW.results.json](PC-PERM-REVIEW.results.json)。四档均用全新隔离 home；standard 的结果与 workspace-write 一致。下表 Q 数是实际捕获的提示次数，拒绝是夹具明确返回的人类拒绝，和 no-handler 停等分开。

| 真实操作（macOS） | read-only | workspace-write / standard | full-access |
| --- | --- | --- | --- |
| 读工作区文件 | A，0 提示 | A，0 提示 | A，0 提示 |
| 读工作区外文件 | D / E_FS_DENIED | D / E_FS_DENIED | A |
| 新建工作区文件 | D / E_FS_DENIED | A，磁盘内容正确 | A，磁盘内容正确 |
| 新建工作区外文件 | D / E_FS_DENIED | D / E_FS_DENIED | A，磁盘内容正确 |
| shell echo，夹具拒绝审批 | D / POLICY_DENIED | Q1 → APPROVAL_REJECTED | A，无提示 |
| shell，无审批 handler | D / POLICY_DENIED | Q1 → **parked**，无 tool/result | A，无提示 |
| shell echo，夹具批准审批 | D | Q1 → 成功 | A，成功 |
| shell 写外部文件，夹具批准 | D | Q1 → OS “Operation not permitted”；外部文件未创建 | A，外部文件内容正确 |
| shell curl example.com，夹具批准 | D | Q1 → 失败 exit 6（受限网络下不能解析域名） | A → exit 0 |
| web_fetch example.com | A / HTTP 200 | A / HTTP 200 | A / HTTP 200 |
| web_fetch 127.0.0.1 | WEB_BLOCKED_URL | WEB_BLOCKED_URL | WEB_BLOCKED_URL |
| memory ask 写新文件 | POLICY_DENIED | **POLICY_DENIED，0 提示，F1** | Q1 → MEMORY_APPROVAL_REJECTED；无提交 |
| memory auto 写新文件 | POLICY_DENIED | **POLICY_DENIED，0 提示，F1** | A，受控记忆文件确实创建 |
| 精确候选 Node 测试（经 Skill helper） | POLICY_DENIED | **Q2**：工具批准后，候选执行确认被拒绝；无测试执行 | **0 提示，真实 Node 测试 1/1 passed** |
| 本地 Skill import → commit | POLICY_DENIED | **Q3**：普通 import 工具、来源读取、安装确认；最后拒绝，未注册/启用 | **Q2**：来源读取、安装确认；最后拒绝，未注册/启用 |
| read 同一合成 home/auth/probe.txt | E_FS_DENIED | E_FS_DENIED | **E_FS_DENIED** |
| 候选 Node 读取该合成 auth 标记 | 未执行 | 确认被拒，未执行 | **成功读取并通过唯一测试，F9** |
| write home/profiles 下新文件 | E_FS_DENIED | E_FS_DENIED | E_FS_DENIED |
| `/yolo` 后文件工具写工作区外 | E_FS_DENIED | **POLICY_DENIED，命令表提前拒绝，F5** | A |
| plan active 下文件写入 | POLICY_DENIED | POLICY_DENIED | POLICY_DENIED |
| exit_plan_mode | Q1 → 明确拒绝 | Q1 → 明确拒绝 | Q1 → 明确拒绝 |

F9 的唯一候选测试使用 `node:fs` 读取本次合成的 `home/auth/probe.txt` 并断言固定标记内容；没有读取任何真实账户、secret 或凭据。普通 read 工具对**同一文件**拒绝，而 full 下候选 Node 测试通过，确认“保护目录”并非候选代码的 OS 边界。测试夹具在准备阶段显式授权此合成候选，不安装、不发布它。

自动审核探针：先取得同一 shell 参数的 scopeHash，再保存 low/allow 人工规则并设置 tainted=true；实际返回 `effect=allow, source=human-override`。这支持 F6 的优先级说明，不代表模型审核也可跳过 taint。

**验证命令与结果**（`heavy-lock.sh` 为任务提供的共享包装器，`TASK_NODE24` 指 mise 返回的 Node 24.20.0 绝对可执行路径；未改容量）：

```sh
pnpm install --frozen-lockfile
heavy-lock.sh "$TASK_NODE24" packages/system-node/scripts/build-native.mjs
heavy-lock.sh "$TASK_NODE24" --import tsx reports/mp/PC-PERM-REVIEW.repro.mts
heavy-lock.sh "$TASK_NODE24" node_modules/vitest/vitest.mjs run \
  packages/base/extensions/approval-policy/test \
  packages/core/test/command-table-floor.test.ts \
  packages/worker-runtime/test/plugin-manage.test.ts \
  packages/daemon/test/plugin-manage-requests.test.ts \
  packages/web-admin/test/permission-picker.test.ts \
  packages/host-common/test/workspace-policy.test.ts \
  tools/guards/src --project fast --maxWorkers=1
node_modules/.bin/biome check reports/mp/PC-PERM-REVIEW.repro.mts
node_modules/.bin/biome format reports/mp/PC-PERM-REVIEW.results.json
"$TASK_NODE24" --check reports/mp/PC-PERM-REVIEW.repro.mts
git diff --check
```

- 安装成功；native helper 构建成功；最终真实探针成功并完成关闭/临时树清理。
- 相关单测和 guards：**45 files passed；560 passed，1 skipped，共 561**，无失败。该命令不是全量 fast suite。
- 复现脚本 Biome 检查及 Node 语法检查通过；证据 JSON 格式检查、报告相对链接/基线/F1–F9、最终 diff 检查通过。
- 早期假模型/夹具构造曾出现 AUTH、TRANSPORT、无效 draft lock、未安装行能力/信任拒绝及来源读取被拒；均在修正夹具后重跑，不作为产品通过或缺陷证据。默认 builtin plugin_test 在该直接 Host 夹具无管理桥，最终使用有真实管理桥的 Skill helper 候选路径；不据该缺失桥断言产品缺陷。
- 不运行包 typecheck：没有修改任何产品包、共享类型、测试项目或公开协议。Linux/Windows、真实 daemon/worker 消息通道、浏览器/TUI 操作、MCP 服务器、真实设备和实际定时触发未测；相应结论只标源码证据。

建议先处理 F9 的候选执行信任边界、F1 的受控 memory 误拒绝及 F3 的 unattended 状态，再同步 F2/F4/F5/F6 中英说明。报告只提出建议，未改变任何安全策略。
