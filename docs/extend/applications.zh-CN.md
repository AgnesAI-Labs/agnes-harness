# 应用

[English](applications.md) | 简体中文

[插件元数据](plugin-metadata.zh-CN.md) · [UI 注册表](../develop/ui-extension-registries.zh-CN.md)

应用提供产品身份、展示默认值和智能体目录。安装、信任或启用应用包只让它成为候选；管理员在
**设置 → 应用**中显式预览、采纳。选择应用不会启用依赖，也不会改变执行 profile、组合哈希、已有会话、
pin、Actor、权限或模型 persona。


目录应用卡片可包含 `applicationAssets.mark`：由包声明资源读取的有界光栅图像，仅用于展示。安装仍重新检查来源，采用以已验证的不可变包和同意摘要为准。图库将角色智能体归入一张应用卡片；“安装并采用”保留安装/信任审阅与明确的应用同意，随后进入声明的主页。


## 用同一个 Acme 示例理解装配

部署执行 Profile → 插件 → 智能体 → 应用展示，各自承担一项职责：

| 层 | Acme 中的对应内容 | 谁决定、何时生效 |
| --- | --- | --- |
| 部署执行 Profile | `AGNES_PROFILE=local-dev`：模型、权限上限、默认 Loop 与运行服务 | 部署者配置执行环境；应用采纳不修改它 |
| 插件 | `@acme/operations`：工具 `acme_status`、页面、`desk` Bundle 和应用声明 | 安装、审阅信任并启用后提供候选能力 |
| 智能体 | `@acme/operations#desk`：自身的 `launch.preset=acme`、工具范围和可编辑提示草稿 | 启动审阅绑定最终运行方式、模型、权限及来源；启动后会话保留其执行绑定 |
| 应用展示 | `acme-operations`：Acme 品牌、Ava 助手名、`@acme/operations#acme-overview` 页面、隐藏自动化入口和默认／可见智能体 | 管理员在设置 → 应用预览并显式采纳；只选择展示默认值 |

本期**不分发或采纳执行 Profile 模板**。应用不是执行模板；部署者继续独立配置 Profile，切换展示不会重配已有会话。完整安装、预览与启动命令见 [Acme 参考应用](../../examples/acme/README.zh-CN.md)。

## 应用声明

```json
{
  "application": {
    "id": "acme-operations",
    "brand": {
      "name": {
        "en": "Acme",
        "zh-CN": "Acme"
      },
      "title": {
        "en": "Acme Operations",
        "zh-CN": "Acme 运营台"
      },
      "assistantName": {
        "en": "Ava",
        "zh-CN": "艾娃"
      },
      "mark": "assets/mark.png",
      "favicon": "assets/favicon.png"
    },
    "presentation": {
      "home": "@acme/operations#acme-overview",
      "navigation": {
        "entries": [
          "@acme/operations#acme-overview"
        ],
        "hideBuiltin": [
          "automation"
        ]
      }
    },
    "defaultAgent": "@acme/operations#desk",
    "agents": [
      "@acme/operations#desk"
    ]
  }
}
```

以上是 `package.json` 的 `agnes.application` 值；除 `id` 外均可省略。品牌文字复用
`{en, "zh-CN"?}` 本地化合同；`favicon` 与 `mark` 使用相同资产结构。inspect 从不可变包快照计算长度、MIME 和 SHA-256。
资产只能是包内普通文件，每个最多 128 KiB，长度、SHA-256、扩展名和 raster 签名须一致，支持 PNG、JPEG、
WebP、GIF、ICO；拒绝符号链接、路径穿越、URL 和 SVG。从已核验的安装包读取字节，在浏览器 CSP 下使用有界 blob URL。

主页和导航页面引用采用 `package#page`，由 profile client 静态声明 `homeEntries` 或 `examplePages`。
智能体必须是自身含 `launch` 的 Bundle；皮肤须由当前包声明。跨包目标需要声明依赖并在部署环境复验，
未知引用一律拒绝。

标准接管角色为 `navigation`、`conversation`、`composer`、`goal`、`interaction`、`deliverables`。
目标 client descriptor 必须有显式稳定 `client.id`、`lifetime: "profile"`，以及相应
`presentationRoles: ["navigation"]`。新增可选静态字段使 descriptor 从 16 字段增至 17，manifest 主干仍为 29。
inspect、不可变快照、信任哈希和浏览器 roster 全程保留声明。产品接管先按当前应用或用户显式选择筛选，
再执行 priority 选举；未选应用不能靠低 priority 抢占。普通页面、设置、卡片和 slots 保留原有作用域及语义。

