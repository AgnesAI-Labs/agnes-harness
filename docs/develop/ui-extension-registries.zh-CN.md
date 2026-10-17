# 前端扩展注册表

[English](ui-extension-registries.md) | 简体中文

`@agnes/web-client` 导出平台单例 `settingsSections`、`conversationCards`、`homeEntries`，以及供独立宿主和测试使用的 `UiExtensionRegistry`。这些 API 只负责展示，不选择会话工具、不修改配置、不授予能力。使用宿主提供的 web-client 平台模块，避免打包出另一份注册表单例。

设置区注册 `{ group, id, titleKey, groupTitleKey, icon, order, component }`。ID 以小写字母开头，仅包含小写字母、数字、点和连字符，必须唯一；order 为有限数值。渲染前向现有语言服务注册标题键。icon 指定共享设置图标。component 接收 `{ context }`，包括取词函数、可选会话和资源服务，以及由宿主拥有的不透明 data。

```tsx
import { settingsSections } from '@agnes/web-client'
const dispose = settingsSections.register({
  group: 'example', id: 'example.inspector', order: 52,
  titleKey: 'example.inspector.title', groupTitleKey: 'example.title',
  icon: 'plug', component: Inspector,
})
```

设置弹窗固定列出三页（通用、模型与账户、权限与安全）；「显示高级设置」打开时多出「高级」分组。这个开关默认打开：只有读者在本机浏览器里明确关闭才隐藏，未保存或读不到存储都算打开。`group` 决定设置区出现的位置：`general`、`accounts`、`security` 作为对应页面的一个页签；`advanced` 列在「高级」分组里，只在开关打开时可见；其他取值按设置区自己的标题列在「扩展」下，始终可见。外壳拥有导航、页签键盘操作、布局和 `?settings=<id>` 深链接。内置账户页和通用页通过原生面板生命周期桥接字段 nativePane、navigationId 保留已有 DOM、控制器和皮肤钩子，其余设置区通过同一注册表在弹窗自己的页面宿主里渲染。插件、技能、MCP、自动化、会话搜索和归档不再是设置页；旧的 `?settings=<id>` 链接会打开取代它们的整页或侧栏视图。页面内的高级选项用 `@agnes/web-ui` 的 `SettingsAdvanced`，它跟随同一个开关（`useAdvancedSettings`）。宿主的运行上下文不透明；扩展读取和操作自己的数据应使用已声明的客户端服务。

导航 test id 为 settings-navigation；导航项为 settings-nav-ID（带页签的内置页用其首个设置区的 ID）；页签为 settings-nav-ID-tab，保留 role=tab、aria-selected 和游走焦点。内置控制器 ID 保留，运行页面使用 settings-page-ID。SettingsPage、SettingsCard、Field、共享表单控件和 SettingsState 负责视觉模式。

会话卡片注册 `{ id, order, matches, component }`。matches 接收 `{ kind, data }`；按 order、ID 排序后第一个匹配的注册项负责渲染。匹配函数只检查展示数据，不发请求或执行副作用。组件接收 `{ card, context }`。具体渲染器应排在通用兜底之前。内置问题、计划、交付物、作业、子代理、工作流、目标、日程、插件和工具卡片均通过同一 API 注册。插件插槽归属及资源访问仍经过现有插槽与客户端资源服务。

```tsx
const disposeCard = conversationCards.register({
  id: 'example.result', order: -10,
  matches: (card) => card.kind === 'example-result',
  component: ResultCard,
})
```

使用 ConversationCardLayout 作为卡片表面、SettingsState 作为状态反馈。卡片状态为 ready、loading、empty、error、disabled。沿用稳定 test id 与有意义的 form/article/log 角色；后台任务、子 Agent 与目标卡片保留原 ID。官方问答、交付物列表与工作流/提醒表格使用 [Intelligent UI catalog](intelligent-ui-web.zh-CN.md) 的 surface/form/action ID。

### 首页入口

声明过的 profile 主入口在运行时 generation 等待激活或后台 revision 就绪时保留宿主拥有的加载页。旧模块及其权限立即撤销；ready 名册到达后替换加载页。禁用、移除或失败的贡献仍会失去入口。

`homeEntries` 列出首页侧栏里可以打开的页面。注册项为 `{ id, icon, titleKey, order, component }`，可选 `subtitleKey`（标题旁的次要说明）和 `badge`。选中入口后，`component` 作为整页显示在主区域，替换对话区，侧栏保留。内置的业务 Agent、插件、自动化三个入口也通过这个注册表注册。插件注册的入口无论 `order` 是多少都排在这三个之后，按 `order`、再按 ID 排序；超过三个时折叠成一个「更多」菜单。卸载注册项后入口消失，正在显示的页面回到对话区。

