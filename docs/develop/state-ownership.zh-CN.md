# 状态归属：权威、副本与对账

[English](state-ownership.md) | 简体中文

[文档导航](../README.zh-CN.md) · [架构](architecture.zh-CN.md) · [插件与 provider 架构](architecture-plugins.zh-CN.md) · [源码导航](source-map.zh-CN.md)

本页对 AGH 保存的每一类状态回答三个问题：

1. **谁是唯一权威？** 一份由单一写入方拥有、定义真相的记录。
2. **其他模块持有什么？** 是*事实*（第二个权威，属于缺陷）、*缓存*、*投影*，还是*观测*。
3. **两份副本不一致时谁说了算，怎样修复？**

执行事实（会话账本、决策、effect）已经清晰：一条只追加的日志，其余都是派生。不那么明显的是插件安装与发布、组合、代次与会话 pin、资源目录、Profile 与配置层、管理面快照和客户端状态。本页对它们做同样的梳理，代码尚未达标之处列在[缺口](#缺口)。

文件引用写作 `path:line`，已对照提交 `a6bf884c2` 核实。后续改动可能使行号漂移，旁边的符号才是稳定锚点。裸文件名沿用同一张表最近出现的完整路径；例外：`host.ts` 始终指代次宿主（`packages/host/src/runtime/generation/host.ts`），`runtime.ts` 指 daemon supervisor（`packages/daemon/src/supervisor/runtime.ts`），`configuration.ts` 指配置服务（`packages/host-infrastructure/src/configuration.ts`）。

## 术语

| 术语 | 含义 | 不一致时的规则 |
| --- | --- | --- |
| **权威** | 定义该状态的唯一持久记录或唯一进程内拥有者。只有其所属端口可以修改。 | 按定义它说了算。 |
| **投影** | 由权威经确定性函数算出、可随时丢弃的值，如寄存器表、历史索引、UI 时间线。 | 丢弃并从权威重建。 |
| **缓存** | 为速度保留的副本，带失效触发条件。它从不单独回答安全问题。 | 重新读取权威，把缓存视为过期。 |
| **观测** | 由运行体自己给出的“实际在跑什么”的报告。它从不覆盖期望状态。 | 两者并列展示；通过对期望状态采取行动来对账。 |
| **Pin** | 把一个*选择*（代次、组合、资源集）在首次使用时固定到会话上的持久绑定。 | 对该会话，pin 优先于当前默认值；更改须是显式迁移。 |

下文反复出现“期望”（desired）、“实际”（actual）和“生效方式”（effect）。*期望*是权威说应当运行的内容；*实际*是观测；*生效方式*（`new-sessions`、`restart-required`）是告诉客户端改动何时到达会话的标签。

## 总览

| 类别 | 唯一权威 | 章节 |
| --- | --- | --- |
| 会话执行事实 | 会话账本（`events`） | [A](#a-执行事实) |
| 永久审批授权 | Host 授权表 | [A](#a-执行事实) |
| 会话目录与展示偏好 | 存储 `sessions` 表；偏好表 | [A](#a-执行事实) |
| 包的安装、信任、启用 | `agnes-lock.json` 加包目录树 | [B](#b-插件安装) |
| 期望运行目标（行、插件配置） | 组合目标存储（composite target store） | [C](#c-发布与组合) |
| 会话组合 | 组合绑定文件 | [C](#c-发布与组合) |
| 代次快照与会话 pin | 代次快照存储 | [D](#d-代次与会话-pin) |
| MCP 服务、技能控制状态 | 资源控制日志（journal） | [E](#e-资源目录与模型配置) |
| 模型账号、槽位、会话默认值 | `configuration.json` 加凭据存储 | [E](#e-资源目录与模型配置) |
| 已解析的 Profile | 无：由分层输入算出的投影 | [F](#f-profile-与配置层) |
| 管理面快照 | 无：实时投影 | [G](#g-管理面快照) |
| 客户端状态 | daemon；客户端只持有游标与草稿 | [H](#h-web-与客户端状态) |

## A. 执行事实

会话账本是“会话里发生了什么”的唯一权威。模型提出建议，账本做记录。Core 把账本折叠成状态；没有任何模块保存与之竞争的结果记录。

| 状态 | 权威（位置、格式） | 修改端口 | 读取方 | 副本（类别） | 不一致规则 | 恢复 |
| --- | --- | --- | --- | --- | --- | --- |
| A1 会话事件 | `events` 表，每个事件一行、哈希链接，键 `(session_key, seq)`（`packages/host-infrastructure/src/adapters/ddl.ts:7`；链校验在 `packages/core-ledger/src/log/integrity.ts:101`） | 持有写者声明（writer claim）的 `SessionLogImpl` 追加（`packages/core-ledger/src/log/session-log.ts:168`） | Core、daemon 列表、历史索引、经事件读取的客户端 | 本表以下各项（投影） | 账本说了算；链断裂时打开失败（`E_LEDGER_INTEGRITY`），不对外提供状态 | `SessionLogImpl.open` 在暴露重放状态前校验整条链（`session-log.ts:176-186`） |
| A2 寄存器表 | `registers` 表（`ddl.ts:22`）：每个具名寄存器的最新单元 | 存储适配器随事件批次写入 | `openTracked`、日志缓存 | A1 的**投影** | 表是该丢弃的副本（`packages/core-ledger/src/reduce/tracker.ts:72-77`） | `openTracked` 重放日志并比较该表（`tracker.ts:249-257`，选项 `verify`，默认 `always`）；不一致时日志缓存中的表被重放结果替换（`tracker.ts:128-135`）。例外：`op.state` 程序计数器不参与折叠，保留表中的值并单独校验（`verifyOpCells`） |
| A3 人工决策 | `decision/state` 寄存器，由决策事件折叠而成（`packages/core-ledger/src/reduce/reducer.ts:138`） | 仅 Core 的 `decision` 状态函数；审批 provider 只投递问题，从不持有答案（`packages/core/src/step/decisions.ts`） | Core 闸门、延迟调用、UI 投影（`packages/core-ledger/src/project/ui.ts:1037`） | 客户端的待审批视图（投影） | 寄存器说了算；结算后仍显示待处理的客户端视图是过期的 | 重放即可重建 |
| A4 效果与未知结果 | A1 中的 effect 与结算事件 | Core 步骤执行器；Host 适配器经派发端口回报结果 | Core 恢复、UI | 停驻 turn 记录（投影） | 结算事件为终局；没有结算的 effect 保持*未知*，交人工对账，绝不自动重放（见[架构](architecture.zh-CN.md#状态归属)） | 恢复时从 tracker 读取待处理 effect（`packages/core-ledger/src/reduce/tracker.ts`） |
| A5 UI 时间线、surface 缓存 | 无 | `openTracked` 用追加的批次驱动 `SurfaceCache` 与 `UIProjectionCell`（`tracker.ts:140`） | SDK `UIProjectionSync`、Web | **投影** | 从 A1 重建 | 打开时重放重新播种 |
| A6 写者声明 | `writer_claims` 行，含租约与代数计数（`ddl.ts:25`；`packages/host-infrastructure/src/adapters/storage-sqlite.ts:325`） | 存储适配器的 claim、renew、release | 打开时的 Core、daemon 列表（运行状态） | 列表里的“运行中”标志（投影） | 租约过期者失效 | 租约自行过期（`storage-sqlite.ts:351` 列出已过期声明） |
| A7 永久审批授权 | `@agnes/host/approval-grants` 元数据命名空间 `grants` 中的 `grant:<id>` 条目（`packages/host/src/runtime/approval/grants.ts:168`） | 仅 Host 授权控制面（`grants.ts`），审批 provider 不得写 | Core 工具闸门经授权端口读取 | 无 | 元数据条目说了算；撤销是条目上的一个字段（`revokedAt`） | 持久，无需重放 |
| A8 会话目录 | `sessions` 表（`ddl.ts:28`）及其索引的事件 | 创建或分叉会话时由存储适配器写入 | daemon `StorageLister`（`packages/daemon-foundation/src/storage/lister.ts:39`） | 列表分页（投影） | 存储说了算 | 每次调用重新计算 |
| A9 展示偏好（标题覆盖、归档、书签过的提问） | daemon 作业存储中的 `session_preferences` 表，书签为其中一列（`packages/daemon-foundation/src/storage/session-preferences.ts:8`） | 经 daemon RPC 的 `SessionPreferencesStore` | `withSessionPreferences` 叠加到列表上 | 无 | *仅对展示*是权威；该类的文档说明它独立于生成标题和对话历史，因此从不改写账本事实 | 持久 |
| A10 历史搜索索引 | `history-index.db`（`packages/history-index/src/directory.ts`） | 仅索引器 | 搜索 RPC | 账本目录的增量**投影**：每个会话记录最后索引事件的 seq 和 id | 戳记变化后，下次搜索只索引新追加的事件；已索引的尾部消失或被替换的会话重新索引（`packages/history-index/src/sync.ts` 的 `syncLedger`） | 下次搜索时从账本重新索引；表结构变化时整库丢弃重建 |

相关控制表（子任务、预算范围与预留）与事件同库（自 `ddl.ts:32` 起）。本页不审计它们。

## B. 插件安装

安装回答“磁盘上有什么代码、是否受信、是否启用”。它与“正在运行什么”（C 类）和“会话使用什么”（D 类）分开。

| 状态 | 权威（位置、格式） | 修改端口 | 读取方 | 副本（类别） | 不一致规则 | 恢复 |
| --- | --- | --- | --- | --- | --- | --- |
| B1 包锁 | Profile 目录下的 `agnes-lock.json`，读写均按 schema 校验（`packages/package-manager/src/lockfile.ts:23,73,98`） | 持有 profile 锁（`lockfile.ts:116`）的 `PackageManager`，经 `commitPackage` | Host 启动、daemon 管理面、信任闸门 | 已解析 Profile 的 `packages`（启动时的投影，`packages/host/src/runtime/profile/inputs.ts:88`）；已安装清单（投影） | 锁说了算；Profile 的 `packages` 是启动时快照，之后的安装经已发布目标到达会话，而不是经 Profile | 写入为临时文件加 rename |
| B2 包目录树 | `<data>/profiles/<profile>/packages/<id>` 目录，完整性由锁条目（`treeIntegrity`）固定 | `commitPackage` 先暂存再 rename（`packages/package-manager/src/store.ts:253`） | 加载器、快照 | 运行时快照（不可变副本，D） | 目录树哈希必须等于锁中的 `treeIntegrity`，否则 `E_LOCK_MISMATCH`（`store.ts:273`） | 事务日志 `.agnes-package-transaction.json`（`store.ts:54`）由 `recoverPackageStore`（`store.ts:217`）重放，完成或回滚 |
| B3 包审计 | 经 `appendPackageAudit` 追加的审计文件（`packages/package-manager/src/audit.ts`） | 在提交的 `finish` 内写入（`store.ts:160`） | 运维人员 | 无 | 审计是证据，不是状态 | 以 `eventId = transactionId` 幂等 |
| B4 运行时快照（开发用与按用途的 pin） | `.agnes-runtime-snapshots.json` 加 `.runtime-snapshots/`（`packages/package-manager/src/runtime-snapshots.ts:131-133`） | 持有 profile 锁的 `pinRuntimeSnapshotStore`、`releaseRuntimePinStore`、`collectRuntimeSnapshotsStore` | 包管理面的 pin 检视；worker 通过无锁的 `runtimePluginSnapshots` 读取，失败时若有事务日志或锁/状态写入可以解释则重试，重试用尽后以 `runtime-source-stale` 拒绝 | 快照副本 | 状态文件列出已知目录；未知目录被拒绝（`assertKnownRuntimeDirectories`） | `recoverRuntimeSnapshotStore` 重放其日志（`runtime-snapshots.ts:591`）。“运行时状态从不决定生效版本”：锁决定 |
| B5 包操作 | daemon 管理面存储中的操作日志（`packages/daemon-admin/src/packages/operations.ts:34`） | 包管理 handler | 管理客户端（轮询操作状态） | 无 | 操作记录是请求/响应账，不是安装状态。已结束的记录及其取消命令在结束七天后回收（客户端重放窗口）；未完成的记录保留。保留记录达 10,000 条时新命令以 `E_PACKAGE_STATE`、`detail.reason: operation-journal-full` 拒绝 | 启动时只重新调度本 daemon 所属 profile 的未完成操作；共享日志里其他 profile 的记录留给其所属 daemon（`packages/daemon-admin/src/packages/handler.ts:536`） |
| B6 本地开发源 | 作者指向的目录；以 `developmentSources` 读取 | `reloadPlugin` 发布（`packages/host/src/runtime/generation/host.ts:865`） | 代次宿主 | 内存中的 `developmentSources` 映射（缓存） | 下次重载时磁盘说了算 | 重启即丢失；由锁中的 `file:` 来源重新注册 |

## C. 发布与组合

“应当运行什么”是一个目标（target）：一组插件行加资源行。它不同于锁状态，因为行携带配置，并且有发布顺序。

| 状态 | 权威（位置、格式） | 修改端口 | 读取方 | 副本（类别） | 不一致规则 | 恢复 |
| --- | --- | --- | --- | --- | --- | --- |
| C1 期望运行目标 | 每个 profile 一行 `composite_targets`：`desired`、`previous`、`last_good`、`report`、`last_failure`、`acknowledged`（`packages/daemon-foundation/src/storage/composite-target-store.ts:50,89,123`） | 发布协调器；制品须先通过隔离 worker 中的探测才能成为 desired（`packages/daemon/src/supervisor/publication/composite-target-activation.ts:47`） | Worker（启动与投递）、管理面 | Worker 实时树（观测，C2）；各包视图（投影） | desired 是应当运行的内容；`acknowledged` 表示 worker 已确认的内容；失败的 desired 会在下一次发布前被还原（`revertFailedDesired`，`composite-target-activation.ts:268-275`） | 持久的 SQLite 事务；尚无确认的 worker 从 desired 启动 |
| C2 worker 中的实时插件树 | 进程内存，由唯一的指针 `RuntimeStateCoordinator` 持有（`packages/host-providers/src/runtime-state.ts:43`） | 发布闸门之下的 `RuntimeTargetPublisher`（`packages/host-providers/src/runtime-target-publisher.ts:130`） | Kernel；会话经 `runtimeRegistryRevisionForTarget`（`runtime-target-publisher.ts:58`） | C1 中的 `acknowledged` 行与 `pluginTreeActual`（观测）（`packages/daemon-admin/src/plugin-tree-surface.ts:36`） | 从不是权威：它向 C1 收敛。纪元（epoch）检查拒绝基于过期基线的发布（`E_RUNTIME_STATE_STALE`） | 重启后为空，由 C1 重建 |
| C3 插件配置值 | 同一存储中的 `plugin_config_values` 与 `plugin_config_audit` 表（`packages/daemon-foundation/src/storage/plugin-config-audit.ts:5`） | 发布事务内的 `PluginConfigAuditStore.stage` | `rebuildDesiredFromInventory` 构造行时读取（`packages/daemon-foundation/src/composite-desired.ts:173`） | desired 行上的 `config` 字段（投影） | 重建行时以表为准；未发布的意图在启动时删除，“崩溃留下的未发布意图不算成功变更” | 构造函数中清除 `plugin_config_intents` |
| C4 由锁推导 desired | 派生：按包对上一个 desired 目标打补丁，依据已安装清单 | 每次 enable、disable、update、rollback、remove 的 `rebuildDesiredFromInventory`（`composite-desired.ts:173`） | C1 | 其他包沿用的旧 desired 行 | 锁决定是否合格；C1 决定行。见[缺口 G6](#缺口) | 启动只修复本地来源与 web 行（`packages/daemon/src/supervisor/runtime.ts:1450-1500`）；其他漂移依赖 B5 操作日志 |
| C5 会话组合 | `.session-compositions/<sha256(sessionKey)>.json`：已解析的组合树加 Profile 快照（`packages/host-providers/src/profile/composition-state.ts:41,69`） | 经组合宿主的 `CompositionSessionStore.pin`（`packages/host/src/runtime/profile/composition-runtime.ts:260`） | 组合宿主、事实链绑定、客户端模块准入 | 以树哈希为键的内存容器（`composition-runtime.ts:54`，缓存） | 对该会话 pin 说了算；容器据此重建 | 持久的 link 先写者胜发布（见[持久发布与损坏处理](#持久发布与损坏处理)）；读取时对整条记录解码（每个树字段、已保存的 Profile，以及必须与树内容一致的树哈希），损坏的记录以 `E_COMPOSITION_BINDING_INVALID` 拒绝并指明文件。绑定是意图记录：先于代次 pin（D2）写入、后于它释放。绑定超过十分钟且**同一 key 摘要命名的 pin 文件确定不存在**时，组合宿主才清扫；该判断从不解析绑定本身，所以 pin 仍在的损坏绑定会被保留供检查，对应会话恢复时按损坏拒绝（已关闭缺口 G1） |
| C6 实时组合状态 | 每个 worker 一个 `.composition-live/<uuid>.json`，带 pid 与进程启动标识（`composition-state.ts:91,119`） | `createLiveCompositionWriter` | 迁移与 bundle 选择的守卫 | 无 | 进程身份已不匹配的文件被忽略 | 下一个写入方启动时，会删除已死亡或 pid 被复用的 worker 的文件以及无法解析的文件；进程身份未知时绝不当作已死亡（已关闭缺口 G7） |
| C7 管理员 bundle 选择 | 带 revision 的 `bundle-selection.json`（`packages/host/src/runtime/profile/bundle-selection.ts:32`） | 配置锁下的配置服务 | Profile 输入读取（`inputs.ts:109`） | 已解析 Profile 的 `adminBundles`（投影） | 文件说了算 | 持久 |

## D. 代次与会话 pin

*代次*（generation）是一组会话所运行代码的不可变归档：目标制品、包目录树副本、包列表和兼容性指纹。会话在首次使用时绑定到一个代次，直到管理员迁移它之前一直留在其上。

| 状态 | 权威（位置、格式） | 修改端口 | 读取方 | 副本（类别） | 不一致规则 | 恢复 |
| --- | --- | --- | --- | --- | --- | --- |
| D1 代次快照 | `.runtime-generations/<uuid>/generation.json` 加包副本 `0..n`（`packages/package-manager/src/runtime-snapshots-generations.ts:48,60`） | 代次宿主调用 `RuntimeGenerationSnapshotStore.create`（`packages/host/src/runtime/generation/host.ts:187`） | 冷恢复时的代次宿主（`host.ts:406`） | 内存中的 `live` 容器（“由快照构建”的缓存） | 快照说了算；每个包副本在读取时重新哈希（`runtime-snapshots-generations.ts:111-132`）。重建前从锁重新检查信任（`packages/host/src/runtime/generation/trust.ts:6`） | 使用前完整解码（每个包、来源与 seam 条目；版本 3 的快照必须选择全部 seam 类别）。快照缺失报 `E_GENERATION_SNAPSHOT_MISSING`；任何形状或哈希失败报带文件的 `E_GENERATION_INTEGRITY`；较新格式报 `E_GENERATION_SNAPSHOT_NEWER`。pin 保留 |
| D2 会话到代次的 pin | `.runtime-generations/sessions/<sha256(sessionKey)>.json`（`runtime-snapshots-generations.ts:189`） | `pin`（原子 link，从不覆盖）、`recordLoop`、`migrateSession`、`releaseSession`（`:193,235,247,315`） | 各处的 `store.session(key)`；`sessionGeneration` | Host 的 `bindings` 映射与 `kernel.sessions`（缓存） | pin 优先于头部代次；第二个冲突的绑定者得到 `E_GENERATION_BINDING_CONFLICT`（`host.ts:181`） | 持久；只在会话被删除之后才删除。pin 使用前完整解码（key、代次 id、格式、每个固定的 seam、loop、资源摘要；文件名必须等于其 `sessionKey` 的摘要）。`seams` 必填：缺失的 pin 被拒绝而不是跳过。读改写（`recordLoop`、`migrateSession`、`pinSessionResources`、释放）在带所有者信息的 `<pin>.json.lock` 文件下进行，并发写入方不会丢失彼此的字段；只有所有者 pid 确认已死才接管，不按年龄接管，存活或未知所有者会以 `E_GENERATION_PIN_BUSY` 拒绝 |
| D3 头部代次 | `.runtime-generations/heads/<sha256(compositionKey)>.json`：`{ compositionKey, generationId }`（`RuntimeGenerationSnapshotStore.setHead`）；代次宿主内存中的 `current` 是其实时副本 | worker 启动时的 `ensureCurrent`，以及头部变更提交后 `publishTargetCore`（`host.ts` 的 `recordHead`） | 后续 worker 的 `ensureCurrent`（经 `reusableHead`）；`publishTargetCore`（经 `reusableGeneration`）；未绑定会话的 `createSession` | 每个 worker 各自的 `current`（缓存） | 指针只是捷径：仅当所记录的快照能正常读取，且与目标摘要、兼容性指纹、包列表、资源摘要和 seam 选择都一致时才使用；否则 worker 重新做快照并覆盖它。改动代码的发布会先寻找由完全相同的这五项输入记录的代次：本 worker 替换掉的头部（新 worker 会用自己的启动快照覆盖上一个 worker 发布的头部）、当前记录的头部，再到会话 pin 指向的代次。它复用第一个能正常读取的代次，使用前先登记为采用者；容器已在运行或已见失败的代次，以及带有已接受实时配置（D4）的代次都会跳过 | 持久替换；无法解码的头部不会被读取方使用，且在重新发布之前使 `collect` 停手；创建者消失后 `collect` 仍保留所记录的头部 |
| D4 已接受的实时配置 | 代次目录内的 `live-config.json`（`runtime-snapshots-generations.ts:147,164`） | `publishTarget` 调用 `saveLiveConfig`，失败时补偿（`host.ts:797-850`） | `build` 把它叠加到归档目标上（`host.ts:226`） | 内存中的行配置（缓存） | 重建时记录说了算；代次缺失则拒绝保存 | 持久替换；记录读不出时报 `E_GENERATION_CONFIG_INTEGRITY` 并指明文件 |
| D5 兼容性指纹 | 存于 D1（`compatibility`）；由 Profile 重新计算（`host.ts:147-166`） | 创建时固定 | `build`、`migrate` | 无 | 指纹不同则拒绝重建与迁移（`E_GENERATION_INCOMPATIBLE`） | 由 AGH 构建与 Profile 决定 |
| D6 会话资源 pin | 被固定代次内的 `session-resources/<sha256(key)>`，摘要记在 pin 中（`runtime-snapshots-generations.ts:269-313`） | `pinSessionResources` | 该会话的技能与资源使用方 | 实时技能目录（缓存） | 对该会话 pin 说了算 | 目录 rename，随后在按 pin 的锁下重写 pin |
| D7 回收 | 是规则而非数据：若有 pin、所记录的头部或实时容器引用某代次，或其创建者或采用者仍在运行，则保留。“在运行”同时比较 pid **与进程启动标识**（与 C6 相同），所以被复用的 pid 不会保住任何东西；没有启动标识的平台只比较裸 pid，只会多保留，绝不会提前删除 | `collect`，在发布、释放、迁移与空闲关闭后调用（`host.ts:435`） | Host | 无 | 被引用的代次从不删除；任何无法解码的 pin 或头部（由 `corruptEntries()` 列出，`scanDamage()` 还会把它们作为 `blocked` 行放进管理端代次状态）都会使整轮停手，因为读不出的条目无法证明某代次未被引用。回收者先把目录重命名为认领名，再重新读取 pin、头部与采用者后才删除；采用、pin、头部与迁移都先发布引用再确认代次仍在（缺口 G11，已关闭） | 空闲容器在 `worker.generation_idle_close_ms`（默认 60 秒，`host.ts:132-137`）后关闭；之后再打开即从 D1 冷恢复 |
| D8 代次宿主的每容器状态 | `preparedRows`、`rowsByGeneration`、`latestSkills`、`failures`、`failedSnapshots`（`host.ts:105-113`） | 宿主的串行队列（`enqueue`） | 同一宿主 | **缓存**；持久对应物是 D1 的 `resources`，以及由 `restoreGenerationRows` 重建的声明（`packages/host/src/runtime/generation/resources.ts`） | 冷重建时以快照资源为准 | 重启即丢，之后重建 |

快照输入捕获由 `generation/snapshotter.ts` 负责，状态投影由 `generation/status.ts` 负责。内部 `GenerationReuseMode` 明确区分新建、启动时复用头部、发布时复用等价归档。发布排除同进程任意 Host 仍持有的代次、失败候选和带已接受实时配置的归档；持久 pin 对归档的保留独立于实时容器。

`packages/package-manager/src/generation-equivalence.ts` 统一拥有构建输入及两种比较。`matchesGenerationBuildInputs` 比较 artifact、兼容性、包、资源与 seam；`sameGenerationCodeAndSources` 还要求已记录 seam/资源，并比较完整来源元数据（忽略归档目录），才能让不同持久 ID 共用容器。两者服务于不同合同。

### 三种“代次”

三个不同的计数共用这个词，不可互换。*插件代次*（plugin generation）是 D1 中不可变的代码归档，也是会话 pin 的单位。*运行时注册表修订*（runtime registry revision）标识 Core 的工具与钩子注册表，驱动写时复制的会话重绑定（`runtime-target-publisher.ts:58`）。*资源代次*（resource generation）是 `ResourceGenerationCell` 持有的实时资源集（`packages/host-providers/src/resource-generation-cell.ts:190`）。一次发布可以只推进其中一个。

### 发布规则

在已有会话绑定的代码容器里，改变代码的发布会分叉出新代次；只改变资源、与注册表无关、或到达时没有任何会话绑定的发布则原地更新（`host.ts:756-770`）。后端面向（backend facets）无法在运行中的进程里更改：`adapter:*` 行、`seam:sandbox`、`seam:platform` 行，以及拥有进程级 provider 的包，会被 `E_GENERATION_RESTART_REQUIRED` 拒绝（`host.ts:687-703`）。指纹另行阻止旧代次在不同的后端部署下被重建（`E_GENERATION_INCOMPATIBLE`，`host.ts:230`）。

### Seam pin 与会话运行时描述符

| 状态 | 权威 | 不一致规则 |
| --- | --- | --- |
| 代次的 seam 选择（approval、principals、billing、checkpoint、artifacts、verifier、repair） | 代次快照（D1）内的 `seams` 字段，记录每个选择及其解析出的 provider、版本、来源包与完整性 | 快照说了算：重建的旧容器按它解析 seam，而不是按当前 Profile。会话绑定时比较容器的实际绑定与会话 pin，不符即拒绝（`E_SEAM_PIN_MISMATCH`）；没有记录 seam 的 pin 按损坏拒绝（`seam-pins.ts`，`host.ts` 的 `bindGeneration`） |
| seam pin 变更 | 管理员迁移，须显式列出要重新固定的类别；同时写一条 Host 审计记录 | pin 的 seam 有差异而未列出时，迁移被拒绝（`E_SEAM_PIN_CHANGE`） |
| 会话运行时描述符 | 无：由会话绑定、容器绑定表与当前运行计划计算（`describeHostSession`、`sessionRuntime`） | 描述符是投影。当前选择不同时以 `pending` 呈现，生效方式为 `new-sessions`、`restart-required` 或 `migrate` |
| 运行计划、容器句柄、变更结果 | 纯函数编译 Profile 与清单；容器句柄来自实例管理；变更结果来自变更协调 | 它们在 Host 的三项职责之间传递显式结果 |

### 持久发布与损坏处理

意图记录、代次 pin、头部、代次快照与已接受的实时配置都用同一个原语发布：`publishFileDurablySync`（`packages/system-node`）——在目标旁写私有临时文件并刷盘，再用 link（先写者胜）或 rename（替换）放到位，最后刷新父目录。删除（`removeFileDurablySync`，pin 释放）同样刷新父目录。目录逐层持久化（`mkdirDurablySync`：每个新目录的目录项在其父目录刷盘，锚点目录必须已存在，所以被删除的代次会报错而不是被重建），复制出的树在摘要或 pin 指向它之前持久化（`syncTreeBatchedSync`）：逐个文件和目录刷盘，子项先于父目录；macOS 上每项只做普通 `fsync`，最后对树根做一次整盘刷写（`F_FULLFSYNC`），它会让此前交给磁盘的全部数据落盘，而不是每项各做一次整盘刷写。适用于意图与代次目录、`sessions`、`heads`、`adopters`、`session-resources` 与资源树。这些调用以及基于硬链接的包锁产生的文件系统错误按原样报告，绝不报为“锁忙”。

保证。**进程崩溃**后可见的是旧文件或完整的新文件，不会是撕裂的文件；`*.tmp` 残留无害。**掉电**后已返回的调用是持久的；由于每条记录先于下一条记录持久化，依赖关系中的后一条记录不会在没有前一条的情况下存在。未返回的调用可能整体丢失。

两个 pin 的恢复顺序。会话绑定依次是 (1) 组合意图，(2) 代次 pin；释放顺序相反（先代次 pin，后意图）。据此：只有意图而无 pin 是被放弃的打开，在它变旧且 pin 确定不存在后清扫；只有 pin 而无意图只会由人工删除造成，此时会话从其固定的代次重新打开并重新解析组合（pin 保住代码与 seam）；没有快照的头部被忽略并重新发布。

损坏从不当作“不存在”。每个持久元数据文件都从 `unknown` 完整解码后才使用；失败即 `E_GENERATION_INTEGRITY`（或 `E_COMPOSITION_BINDING_INVALID`、`E_GENERATION_CONFIG_INTEGRITY`）并指明文件，文件保持原样，在会话拒绝边界变为 `E_SESSION_CORRUPT`，路径在 `detail.file`。较新 AGH 写的记录仍是 `E_SESSION_VERSION_NEWER`。列表与回收按条目隔离损坏（`corruptEntries()`），无法证明未被引用的内容一律不删，整轮停手。`configuration.json` 与 `bundle-selection.json` 是安全设置的权威，损坏时启动以 `CONFIG_INVALID_STATE` 失败关闭并指明文件；不存在跳过它们继续运行的模式。

pin 锁。`<pin>.json.lock` 是发布时已带所有者（`pid`、启动标识、token）的文件。只有所有者 pid 已消失才会被接管，绝不按年龄接管：暂停的持有者或慢盘会保住它，竞争者以 `E_GENERATION_PIN_BUSY` 结束并指明所有者。释放时仅当锁仍带释放者自己的 token 才删除。被无关进程复用的 pid 会让锁一直保留到人工删除；启动标识会被记录，但无法同步比较。

尚存的限制。掉电行为靠构造保证，没有故障注入测试。包锁（`.agnes-lock.lock`）发布时已带所有者，有效 owner pid 已死时立即回收，owner 记录畸形时保留 30 秒宽限；它比较裸 pid，绝不因年龄回收存活所有者。所有者存活时，等锁超过 10 秒的调用方以可重试的 `E_PACKAGE_BUSY`（`detail.reason: 'busy'`）被拒绝，不会被报告为完整性失败。

## E. 资源目录与模型配置

| 状态 | 权威（位置、格式） | 修改端口 | 读取方 | 副本（类别） | 不一致规则 | 恢复 |
| --- | --- | --- | --- | --- | --- | --- |
| E1 MCP 服务定义、信任、期望状态 | `<data>/resource-control/mcp/<profile>.mcp.json` 日志（`packages/resource-control-store/src/mcp.ts:147,159`） | `ResourceControlStore.call` 之后、按 profile 串行的 `McpResourceStore.txn`（`packages/resource-control-store/src/control-store.ts:14`） | daemon RPC、worker 快照写入器 | Worker 快照（投影，E3）；worker 回报的状态（观测） | 日志说了算。日志里的 `status` 是“最近一次 Host 观测，不是实时连接”（`mcp.ts:355-365`） | `recover` 重新驱动未终结的操作（`mcp.ts:355`；`control-store.ts:191`） |
| E2 技能控制状态（信任、优先级、期望、操作） | 版本 4 的 `SkillJournal`（`packages/resource-control-store/src/skill-journal.ts:26`） | 同一外观之后的技能存储 | daemon RPC、worker 快照写入器 | `actual` 与 `discovered` 是观测：“desired/operation 从不合成 actual”（`skill-journal.ts:34`） | 期望与实际分开保存，从不合并 | 同上的 `recover` |
| E3 worker 快照 | `<data>/resource-control/worker-snapshots/<profile>.json`（`control-store.ts:209,213`） | 每次修改后 `writeWorkerSnapshot`，临时文件加 rename | 启动时的 worker；资源服务 worker 确认其 sha256（`packages/resource-control-daemon/src/service-adapters.ts:55-58`） | E1 与 E2 的**投影** | 日志说了算；无法确认快照摘要的 worker 被拒绝（`service-adapters.ts:74-75`） | daemon 启动时重写（`packages/daemon/src/supervisor/runtime.ts:1013`），`recover` 时亦然 |
| E4 包技能快照 | `worker-snapshots/<profile>.package-skills.json`（`runtime.ts:1014`） | 先校验锁与已安装目录树的 `writePackageSkillInventory`（`runtime.ts:1026`） | Worker | B1 与 B2 的**投影** | 锁说了算；校验失败让启动失败，而不是扫描未经验证的目录 | 启动时与 `refreshPackageSkills` 时重写 |
| E5 观测到的 worker 状态 | 由共享 worker 回报（`observeWorker`，`control-store.ts:243`；`service-adapters.ts:101-106`） | 只经 daemon 由 worker 回报；只有 `@shared` 会话算数 | 资源管理 UI | **观测** | 从不覆盖期望 | 下一次回报 |
| E6 代次资源捕获 | 代次目录内的 `resources/` 加 `resourcesDigest`（`packages/host/src/runtime/generation/resources.ts:22`） | 代次创建 | 保留容器的冷重建 | 在代次创建时冻结的**投影** | 对旧会话快照说了算 | 读取时校验摘要 |
| E7 模型账号、槽位、会话默认值、子引擎 | Profile 目录中的 `configuration.json`，带版本与单调 `revision`（`packages/host-infrastructure/src/configuration.ts:254,1047-1048`） | 持有锁文件的 `ConfigurationService`；按 `expectedRevision` 比较并交换 | Profile 输入读取、管理 UI | 已解析 Profile 的 `provider`（投影，F）；按 provider 的目录缓存（`configuration.ts:703`，缓存） | 文件说了算；过期的 `expectedRevision` 被拒绝（`CONFIG_REVISION_CONFLICT`） | 持久；旧版本状态在读取时迁移（`configuration.ts:225`） |
| E8 凭据 | home 目录下的凭据存储；配置中只保存带 revision 后缀的 `secret://` 引用（`configuration.ts:244`） | 经 `ConfigurationService` 的凭据存储 | 模型调用时的 Host 密钥存储 | E7 中的引用（指针） | 存储说了算；引用的 revision 超过配置 revision 时在解码阶段被拒绝（`configuration.ts:575-583`） | 持久；读取时校验权限 |
| E9 已应用的模型 Profile | 各 Host 的进程内存（`applyModelProfile`，`packages/host/src/runtime/assemble/provider-stage.ts:106`） | 保存后由 daemon 的 `configurationApplication.apply`（`packages/daemon/src/supervisor/configuration.ts:11`） | 之后打开的会话 | 供新启动 worker 使用的持久副本 `<profileFile>.<hash>.json`（`runtime.ts:678,1867`） | E7 说了算；daemon 比较哈希，只有已应用 revision 与保存 revision 一致才把它标为 `new-sessions`，否则为 `restart-required`（`packages/daemon/src/supervisor/configuration.ts:22-27`） | daemon 启动时若已解析 Profile 的哈希变了，已应用 revision 置 -1（`packages/daemon/src/supervisor/configuration.ts:23`），标签因此重新计算 |

## F. Profile 与配置层

“Profile”没有权威。它是分层输入的纯函数，启动时解析一次，模型 Profile 变化时再解析一次。

| 层（顺序） | 来源 | 写入方 | 能设置什么 |
| --- | --- | --- | --- |
| 1 builtin | 随发布提供的模板，可继承一个父模板（`packages/host-common/src/profile/resolve.ts:406-413`） | AGH 发布 | 所有键的默认值 |
| 2 user | `profiles/<name>/profile.yaml` 与 `configuration.json` 的键合并（`packages/host/src/runtime/profile/inputs.ts:66-86`） | 用户；配置服务 | schema 允许的一切。重叠的键以配置服务的值为准（浅层展开），`adapters` 与扩展隔离例外，它们按字段合并 |
| 3 workspace overlay | 受信工作区经验证的 deploy 清单，通过锁投影（`packages/package-manager/src/lock-state.ts:70-133`） | 工作区所有者，且须先获得工作区信任 | 固定的片段：包、能力上限（只能收紧）、审批模式（只能收紧）、Computer Use（只能收紧）、扩展隔离（`packages/host-common/src/profile/types.ts:153-160`）。不能设置传输或包配置（`resolve.ts:416-426`），也不能设置持久化（`resolve.ts:284-293`） |
| 4 local、flags | `.agnes/profile.local.yaml`、CLI 标志 | 运维人员 | 只有 `extensionIsolation`；其他任何键以 `E_DEP_MISSING` 拒绝而不是忽略（`resolve.ts:433-436`；`packages/host-common/src/profile/isolation.ts:49-77`） |
| 5 managed | 受管策略 | 管理员 | 只有 `version`、空的 `policy` 与 `extensionIsolation`；通用的 managed 层尚未实现，其他内容一律拒绝（`isolation.ts:61-77`） |

已解析 Profile 的各种投影及其不一致规则：

| 副本 | 类别 | 规则 |
| --- | --- | --- |
| Host 内的 `ResolvedProfile`（`packages/host-common/src/profile/types.ts:225`） | 投影，深度冻结（`resolve.ts:626-627`） | 由输入重新计算；绝不原地修改 |
| `<profileFile>.<hash>.json`（`runtime.ts:678`） | 投影；按哈希寻址，使启动中的 worker 读到的就是被告知的那份制品 | 原子替换；旧文件永不改动 |
| 会话组合（C5）里的绑定 Profile | Pin | 有意对会话冻结 |
| 兼容性指纹（D5） | 固定部分的投影（adapters、persistence、sandbox、platform、composition、内置包完整性） | 不同即需重启或新建部署 |

已解析 Profile 的 `hash` 覆盖整个 Profile，包括模型路由。任何以它为键的东西都会随模型配置的变化而变。因此永久审批授权改为绑定 `policyDigest`（`packages/host-common/src/profile/policy-digest.ts`），它只对授权相关字段求摘要：审批、策略、computer use、seams、presets、sandbox、隔离、命令钩子与固定适配器。

## G. 管理面快照

管理面快照是用于展示的投影。任何一份都不得用来做授权判断，也不得回写。

| 快照 | 来源 | 构建位置 | 过期性与规则 |
| --- | --- | --- | --- |
| `RuntimeAdminSnapshot`（`packages/protocol/src/runtime-admin.ts:88`） | **共享 worker** Host 的 `host.providers.catalog()`、预设、发布状态与安全状态，加本地插件根目录 | 按请求：`session.catalog` 命令（`packages/worker-runtime/src/commands.ts:805`），在 `packages/daemon/src/supervisor/runtime.ts:2414` 组装 | 实时读取，无缓存。它描述的是共享 worker 的头部，而不是某个会话的容器；每个会话的视图是会话运行时描述符（已关闭缺口 G3） |
| `PluginGenerationStatus`（`host.ts:36,496`） | pin（D2）、实时容器、快照（D1）、`failures` | 在代次宿主中按请求计算，由组合宿主包装 | 派生。通过 protocol 错误 helper 捕获公开 code/reason；状态只暴露 schema 拥有的代码，不再解析异常消息 |
| `pluginTreeActual`（`plugin-tree-surface.ts:36`） | 当前 worker 代的 C1 `acknowledged` 与 `report` 行 | daemon | 观测；没有 worker 代时报告“未运行” |
| 配置快照的 `effect`（`packages/protocol/src/runtime-admin.ts:172`） | E7 revision 对比已应用 revision | `configurationApplication.present` | 见 E9 |
| 包列表与操作状态 | B1、B5 与 C1 观测 | 包管理 handler | 按请求读取；操作记录与激活观测之间是最终一致 |

## H. Web 与客户端状态

客户端不持有任何会话事实。它们持有账本游标、待发送命令、草稿，以及 daemon 投影的镜像。

| 状态 | 权威 | 客户端副本（类别） | 不一致规则 | 恢复 |
| --- | --- | --- | --- | --- |
| 会话事件与时间线 | 经 daemon 的账本（A1） | 页面中的实时投影（`packages/web-conversation/src/live-projection.ts:17`）：“来自 daemon 的权威时间线：opening、patch 或历史页”，流式文本在本地叠加 | daemon 的时间线到达后替换本地叠加 | 重连从游标继续 |
| 流游标与待发送命令 | SDK `JournalStore`（`packages/sdk/src/journal.ts:34`），浏览器实现使用 `localStorage` 键 `agnes-sdk-journal` | daemon 按 `(clientId, commandId)` 对写入去重，因此重发待发送命令是幂等的 | 日志只记录本客户端读到了哪里；存在什么由账本决定 | 从保存的游标恢复；未发送的命令重发 |
| 输入框草稿与记忆 | 浏览器 `sessionStorage` 与 `localStorage`（`packages/web/src/composer-memory.ts:16`；`packages/web/src/app.ts:691`） | 每个查看者自己的便利状态 | 丢失无妨 | 容忍存储不可用 |
| 管理面操作记录 | `sessionStorage`（`packages/web-admin/src/admin/plugins/admin/operation-storage.ts:16`） | 仅作提示；操作日志（B5）才是权威 | 服务端操作状态说了算 | 重新拉取 |
| 客户端模块 roster | daemon 的包状态（B1、C1） | 页面自行对账 roster、导入、样式与 fiber（`packages/web/src/client-modules/reconcile.ts:23`） | daemon 的 roster 决定哪些模块应当运行；页面已加载的集合是观测 | 重新加载，再次对账 |
| 会话列表、控件 | daemon | 经 `createRefreshCoordinator` 的轮询与失效（`packages/web/src/refresh-coordinator.ts:4`） | 任何变更边界之后重新读取 | 定时刷新 |
| 连接状态 | daemon 存活性 | `createReconnectController` 探测，并在发现是另一个 daemon 时只重载一次（`packages/web/src/reconnect.ts:35`） | 重载到了另一个 daemon，就采用它的 bootstrap | 带上限的退避 |

浏览器插件只能通过与行绑定的中继读写宿主状态，见[插件边界](plugins.zh-CN.md)。

## 不变量

1. **每个事实一个写入方。** 上面每个权威只有一个修改端口。审批 provider、客户端、管理视图和观测报告从不写事实。
2. **模型可见即已记录。** 模型看到的一切，以及每个 effect 的结果，都是账本中的事件。无法经账本看到的状态不能影响决策。
3. **投影可丢弃。** 寄存器表、UI 时间线、历史索引、worker 快照或管理面快照都可以删除并重新计算而无损失。与权威不一致的那份，是被丢弃的那份（`tracker.ts:72-77`）。
4. **期望与实际分开。** 日志和目标保存期望状态；worker 回报实际状态；没有任何路径由期望推导实际。
5. **Pin 是选择，不是默认值。** 持久的 pin（代次、组合、资源集）固定该会话的行为。更改它须经显式迁移，检查兼容性与打开状态（`host.ts:922-960`）。
6. **崩溃落在提交点的某一侧。** 多文件写入使用日志、link 或临时文件加 rename，并能在启动时恢复（`store.ts:217`、`runtime-snapshots-generations.ts:193`、`composite-target-store.ts:123`）。已校验、待删除的包树或快照树先改名为其日志的 `.trash-<transactionId>` 再递归删除，因此恢复时可以不做树校验直接删掉删到一半的 trash；其他受损目录仍然拒绝。
7. **身份不符则失败关闭。** 信任、完整性或指纹不再匹配的代次会被拒绝并保留 pin，绝不静默替换（`trust.ts:6`）。
8. **生效标签要诚实。** 只有实时已应用 revision 等于已保存 revision 时才返回 `new-sessions`（`packages/daemon/src/supervisor/configuration.ts:22-27`）。

## 缺口

这些是代码中存在两个权威、被当作真相的未记录缓存，或缺少对账路径之处。它们按机制命名并记入待办。G1、G2、G3、G4、G5、G7、G8、G9 已关闭（见[已关闭缺口](#已关闭缺口)）；G6 与 G10 是读取规则，不是代码改动。

| 编号 | 机制 | 证据 | 影响 |
| --- | --- | --- | --- |
| G1 | *已关闭* | 见[已关闭缺口](#已关闭缺口) | |
| G2 | *已关闭* | 见[已关闭缺口](#已关闭缺口) | |
| G3 | *已关闭* | 见[已关闭缺口](#已关闭缺口) | |
| G4 | *已关闭* | 见[已关闭缺口](#已关闭缺口) | |
| G5 | *已关闭* | 见[已关闭缺口](#已关闭缺口) | |
| G6 | desired 目标按包操作打补丁；启动时没有完整的锁到 desired 的差异比对 | `rebuildDesiredFromInventory` 只编辑一个包（`composite-desired.ts:173`）；启动只修复本地来源与 web 行（`runtime.ts:1450-1500`） | 带外的锁变更（离线 CLI 编辑）要等到该包下一次被操作才对账。**读取规则：**锁回答“装了什么”，组合目标（C1）回答“发布了什么”；不要由一个推断另一个，各自从自己的权威读取。只有按包操作与启动修复可以写 C4。未做穷尽审计，可能还有其他修复路径 |
| G7 | *已关闭* | 见[已关闭缺口](#已关闭缺口) | |
| G8 | *已关闭* | 见[已关闭缺口](#已关闭缺口) | |
| G9 | *已关闭* | 见[已关闭缺口](#已关闭缺口) | |
| G11 | *已关闭* | 见[已关闭缺口](#已关闭缺口) | |
| G10 | 已解析 Profile 的 `packages` 是启动时锁的副本 | `inputs.ts:88` 只读一次锁；之后的安装经已发布来源到达新会话（`composition-runtime.ts:458-480`） | 启动之后读取 `profile.packages` 的代码会看到过期的安装状态。**读取规则：**`profile.packages` 只用于启动时决策与内置包身份（兼容性指纹、seam 解析）；当前安装状态来自实时清单或实时目录。组合宿主自己合并目录，其他读取方不能依赖 `profile.packages` |

### 已关闭缺口

| 编号 | 修复 | 位置 |
| --- | --- | --- |
| G1 | 组合绑定是意图记录：先于代次 pin 写入，后于它释放。组合宿主启动时清扫超过十分钟、且按同一 key 摘要找到的 pin 文件确定不存在的绑定及其 Profile 快照。判断从不解析绑定：pin 仍在或 pin 状态读不出的损坏绑定会被保留，恢复时按损坏拒绝。 | `CompositionSessionStore.sweepOrphans`（`composition-state.ts`），由 `createCompositionHost` 调用 |
| G5 | 已复现：切换模型路由会改变 Profile 的 `hash`，使永久授权失配。授权改为按 `policyDigest` 匹配；授权存储 schema 升为 3，旧存储报告 `reset-required`。 | `policy-digest.ts`、`approval-grants.ts`、`packages/host/src/runtime/approval/grants.ts` |
| G7 | 写入方启动时删除已死亡或 pid 被复用的 worker 的状态文件以及无法解析的文件。 | `reapDeadLiveCompositions`（`composition-state.ts`） |
| G8 | `generation.json` 在 `owner.json`（`{ pid, startId }`）之后持久发布。`collect` 从 `owner.json` 读所属者；读不出时保留目录十分钟，之后删除。被 pin、被头部引用、被保留或本进程创建的代次永不删除，损坏的 pin 或头部会使整轮停手。 | `runtime-snapshots-generations.ts` |
| G3 | 会话运行时描述符（`sessionRuntime`、`describeHostSession`）按会话报告代次、固定的 seam 以及待生效的较新选择及其生效方式。`session.catalog` 本身仍描述共享 worker 的头部。 | `runtime-descriptor.ts`、`daemon-rpc` 的 `session-runtime` 方法 |
| G4 | seam 选择记录在代次快照中，并按会话作为 seam pin 保存；容器据快照重建，恢复时比较绑定与 pin，迁移须显式列出重新固定的类别。损坏或缺失的 pin 按损坏拒绝。 | `seam-pins.ts`、`host.ts` |
| G2 | 每个组合记录自己的当前头部代次；之后启动的 worker 在输入完全相同时复用它，而不是再写一个快照目录，`collect` 也会保留它。worker 的启动目标与 daemon 随后投递的目标不同，因此这次投递会复用上一个 worker 为它发布的代次或会话 pin 指向的代次，而不是再复制一遍相同的包。 | `runtime-snapshots-generations.ts` 的 `setHead`、`reusableHead`、`reusableGeneration`、`collect`；`host.ts` 的 `recordHead` |
| G9 | 按 `seam:sandbox` 与 `seam:platform` 行 id 的检查已随这两行消失；发布时对部署指纹的比较也已删除：指纹在进程生命周期内固定，不可能不同。须重启守卫是 `publishTargetCore` 中的 `adapter:` 行差异与进程级包检查，以及冷恢复时 `build` 的指纹检查；`platform` 仅宿主可用。 | `host.ts` 的 `publishTargetCore`、`build` |
| G11 | 回收者删除前先把代次目录重命名为 `<id>.deleting-<毫秒>-<token>`，再重新读取 pin、头部与采用者，发现任何引用就把目录放回。采用者文件发布在代次目录内部（从不递归创建）；pin、头部与迁移后的 pin 先发布，若代次已不在则撤回并报 `E_GENERATION_SNAPSHOT_MISSING`。认领者崩溃后，十分钟后的下一轮回收会结算该认领。 | `runtime-snapshots-generations.ts` 的 `collect`、`#confirmPresent`、`#adopt`；交错用例在 `generation-collect.test.ts` |

## 相关页面

- [架构](architecture.zh-CN.md)：请求路径与分层职责
- [插件与 provider 架构](architecture-plugins.zh-CN.md)：从作者角度看行、目标与代次
- [延迟调用](deferred-invocations.zh-CN.md)：决策寄存器
- [源码导航](source-map.zh-CN.md)：定位所属包
