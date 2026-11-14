# 插件托管会话

[English](managed-sessions.md) | 简体中文

[作者工具包](README.zh-CN.md) · [插件流与受管理服务](transports.zh-CN.md) · [组合包与配置](bundles-and-profiles.zh-CN.md)

profile 范围的进程内托管服务可以替信任并启用该插件的主人开会话、驱动会话。会话归主人所有，宿主记下托管它的包和插件行。主人在 Web 上能看到会话、在那里回答审批，也能停掉它。在进程内代码的[信任边界](#信任边界)之内，插件只能看到和驱动自己托管的会话，看不到主人自己的会话，也看不到其他插件的会话。

## 声明

在 `capabilities.managedServices` 的托管服务上写 `sessions: true`。信任审阅显示原子 `managedSessions:profile:<id>`。能力哈希覆盖这个标志，加上它需要重新做信任决定。没有这个标志时，`init.sessions` 上的每个调用都以 `CAPABILITY_DENIED` 拒绝。会话里的工具和 hook 拿不到这个端口。

```json
{ "id": "engine", "scope": "profile", "artifact": { "kind": "in-process" }, "sessions": true, "...": "..." }
```

## 授权工作区

托管会话只能开在主人授权给该插件的工作区里。主人用 `agh` 命令行授权；插件没有任何办法授权、列出或撤销工作区，因为命令背后的管理方法只接受经 Unix 管理连接的本机主人。

```sh
agh plugins grants grant @example/companion /work/repo
agh plugins grants list [@example/companion]
agh plugins grants revoke @example/companion /work/repo
```

工作区必须已经登记且存在：在某个目录里启动 `agh` 会登记它，在 Web 工作台里添加也会。后端用和 `start` 相同的检查解析路径，保存规范根路径，所以符号链接或结尾斜杠指向同一条授权。一条授权覆盖该包的所有插件行。未知的包、没有声明 `sessions` 托管服务的包、未登记的路径、另一个已安装的包也声明了相同插件行编号的包，都会被拒绝，且不保存任何内容；这种共用行的托管会话也会被拒。撤销后下一次 `send` 被拒，正在运行的回合会跑完。工作区在授权后被删除，也可以撤销。一条授权同时属于包和它的插件行，所以声明了相同行编号的另一个包永远不会继承它。移除一个包时，后端先在同一步里撤销它的全部授权、解除它的全部会话；这一步失败就拒绝移除，包仍然保留。解除后的会话在 Web 里仍归你，仍是托管会话，规则不变，但任何包都不能再列出或触及它。如果这一步之后包管理器拒绝了移除，授权和会话仍保持撤销和解除。之后以同一个包编号再次安装的包从零授权、零会话开始，需要重新授权；之前那个包用过的 `startKey` 会开一个新会话。授权也只对已安装的包当前声明的插件行存在。每次安装、更新、回滚、移除之后，守护进程启动时，以及每次授权、列出、撤销之前，后端都会删除其包不再声明的插件行的授权。这包括被更新或回滚改了编号的插件行，以及清单读不出来的包。

## 使用

`start(init)` 收到 `init.sessions`，类型是 [ManagedSessions](../../packages/extension-api/src/managed-sessions.ts)。

```ts
const { sessionId } = await init.sessions.start({
  bundle: '@example/companion#worker',
  workspace: '/work/repo',
  input: 'Fix the failing test.',
  startKey: 'task-42',
  retention: 'task',
})
const sent = await init.sessions.send(sessionId, { text: 'Also update the changelog.', idempotencyKey: 'task-42:2' })
if (sent.state === 'notSubmitted') console.log(sent.reason) // busy | archived | duplicateKey
```

- `start` 只接受调用方自己包里审阅过的 Bundle（`<包>#<bundle>`），preset 由 Bundle 的 launch 决定，和启动应用一样。工作区必须是主人[授权](#授权工作区)给这个插件的。相同的 `startKey` 返回它开过的会话（`created: false`），开会话中途崩溃后重试也一样。每次开会话（包括重试）都重新检查工作区、模型和权限。重试时 Bundle、工作区、保留方式、权限、模型或两个开关与首次不同，以 `START_KEY_REUSED` 拒绝。
- `taskBinding: { id, generation }`（可选，5.21.0 新增）把会话绑定到调用服务的一个任务。已绑定的会话调 `send` 会被 `CAPABILITY_DENIED` 拒绝（`data.reason: 'OWNER_INPUT_REQUIRED'`，在归档、重复、忙之前判）；之后的输入都走[`admitInput`](#准入主人的输入)。同一 `startKey` 换绑定或换首个输入重复开会话，以 `START_KEY_REUSED` 拒绝。
- 会话属于开它的包和插件行。另一个包即使声明了相同的插件行 id，也不能列出、读取、停止或归档它，第一个包被移除之后也一样。之后以第一个包的编号安装的包同样不能：移除会把会话从所有包解除。后端每次调用都按当前清单重新核对调用方的插件行：包必须已启用且受信，服务必须声明 `sessions`，插件行必须是这个包自己的。这项核对管不到的范围见[信任边界](#信任边界)。
- 可选的 `model` 指定主模型路由。部署里没有这条路由就拒绝开会话，不回落到默认路由。
- 每个托管会话都带着[对外检查点](../guide/security.zh-CN.md#outward-checkpoint)及其命令规则运行。后端每次打开这个会话、它的子代理、角色子会话或分叉，都会开启命令规则，不论由谁打开：首次开会话、重启后的发送，还是绑定唤醒。它的 shell 里的 `git push`、发包或其他对外命令停下等真人，声明为对外的工具也一样。终端（`pty_open`、`pty_send`）和常驻 shell 一律拒绝，因为检查看不到它们的历史。打开后会话策略没有执行检查点，以 `CAPABILITY_DENIED` 和原因 `OUTWARD_CHECKPOINT_UNAVAILABLE` 拒绝，开会话时还会把它归档。已经在没有命令规则的情况下打开的会话，以原因 `OUTWARD_COMMAND_RULES_OFF` 拒绝，不会被复用。
- `permission: 'full-access'`，或 Bundle preset 把会话设成完全访问，只在两项前提都成立时才放行。会话创建之前，后端检查打开它的路径会开启命令规则，并且平台沙箱探测报告完整的 OS 边界。会话打开之后，后端读它的实时策略：对外检查点必须生效，会话的沙箱执行级别必须是完整。缺任何一项，开会话或发送都以 `FULL_ACCESS_UNAVAILABLE` 拒绝，附带 `missing: 'outward-checkpoint'` 或 `missing: 'os-boundary'`。没有探测过或只部分生效的边界算缺失，后端读不出的策略也算缺失。完全访问从不回答对外检查点，只有真人能回答。部署开着自动审核时，所有开会话请求都拒绝。
- `memoryWrites: false` 在请求任何审批之前拒绝会话里的每次持久记忆写入，完全访问也无法放行。范围包括工具写记忆文件、把提炼结果保存到工作区记忆或用户记忆（包括保存的技能，无论由主人、模型还是自动推荐发起），以及续期已保存的条目。只留在会话自身历史里的提炼条目仍然允许。`skillInstalls: false` 在请求任何审批之前拒绝会话发起的每次安装，完全访问也无法放行。范围包括技能安装（含保存的技能）、插件管理和 MCP 服务器管理。Bundle preset 没有这两项的开关，读外部文字的会话应两项都关。
- 两个开关沿会话的谱系传下去：它开的每个子代理和角色子会话、它的每个分叉，以及这些会话的后代都保留开关。后端读不出某个会话的来历时，拒绝它的技能安装。定时任务新开的会话不是后代，不带这两个开关。
- `send` 只在会话空闲时接受。宿主记录每个 `idempotencyKey`，重复的键返回 `notSubmitted { reason: 'duplicateKey' }`，不会第二次入队。每次发送都重新做开会话时的检查：工作区授权被撤销或工作区不再登记、模型路由缺失、部署开着自动审核、Bundle 未审阅，或完全访问缺少前提条件，都以同样的原因拒绝，什么也不入队。授权撤销时已经在跑的回合照常走完。`list`、`status`、`events`、`result`、`usage`、`toolResult`、`interrupt` 和 `archive` 仍然可用，插件可以停掉会话并清理。
- 输入身份是后端生成的 `plugin:<插件行>`，无人值守策略是**转人工并通知**：遇到审批，会话停下等待，主人稍后在 Web 或已绑定的渠道上回答。

## 读取

| 调用 | 返回 |
| --- | --- |
| `list()` | 本包的这个插件行托管的会话及各自状态。 |
| `status(id)` | `{ kind: notLoaded \| idle \| active \| systemError, flags }`。等审批或等回答的回合是 `active`，带 `waitingOnApproval` 或 `waitingOnUserInput`。每次读取时由运行事实计算。 |
| `events(id, { afterSeq })` | 某个序号之后的助手文字、工具调用、审批和回合结束，以及下次要传入的 `lastSeq`。 |
| `result(id)` | 最后一个回合怎么结束的，以及它最后一段助手文字。 |
| `usage(id)` | 输入、输出 token 和花费。运行时给不出的值是 `null`，不是 `0`。 |
| `toolResult(id, callSeq)` | 一次工具调用的结果文字、`isError`，`shell` 还给出数字形式的退出码。调用还没有结果时 `state` 为 `pending`，此时 `isError`、`text` 和 `exitCode` 没有意义；调用已结束但没有输出，则是 `done` 且 `text: ''`。 |

长期保留的任务会话中，持久账本里尚未关闭的原生 `ask_user_question` 也会产生
`waitingOnUserInput`，即使默认非阻塞的工具调用及其回合已经结束。读取状态不会加载历史
worker；账本读取失败会拒绝调用，不会视为问题已回答。该标志仍存在时，不能仅凭回合完成
就把任务标为完成。

### 审批怎么结束的

`approval` 事件保持审批第一次出现时的序号，所以已经用 `afterSeq` 越过它的读取方永远看不到它的变化。审批结束时，`events` 还会在结束它的那个事件的序号上返回一个 `approvalOutcome` 事件：

```ts
{ kind: 'approvalOutcome'; seq: number; approvalSeq: number;
  outcome: 'allowed' | 'rejected' | 'expired';
  via: 'person' | 'full-access' | 'automatic' }
```

- `approvalSeq` 是该审批 `approval` 事件的 `seq`。每个审批至多有一个结果事件，从同一个 `afterSeq` 重读只返回一次。只往前翻页、从不从 0 重读的读取方，能得知它见过的每个审批是否结束。`lastSeq` 的用法不变。
- `allowed` 包含允许一次、本会话允许和永久允许。`rejected` 是拒绝。`expired` 表示截止前没人回答，或请求不再有效。
- `via: 'person'` 表示主人回答了。只有回答携带主人审批所用的身份时才报告它；其他身份的回答都是 `automatic`，因此“`person` 加 `rejected`”的计数不会包含无法担保的拒绝。`full-access` 是完全访问下的自动允许，它从不处于待定：它的 `approval` 事件一出现就是 `decided`，结果事件在同一序号紧随其后。过期和其他情况都是 `automatic`。
- 结果读自会话时间线，而时间线由账本重建，所以守护进程重启和 worker 恢复后仍在。`events` 读取最近 5000 个时间线节点；落后超过这个窗口的读取方，可能错过节点已移出窗口的审批的结果。

`interrupt(id)` 停掉正在跑的回合，`archive(id)` 归档会话。

## 准入主人的输入

5.21.0 新增。替主人持有任务的服务，不用 `send` 把主人的话塞进已绑定的会话，而是请平台准入。平台记下输入、持有原文，只在会话空闲且开会话检查通过时才提交，所以会话忙、有未答的问题、工作区授权被撤或会话已归档时，输入既不会丢，也不会投错地方。

```ts
const result = await init.sessions.admitInput(sessionId, {
  key: 'task-42:owner:1', // 1–256 个字符，你自己的幂等键
  target: { taskId: 'task-42', taskGeneration: 3, startKey: 'task-42' },
  input: { kind: 'ownerMessage', receiptId: event.receiptId },
})
// 之后或崩溃后：读同一条输入的状态（不会成为新的请求）
const again = await init.sessions.inputResult(sessionId, { key: 'task-42:owner:1' })
```

`target` 必须与会话的 `startKey` 和绑定相符。同 key、同请求重复调用返回同一条输入；有任何不同即拒绝。

| `input.kind` | 原文 | 平台做什么 |
| --- | --- | --- |
| `ownerMessage` | 从不传入。给出[渠道事件](channel-targets.zh-CN.md#回执)的 `receiptId`。 | 按宿主记下的回执取出原文。回执必须属于你的服务和主人当前的配对，一张回执只准入一次。 |
| `recoveryContinuation` | 从不传入。给出 `turnEndSeq`，即已结束回合的 seq。 | 核对该回合是最后一个、以取消或失败结束、之后没有新的回合开始；通过则提交固定的英文句子 "Continue the interrupted turn without treating this recovery as a new owner decision."，否则为 `recoveryUnknown`。 |
| `legacyOwnerMessage` | 以 `text` 传入，另带 `originalInbox: string \| null`。 | 来源无法认证，结果一律是 `recoveryUnknown`；只有主人在 Web 上选择“投递”，原文才会执行。 |

结果是下列状态之一。除 `legacySend` 与 `absent` 外，都带 `inputId`（等于 `key`）、`version`（每次变化加一）、`reason` 和 `reviewLocation`。

| `state` | 含义 | 该怎么做 |
| --- | --- | --- |
| `queued` | key 已占下但记录未完成：崩溃在两步之间，或 `admitInput` 因开会话检查读不到（例如 daemon 正在重启）而 reject。该输入不会执行。 | 用同一请求再调一次 `admitInput`。 |
| `enqueued` | 已准入。平台持有原文，等会话空闲且开会话检查通过。检查读不到时，输入原样持有。 | 轮询 `inputResult`。它从不改动请求本身，但持有的输入此时已可投时会顺带提交；会话空闲时和定期巡检时平台也会这样做。 |
| `consumed` | 某一轮已取走原文，附带 `turn` 和 `seq`。终态。 | 完成。 |
| `retained` | 保留不投：主人在 Web 上选了保留或丢弃，或会话已归档。终态。 | 完成。 |
| `needsOwner` | 无法证明可投：回执查不到或不属于你、配对已变、授权已撤，或开会话检查不通过（准入时与提交时都查）。原因为 `ownerDiscarded` 时，表示已提交的输入在平台之外被移出会话收件箱，原文为主人保留。 | 通知主人，不要重试；由主人在 Web 上处置。 |
| `waitingQuestion` | 会话有未答的问题。平台持有输入，问题关闭后自动往下推进。 | 通知主人并等待。 |
| `recoveryUnknown` | `legacyOwnerMessage`，或校验不过的 `recoveryContinuation`。 | 通知主人；由主人在 Web 上处置。 |
| `legacySend` | key 只出现在旧 `send` 台账。`delivery` 为 `consumed`、`pending` 或 `unknown`。 | `consumed` 是终态；否则以 `legacyOwnerMessage` 重新提交。 |
| `absent` | 平台不知道这个 key。你的服务仍在托管的会话，`historyCoverage` 一律为 `complete`：受管会话的输入与发送记录不按时间清理。`partial` 为保留值，目前不会返回。 | `complete` 时准入；若日后返回 `partial`，只发通知。 |

`reason` 取 `eligible`、`busy`、`questionOpen`、`legacySourceUnknown`、`recoveryUnverified`、`receiptUnknown`、`pairingChanged`、`grantRevoked`、`sessionArchived`、`ownerRetained`、`ownerDiscarded` 之一（`ownerDiscarded` 配 `retained` 表示主人已丢弃，配 `needsOwner` 表示在平台之外被移除）。只当文字显示，取值可增。`reviewLocation` 是 `/?session=<sessionId>&ownerInput=<inputId>`，主人在 Web 上的这个页面查看原文、来源和历史并作决定。页面上的决定（投递、保留、丢弃，以及对停放的渠道回执重投或丢弃）经 `_agnes/v1/managedInput.get` 与 `_agnes/v1/managedInput.decide`，二者只接受主人自己的 Web 页面。经 Unix 套接字连接的本地 SDK 客户端以 `CAPABILITY_DENIED` 拒绝；插件的客户端模块、主页页面和工作台面板经 Web 交给它们的接口调用时同样被拒绝。限制：插件代码与页面运行在同一页面中，改写页面 WebSocket、自开连接或绕过 SDK 对象的代码拦不住。

主人不需要链接也能找到等其处理的内容。一旦有内容等待，Web 主页侧栏会出现带计数的 **主人输入** 入口。其页面跨会话、无需任何 key 地列出：处于 `needsOwner` 或 `recoveryUnknown` 的输入、开会话检查读不到而被持有的输入、一分钟内没有完成准入的 `queued` 记录，以及所有停放的渠道回执（可在页面上重投或丢弃）。它读取 `_agnes/v1/managedInput.list`，同样只接受主人自己的 Web 页面。

拒绝按[拒绝](#拒绝)一节的方式 reject，`data.reason` 为：`OWNER_INPUT_TARGET_MISMATCH`（`target` 与会话的 startKey 或绑定不符）、`OWNER_INPUT_KEY_REUSED`（同 key、请求有任何不同）和 `SESSION_ARCHIVED`（抛出，不作为结果返回）。对已绑定会话调 `send` 会以 `OWNER_INPUT_REQUIRED` reject。参数不合法为 `INVALID_PARAMS`。开会话检查读不到时，`admitInput` 以非拒绝类错误 reject，key 留在 `queued`；稍后用同一请求再调一次。

信任标注：已准入的主人原文仍以 `origin: 'system'`、`trust: 'untrusted'` 进入会话收件箱。准入证明的是原文来自已配对主人的渠道回执，并不把原文变成主人身份输入，也不授予任何审批。不新增声明键：`sessions: true` 已授予这两个方法。需要它们的插件把 `apiRange` 设为 `^5.21.0`。

## 保留方式与生命周期

- `retention: 'task'` 长期保留会话。`retention: 'ephemeral'` 在 `result` 读到已结束的最后一个回合后归档会话，并且不进任务经验挖掘：自动提炼和模型自己的提议都拒绝。主人自己发起的提炼仍然可用。
- 停用插件后，不能再开新会话或发消息。已有会话仍归主人，进行中的回合照常走完，待决审批仍可在 Web 回答。重新启用后调用 `list()` 核对。
- 卸载插件的包时，平台先把其已提交的主人输入从会话收件箱撤回，再删除其输入记录（含持有中的）和渠道回执（待确认的与停放的）。这些都不会执行，也不会留给主人处置。

## 拒绝

被拒绝的调用以一个普通对象 reject，含 JSON-RPC `code`（例如 `CAPABILITY_DENIED` 为 `-32006`）、与错误名相同的 `message` 和 `data`。`data.code` 是错误名。`data.reason` 给出拒绝原因，例如 `WORKSPACE_NOT_AUTHORIZED`、`FULL_ACCESS_UNAVAILABLE`、`OUTWARD_CHECKPOINT_UNAVAILABLE`、`START_KEY_REUSED` 或 `PLUGIN_ROW_AMBIGUOUS`。`FULL_ACCESS_UNAVAILABLE` 还带 `data.missing`，取值 `outward-checkpoint` 或 `os-boundary`。读取 `error.data.reason`，即可暂停任务并告诉所有者该授权什么。守护进程错误的其他字段不会到达插件：没有消息文本、路径和堆栈。不属于拒绝的失败以 `code: 'E_REQUEST'` reject，不带原因。

## 信任边界

托管服务和其他进程内插件一起运行在共享会话 worker 里，经这个 worker 的私有通道访问后端。后端只受理来自共享会话 worker、走 profile 范围服务所用 profile 通道的托管会话请求。来自其他 worker 或会话自身工作的请求以 `CAPABILITY_DENIED` 拒绝，原因是 `MANAGED_SESSION_LANE`。

这项检查不是身份认证。调用方插件行（主人、包、完整性摘要和服务）由 worker 报告，后端按最新清单重新核对，但分不出是哪个进程内插件发起的调用。受信的进程内插件如果有意为之，可以冒用另一个已启用且声明了 `sessions` 的包的插件行，驱动那一行的会话、Bundle 和工作区授权。绑定唤醒（bound wake）的边界相同。这符合[安全与信任](../guide/security.zh-CN.md)中的信任模型：进程内插件是受信代码，彼此之间不隔离。启用任何进程内插件时都要按这一点审核。

## 暂未提供

在 Web 上授权工作区暂未提供，请用 `agh plugins grants`。会话绑定主人渠道是后续工作。

命令规则管不到它看不见的命令：以外部智能体进程运行的子代理（Claude Code、Codex、ACP 或 SDK 智能体）用自己的 shell，[规则列出的缺口](../guide/security.zh-CN.md#outward-command-rules)在完全访问下照样不经询问就执行。给读外部文字的会话开完全访问之前，先权衡这一点。
