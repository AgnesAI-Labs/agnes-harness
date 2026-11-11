# AGH 渠道桥接入开发手册

[English](channel-bridge-integration.md) | 简体中文

[作者工具包](README.zh-CN.md) · [渠道插件概览](channel-plugins.zh-CN.md) · [架构与兼容性](../develop/channel-plugins.zh-CN.md)

本手册面向开发飞书、企业微信、微信及其他聊天平台适配器的作者。依据当前工作树的 Extension API **5.11.0**、统一渠道桥和独立钉钉插件接入经验编写。它描述已实现的合同，不代表所有平台、协议或操作系统均已完成真实账号验收。接收方的底座必须包含渠道桥实现，不能只检查版本号。

## 1. 接入目标与职责

交付一个可独立审核、安装、更新、禁用和卸载的插件包。每个平台通常独立一个包，多个企业或机器人由同一提供者下的多个实例表达。

插件负责平台登录/鉴权、事件验签与规范化、附件下载、消息呈现、发送/更新、连接清理与平台级退避。底座负责包信任与能力审核、凭据引用解析、实例生命周期、会话授权与绑定、转发基线、输入去重、出站回执、配置持久化及统一界面。

不要复制通用 runner、SDK 发现、绑定数据库或另一套凭据文件读取器。不要由插件直接创建/选择任意 AGH 会话。普通渠道接入不需要增加平台专用前端页面，也不需要修改 Harness 的渠道白名单。

```text
平台事件 → 插件鉴权/下载/规范化 → ChannelAdapter.toSession
         → 底座目标与绑定校验 → 原生会话准入/附件存储 → 智能体
智能体投影 / AGH 用户新消息 → 底座出站队列 → 插件 send/update → 平台
```

## 2. 先确认平台接入条件

1. 使用平台正式支持的机器人或应用协议，确认机器人能收哪些消息、支持哪些会话类型，以及是否必须被 @。同名平台的群聊与机器人私聊能力可能不同。
2. 确认登录凭据、应用发布状态、机器人权限、事件订阅、企业授权范围及媒体下载权限。Webhook 模式还需验签、防重放、监听地址和部署方案。
3. 先实现纯文本收发，再逐项启用图片、文件、音视频、线程、编辑、卡片或目录。平台允许下载不代表模型支持直接理解该媒体。
4. 每个平台实现自己的回调解析；不要照搬钉钉的字段名、下载码接口或应用凭据映射。不要假设存在自动可用的微信官方机器人协议。

## 3. 目录和公开依赖

建议目录：

```text
channel-example/
  package.json
  src/index.ts
  src/adapter.ts
  src/gateway.ts
  src/events.ts
  src/channel-manifest.json
  assets/icon.png
  build.mjs
  scripts/write-manifest.mjs
  test/
  README.md
  LICENSE
  NOTICE
```

使用与目标 Harness 匹配的作者 SDK；当前源码预览环境的准备方式见[快速上手](quickstart.zh-CN.md)。不要假设 npm 上存在可直接安装的最新公开 SDK。开发依赖可链接源码，分发包必须依赖公开出口与宿主提供的运行合同，不能包含机器专属 SDK 路径。

渠道合同统一从 `@agnes/plugin-runtime/channel-contract` 导入。通用作者类型和 `managedServiceCapabilities` 从 `@agnes/plugin-runtime` 导入；消息内容类型可从 `@agnes/protocol` 导入。不要导入 `@agnes/channels/src/...` 或私有 Host 模块。

## 4. 定义渠道清单

下面是 `src/channel-manifest.json` 的最小纯文本起点：

```json
{
  "id": "example-chat",
  "displayName": "Example Chat",
  "version": "0.1.0",
  "connection": {
    "modes": [
      "stream"
    ],
    "default": "stream"
  },
  "capabilities": {
    "edit": false,
    "card": false,
    "thread": false,
    "attachment": false,
    "reactions": false,
    "typing": false,
    "voice": false
  },
  "credentials": {
    "required": [
      "clientId",
      "clientSecret"
    ],
    "optional": [],
    "exposes": []
  },
  "limits": {
    "textChars": 12000,
    "cardBytes": 65536,
    "editWindowMs": 0,
    "rate": {
      "perChatPerMin": 20,
      "perAccountPerSec": 10
    }
  },
  "events": {
    "supported": [
      "message"
    ]
  }
}
```

