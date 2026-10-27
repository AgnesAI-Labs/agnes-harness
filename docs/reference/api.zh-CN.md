# API 与 Schema 参考

[English](api.md) | 简体中文

[文档导航](../README.zh-CN.md) · [插件边界](../develop/plugins.zh-CN.md)
[App Server v1](app-server.zh-CN.md) · JSONL、生成的 Schema、认证和错误 envelope。
[协议分层](protocol-tiers.zh-CN.md) · 哪些方法属于稳定的客户端契约，哪些属于可演进的管理契约。

为自己的应用接入 AGH 时，先选择与你的运行环境对应的入口，再查方法和 Schema。这里只列可追溯的接口合同；开发第一个插件可以先看[教程](../develop/plugins.zh-CN.md)。

API 随源码演进，`@agnes/*` 目前通过仓库 workspace 解析。使用与源码版本匹配的接口和示例。

校验错误通过 `data.code`、`data.key` 和 `data.path` 定位拒绝的字段。
Union 诊断使用兼容分支的字段错误，或所有兼容分支共有的约束；字面量判别字段不匹配的分支
不能提供其他形状的字段提示。形状仍有歧义时保留 `ENUM`。缺失字段报告父路径和缺失键。
这些诊断细化错误位置，不改变载荷是否通过校验，描述也不会回显拒绝值。

## 选择正确入口

| 使用方 | 入口 | 典型操作 |
| --- | --- | --- |
| Node 客户端 | `@agnes/sdk` 的 Node 条件出口 | createClient、session、config、packages、resources、skills、mcp |
| 浏览器宿主 | `@agnes/sdk/browser` | 会话与浏览器允许的协议，未提供 Node 管理能力 |
| 浏览器插件 | 宿主传入的 ClientContext | slots、session、theme、locale、commands、agnes.services |
| 后端 Cordis 插件行 | `@agnes/plugin-runtime` / Cordis Context | Config、inject/provide、effect、ctx.extension、ctx.skills、已验证行上的 ctx.services/slots/projections/resources |
| 插件 context facet | `@agnes/extension-api` 的 `PluginContextFacets` | 工具、hooks（16 类全部）、账本事件、服务、槽位、投影、资源、providers 与插件自身身份 |

SDK 的现行 Node 出口：[index.node.ts](../../packages/sdk/src/index.node.ts)；浏览器出口：[index.browser.ts](../../packages/sdk/src/index.browser.ts)。应用只能使用各包 exports 暴露的入口；源码深链接用于解释，不是鼓励消费者深导入。

## SDK 调用顺序

已经获得可信连接配置的 Node 客户端可按以下顺序操作。下例接收部署层提供的 `options`；连接地址与认证方式由该部署确定：

```ts
import { createClient, type CreateClientOptions } from '@agnes/sdk'

async function listSessions(options: CreateClientOptions) {
  const client = createClient(options)
  try {
    await client.initialize()
    return await client.session.list({})
  } finally {
    await client.close()
  }
}
```

新会话为 `client.session.new({ cwd, preset?, sessionKey? })`，恢复用 `client.session.load(id, { cwd? })`；执行是 `session.prompt(text)`，取消是 `session.cancel()`。`session.prompt(input, { creditLimit?, maxSteps?, timeLimitMs? })` 可调低这一轮的额度上限和模型步数上限，并告诉模型墙钟时间上限（到期仍由调用方取消）；每一项都需要服务端声明对应能力，否则被拒绝（见[应用服务器](app-server.zh-CN.md)）。业务使用前按当前服务端要求登记工作区、处理权限请求。关闭 client 是连接清理，不等价于取消后台任务。

从 UI 投影的 `pendingInputs` 读取待执行消息。`session.removeQueued(itemId, { commandId? })` 通过 `_agnes/v1/submit` 的 `removeQueued` 类型删除一条待执行消息，返回已提交的事件序号；`session.sendNow(itemId, { commandId? })` 停止当前轮并优先执行该条排队消息。两者都校验会话所有权；消息已开始执行或已不存在时返回 `QUEUED_INPUT_GONE`。删除保留其他消息，不会启动或停止执行。结果未知时，重试应复用同一个 command ID。

