# API 与 Schema 参考

[English](api.md) | 简体中文

[文档导航](../README.zh-CN.md) · [插件边界](../develop/plugins.zh-CN.md)

为自己的应用接入 AGH 时，先选择与你的运行环境对应的入口，再查方法和 Schema。这里只列可追溯的接口合同；开发第一个插件可以先看[教程](../develop/plugins.zh-CN.md)。

API 随源码演进，`@agnes/*` 目前通过仓库 workspace 解析。使用与源码版本匹配的接口和示例。

## 选择正确入口

| 使用方 | 入口 | 典型操作 |
| --- | --- | --- |
| Node 客户端 | `@agnes/sdk` 的 Node 条件出口 | createClient、session、config、packages、resources、skills、mcp |
| 浏览器宿主 | `@agnes/sdk/browser` | 会话与浏览器允许的协议，未提供 Node 管理能力 |
| 浏览器插件 | 宿主传入的 ClientContext | slots、session、theme、locale、commands、agnes.services |
| 后端 Cordis 插件行 | `@agnes/plugin-runtime` / Cordis Context | Config、inject/provide、effect、ctx.extension、ctx.skills、已验证行上的 ctx.services/slots/projections/resources |
| 受限扩展能力 | `@agnes/extension-api` 的 PluginExtensionAPI | 工具、`on` 观察 hook、`registerHook` 全类 hook 与事件；服务等贡献走行上的 Cordis 入口 |

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

新会话为 `client.session.new({ cwd, preset?, sessionKey? })`，恢复用 `client.session.load(id, { cwd? })`；执行是 `session.prompt(text)`，取消是 `session.cancel()`。业务使用前按当前服务端要求登记工作区、处理权限请求。关闭 client 是连接清理，不等价于取消后台任务。

从 UI 投影的 `pendingInputs` 读取待执行消息。`session.removeQueued(itemId, { commandId? })` 通过 `_agnes/v1/submit` 的 `removeQueued` 类型删除一条待执行消息，返回已提交的事件序号；`session.sendNow(itemId, { commandId? })` 停止当前轮并优先执行该条排队消息。两者都校验会话所有权；消息已开始执行或已不存在时返回 `QUEUED_INPUT_GONE`。删除保留其他消息，不会启动或停止执行。结果未知时，重试应复用同一个 command ID。

传输支持 Node 的 unix/stdio/ws 等入口，生产连接的认证、命名管道进程身份、TLS/Origin 由部署合同决定。建议用户先从 CLI/Web 入口走自动发现；嵌入者不能跳过握手和服务端身份校验。可运行的连接与包管理示例见[文档 smoke](../../tools/public-docs/smoke.mjs)，其凭据与模型由本地夹具产生。另有[共享本地验收](../../tools/acceptance/shared-local-delivery.test.ts)覆盖分发迁移等流程。复现步骤与检查范围见[验证记录](../maintainers/verification.zh-CN.md)。

## 协议方法分组

| 方法族 | 作用 |
| --- | --- |
| `initialize`、`session/new`、`session/load`、`session/prompt`、`session/cancel` | 握手与基础会话 |
| `session/update`、`session/request_permission` | 服务端通知与审批请求 |
| `_agnes/v1/session.*` | 附加、列表、分叉、投影、模型/预设、follow-up 等扩展 |
| `_agnes/v1/config.*` | 配置摘要、测试、保存、账号；敏感输入不可当普通日志 |
| `_agnes/v1/packages.*` | 包检查、安装、治理、更新与操作查询 |
| resource/skill/MCP 管理方法 | 独立控制面权限和 revision 检查，见资源 method table |
| `_agnes/v1/clientModules.*` | 名册与受限 client relay；不是任意 browser RPC |
| `_agnes/v1/extension.call` | 受授权的扩展服务调用 |

具体方法拼写、方向、params/result、管理权限以[method table](../../packages/protocol/src/methods.ts)、[包管理表](../../packages/protocol/src/package-admin.ts)、[资源管理表](../../packages/protocol/src/resource-control.ts)为准。字段不要从本表简写推导。