三个 ID 要分清：npm 包名用于分发，插件条目 `id` 用于安装身份，`provider.id`/`manifest.id` 用于渠道类型。不要把机器人账号或实例标识写进渠道类型 ID。`provider.id` 必须与 `manifest.id` 相同。

清单 schema 禁止额外字段；`connection.default` 必须属于 `modes`；凭据 required/optional 不得重叠。只有支持卡片时才能声明 `cardAction`。`credentials.exposes` 是身份 `raw` 字段的白名单，不是密钥列表。

底座会冻结登记时的清单，adapter 必须使用同一份内容；`capabilities()` 不能超过声明上限。可按实例关闭卡片/编辑等可选能力，不可运行中扩大能力。所有清单字段以[协议 schema](../../packages/protocol/schema/channel.json)为准。


### 渠道名称的中英文显示

从 Extension API 5.11.0 起，在渠道 manifest 中保留默认名称，并可提供翻译：

```json
{
  "id": "example-im",
  "displayName": "示例渠道",
  "displayNames": { "en": "Example IM", "zh-CN": "示例渠道" }
}
```

`displayNames` 为可选对象，当前支持 `en`、`zh-CN` 两个可选键。每个名称须包含非空白字符，长度为 1–64 个字符；不支持其他键。声明此字段的插件应使用 `apiRange: "^5.11.0"`。

底座根据当前界面语言选取对应名称；缺少当前语言时回退到 `displayName`，再回退到 `id`，不会自动选择另一语言。渠道总览、筛选项、绑定弹窗与会话渠道状态按钮共用该规则，切换语言后同步更新。旧插件无需修改。

名称仅用于显示，禁止按界面语言改变 `provider.id`、`manifest.id`、实例标识、凭据引用或已保存的绑定。provider 与 adapter 应继续使用同一份 manifest。钉钉可声明 `{ "en": "DingTalk", "zh-CN": "钉钉" }`，飞书可声明 `{ "en": "Feishu", "zh-CN": "飞书" }`。

## 5. 注册提供者

`src/index.ts` 示例；`createExampleAdapter` 由作者在下一节实现：

```ts
import type { PluginContextFacets } from '@agnes/plugin-runtime'
import type { ChannelConfiguration, ChannelProvider } from '@agnes/plugin-runtime/channel-contract'
import manifestJson from './channel-manifest.json' with { type: 'json' }
import { createExampleAdapter } from './adapter.js'

export const provider: ChannelProvider = {
  id: 'example-chat',
  version: '0.1.0',
  manifest: manifestJson as ChannelProvider['manifest'],
  configSchema: {
    type: 'object', additionalProperties: false,
    properties: { region: { type: 'string', title: '服务区域 / Region', enum: ['global', 'cn'] } },
  },
  create({ config }) {
    return createExampleAdapter({ manifest: this.manifest, config })
  },
}

export const main = {
  inject: ['profileRuntime', 'services', 'providers'],
  apply(ctx: Pick<PluginContextFacets, 'profileRuntime'>, config: Partial<ChannelConfiguration> = {}) {
    if (!ctx.profileRuntime.registerChannel) throw new Error('Channel bridge unavailable')
    ctx.profileRuntime.registerChannel(provider, { instances: config.instances ?? [] })
  },
}
```

`configSchema` 只表达非敏感平台参数，保存前仍须由工厂验证枚举、类型和额外字段。缺少必填参数要明确报错，不要悄悄采用另一企业或另一环境。密钥不能放进此对象。

调用 `registerChannel` 即可同时登记目录和受管资源；不要再自行注册一遍 `channelKind`。只调用 `providers.register` 不能建立完整的受管连接与绑定流程。实例初值用空数组，安装后不会自动连接平台账号。

## 6. 生成完整包声明

