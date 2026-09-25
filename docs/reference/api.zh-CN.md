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

读取完整工具记录时，使用 `_agnes/v1/session.readToolDetail` 按需读取工具调用及其匹配的结果。传入 `sessionId`，并把工具节点的 `seq` 作为 `callSeq`；有 `resultSeq` 时一并传入。可选的 `offset` 和 `maxBytes` 按 UTF-8 字节分页，单次响应最多 262,144 字节。响应包含 base64 编码的 `data`、`totalBytes` 和 `nextOffset`（最后一块为 `null`）。先解码并拼接各块，再解析 `{call, result?}` JSON。daemon 读取事件前会校验会话访问权限。SDK 的 `Session.readToolDetail(callSeq, resultSeq?)` 最多组装 64 MiB；更大的记录可直接对 RPC 分页。常规 UI 投影仍使用长度受限的预览，工具节点新增可选 `resultSeq`。

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