读取完整工具记录时，使用 `_agnes/v1/session.readToolDetail` 按需读取工具调用及其匹配的结果。传入 `sessionId`，并把工具节点的 `seq` 作为 `callSeq`；有 `resultSeq` 时一并传入。可选的 `offset` 和 `maxBytes` 按 UTF-8 字节分页，单次响应最多 262,144 字节。响应包含 base64 编码的 `data`、`totalBytes` 和 `nextOffset`（最后一块为 `null`）。先解码并拼接各块，再解析 `{call, result?}` JSON。daemon 读取事件前会校验会话访问权限。RPC 和 SDK 的 `Session.readToolDetail(callSeq, resultSeq?)` 都将完整序列化记录限制在 64 MiB；分页不能读取更大的记录。超限时 RPC 返回 `INVALID_PARAMS`，原因是 `detail-too-large`。常规 UI 投影仍使用长度受限的预览，工具节点新增可选 `resultSeq`。

大的内联附件可能以精简形式到达：base64 数据超过 262,144 个字符的 `image` 或 `file` 块不带 `data`，改带 `dataOmitted: {bytes}`。UI 投影始终使用这种形式。对于由 worker 承载的会话（daemon 的常规方式），实时事件与回放（`session.attach`、`session/load`）也使用它，ACP 回放时把这样的块换成一段文字，写明其 `session-image://` 或 `session-file://` 引用；进程内会话仍下发完整行。要以一行 JSONL 读取一条存储行的完整信封，调用 `_agnes/v1/session.exportRaw`，传入 `sessionId`、该行的 `seq` 和 `offset`（从 0 开始）。每次响应的 `base64` 最多含该行 JSONL 文本（JSON 加换行）的 8 MiB，`nextOffset` 在最后一块为 `null`。解码后依次拼接。daemon 先校验会话属主；不存在的行返回 `INVALID_PARAMS`，原因是 `row-not-found`。会话的完整历史通过完整性校验之前不返回任何分块；校验失败的历史以 `SEMANTIC_REJECTED`、`code: 'E_LEDGER_INTEGRITY'` 拒绝，与 `_agnes/v1/session.verifyHistory` 相同。

要下载用户附件本身，调用 `_agnes/v1/session.attachmentRead`，传入 `sessionId`、消息的 `seq`、`kind`（`image` 或 `file`）、`index`（它在该消息同类块中从 1 起的位置，与 `session-image://<seq>/<index>`、`session-file://<seq>/<index>` 一致）、`offset`（从 0 开始）和 `length`（1 到 1,048,576 字节）。加 `thumbnail: true` 则读取图片的缩略图。只返回会话本身分支里的附件，且只返回附件存储标记为用户附件或缩略图的对象：指向其它存储对象的摘要一律按缺失拒绝。每次响应带 `mimeType`、`totalBytes`（整个附件或缩略图的大小）、最多 `length` 字节的 `base64`，字节来自存储对象时还带它的 `sha256`（旧的内联附件给出首次读取时存储保留的副本的摘要）。从 `offset` 加上解码后的长度继续读，直到达到 `totalBytes`。一个窗口装得下整个对象时会按摘要校验；更大的对象按区间读取、不校验，请用 `sha256` 校验拼接后的字节。daemon 先校验会话属主，并且与 `session.exportRaw` 一样，会话历史校验通过前不返回任何内容。不存在的附件返回 `INVALID_PARAMS`，原因是 `attachment-not-found`；存储的字节丢失或损坏时以 `SEMANTIC_REJECTED` 拒绝，`code` 为 `ATTACHMENT_MISSING` 或 `ATTACHMENT_CORRUPT`。以这种方式读取旧的内联附件不会改动会话记录。