将以下内容保存为 `scripts/write-manifest.mjs`，在插件根目录运行。它从匹配版本的公开 API 生成服务声明，不要手写复制过期的服务 schema。开发时可由 tsx 执行此脚本；宿主提供的 SDK 只在开发环境准备，不由安装包重复分发。

```js
import { readFile, writeFile } from 'node:fs/promises'
import { managedServiceCapabilities } from '@agnes/plugin-runtime'
import { CHANNEL_CONFIG_SCHEMA, channelServiceCapabilities } from '@agnes/plugin-runtime/channel-contract'

const pkg = JSON.parse(await readFile('package.json', 'utf8'))
pkg.name = '@your-org/channel-example'
pkg.version = '0.1.0'
pkg.type = 'module'
pkg.engines = { node: '>=24.10' }
pkg.exports = './dist/index.mjs'
pkg.files = ['dist', 'assets', 'README.md', 'LICENSE', 'NOTICE']
pkg.agnes = {
  hostProvidedExternals: {
    '@agnes/plugin-runtime/channel-contract': '0.0.0',
    '@agnes/protocol': '0.0.0',
  },
  provides: ['service'],
  metadata: { displayName: 'Example Chat', summary: 'Independent Example Chat channel' },
  plugins: [{
    id: 'ext:your-org.channel-example', export: 'main', apiRange: '^5.11.0',
    runtime: 'in-process', default: true,
    inject: ['profileRuntime', 'services', 'providers'],
    configSchema: CHANNEL_CONFIG_SCHEMA, config: { instances: [] }, configReload: 'live',
    capabilities: {
      network: ['api.example.invalid', 'stream.example.invalid', 'media.example.invalid'],
      secrets: ['secret://example-chat/*'], store: true,
      managedServices: [{
        id: 'channel', scope: 'profile', artifact: { kind: 'in-process' },
        listeners: [], healthPath: '/health', startupTimeoutMs: 30000,
        shutdownTimeoutMs: 5000, apiVersion: '1.0.0', requires: [],
      }],
      services: [
        ...managedServiceCapabilities('channel', CHANNEL_CONFIG_SCHEMA),
        ...channelServiceCapabilities(),
      ],
    },
  }],
}
await writeFile('package.json', JSON.stringify(pkg, null, 2) + '\n')
```

把 `.invalid` 域名替换成实际 API、长连接、媒体 CDN 主机范围；`network` 使用主机名或已审核通配符，不是完整 URL。`secrets` 范围必须覆盖用户实际选择的凭据命名空间。不要为省事默认要求全部网络或全部密钥。

生成的 profile 服务包括 `channel.status/configuration/check/retry/reconcile/configure`；session 服务包括 `channel.session/bind/unbind`。两组声明都要保留。前者管资源及原生配置审批，后者管当前会话绑定。`requiresApproval: never` 不表示绕过授权，绑定仍校验当前会话、工作区、聊天目标、版本和插件身份。

`managedServices.listeners: []` 是主动连接型适配器的示例；`healthPath` 只是受管声明的一部分，不要求插件另开一个 HTTP 健康端口。需要入站监听的 Webhook 应按[受管传输](transports.zh-CN.md)声明监听与生命周期，不能把示例的 stream 清单直接当作 Webhook 部署方案。

插件以用户权限执行；能力声明用于准入审核，并非任意 JavaScript 的强制网络沙箱。作者仍须在代码里实施 URL、身份、范围与输入校验。

## 7. 实现 ChannelAdapter

工厂每次 `create` 返回独立 adapter，不能跨实例共享凭据、socket、机器人身份或聊天目标。完整签名见[公开渠道合同](../../packages/extension-api/src/channel-contract.ts)。必须实现：