```tsx
import { homeEntries, homeNavigation } from '@agnes/web-client'
const dispose = homeEntries.register({
  id: 'example.board', order: 100, icon: 'activity',
  titleKey: 'example.board.title', component: BoardPage,
})
homeNavigation.open('example.board', { tab: 'week' })
```

`component` 接收 `{ context }`：`context.t` 解析宿主语言键，`context.selection` 是调用 `homeNavigation.open(id, selection)` 时传入的不透明值。`badge` 为 `{ subscribe, getSnapshot }`，返回一个数量，为零时不显示。`icon` 指定共享图标，未知名称退回插件图标。`homeNavigation.close()` 回到对话区；`subscribe`、`getSnapshot` 给出当前请求的 `{ id, selection }`。宿主把请求写进地址 `?page=<id>`，selection 为 `{ tab: string }` 时再加 `&tab=<name>`，因此链接会在入口注册后打开对应页面。页面和页签切换会写入浏览器历史；前进与后退恢复请求的页面，同时保留地址中的会话和工作区参数。替换注册项会重新开始组件生命周期，即使 ID 和组件函数相同。入口只负责导航，不授予能力，也不选择会话工具。侧栏使用 `data-testid="home-entries"` 和 `home-entry-<id>`；用宿主页面框架搭的页面使用 `home-page-<id>`。

register 返回幂等且绑定该注册项身份的卸载函数，须绑定到客户端模块的 effect 或销毁作用域。旧卸载函数不会删除后来使用同一 ID 的注册项。subscribe、getSnapshot 支持响应式宿主；entries 返回排序后的注册项；get 按 ID 查询。选中的设置分类卸载后回到第一个内置分类；首页入口卸载后显示对话区。UI 注册项必须与已安装客户端模块的生命周期一致。

会话工具组和 session-info 数据结构属于后台。SessionToolsPanel 独立渲染 SessionCapabilitySet 的启用状态和 source/rule 来源说明，并兼容可选的旧 toolGroups；注册表不规范化、扩展或保存此数据。配置页面可通过下方链接的 schema UI API 声明后注册；保存和测试适配器不改变后台权限。

配置页面声明与 shared forms 见 [schema 配置 UI](../extend/configuration-ui.zh-CN.md)。设置 context 的翻译器可解析已注册的扩展目录键。

设置项可声明 `runtimeCatalog: false`，由自身服务提供刷新、加载和错误状态，不读取插件目录；标题与导航仍由统一 shell 管理。

[会话工作台面板](../extend/workbench-panels.zh-CN.md)介绍右侧和底部停靠面板的注册方式。

### 按需工作台面板

`WorkbenchPanel.visibility` 缺省为 `always`。依赖会话内容的面板可选择 `contextual`，并以仅用于呈现的 `when(context)` 判断是否显示。`icon` 指定共享图标名；可选的 `title(context)` 提供内容标题。这些字段不改变授权。内置面板使用右侧工作台；`bottom` 仍可供插件使用。

## Profile 首页入口与随包示例

已安装模块通过 `ctx.homeEntries.register` 注册首页入口，同时在 `client.homeEntries` 声明相同条目，并设置 `client.lifetime: "profile"`。每个声明包含 `id` 和 `placement: "primary" | "secondary"`。内置页面同样显式声明 primary。primary 始终留在侧栏；secondary 超过三个时一起进入“更多”。组内按 order、ID 排序。重复 ID、超过 64 个入口或 32 个 primary 会拒绝新注册，保留已接纳条目。省略 placement 时仍为 secondary。

daemon 名册提供 `binding`，包含 owner、包、integrity、profile、activation、lifetime 和 availability；`ctx.availability` 提供只读快照和订阅。profile 模块始终跟随当前启用状态，不随选中会话切换版本；session 模块保留固定的历史呈现。禁用在异步清理前撤销全局注册，已记录的会话内容仍可读。availability 只用于呈现，后端继续独立授权每个操作。应将 profile 页面与 session 历史渲染器拆成两个 client 贡献。受管理服务的健康状态与静态页面可用性分开。

随包示例的 metadata 声明 `category: "example"`、指向宿主包的 `exampleOf`、可选 `pageEntry`，以及最多 32 个 `launches`。每项包含 `id`、`kind: "business-agent"`、`title`、`bundle`、`preset` 和最多 16 KiB 的 `prompt`，并显式声明父包依赖。此类包仅在所属插件的示例页面管理，不进入普通插件列表或业务 Agent 目录。启用前检查所属插件的安装、信任、启用状态及依赖版本兼容性；停用所属插件后，示例的启动入口不可用。发现关系不授予任何服务访问权限。

