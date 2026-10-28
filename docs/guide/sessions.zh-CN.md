# 会话与恢复：让工作接续起来

[English](sessions.md) | 简体中文

Web 中，历史内容可在执行准入完成前阅读。“正在准备会话…”期间可以编辑本地纯文本草稿；发送、文件引用、附件和审批操作仍等待准入。草稿按当前 Profile 和会话保存。切换会话只取消旧的打开等待、保留其文本草稿，不停止运行中的智能体。准入失败时保留可读记录并提供新开会话入口；准备结束不会自动发送草稿。

[文档导航](../README.zh-CN.md) · [安全边界](security.zh-CN.md)

工作可以跨越多次打开终端或浏览器的过程。用明确的会话 ID 找回上下文、查看执行记录，并决定接着做什么。

会话承载任务历史、模型选择和执行状态；一次用户请求会形成一轮运行。CLI、Web 和 SDK 读取相同后台的事实，但界面的历史投影不是原始数据库备份。

## 日志尾部损坏

会话打开时，SQLite 先检查序号连续性、checkpoint 自检和边界摘要，并对 checkpoint 之后的行（没有可用 checkpoint 时为最后 32 行）重新计算哈希；通过后才能执行会话 hook、恢复、标题生成、工具或模型。没有可用 checkpoint 时还会检查前缀的链链接和行顺序，但不重新计算前缀内容摘要。append 同事务写入的水位还会检测末尾被删除。这些检查发现缺口、尾部损坏行、缺链或 head 不匹配时会拒绝打开，并保留原始证据，不自动截断。请保留数据库用于排查；无法执行时仍可使用只读历史视图。插件架构之前的旧产品 home 仍不受支持。只有数据格式受支持时才能打开会话；已退役的 SQLite 目录以 `E_DATA_DIR_STALE` 拒绝，不做迁移（见[恢复](install.zh-CN.md#数据格式与升级)）。受支持账本可能没有追加水位：下一次追加时原子启用水位保护，不改写历史事件；显式完整校验仍会对其完整哈希链重新计算。水位建立前已被删除的末尾，无法通过后续水位保护追溯检测。

冷打开保留快速路径：折叠每行并检查序号连续性，哈希 checkpoint 之后的尾部（无 checkpoint 时为最后 32 行），随后返回，不等待前缀哈希。打开后自动在后台对固定快照做全量校验，按小页读取，在页间及 CPU 时间片之间让出事件循环。普通 prompt、模型/工具步骤、写入和 fork 可继续执行。**verified-head checkpoint 只能覆盖实际哈希校验过的历史，以及 Core 自己计算哈希的追加**；未校验的前缀不会被提升为 checkpoint，校验期间关闭也不会写出这种 checkpoint。

校验完成前，作为证据的 decision 回答/消费（含审批和签名）、审批复核证据、profile service 准入回执、声明 `attestsHistory` 的报告/导出工具、最终 turn verifier/gate 结论、RLAF 与 CLI 历史导出、诊断事件导出和执行依据审计视图等待校验。持有写锁的操作遇到新校验时可明确拒绝并提示正在校验历史；冷态审计视图要求先打开会话。这些门位于通用 decision、verifier 和导出合同；普通会话展示和 artifact 字节读取不构成账本完整性证明。fork 独立校验继承的前缀；父会话封存或关闭后，不再发布正在创建的子会话。

显式重新审计入口：`_agnes/v1/session.integrity` 传 `{sessionId, verify: true}`；SDK `client.session.integrity(id, true)` / `session.integrity(true)`；CLI `node agnes.mjs sessions verify SESSION_ID --json`；Web **运行信息 → 历史完整性 → 运行完整校验**。不传 `verify` 时返回已打开会话的当前状态，未打开时拒绝；读取状态不会打开会话。显式审计会先打开未加载的会话，再进行校验。结果包含 `state`、`verifiedThroughSeq`、`verifiedAtMs`、`lastSeq`、`legacyThroughSeq`，损坏时包含 `failureSeq`。Web 等待期间显示“正在校验历史…”。取消客户端等待不会取消会话校验，也不会解除证据门。

`session/load` 或 `_agnes/v1/session.open` 成功仅表示打开检查与会话装配结束；ACP 回放内容的前缀哈希可能仍待完成。后台或显式校验会发现 checkpoint 之前的字节变化，以 `E_LEDGER_INTEGRITY` 封存会话、删除 checkpoint、保留账本和持久化失败标记；发现后拒绝排队和新工作，reload 返回 `E_SESSION_CORRUPT`。发现前已准入的普通工作可能已经执行，因此保证是篡改检测与证据门控，不能声称普通执行始终读取已完整审计的历史。校验是时间点结论，怀疑变化时应重新审计。没有哈希的 legacy 行不能获得追溯性保护（`legacyThroughSeq` 标识其范围）。能同时重写数据及所有本地完整性元数据的攻击者可绕过本地检查；独立外部锚点/签名需另行建立。

Web 可在验证时显示**未经验证的只读预览**的历史；大载荷和内嵌媒体可能显示占位文本。预览不授予执行权限，打开时的检查与会话组装完成后由实时会话替换；前缀校验失败时页面会说明。历史窗口和扫描预算标记说明省略范围。SDK `session.load(id, { onProgress })` 提供验证及重放进度；`timeouts.loadIdle`（默认 30 秒）和 `timeouts.loadHard`（默认 10 分钟）分别限制无进展等待和总时长。超时或断连会取消该连接的待完成加载；存活会话上已在运行的完整校验独立继续。

打开期间，预览直接显示已记录的内容，不显示校验状态行；准入后仍保留预览，直到首个正式投影替换它。尚未完成的预览不能覆盖正式投影，也不能改变已准入代际的就绪状态。会话准备期间可以编辑本地纯文本草稿，执行操作仍等待正式打开和控件就绪。只有打开被拒绝时，才显示带恢复操作的只读警告；正常加载不会显示这种警告。

JSONL persistence 示例有自己的诊断隔离文件，不代表 SQLite 的恢复策略。

工具参数错误由系统自动恢复。同一工具默认连续两次参数无效后，本轮不再提供该工具；其他工具仍可用，新一轮重新开始。Web 将失败尝试收进一条默认折叠的技术记录，界面无法生成时改用文字。完成校验发现内容问题时，最多自动修正一次，再次未通过则停止并保留已有文字和折叠说明；完成策略也可以明确结束本轮，校验结果仍如实记录。校验或修复服务不可用时，本轮会结束并提示“未能完成校验”，不会阻塞后续工作。系统不再通过人工“允许”来接受未通过校验的完成结果；历史校验问题会自动撤回。业务操作审批、未知操作结果核对和预算审批仍保留。失败的操作不会记为成功。

## 找到并继续会话

```sh
node agnes.mjs sessions --json
node agnes.mjs sessions show SESSION_ID
node agnes.mjs resume SESSION_ID -p "继续说明尚未完成的部分"
node agnes.mjs -p --resume SESSION_ID "接着上次的讨论"
node agnes.mjs -p --continue "继续"
```

`--continue` 与 `--resume` 互斥。需要精确控制时使用明确 ID，避免恢复到不期望的最近会话。新建会话和恢复会话的工作目录、模型、权限需要分别核对；切换 Web 工作区不会把已有会话的所有权转移给另一个后台。

更换模型账号不会替换已有会话的插件代码或权限策略。如果原模型已不可用，请重新打开会话，明确选择一个可用模型后再继续。

## 搜索历史

侧栏的「搜索会话」按字面子串匹配会话标题（包括中文），按短语搜索消息文本，按工作区路径精确过滤，并分页查看结果。索引是根据账本重建的独立 SQLite 文件，不会修改账本。只读工具 `session_search`、`session_event_search`、`session_trace`、`session_event_trace` 和 `session_event_read` 只查看调用者所在工作区及其已记录的所有者。

## 导出与导入

```sh
node agnes.mjs export SESSION_ID --format agnes -o session.jsonl
node agnes.mjs export SESSION_ID --format sharegpt -o training.json
node agnes.mjs export SESSION_ID --html -o session.html
node agnes.mjs import session.jsonl --from auto --key agnes:local:default:import:dm:docs-copy
```

上例原生导入使用一个新的 session key；重复演练时换一个未使用的 key。省略 key 可能指回原会话，遇到已打开或非空目标会拒绝。import 是 one-shot 路径，不支持 `--connect`。导入的会话会在首条事件（`session/start` 的 `imported` 字段）记录来源格式，原生导入还会记录原会话 key；从 Web 导出它的诊断包时会带一条 `imported` 警告。任意长度的原生导入都会让每一行落在导出时的序号上：写入事务只在两轮之间切分，超过单个事务的一轮整体写入；写入期间目标会话不生成标题，也不让审批过期。

导出文件可能包含提示、工具参数、路径和业务数据，分享前审查。`--raw` 会减少隐私过滤，不是默认共享方式。外部格式（Claude Code/Codex/Pi）导入是格式转换，不能恢复原工具权限、原进程或保证所有语义无损。导入失败要保留错误并检查会话列表，不通过重试换 ID 来掩盖失败。

构建后续模型请求时，导入的 assistant 文本与思考内容仍作为不可信上下文处理。

导入源必须是普通文件，最大为 64 MiB；读取过程中增长到超过上限也会在预留目标会话前被拒绝。

## 中断与重启

指导、补充或队列控制的结果未确认时，SDK 保留原命令 ID。重连会重放 pending 命令一次；
未知回执、`UNCERTAIN` 错误或再次重放失败会将命令转为 `needs-confirmation`，停止自动重试，
继续恢复其余命令与会话订阅。确定拒绝会清除命令。`session.pendingCommands()` 返回 pending 和
needs-confirmation 两种未决项；`session.checkCommand(commandId)` 使用原内容与身份显式核对。
成功仍返回数字序列；SDK 持有命令期间，提交错误附带 `submission: { sessionId, commandId, state }`。

Web 显示「结果未确认，请核对」并提供「核对」，不会将 SDK 持有的消息恢复成可重新发送的草稿，
结果明确前阻止再次发送。浏览器存储可用时，命令日志在本标签页刷新后仍保留。切换会话不会转移
其他会话的未决命令。队列提升在后端原子地将原条目转为指导，保留附件，不会删除后再补发另一条消息。

停止请求、进程退出、审批到期和一轮完成是不同事实。Core 通过持久事件与状态机恢复；副作用未知时可能需要人工确认，不能保证外部系统操作“恰好一次”，也不能用重新发相同自然语言来代替恢复。

挂起工具恢复时仍须通过原审批门，即使当前策略原本允许该调用。允许答复与工具的 effect intent 一起消费且只消费一次；恢复完成后，Web 不再把该决定显示为待处理操作。恢复仍检查当前授权、原工具及策略绑定。

后台故障后：先保留 home 和错误，查看 `daemon status`，用同一 profile 启动后检查历史，再决定继续。不要删除 SQLite、owner 或审计记录强行重开。数据库的备份应在停止对应实例后保存同一 home 中相互关联的数据；单独复制正在写入的数据库文件不构成可靠备份。

TUI `/rewind`（已完成轮次的选择器，或 `/rewind SEQ`）和 Web 分叉从某个历史位置创建新会话，不撤销已经写入的文件、不撤回网络请求、不让已执行工具失效。恢复也按当前权限重新约束执行，而不是复活过去的授权。

实现依据：[会话 SDK](../../packages/sdk/src/session.ts)、[Core](../../packages/core/src)、[导入](../../packages/cli/src/commands/import.ts)、[导出](../../packages/cli/src/commands/export.ts)。

<a id="persistent-goals"></a>

## 持久目标

官方默认目标插件将会话目标保存在账本中。打开 Web 对话上方的目标栏，可创建/编辑目标，设置自动续轮上限和可选额度预算，暂停/恢复、完成或清除。CLI 使用同一会话输入：

```text
/goal create --max-rounds 10 --budget 20 交付并验证补丁
/goal edit --max-rounds 5 交付较小的补丁
/goal edit --budget none 移除目标积分上限
/goal pause
/goal resume
/goal complete
/goal clear
```

/goal 后接目标内容也可创建目标，CLI 中 /goal 显示当前状态。选项写在目标内容之前。默认允许十次自动续轮，不额外限制额度。恢复会重新授权续轮次数并保留已用额度；编辑保留阶段与额度。模型只能通过 goal_update 提交带原因的完成或受阻状态，不能提高上限或自行恢复。

自动续轮进入下一回合输入队列；人工控制优先，过期续轮在推理前停止。完成、受阻、取消、错误或耗尽上限都会停止续轮。额度在步骤与回合边界检查，因此正在执行的响应可能超过目标预算，模型的常规预算准入仍生效。设置目标预算但额度用量未知时，续轮会受阻。恢复进程或派生分支后，原本活跃的目标暂停，等待明确恢复。

## 控制正在运行的任务

Agent 工作时发送消息，默认排队为指引，在当前模型调用或工具批次结束后的步骤边界送达。送达前可在输入框上方编辑或撤回。排队消息旁的**立即打断**会合作停止当前步骤，再优先执行该消息；已提交的效果保持已提交，未知结果仍如实显示为未知。

**暂停**在下一个步骤边界生效，**继续**恢复同一轮。浏览器刷新和 daemon 冷启动都会保留暂停。如果停机已结束该轮，继续操作会解除保留的暂停，让排队消息执行，不会重放已结束的轮次。**取消**结束当前轮，并将待送达的指引退回输入框。Trace 的**人工控制记录**显示操作者、时间、请求和结果。控制始终作用于会话固定的 Loop 版本，包括热升级期间；不支持的控件显示禁用原因。

SDK：`session.controls()` 读取能力与状态；`steer(content)`、`editQueued(itemId, content)`、`removeQueued(itemId)`、`interrupt(itemId)`、`pause()`、`resume()` 和 `cancel()` 都走持久命令路径。Loop 通过 `LoopFactory.controls` 声明支持能力，省略即拒绝指引、打断和暂停。不带 `afterSeq` 时，`controls()` 只返回最新的至多 200 条事实（`facts[0].seq` 是该窗口中最早的 seq），窗口已满时 `factsMore` 为 true。读取历史请从 `afterSeq: 0` 开始。

输入框上方的子代理树显示所属 workflow 和子代理会话的时长、Token 用量；未知值明确显示为未知。**停止子代理**协作式结束子代理当前轮，workflow 继续等待；发送继续消息后，同一子会话保留原有约束继续工作。SDK 使用 `stopChild(childId)` 和 `continueChild(childId, text)`。父、子控制事实保留人工操作者。外部子代理提供者声明自己的打断/继续能力，不支持的子代理动作隐藏。只有当前轮仍在执行时才提供停止按钮；仅可继续的子代理显示带提示的后续消息输入框。执行前即取消的子代理显示 0 Token 和 0 耗时。`controls({ afterSeq })` 通过 `factsThrough` 和 `factsMore` 分页读取完整控制历史。

原件无损导出使用 `node agnes.mjs export SESSION_ID --raw -o session.agnes`，并将 `session.agnes` 与 `session.agnes.artifacts/` 一起保存。清单以 size 和 SHA-256 绑定完整事件流及每个声明原件；导出通过已认证的 session/lane 权限读取并核验原件。缺失、摘要不符或权限拒绝时不发布 bundle，已有 bundle 不会被覆盖。脱敏导出用于分享，不包含原件。

使用 `node agnes.mjs import session.agnes --key NEW_SESSION_KEY` 导入。预留目标前先核验清单、序号、事务边界和全部 sidecar 原件；随后再次核验原件，并通过所选 artifact seam 以新会话和 lane 的作用域获取 receipt、存储原件。引用事件持久化前，pending receipt 保护原件不被回收；持久化后再确认 receipt。append 或激活失败会回滚新会话；已写入但未引用的内容寻址原件由普通保留机制回收。格式只支持当前产品的事件 schema，单个原件最多 32 MiB，声明原件总量最多 256 MiB，不提供其他产品格式或旧 home 的迁移。

## 原件附件

原件上传通过 `_agnes/v1/session.fileUpload`，指定 `destination: "original"` 和当前
`laneId`。`start`、`chunk`、`status`、`finish`、`cancel` 操作绑定会话的上传 ID。
每块最多 1 MiB，携带 SHA-256；`finish` 核验完整摘要后返回待确认的附件回执。
将该引用放入 prompt 内容即可提交到会话。已经完成、取消或过期的上传 ID 不能再次完成。
断线后可在同一个存活 worker 内续传；worker 重启后需要新上传 ID。
上传在 30 分钟后过期，并预留有界配额。不指定 `destination` 时保留独立的工作区文件上传语义。

SDK 导出 `uploadAttachment` 和 `cancelAttachmentUpload`，供客户端分块上传原件。
Web 的文件和图片使用同一原件回执。历史图片按需加载经授权的缩略图或原件引用；
下载保留原字节。模型图片版本由 provider 派生和缓存，不修改原件。
当前轮图片必须满足所选模型限制；缺失的旧原件显示占位；已经省略的历史前缀在模型切换和重启后继续省略。

配置的模型凭据缺失导致 worker 无法启动时，打开会话会返回 `E_SECRET_UNRESOLVED`；在当前 home
或配置的环境中恢复凭据后重试。已退役的 plugin-core 格式返回 clean-home 指引；这两类拒绝都不会
转换已保存的数据。移动 home 还可能改变与路径绑定的沙箱执行策略：策略不匹配仍然拒绝，不会静默
更改该会话的隔离决定。