- `manifest`、`capabilities()`：固定合同与当前实例能力。
- `connect(options)`：使用后端给出的凭据连接，设置回调；连接建立后返回，不要等到整个长连接结束才返回。订阅使用 `options.signal`。
- `disconnect()`：可重复调用；释放 socket、监听、定时器、下载任务和排队请求，旧连接回调不得污染新连接。
- `toSession(event, context)`：把消息转为入站意图；非业务消息返回 `null`。纯附件消息不应仅因没有文字就丢弃。
- `resolveScope(event)`：返回平台聊天作用域与是否私聊，不得用它替代后端授权。
- `credentialOf(event)`：从已认证事件生成 `kind: 'channel'` 身份，包括 channel、accountId、userId、chatId、chatType；只带必要的 raw 字段。
- `render(node, context)`：把需要呈现的投影变成 `ChannelMessage`；不支持的节点返回 `null`。不要重复转发所有 user 节点，底座负责用户消息标记与防回环。
- `send(target, message)`：成功后返回真实平台 `MessageRef`；不能未发出就返回一个伪造成功回执。
- `update(reference, message)`：仅在声明支持编辑时使用；不支持则明确拒绝，不要偷偷发送重复新消息。
- `renderApproval`、`onApprovalAction`：接口必须存在；不支持交互时可呈现普通说明并返回 `null`。不要把用户输入“同意”直接变成任意原生审批授权。当前绑定流程的原生审批留在 AGH。

`attention`、`react`、`onSlotAction`、`syncDirectory` 为可选扩展。一般先不实现 `attention`，让底座按 `allowFrom`、`requireMention` 处理；自定义时必须保留同等的身份与提及规则。

## 8. 规范化事件与会话路由

在平台 SDK 或验签通过后再调用 `options.onEvent`。校验 eventId、messageId、accountId、稳定 userId、chatId、时间、聊天类型和提及标志。`senderNick` 不能作为授权用户 ID。重复投递保留相同事件/消息 ID，不要每次生成随机 ID。

以下是纯文本 `toSession` 的起点，不是附件实现：

```ts
import type { ChannelAdapter, ChannelEvent, InboundIntent } from '@agnes/plugin-runtime/channel-contract'
import { sessionKeyFor } from '@agnes/plugin-runtime/channel-contract'

export function toSession(
  adapter: ChannelAdapter,
  event: ChannelEvent,
  context: { tenant: string; agent: string },
): InboundIntent | null {
  if (event.kind !== 'message' || !event.text.trim()) return null
  return {
    sessionKey: sessionKeyFor({ ...context, channel: adapter.manifest.id, chat: event.chat }),
    credential: adapter.credentialOf(event),
    eventId: event.eventId,
    messageId: event.messageId,
    content: [{ type: 'text', text: event.text }],
    kind: 'message',
  }
}
```

使用底座传入的 tenant/agent 和公开 `sessionKeyFor`，不要自行填固定租户或读取 daemon 发现信息。helper 拒绝空或含 `:` 的段；若平台原始 ID 含分隔符，可对身份段做稳定、无冲突的编码，发回平台时仍使用原始目标 ID，不能用有碰撞的字符串替换。

`ChatRef.type: 'thread'` 必须带 threadId，并正确声明线程能力。`mentions.bot` 必须来自平台真实提及信息，不要只靠文字中出现 `@机器人`。

只把已经验证、规范化的消息交给底座。平台回调的 `content` 可能是对象或 JSON 字符串，图文混排可能是数组，媒体下载码与文件名可能不在同一层。用有限长度解析及真实平台样本测试，不要把字符串当对象读取后误报“缺下载码”。

私聊还可以配对给插件的托管服务（[让插件服务接收渠道私聊](channel-targets.zh-CN.md)）。渠道桥和绑定一样，用你的 `toSession` 返回的会话键识别私聊，并通过你的 `send` 回复；只要把私聊上报为 `chat.type: 'dm'` 并带上发送者稳定的用户 id，适配器就无需其他改动。

## 9. 附件必须把真实内容交给底座

推荐流程：验证平台事件 → 提取下载码/媒体标识 → 插件调用平台接口获取临时链接 → 插件校验并下载 → 在 `toSession` 中转换为 `ContentBlock`。底座不会替插件解析下载码，也不会自动抓取任意 `Attachment.url`。