设置中的采用预览使用分组卡片展示应用身份、界面变化、包含的智能体和权限。较长角色列表折叠，相同权限摘要合并。
依赖、实现引用、摘要和完整 JSON 保留在可复制的 **技术详情** 中。**界面实现**的独立预览展示可见部分和当前权限，
依赖差异未知或不适用时在技术详情中明确说明。应用及界面候选收到插件变更通知或返回窗口时刷新，空闲页面不轮询；
读取失败保留上次列表并显示错误，刷新本身不会采用应用或界面选择。

同意预览绑定来源和签名状态、包/版本/完整性、品牌及资产、隐藏入口、主页/皮肤、智能体、角色代码来源、
依赖权限及差异、作用范围和恢复方法。
依赖闭包评审托管插件。已显式声明在 `agnes.hostProvidedExternals` 中且不在托管清单中的导入，
使用代码准入已校验的宿主 ABI，无需另行安装为插件；已托管的包即使同时声明为 external 也始终进入评审。
未声明的缺失依赖仍会使应用与界面角色预览拒绝。
采纳和清除沿用 admin principal、method allowlist 与配置 CAS revision；
预览变化或 revision 过期都会拒绝。品牌变更属于正常包升级，需要重新信任及显式采纳；旧会话保留原执行 pin。
受信 JavaScript 与工作台同环境运行，并非沙箱。

无选择时显示宿主 AGH。安装 B 不会替换已选 A。A 被停用、撤信、移除、更新或资产/引用不可用时，保留选择并标记
**unresolved** 及原因，展示安全回落 AGH，绝不自动选 B。优先级依次是 URL 显式覆盖、用户偏好、应用默认、宿主默认；
清除应用只移除应用默认，保留用户偏好。

宿主侧栏始终保留**应用**（采用应用后为 **返回官方界面** 和 **切换应用**），应用替换导航也不会移除此入口。打开应用设置可查看应用名称、版本和界面变化，或选择**恢复官方界面**。高级界面引用和恢复命令收在折叠的技术详情中。

**`/?admin`** 是独立宿主恢复 bootstrap，在导入应用 JavaScript、CSS、角色和导航之前选择宿主品牌与皮肤。
URL 不授予权限，写操作仍经认证 BFF 与 admin 校验。**`agh app clear [--profile NAME] [--json]`**
在通用 boot 前分派，不加载插件，只清除展示选择。daemon 运行时走在线 CAS；否则使用同一配置锁和 revision 原子写入。

页面引用在浏览器保留并复验包身份；客户端加载失败、尚未就绪或同名冲突不会把其他包的普通页面当作已采纳主页。应用变化会同步撤销其 CSS/token，迟到的 CSS 响应不能重新上色；URL、用户偏好的优先级保持不变。

品牌资产还必须通过真实像素解码：最多 1,048,576 总像素、32 帧，编解码超时两秒；ICO 需使用 PNG 帧，旧 DIB 编码拒绝。浏览器加载或解码失败时回退宿主。配置保存已同意的完整预览及摘要，因此同 ref 升级、卸载旧包后仍比较旧/新传递依赖闭包；旧同意快照无法验证时明确显示“未知”，不声称没有变化。

[Acme 参考应用](../../examples/acme/README.zh-CN.md)提供工具、默认 Loop 智能体、品牌栅格资产、追加页面和可执行的 SDK 预览／采纳命令。


应用可以通过 `delegableAgents` 声明最多 64 个可委派角色。每个引用也必须在 `agents` 中，且对应
可启动的 Bundle。采纳应用后，后端会把这些角色加入该会话的 `subagent_spawn` 说明。
例如 `{"role":"@acme/operations#reviewer","task":"复核证据"}` 会使用角色自己的配方、人格、
工具和技能，创建不含父会话历史的新会话。未采纳应用、未知或不在名单内的角色，以及将 `role`
与 `fork` 或 `model` 同时使用，都会明确报错。