profile 模块使用 `ctx.profile.examples.list/inspect/enable/read/stop/inspectRemove/remove` 和 `ctx.profile.launch.prepare/start/openPage`。inspect 返回五分钟内有效、绑定调用方、activation、内容与能力的 review。enable 通过既有安装、信任和精确启用流程确认这些字节。停止示例后，inspectRemove 创建独立的移除 review；remove 接受该 review ID 和稳定的 operation ID，并保留普通包引用及 pin 检查。启用 review 不能授权移除。launch 选择示例声明的 bundle 和 preset；同一 operation ID 只产生一个会话和一条耐久输入，丢失回执后仍可安全重试。缺少 bundle、preset、依赖，内容变化或 activation 撤销均拒绝执行。未知外部结果通过 read 保留，不自动重发。浏览器接口不接受包来源或任意管理方法。SDK 可通过 `createExampleClient` 和宿主认证 transport 使用相同窄接口。

示例的 profile 模块通过 `ctx.examplePages.register` 注册声明的组件，父模块通过 `ctx.examplePages.render(exampleId, context)` 呈现，并订阅该注册表的快照。组件继续使用自己的模块作用域，不获得父包管理连接。模拟器生命周期应属于 profile 模块的 effect 作用域；切页只分离场景视图。示例禁用或所属浏览器关闭时释放连接并停止工作。会话 tab 复用已有 workbench panel API。

场景资源声明在 `client.assets` 中，相对于与 entry 相同的描述文件目录。支持 glTF/GLB、二进制缓冲、PNG/JPEG/WebP、KTX2 和 WebAssembly。安装拒绝路径穿越和越界符号链接；不可变快照绑定每个文件的哈希和长度，读取时再次校验。代码继续受单文件 4 MiB、合计 16 MiB 限制；场景资源单文件最多 32 MiB、完整快照最多 128 MiB。不支持或超限的资源拒绝发布。解码器执行仍须满足部署 CSP，能够下发 wasm 文件不代表浏览器能够执行。示例应明确展示场景加载失败，不得据此伪报设备已就绪。 启动器的私有资产读取支持相同的 32 MiB 资源上限，并计入 base64 编码开销。本地和 SEA 打包会检查声明的客户端文件、字面量 `new URL(..., import.meta.url)`、CSS URL 及 glTF 缓冲区/图像引用是否存在于交付 payload；优先使用字面量资产 URL，使漏文件在构建时失败。

profile 的 primary 声明可添加 `navigation: { title, titles?, icon, order }`。`titles` 按界面语言提供标签，`title` 为回退值。宿主收到已启用且就绪的名册后即呈现入口，首次打开才加载模块；模块仍通过原有的 `ctx.homeEntries.register`、声明与归属校验接管同一入口。省略元数据时保留立即加载行为。失败或撤销会立即移除入口；元数据不授予权限。

## 替换交付物呈现

生命周期为 `profile` 的客户端模块可调用 `ctx.presentationRoles.register({ role: 'deliverables', priority: 0, mount })`。`mount` 必须返回同步清理函数，撤销它注册的全部 slot、卡片、面板和订阅。角色沿用 single slot 的优先级规则：数值最小者生效，同优先级拒绝注册，先卸下旧提供方再挂载新提供方。默认 `@agnes/deliverables-ui` 使用 100。名册撤权在异步模块清理之前撤销角色；禁用替代插件会恢复默认呈现。角色不授予后台权限。

使用 `@agnes/web-client` 的 `DeliverablesStore(ctx.agnes, ctx.session)`，并随呈现一起 dispose。只读 `DeliverableRecord` 包含 `id`、`sessionId`、`laneId`、来源 owner/调用、可确定时的所属 `turnId`、呈现 `seq`、名称/说明、inline/workbench 位置及现有完整 `ArtifactRef`。同名历史只是展示分组，不证明版本谱系。修改工作区源文件不会改变已交付快照。新交付在现有交付物事件之外持久化工具 `structured` 结果；原有 Intelligent UI 文件列表仍可读取。Intelligent UI 是可选增强：没有渲染器时仍能展示已记录文件的普通列表。

通过 `conversation.chat.turnTail` 注册轮次卡片（owner 为 `{ turn: UITurn, nodes: readonly UINode[] }`），通过 `workbenchPanels` 注册标签，通过 `conversationCards` 的 `artifact-file` 类别渲染文件组件（data 为 `{ file, sessionId, laneId }`）。匹配 `intelligent-ui.surface` 类别、data 为 `UiSurfaceRecord` 的卡片表示由插件接管整个 surface，通用视图面板会让出它。角色 mount 应返回上述全部注销函数，不依赖异步卸载清除标签。打开和下载必须通过 `ctx.resources.documents/files`，携带记录中的 lane 和完整 artifact 引用，不得把源路径当下载 URL。

参见[独立画廊示例](../../examples/community/deliverables-gallery/README.md)。它不导入 Web 宿主代码，展示当前 profile 启用、历史恢复、接管及回退。