```ts
import type { ContentBlock } from '@agnes/protocol'

// bytes must already be downloaded and bounded by the platform adapter.
export function fileContent(name: string, mimeType: string, bytes: Uint8Array): ContentBlock {
  return { type: 'file', name, mimeType, data: Buffer.from(bytes).toString('base64') }
}
export function pngContent(bytes: Uint8Array): ContentBlock {
  return { type: 'image', mimeType: 'image/png', data: Buffer.from(bytes).toString('base64') }
}
```

在 `toSession` 中把这些块放进 `intent.content`，与文字一并提交。只有完成下载并确认内容格式时才使用图片块；示例 `pngContent` 只适用于真实 PNG。JPEG 使用 `image/jpeg`；其他图片格式、音视频和文档可作为 `file` 保存。文件名要去路径、控制字符并限长，MIME 要去掉 HTTP 参数并校验，不能把服务端错误页当图片。

不能只提交 `attachment://sha256` 或自己拼 `artifact://sha256`：哈希不等于文件已经入库，也不等于有访问权限。不要直接写入 Harness 产物目录或把临时下载 URL 当长期附件。底座原生准入负责保存、回执授权、会话归属与后续读取。

按文件、单消息总字节、附件数量、像素及超时分别设置上限；钉钉插件当前采用单消息下载合计 20 MiB、最多 50 个附件，这是适配器策略，不是所有平台的统一承诺。部分下载失败时保留成功文件并明确提示失败项。错误只显示固定类别和数值状态码，不显示 token、下载码、签名查询参数或原始后端响应。

下载临时链接要校验协议、凭据字段、域名及 DNS 的所有地址。不得访问 loopback、内网、链路本地或保留地址；请求应固定已校验的 DNS 结果。禁止自动跟随未经逐跳校验的重定向，也不能把平台 access token 带往 CDN。若支持 HTTP 地址，先升级为 HTTPS 并重新校验，全程不要明文下载。DNS 失败应与不允许的地址分别诊断；不要以关闭地址校验来修复代理 DNS 问题。

当前桥在原生图片准入明确返回数据、MIME 或像素拒绝时，可降级为普通文件并附带说明；未知结果、授权、配额与存储失败不触发这种重试。降级成功不等于图片已作为视觉输入识别。当前 inline 图片路径存在缩放前约 212 万像素校验，较大截图可能降级；不要把这段实现限制写成平台图片规格，也不要承诺一定展示缩略图。图片识别还取决于模型声明、格式及图片处理能力。

## 10. 出站、回执与防回环

底座只同步显式绑定之后的新消息。平台用户入站不回送平台；AGH 用户新文本按“来自 AGH 的用户消息”标记，智能体回复由同一队列发送。当前 AGH 用户附件出站只是“在 AGH 中查看”提示，不是自动上传附件到所有平台。

`ChatTarget.deliveryKey` 是稳定投递标识；平台有幂等键时应映射使用。返回的 `MessageRef` 要足以定位真实消息，支持时保存 cardBizId。操作已成功但响应丢失时，不要盲目再发一条；按平台查询/幂等能力确认，无法确认就保持不确定状态。

处理平台文本长度、Markdown 差异、频率限制、消息拆分和编辑窗口。不能声明 edit/card 后再把所有 update 当 send。卡片与按钮回调要校验真实操作者、请求标识和时效；历史卡片不应决定当前会话的审批。

## 11. 配置、连接与绑定的完整用户流程

1. 用户检查、信任、启用插件后，渠道总览和会话弹窗动态出现新渠道。不需要写死平台列表。
2. 先创建一个真实会话；草稿需发送第一条消息。会话中点“渠道绑定”，选渠道。
3. 后端从会话派生实例标识、工作区与智能体。插件只收平台凭据和非敏感参数，不要求用户手填这些会话事实。
4. 凭据选择的是保存的 `secret://` 引用；后端按清单凭据名与审核范围解析。若凭据保存到 generic 命名空间，包声明也必须明确覆盖该实际范围。
5. 保存配置并完成原生审批；向平台机器人发一条消息，确认聊天目标。群聊通常还需 @。
6. 刷新并显式确认目标后绑定；目标必须与该实例及授权工作区相符。绑定前的历史不补发。
7. 会话入口显示实际渠道状态；点击编辑该连接。总览按渠道、实例展示会话名称和目标，支持解绑或换绑。