要按引用上传附件，对自己拥有的会话调用 `_agnes/v1/attachment.upload`。`operation: 'limits'` 返回 `{ limits: { maxBytes, chunkBytes, maxConcurrent } }`。`start` 传入客户端选定的 UUID `uploadId`、`name`、`mimeType`、`size`，可选 `purpose: 'thumbnail'`，返回 `{ offset }`（对同一 `uploadId` 再次 `start` 会返回已接收的位置）。`chunk` 在恰好等于该 `offset` 的位置发送最多 1 MiB 的 `data`（base64）和这一块的 `sha256`；重发上一块会返回当前偏移。`status` 返回偏移，`cancel` 丢弃上传，`finish`（可选附带整个对象的 `sha256`）保存对象并返回 `{ offset, attachment }`：文件引用块、带有从图片头读出尺寸的图片引用块，或对缩略图（不超过 256 KiB、每边不超过 320 像素的 JPEG）返回 `{ sha256, bytes, width, height }`，填入图片引用块的 `thumbnail`。返回的块只有上传它的会话能发送。在 ACP `session/prompt` 中，引用以指向 `artifact://<sha256>` 的 `resource_link` 传递，块本身放在 `_meta["ai.agnes.harness"].attachment`。拒绝时返回 `SEMANTIC_REJECTED`，`code` 为 `UPLOAD_INVALID`、`UPLOAD_SIZE_LIMIT`、`UPLOAD_OFFSET`、`UPLOAD_HASH_MISMATCH`、`UPLOAD_INCOMPLETE`、`UPLOAD_CANCELLED`、`UPLOAD_BUSY`、`UPLOAD_EXPIRED`（空闲 30 分钟的上传也是）、`UPLOAD_QUOTA`、`UPLOAD_UNAVAILABLE` 或 `UPLOAD_NOT_IMAGE`。prompt、steer 或 follow-up 中的附件被拒绝时也这样返回，`code` 如 `ATTACHMENT_NOT_AUTHORIZED`、`ATTACHMENT_MISSING` 或 `UPLOAD_QUOTA`，且不会排入任何内容；模型请求放不下的图片（超过 16 MiB，或一条消息合计超过 800 万像素）返回 `ATTACHMENT_IMAGE_TOO_LARGE`，`ATTACHMENT_MISSING` 会在 `name` 中给出是哪个附件。请读取 `code` 而不是 `reason`：上传拒绝的 `reason` 与 code 相同，其它拒绝的 `reason` 是 code 的短横线小写形式。30 分钟没有新分块、或已开启 6 小时的上传会被丢弃；同时开启的上传每会话最多 4 个、每个主体最多 16 个、每个后台最多 64 个，后台同时处理 4 个分块（`UPLOAD_BUSY`，稍候重试）。

写操作通常通过 clientId/commandId、expected revision/integrity 返回持久化 operation receipt，再查询最终状态。不要收到 receipt 就记录效果成功；不要未知结果后换 commandId 重做外部效果。

## Skills 写接口

Node SDK 与服务端提供以下管理接口；调用者必须持有对应控制面权限。

| Node SDK / RPC | 输入与结果 |
| --- | --- |
| `client.skills.remove` / `_agnes/v1/skills.remove` | profile、clientId、commandId、resourceId、expectedRevision；返回 ResourceOperationReceipt |
| `client.skills.prioritySet` / `_agnes/v1/skills.priority.set` | 同上，加 expectedPriority 与 priority（50–500 整数或 null）；返回 ResourceOperationReceipt |

两项均要求 admin authority 和 `resources.skills.write`。`remove` 只接受可删除的 workspace/user 来源；`prioritySet` 拒绝 runtime 来源。Web BFF 分别映射为 `/admin/resources/api/skills/remove` 和 `/admin/resources/api/skills/priority`；这不增加浏览器 SDK 的直接资源管理权限。shell/TUI 也没有同名新增命令。

通过 `client.resources.operation.get({ profile, operationId })` 等待 succeeded/failed，记录错误并检查 actual；删除受理后不能取消。优先级保存不改变信任/启用；删除的目录范围、永久标记和同名接替见[Skills 指南](../guide/skills.zh-CN.md)。权威来源：[Schema](../../packages/protocol/schema/resource-control.json)、[方法/权限表](../../packages/resource-control-contracts/src/resource-control.ts)、[Node facade](../../packages/resource-control-client-node/src/resource-control.ts)。

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