角色子代理在启动时将角色与父会话的工具、MCP、Skill、文件、网络、沙箱及只读权限取交集，
形成统一权限快照。资源捕获与实际读取使用相同的工作区视图；工具须同时匹配定义和执行绑定。
捕获上限为空时拒绝全部，组合选择为空时保留默认。快照由子会话自己的账本恢复，无需父会话存活；
之后父会话的变化不能扩大捕获的上限。需人审批的工具效果等待子会话的裁决，显示在父会话的人类审批卡和 Web **审批**标签中；只有已认证的人可以单次允许或拒绝，没有人类审批界面则拒绝。父会话或祖先停止、关闭会撤回待决请求及授权。业务签署仍拒绝并交回主助手，父会话使用“完全访问”也不例外。委派卡片和完成通知保留后端记录的角色归属，
刷新后仍可查看。普通 spawn 保持原有行为。

## 启动 Acme 的前置条件

在同一 home 和 profile 下，先启动选定 origin 的 Web 服务，再安装应用；或在安装后、启动 Web 前执行 `node agnes.mjs daemon stop`。`plugins add` 本身可能启动 daemon。若其 origin 不匹配，`serve --port 4198` 会拒绝并提示 `local daemon Web origin does not match the selected origin`。停止该 home 的 daemon 后重试同一 `serve` 命令即可；完整命令见 [Acme 部署流程](../../examples/acme/README.zh-CN.md#部署者采用流程)。

通过公开出口构建替代实现：[构建呈现插件](presentations.zh-CN.md)。

## 单独选择界面实现

在 **设置 → 应用 → 高级界面选择** 中，管理员可以分别替换 navigation、conversation、composer、goal、interaction、deliverables 六种标准角色。例如保留应用 A 的品牌和导航，只选择插件 B 的交付物界面；也可以保留默认 AGH 应用，直接选择 B，无需采纳任何应用。

每行显示当前实现、来源（**默认 / 应用 / 你的选择**）、候选和“恢复默认”。候选来自已安装、受信且启用的插件，其 profile client 必须在静态 `presentationRoles` 中声明该角色。作者只需声明角色，无需额外声明应用。

确认前预览来源与签名、包完整性、替换角色与可见部分、client 入口和依赖信任范围、仅影响展示的作用域及恢复方法。这些内容和 client 声明均绑定同意摘要。角色选择复用应用配置的 CAS revision、管理员权限和方法白名单，不改变执行配置或哈希。优先级为：你的选择 → 应用角色 → 宿主默认。“恢复默认”仅移除该角色覆盖，恢复可用的应用实现。

所选插件停用、撤销信任、移除、内容变更或加载失败时，保留选择并标记 unresolved 及原因，回落到应用或宿主实现，不自动选择其他社区候选。代码或声明变更需要重新预览和同意。每次角色挂载时，宿主都会将已保存的同意与实际模块完整性、client 声明和依赖绑定进行比对；旧选择响应不能放行新名册中的内容。缺失或不匹配的绑定保持 unresolved，直到已审阅且身份匹配的实现可用。

`/?admin` 的清除操作和 `agh app clear [--profile NAME] [--json]` **同时清除当前应用与全部界面实现选择**。恢复启动不运行第三方代码，保留执行配置和其他用户偏好。

开发者示例见[五个机制教学包](../../examples/fde/README.zh-CN.md)。已随源码提供的产品演示包括 DevBoard、Pharma 与 Aerospace [showcase 应用](../guide/demos.zh-CN.md)。

## 会话业务工作台

可选的 `application.workbench` 将应用组织为一个业务工作台；未声明的既有应用保持原有界面。
安装审阅和应用采用同意仍然独立。下面以 `acme/kit` 的 profile 页面 `dossier` 为例：

```json
{
  "workbench": {
    "tabs": [
      { "id": "object", "title": { "en": "Current object", "zh-CN": "当前对象" }, "icon": "file", "order": -30, "slot": "workbench.panel", "view": "page", "page": "acme/kit#dossier", "when": "session" },
      { "id": "signatures", "title": { "en": "Pending signatures" }, "order": -20, "slot": "workbench.panel", "view": "signatures" },
      { "id": "evidence", "title": { "en": "Evidence and reports" }, "order": -10, "slot": "workbench.panel", "view": "evidence" }
    ],
    "actions": [
      { "id": "review", "title": { "en": "Review NCR" }, "agent": "acme/kit#reviewer", "prompt": { "en": "Review the selected NCR using its controlled evidence." }, "focusTab": "object", "object": { "type": "ncr", "id": "NCR-018" } }
    ],
    "includes": ["pages", "tools", "signatures", "reports"],
    "scenarios": [{ "en": "Anomaly → investigation → disposition → signature" }]
  }
}
```

- `tabs` 最多 8 项：唯一 `id`、本地化 `title`、可选 `icon`、-100～100 的整数 `order`、固定
  `slot: "workbench.panel"`。`view` 为 `page`、`signatures` 或 `evidence`。只有 `page` 必须且能够
  声明 `page: "包名#页面ID"`，目标必须是已声明且就绪的 profile 页面。`when` 可为 `session`（默认）
  或 `object`。清除或无法解析应用时撤下标签；渲染错误隔离；文件、更改、终端仍可由工作台和溢出菜单访问。
- `actions` 最多 12 项：唯一 `id`、本地化 `title`、`prompt`；可选 `agent` 默认为应用 `defaultAgent`，
  必须是应用允许且可启动的角色。可选 `focusTab` 引用声明标签；`object: {type, id}` 是默认对象。
  点击后若采用同意已覆盖则直接打开对话，否则先显示简短审阅；请求草稿可编辑，不自动发送。角色在启动时路由，不引入委派运行时，也不切换进行中会话的角色。
- 可选 `includes` 声明图库包含项：`pages`、`tools`、`signatures`、`reports`，最多 4 个且不重复，只声明应用确实提供的能力。
- `scenarios` 最多 3 项，在图库显示具体业务场景；角色说明保留在折叠详情中，工作台应用不再逐角色展示启动按钮。
  本地化文本必须有 `en`，可有 `zh-CN`，每种语言最多 2048 字符；其他字段和数组同样受限。

业务页面从 `@agnes/web-client` 导入 `openApplicationWork`，调用
`openApplicationWork('review', {type: 'ncr', id: record.id})`。对象类型最多 64 字符、编号最多 128 字符。
对象以独立、可移除的上下文 chip 显示，输入框只含可编辑的人类提示；提交时才序列化到持久用户内容。
消息记录恢复同样的 chip，重新加载或新浏览器标签页也能恢复。移除待发 chip 后，后续请求不再附加该上下文，
不会修改已经提交的消息或当前档案。
可选的浏览器会话记忆恢复提交前的对象焦点及启动角色归属，不授予权限，
也不充当后端业务记录。

标签页面组件通过 `context.selection.object`、`context.selection.applicationPanel` 接收展示上下文。
从 `apply(ctx)` 闭包取得服务，通过已声明的 profile query 读取业务数据；订阅 `ctx.session.projection`
失效通知和 `ctx.session.readiness` epoch，在工具写入后刷新、丢弃旧读取，并在卸载时退订，不能轮询。
`signatures` 复用宿主当前决定动作，包括独立的 `business.confirm`；完全访问权限处理不把业务签署变成客户端写入。
完全访问下，宿主自动确认符合条件的业务决定并记录方式，不显示待签卡；标准和工作区写入权限保留人工确认。不能把自动确认写成人工点击。
`evidence` 从当前会话工具回执进入既有执行记录和报告文件。业务状态、CAS 和签署证明仍由后端模块负责。

已安装应用的页面仍可通过插件和智能体界面访问；只有已采用应用的页面进入主侧栏，普通非应用插件的导航不受影响。

当后台确认保存的摘要绑定启动计划与当前准入结果完全一致（智能体、来源版本和内容哈希、能力、模型及权限）时，
应用动作复用采用同意，直接打开带对象上下文与可编辑请求的对话，不自动发送。缺少启动计划或采用代次的旧同意快照、
配置变化或不属于已采用目录的启动仍需简短审阅；路由、哈希和导出等技术信息折叠展示。
原有票据期限、调用方与工作区绑定、配置漂移检查和 Host 准入保持生效。每次采用由后台生成独立的
`adoptionGeneration`，与配置 revision 无关。清除会移除当前代次，重新采用相同内容也生成新代次，旧的直接启动票据不恢复；
无关配置变化保留该代次。最后一次异步校验结束后、派发启动前还会复查期限；已完成回执在过期或清除后仍可读取。
派发后撤销采用目前不会取消等待中的会话创建，但不会发送草稿或扩大该会话的权限。