配置保存不代表连接成功，连接成功不代表已绑定。重连后目标需重新收到可信消息确认；待核对状态应通过原生恢复/解绑处理，不由插件擅自改绑定。卸载成功会清理当前 profile 的渠道实例覆盖配置、目标和绑定；凭据与会话历史保留。禁用、重启、更新保留配置。其他命名空间、其他 profile 或平台侧应用状态不是插件卸载的自动清理范围。

## 12. 图标与统一界面

`manifest.icon` 可选，使用包内图片构建出的 PNG/JPEG base64 数据 URL；不要设置远程图片 URL。完整字符串最多 32768 字符，解码最多 24 KiB、总像素最多 1048576，建议方形 512×512 或更小。未提供、无效或加载失败时显示默认渠道图标。

构建时将图标写入 provider 与 adapter 的同一份 manifest；只给其中一份加字段会触发清单不一致。保留图片来源和许可证/品牌归属；不要假设插件代码许可证也覆盖商标图标。

统一界面由提供者目录、凭据声明、configSchema 和后端绑定状态驱动。schema 的 title/description 应帮助用户理解参数；参数只在特定功能启用时必需，就不要无条件标为 required。不要暴露 access token 或把服务端实现字段塞进用户配置流程。

## 13. 生命周期与平台隔离

每实例独立状态；认证变更后清空缓存 token、学习到的机器人身份及旧目标，旧连接回调要通过 epoch/实例代际检查。中止时先停止接收，再等待正在进行的处理，关闭资源。超时或关闭结果未知时由受管恢复流程接管，不要直接宣称退出成功。

长连接需考虑断网、休眠、系统唤醒、重连退避及服务器限流。Webhook 需验证时间戳/签名并支持重复投递；原始下载码和签名 URL 不应进入持久日志。每个平台自己实现协议差异，不能与另一个实例共享全局 socket 或账号缓存。

路径用 Node path/URL API，不写 Windows 盘符。纯 JS 插件通常可共用 tgz；包含原生依赖时必须按目标平台交付。Harness 自身包含平台运行时，Windows local 构建不能直接复制给 Mac 使用。当前改造已在 Windows 验证，macOS 接入仍须实机验收。

## 14. 构建、打包和安装

打包示例 `build.mjs`：

```js
import { build } from 'esbuild'
await build({
  entryPoints: ['src/index.ts'], outfile: 'dist/index.mjs',
  bundle: true, platform: 'node', format: 'esm', target: 'node24',
  external: ['@agnes/plugin-runtime/channel-contract', '@agnes/protocol'],
})
```

这只是纯 ESM 构建起点。若平台依赖仍有动态 CommonJS require，需提供适当 createRequire 兼容或保持该依赖的正确模块边界，并验证打包产物。使用运行时读入的 JSON/资源必须显式复制到 dist；静态 JSON 导入可被 bundler 内联。Node 内置模块由运行环境提供。

把 `@agnes/plugin-runtime/channel-contract` 与 `@agnes/protocol` 保持 external，并在 hostProvidedExternals 声明；不要把另一份 kind token 或通用 runner 打进 bundle。如果运行时代码还导入其他 SDK 出口，也要按实际用法保持对应 external 与宿主映射，不要只复制示例数组。

```sh
npm run typecheck
npm test
npm run build
npm pack --dry-run
npm pack
```

在 package.json 中为这些脚本配置实际执行器并锁定依赖。上面的命令在独立插件目录执行；修改本仓库时使用仓库固定入口 `mise exec -- node tools/toolchain/run.mjs ...`，记录实际 Node 版本。

检查 tgz 包含 dist、必要图片/JSON 和许可证，不含 node_modules、备份、SDK 链接、机器路径、凭据、实例配置和会话记录。把 tgz 交给对方，在 AGH“插件 → 从来源安装”选择本地文件、审阅、启用并配置自己的凭据。更新能力声明后重新审阅。分发包可移植不表示宿主运行时可跨操作系统复制。