传输支持 Node 的 unix/stdio/ws 等入口，生产连接的认证、命名管道进程身份、TLS/Origin 由部署合同决定。建议用户先从 CLI/Web 入口走自动发现；嵌入者不能跳过握手和服务端身份校验。可运行的连接与包管理示例见[文档 smoke](../../tools/public-docs/smoke.mjs)，其凭据与模型由本地夹具产生。另有[共享本地验收](../../tools/acceptance/shared-local-delivery.e2e.test.ts)覆盖分发迁移等流程。复现步骤与检查范围见[验证记录](../maintainers/verification.zh-CN.md)。

进程内 Core/Host 会话还提供只读的 `isRunning`，表示当前正在执行 run、step 或 resume；只有等待恢复的持久轮次不算运行。daemon 据此拒绝移除有活动会话的工作区。

## 协议方法分组

`client.session.open(id, { cwd?, signal?, onPermissionRequest?, onProgress? })` 执行会话准入，不重放 ACP 历史。当 `initialize.agentCapabilities._meta["ai.agnes.harness"].sessionOpen` 为 `true` 时，SDK 使用 `_agnes/v1/session.open`（`sessionId`、可选工作区提示 `cwd`、唯一 `requestId`）；旧 daemon 使用 `session/load`。准入拒绝不会触发回退。工作区、所有权、插件恢复和完整历史校验与 `session/load` 相同；普通 ACP load 仍完整重放转录。SDK 恢复记住该 handle 的打开方式。

ACP 回放根据历史 `turn/start` 的序号推导 `_meta["ai.agnes.harness"].promptTurnId`，跨回放分页保留正确的轮次归属。每次 load 独立重建元数据，与实时 feed 隔离；后续实时更新仍归属于实时轮次。

Web 创建 SDK 连接时设置 `sessionRestoreHistory: 'none'`，使保留了工作区提示的新建、分叉或直接附加句柄在 worker 回收后也只做准入恢复。其他 SDK 客户端默认 `'full'`；显式 `session.load` 仍为该句柄保留完整重放，即使连接的恢复默认值不同。

`client.session.fork(parentId, at, { cwd? })` 可为子句柄保留父会话已知的工作区提示。Web 的 turn 和侧栏分叉都会传递它。该提示仅留在客户端；后端从父绑定派生子会话权限，恢复时仍会重新核对提示。`session.fork(parentId, at, { additionalDirectories })`（线上是 `_agnes/v1/session.fork` 和 `fork` 提交的负载）让子会话拥有父会话的额外目录再加上所列目录，父会话不变。daemon 对合并后的列表按 `session/new` 的规则准入（绝对路径、已登记、不受保护、合计最多 8 个，超出则拒绝而不截断）。SDK 只在 `initialize.agentCapabilities._meta["ai.agnes.harness"].forkAdditionalDirectories: true` 时才发送，否则抛出 `unsupported`，也不会 fork。

`client.session.btw(sessionId, question)` 基于当前对话回答一个旁问（1 至 4000 字符），不进 transcript：账本里只多一条 `side-call` 的费用行，模型不能调用工具；回合进行中只看到该回合之前已完成的部分。同一会话同时只能有一个旁问（`SESSION_BUSY`）；单次请求或树预算不足是 `SEMANTIC_REJECTED`（`reason: 'BUDGET'`），60 秒超时是 `REQUEST_TIMEOUT`。模型一旦被调用，超时或失败也会写入 `side-call` 费用行（标记为中断）。