## 15. 验收门槛

至少覆盖下列可观察行为；优先扩展现有测试，不以内部调用次数代替合同验证。

1. 清单/包声明：schema、提供者 ID、能力上限、服务声明齐全；缺网络/凭据范围或清单不一致时拒绝。
2. 连接：两实例不同企业隔离；认证更新、禁用、卸载和启动中取消后，旧回调不再生效。
3. 入站：私聊、群 @、无 @、陌生用户、线程、重复消息、畸形回调，以及对象/字符串 content。
4. 附件：真实 PNG/JPEG、文档、音视频、图文混排；原件保存后逐字节读回；拒绝伪造产物引用；缺码、过期、权限失败、超限、DNS 失败、非公网地址、部分成功均有明确结果。
5. 出站：AGH 文本和智能体回复均同步；平台入站无回环；未知发送结果、重启恢复和编辑失败不会伪造成功或无限重复发送。
6. 原生流程：配置审批、目标确认、绑定基线、工作区不匹配拒绝、解绑/换绑、重连确认、卸载重装为空。
7. 界面：至少两个不同渠道、每渠道多个实例；新增插件动态出现；正确会话标题、状态、编辑入口、默认/自定义图标、窄屏和深色主题。
8. 真实平台：平台后台发布、权限、企业范围、实际 CDN、休眠重连、限流均实测。假网关通过不能替代真实账号验收；单次公开文件 HTTPS 下载也不能证明平台授权下载已通过。

## 16. 常见故障排查

- 看不到渠道：检查是否信任并启用、Host 是否装配桥、是否使用 registerChannel、必需注入/受管声明及配置 schema 是否通过。
- 只能配置不能绑定：检查三个 session 服务声明、真实会话、当前插件状态及工作区授权。
- 已连接但无目标：检查真实事件是否到达、稳定身份、allowFrom、群提及以及 toSession 是否返回了意图；状态应区分“连接”与“绑定”。
- 文本能收附件不见：依次查媒体字段/字符串解析、下载码、平台权限、临时链接校验、真实 bytes、ContentBlock 转换、原生附件准入和 UI。不要只检查 capabilities.attachment。
- 看到图片降级说明：原件已按文件保存，视觉输入被拒绝；与下载失败是不同阶段。检查具体拒绝码、像素、格式和模型能力，不要仅凭助手复述旧错误下结论。
- HTTP 400/403：先区分取 token、换下载链接还是下载文件失败；核对平台文档、机器人身份和权限，不在用户提示中输出原始错误响应。
- DNS_FAILED / NON_PUBLIC_ADDRESS：区分解析失败与实际指向内网/保留 IP；检查本机代理 DNS。不要关闭公网校验或伪造解析结果。
- 下载成功仍无法读取：检查是否提交了真实 file/image 块，以及是否通过原生存储；仅有 URI 或哈希不够。
- 装到 Mac 不能运行：先确认 macOS 宿主构建、API/桥版本和原生依赖，再排查实例路径；tgz 的 Windows 构建记录不是 Windows 专用的证明。

## 17. 合同与实现索引

- [作者合同与公开 helper](../../packages/extension-api/src/channel.ts)、[适配器完整接口](../../packages/extension-api/src/channel-contract.ts)、[受管服务声明生成](../../packages/extension-api/src/profile-runtime.ts)。
- [协议 schema](../../packages/protocol/schema/channel.json)、[桥接装配](../../packages/channels/src/bridge.ts)、[入站处理](../../packages/channels/src/runner/inbound.ts)。
- [原生附件准入](../../packages/core/src/request/attachment-admission.ts)、[附件读取](../../packages/core/src/request/session-files.ts)。
- [桥接回归](../../packages/channels/test/bridge.test.ts)、[入站回归](../../packages/channels/test/inbound.test.ts)、[原件持久化回归](../../packages/core/test/attachment-admission.test.ts)。

本手册的代码片段是开发起点，平台 gateway、验签、媒体转换与发送实现仍需作者补齐。新渠道应作为独立插件交付，遵守相同公开合同，不把平台协议重新写回底座。