`_agnes/v1/session.voice.transcribe`（`sessionId`、`audio`，可选 `language`）把一段录音转成文字，`_agnes/v1/session.voice.speak`（`sessionId`、`text`，可选 `voice` 和 `speed`）返回 base64 的 `audio/mpeg`。两者都只对会话所有者开放，使用语音设置所选的语音账户；`language`、`voice` 和 `speed` 缺省时取已保存的设置。`audio` 是 base64 的 PCM WAV，16 kHz 单声道 16 位，最长 20 秒（格式不对是 `INVALID_PARAMS` 加 `reason: 'VOICE_AUDIO_FORMAT'`，录音过长或过大是 `VOICE_TOO_LARGE`）；`text` 为 1 至 120 个 UTF-16 码元（表情符号计为 2，超出是 `INVALID_PARAMS` 加 `reason: 'VOICE_TOO_LARGE'`）。`_agnes/v1/voice.status` 不需要会话，返回 `transcribe` 和 `speech` 两项功能的状态（`available`、`unconfigured`、`no-model`、`credential-missing` 或 `ambiguous`）、所选的 `account`、没有可用账户时的 `reason`，以及已保存的 `settings`；`voice.settings.get` 和 `voice.settings.save` 读写这些设置，只接受本地所有者。错误：没有可用账户是 `SEMANTIC_REJECTED`（`reason: 'VOICE_UNAVAILABLE'`，并带说明原因的 `state`）；服务商拒绝或失败是 `SEMANTIC_REJECTED`（`reason: 'VOICE_PROVIDER'`，附 `code`、`retryable`，已知时还有 `retryAfterMs`）；单次请求或树预算不足是 `SEMANTIC_REJECTED`（`reason: 'BUDGET'`）；30 秒期限是 `REQUEST_TIMEOUT`。每个会话同时只能有一次识别和两次朗读在进行（`SESSION_BUSY`，`reason` 为 `'voice.transcribe'` 或 `'voice.speak'`），一分钟内受理的调用超过 30 次是 `OVERLOADED`（`reason: 'VOICE_RATE'`，附 `retryAfterMs`）。到达服务商的调用会写入一条 `side-call` 费用行，标签为 `voice.transcribe`（音频秒数，向上取整）或 `voice.speak`（文字的 UTF-8 字节数）；在此之前被拒绝的调用不写任何行。会话里还没有回合时，调用不做树预算预留。见[和智能体说话](../guide/voice.zh-CN.md#费用与限制)。

准入后读取有界的 `projectUIOpening`，从该 opening 的 generation 和排他 `upto` cut 订阅；open 响应不是投影游标。权限处理器必须在打开前注册。中止 SDK 调用会发送带相同请求 ID 的 `session.loadingCancel`，只释放该连接上的本次等待，不停止运行中的 turn。省略 ID 保留旧的连接/会话级加载取消行为。历史预览和本地草稿都不能授权发送或回答审批。

| 方法族 | 作用 |
| --- | --- |
| `initialize`、`session/new`、`session/load`、`session/prompt`、`session/cancel` | 握手与基础会话 |
| `session/update`、`session/request_permission` | 服务端通知与审批请求 |
| `_agnes/v1/session.*` | 附加、列表、分叉、投影、模型/预设、控制等扩展 |
| `_agnes/v1/submit`、`_agnes/v1/submit.ack` | 持久命令，包括指引、follow-up 和排队消息修改；重试复用 commandId |
| `_agnes/v1/config.*` | 配置摘要、测试、保存、账号；敏感输入不可当普通日志 |
| `_agnes/v1/packages.*` | 包检查、安装、治理、更新与操作查询 |
| resource/skill/MCP 管理方法 | 独立控制面权限和 revision 检查，见资源 method table |
| `_agnes/v1/clientModules.*` | 名册与受限 client relay；不是任意 browser RPC |
| `_agnes/v1/extension.call` | 受授权的扩展服务调用 |

具体方法拼写、方向、params/result、管理权限以[method table](../../packages/protocol/src/methods.ts)、[包管理表](../../packages/protocol/src/package-admin.ts)、[资源管理表](../../packages/protocol/src/resource-control.ts)为准。字段不要从本表简写推导。

`_agnes/v1/session.runtime`（SDK `client.session.runtime(id)`）说明会话实际运行在什么上面：代码代次（以及是否有更新的代次）、组合、Loop、每类 provider 的当前选择及其 `pending` 变更、seam 绑定、资源版本（Skills、MCP 服务器、模型路由指纹）、生效的审批模式、工具策略与沙箱，以及需要重启的输入。`pending.effect` 为 `new-sessions` 表示之后新开的会话生效，`restart-required` 表示需要重启 daemon。管理端 `plugins.generations` 的代次列表也会列出每个代次所绑定的会话。

读取完整工具记录时，使用 `_agnes/v1/session.readToolDetail` 按需读取工具调用及其匹配的结果。传入 `sessionId`，并把工具节点的 `seq` 作为 `callSeq`；有 `resultSeq` 时一并传入。可选的 `offset` 和 `maxBytes` 按 UTF-8 字节分页，单次响应最多 262,144 字节。响应包含 base64 编码的 `data`、`totalBytes` 和 `nextOffset`（最后一块为 `null`）。先解码并拼接各块，再解析 `{call, result?}` JSON。daemon 读取事件前会校验会话访问权限。RPC 和 SDK 的 `Session.readToolDetail(callSeq, resultSeq?)` 都将完整序列化记录限制在 64 MiB；分页不能读取更大的记录。超限时 RPC 返回 `INVALID_PARAMS`，原因是 `detail-too-large`。常规 UI 投影仍使用长度受限的预览，工具节点新增可选 `resultSeq`。

读取已交付文件时，使用 `_agnes/v1/session.deliverables` 获取交付物视图所需的来源，而不必拉取完整 UI 投影：即已有结果的 `present` 工具调用。传入 `sessionId`、不含边界的 `afterSeq`（默认 0）和 `limit`（1–200，默认 100）。每一项包含 `callSeq`、`resultSeq`、`toolUseId`、序号范围包含该调用的投影回合 `turnId`（有时才返回），以及 `structured`，即结果中按原样记录的结构化数据（结果没有时省略）；请像校验 `readToolDetail` 的结果一样校验它。调用与结果的配对方式与 UI 投影在会话主 lane 上配对工具节点完全一致，包括续写回合和分叉继承的回合；daemon 只读取工具行和回合行来查找它们。各项按 `resultSeq` 升序排列，`upto` 是本页覆盖到的账本序号。 被截断的页在结果边界停止，配对、结果替换和回合归属均截至该页的 `upto`；同一调用在后页出现新结果时会再次返回。重复结果也计入单页读取预算，因此一页可能少于 `limit` 项。单页最多 `limit` 项、JSON 不超过 262,144 字节；还有剩余时返回 `nextAfterSeq`（等于 `upto`），作为下一页的起点。要获取之后的新结果，把上一页的 `upto` 作为 `afterSeq` 传入：结果被替换的调用会带着新结果再次返回，因此请按 `callSeq` 保存各项。daemon 读取前会校验会话所有者。`afterSeq` 超过会话最后序号时返回 `INVALID_PARAMS`，原因是 `after-seq-out-of-range`；单项超过一页时原因是 `deliverable-too-large`，这类结果请改用 `readToolDetail` 读取。SDK 方法是 `Session.deliverables({ afterSeq?, limit? })`。

写操作通常通过 clientId/commandId、expected revision/integrity 返回持久化 operation receipt，再查询最终状态。不要收到 receipt 就记录效果成功；不要未知结果后换 commandId 重做外部效果。

## Skills 写接口

Node SDK 与服务端提供以下管理接口；调用者必须持有对应控制面权限。

| Node SDK / RPC | 输入与结果 |
| --- | --- |
| `client.skills.remove` / `_agnes/v1/skills.remove` | profile、clientId、commandId、resourceId、expectedRevision；返回 ResourceOperationReceipt |
| `client.skills.prioritySet` / `_agnes/v1/skills.priority.set` | 同上，加 expectedPriority 与 priority（50–500 整数或 null）；返回 ResourceOperationReceipt |

两项均要求 admin authority 和 `resources.skills.write`。`remove` 只接受可删除的 workspace/user 来源；`prioritySet` 拒绝 runtime 来源。Web BFF 分别映射为 `/admin/resources/api/skills/remove` 和 `/admin/resources/api/skills/priority`；这不增加浏览器 SDK 的直接资源管理权限。shell/TUI 也没有同名新增命令。

通过 `client.resources.operation.get({ profile, operationId })` 等待 succeeded/failed，记录错误并检查 actual；删除受理后不能取消。优先级保存不改变信任/启用；删除的目录范围、永久标记和同名接替见[Skills 指南](../guide/skills.zh-CN.md)。权威来源：[Schema](../../packages/protocol/schema/resource-control.json)、[方法/权限表](../../packages/resource-control-contracts/src/resource-control.ts)、[Node facade](../../packages/sdk/src/resource-control.node.ts)。

## Schema 导航

| 合同 | 手写源 |
| --- | --- |
| 核心协议/会话 | [agnes-v1](../../packages/protocol/schema/agnes-v1.json)、[session-v1](../../packages/protocol/schema/session-v1.json) |
| Profile/预设/模型 | [profile](../../packages/protocol/schema/profile.json)、[preset](../../packages/protocol/schema/preset.json)、[model](../../packages/protocol/schema/model.json) |
| 工具/扩展/hook | [tooldef](../../packages/protocol/schema/tooldef.json)、[extension-manifest](../../packages/protocol/schema/extension-manifest.json)、[hooks](../../packages/protocol/schema/hooks.json) |
| 扩展服务/投影 | [extension-service](../../packages/protocol/schema/extension-service.json)、[projection](../../packages/protocol/schema/projection.json) |
| 包/资源控制 | [package-admin](../../packages/protocol/schema/package-admin.json)、[resource-control](../../packages/protocol/schema/resource-control.json)、[lockfile](../../packages/protocol/schema/lockfile.json) |
| 身份/部署/Surface | [authz](../../packages/protocol/schema/authz.json)、[deploy-manifest](../../packages/protocol/schema/deploy-manifest.json)、[surface](../../packages/protocol/schema/surface.json) |
| ACP 差异与来源 | [UPSTREAM](../../packages/protocol/schema/acp/UPSTREAM.md)、[DEVIATIONS](../../packages/protocol/schema/acp/DEVIATIONS.md) |

生成类型在[gen/ts](../../packages/protocol/gen/ts)。Schema 通过只证明形状，跨对象关联、授权、事务和实际执行仍由相应实现验证。

模型记录可选的 `inputLimits` 透传 pi-ai 的 `maxRequestBytes` 和 `images` 限制（`maxPerMessage`、`maxPerRequest`、`resize`）。`resize.maxBytes` 以 Base64 编码字节计，`jpegQuality` 以 1–100 计；未声明的限制仍受产品上限约束。图片支持仍由 `input` 是否包含 `image` 决定。

`_agnes/v1/apis.list` 的 `profile.models` 条目包含 `input` 和可选的 `inputLimits`，客户端按已解析的模型能力判断。旧服务端可能不返回这两个字段，客户端不能根据模型名称猜测图片支持。

`ToolContext.session.readImages` 是 Core 提供的可选能力，由内置 `read` 工具使用。输入为 `{ path, offset?, limit? }`，返回 `ToolResult`。`session-image://list` 分页列出当前会话、当前 lane 的原图；`session-image://<消息序号>/<图片序号>` 读取一张，逗号分隔的引用可整批读取。分页偏移和图片序号从 1 开始；列表默认每页 20 项，最多 100 项。读取不能指定其他会话或 lane、看到读取开始后的记录，也不能绕过模型和运行环境的图片限制；工具取消会取消读图。旧运行环境不提供此能力，`read` 会明确返回不可用。

`ToolContext.fs.read` 使用从零开始的字节偏移，最大字节数由底层读取执行。Host 旧的行窗口适配器仍从第一行开始，只有选择 `unit: 'bytes'` 才使用字节窗口；不支持有界读取的 provider 会拒绝该模式，而不是读取全文。`ToolContext.net.fetch` 合并调用取消、可选的调用方 signal 和受调用期限及剩余 writer lease 约束的期限。省略 timeout 时使用调用的默认期限；显式 timeout 不能延长调用或 lease。调用已到期时，在建立连接前拒绝。Fetch provider 必须让连接和响应体（包括已锁定的 reader）遵守传入 signal；默认 provider 已实现。调用结束时也会取消尚未读取的响应体。

默认 Host 文件系统对 canonical 名称授权，再通过不跟随链接的目录或文件句柄执行读、写、元数据查询、列举、创建和删除。允许的符号链接在授权前解析；授权后被替换为链接的路径组件会被拒绝，没有按路径重新打开的后备实现。本地操作需要当前版本的 `@agnes/system-node` 原生产物。POSIX 原生入口和远端适配器对含有未配对 Unicode 代理码元的路径返回 `EINVAL`，避免 UTF-8 编码改变文件名。POSIX 远端适配器要求 Python 3 支持相对描述符的文件操作，通过 transport 的 `exec` 端口执行，包括用 stdin 传输二进制写入，不再调用基于路径的 upload/download。自定义文件系统 provider 负责同样的边界。递归删除拒绝硬拒绝路径的祖先目录，即使会话具有完全文件权限。此边界覆盖文件工具；命令和 MCP 进程仍遵循各自的沙箱合同。

## 会话的授权

`client.approval.sessionGrants(sessionId)`（`_agnes/v1/approvalGrants.forSession`）向会话所有者列出让该会话的工具不再询问的全部授权，不需要给出工具、范围或策略版本：

```json
{ "grants": [
  { "grantId": "dec-41", "lifetime": "session", "toolId": "shell", "scope": "tool:shell:execute", "createdAt": "2026-10-14T02:11:09.000Z", "issuer": { "id": "local", "org": "local", "role": "user", "deptPath": [], "attrs": {} } },
  { "grantId": "grant-9f2c", "lifetime": "always", "toolId": "write", "scope": "tool:write:execute", "policyVersion": "v1", "createdAt": "2026-10-12T08:00:00.000Z", "issuer": { "id": "local", "org": "local", "role": "user", "deptPath": [], "attrs": {} } }
] }
```

`session` 是仍然有效的「本会话允许」；`always` 属于该会话的操作者及其策略，对这个操作者的其他会话同样生效。`client.approval.revokeSessionGrant(sessionId, grantId)`（`_agnes/v1/approvalGrants.revokeForSession`）按列表里的 id 撤销任一种授权，返回带 `revokedAt` 的授权；不在列表里的 id 以 `APPROVAL_REJECTED` 拒绝。撤销是持久的，会话授权在会话重新打开后也不会恢复；它对之后的调用生效，工具会再次询问。已经掌握工具、范围和策略版本的调用方仍可使用完整绑定的 `approvalGrants.list` 与 `approvalGrants.revoke`。

## 会话书签

会话把书签过的用户提问和其他展示偏好存在一起，所以各台设备看到同一份列表。`client.session.setBookmarks(sessionId, bookmarks)`（`_agnes/v1/session.bookmarks.set`，参数 `{ sessionId, bookmarks: string[] }`）整体替换列表，返回 `SessionPreferences`：

```json
{ "title": "季度复盘", "archived": false, "bookmarks": ["01JABCDEFGHJKMNPQRSTVWXYZ0", "01JABCDEFGHJKMNPQRSTVWXYZ7"] }
```

每个 id 是会话 UI 投影（`session.projectUI` / `session.view` 的 `nodes`）里 `kind: "user"` 节点的 `id`，即 `user/message` 事件的账本 id：26 位 ULID，刷新、daemon 重启和分叉后都不变。列表保持给定顺序，重复的 id 只保留第一次出现的位置，最多 200 个，每个 1–128 个字符且不含控制字符；空列表即清空；没有书签时不返回 `bookmarks` 字段。id 不与对话记录核对，对应提问不在界面上时这个书签只是匹配不到。调用是幂等的，所有者与本地凭据检查和 `session.rename` 相同；未知会话以 `SESSION_NOT_FOUND` 拒绝。

`session.list` 的行（`SessionMeta`）在 `title`、`archived` 旁带同样的 `bookmarks` 字段。分叉会按原顺序复制提问位于继承历史内（分叉边界及之前）的书签，父会话的列表不变。目前没有删除会话的接口；归档的会话保留书签。`session.list` 的行在会话有额外目录时还带 `additionalDirectories`（按绑定顺序排列，是 daemon 所在机器上的路径），没有则不出现该字段。

## 置顶会话

`client.session.pin(sessionId, pinned)`（`_agnes/v1/session.pin`，参数 `{ sessionId, pinned: boolean }`）把会话置顶到侧边栏最上面，返回带 `pinnedAt` 的 `SessionPreferences`。对已置顶的会话再次置顶保留原来的时间；`pinned: false` 取消置顶。已归档的会话以 `SESSION_ARCHIVED` 拒绝；归档会话（包括通过 `workspace.remove`）会取消置顶。所有者与本地凭据检查和 `session.rename` 相同。`session.groups` 把 `pinned` 组排在最前；`session.list` 带 `sidebar: { groupId: "pinned" }` 按置顶时间从新到旧分页，工作区组不再列出已置顶的会话。`SessionMeta` 行带 `pinnedAt`。

## 辅助模型默认值

本地 Node SDK 提供 `client.config.modelSlots.get()` 与 `client.config.modelSlots.save({ revision, slots })`，均返回 `{ revision, slots, auto? }`。`slots` 仅接受 `fast` 和 `verifier`，值为显式 `{ route, model }` 或 `null`（不使用）；省略 `verifier` 时保留预设定义行为。保存会替换辅助模型默认值映射，检查共享配置 revision，并按 Host 实时目录校验完整路由／模型组合；模型不可用或 revision 冲突时拒绝。

省略 `fast` 槽位时，它跟随默认账户。此时结果带有 `auto: { fast: { accountId, route, model } }`，新会话的快速模型使用该模型：

```json
{ "revision": 4, "slots": { "verifier": null }, "auto": { "fast": { "accountId": "account-1f0c", "route": "agnes-ai", "model": "agnes-2.5-flash" } } }
```

模型从默认账户自己的模型里按保存顺序选出：服务商公布价格时取输入加输出价格最低的；没有价格时取 ID 带轻量档标记（`flash`、`mini`、`lite`、`haiku`、`nano`、`fast`、`small`）的第一个。槽位已设置或为 `null`、没有已启用的默认账户、或两条规则都选不出模型时，结果不含 `auto.fast`，此时沿用预设自己的快速模型；Host 没有提供所选模型时也是如此。`auto` 只读：保存时接受并忽略它。验证模型从不自动选择。

这两个方法属于部署本地管理权限，浏览器 SDK 禁止调用。Web 通过同源 `/admin/api/model-slots` GET/POST 管理桥接，沿用读取／激活权限和恢复只读检查。两个响应均只含 `{ revision, slots, auto?, canSave }`。可选模型通过 `/admin/api/model-adapters` 独立读取（读取权限），目录缓慢或不可用不阻塞已保存槽位的展示和清除。保存仍按实时目录校验所选目标一次，不会为了响应再次读取目录。默认值写入新会话初始选择；已有会话通过 `Session.setModel({ slot, route, model })` 显式覆盖。参见[审查模型配置](../guide/security.zh-CN.md)。

## 智能体解析与启动

SDK 支持 `client.session.new({ cwd, agent: '@acme/kit#review' })`，调用方无需了解 Bundle 组合。`client.agents.resolve(ref)`（RPC `_agnes/v1/agents.resolve`）返回精确选择、模型、权限摘要、来源身份和最终有效配置摘要；审阅过的调用可传 `agentDigest`，发生漂移即拒绝。不能同时传入 `loop`、`bundles` 或 `preset`。会话/工作区授权仍走普通创建链路；普通会话保留已有模型 fallback。

`session/new` 接受 `_meta['ai.agnes.harness'].systemPromptAppend`（SDK：`client.session.new({ cwd, systemPromptAppend })`），即只给这一个新会话的系统提示词追加所有者文本。长度 1 到 8192 个字符，不能含 NUL，只追加不替换：它被并入收尾指令 `personaSuffix`（原有内容、一个空行、再接追加内容），因此出现在 `session/start` 行的 `systemPrompt.config` 与 hash 中，随 resume 和 fork 保留，不新增 ledger 事件。以下情况会拒绝（`SEMANTIC_REJECTED`，不创建会话）：与 `agent` 同用、会话已存在、包管理控制面报告配置只读（`E_ADMIN_READ_ONLY`，与 `systemPrompt.save` 同一检查；内嵌 endpoint 没有可锁定的控制面）、部署使用 `fullOverride`、合并后的 `personaSuffix` 超过 8192 个字符。不认识该字段的旧 daemon 会静默忽略，所以需要这段文本的客户端应在发第一条提示前，用新的 `sessionId` 读 `_agnes/v1/systemPrompt.get` 并检查各段。

宿主启动 facade 使用 prepare → review → start(ticket, operationId)。start 只返回会话 ID 和可选的已审阅草稿。草稿编辑后通过普通 submit、使用独立 commandId 提交；重试 start 不发送任何提示词。不确定或失败的 operation 不会重新派发。普通启动没有安装、信任或移除权限；示例管理仍受经依赖版本校验的 `exampleOf` 限制。

审阅同时绑定包身份和已发布的执行配置，原始 row 配置保留在后台；工具摘要来自实际准入能力。启动响应丢失后，Web 保留原 ticket 和 operationId，查询原操作回执。另建会话使用独立操作，并明确提醒可能重复创建。

创建自动化时，`schedules.upsert` 可在请求顶层传 `agent`，后端将其解析为原有 new-session target（loop、bundle refs、preset、model）。保存内容不包含 AgentRef 或 launch。后续运行不再读取 launch，每次按当前可信的 Bundle/Preset 和部署配置准入，再为该次会话 pin；旧 target 保持原样。
