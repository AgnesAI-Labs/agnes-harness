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

设置弹窗固定列出三页（通用、模型与账户、权限与安全）；读者打开「显示高级设置」后多出「高级」分组。`group` 决定设置区出现的位置：`general`、`accounts`、`security` 作为对应页面的一个页签；`advanced` 列在「高级」分组里，只在开关打开时可见；其他取值按设置区自己的标题列在「扩展」下，始终可见。外壳拥有导航、页签键盘操作、布局和 `?settings=<id>` 深链接。内置账户页和通用页通过原生面板生命周期桥接字段 nativePane、navigationId 保留已有 DOM、控制器和皮肤钩子，其余设置区通过同一注册表在弹窗自己的页面宿主里渲染。插件、技能、MCP、自动化、会话搜索和归档不再是设置页；旧的 `?settings=<id>` 链接会打开取代它们的整页或侧栏视图。页面内的高级选项用 `@agnes/web-ui` 的 `SettingsAdvanced`，它跟随同一个开关（`useAdvancedSettings`）。宿主的运行上下文不透明；扩展读取和操作自己的数据应使用已声明的客户端服务。

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

`homeEntries` 列出首页侧栏里可以打开的页面。注册项为 `{ id, icon, titleKey, order, component }`，可选 `subtitleKey`（标题旁的次要说明）和 `badge`。选中入口后，`component` 作为整页显示在主区域，替换对话区，侧栏保留。内置的业务 Agent、插件、自动化三个入口也通过这个注册表注册。插件注册的入口无论 `order` 是多少都排在这三个之后，按 `order`、再按 ID 排序；超过三个时折叠成一个「更多」菜单。卸载注册项后入口消失，正在显示的页面回到对话区。

```tsx
import { homeEntries, homeNavigation } from '@agnes/web-client'
const dispose = homeEntries.register({
  id: 'example.board', order: 100, icon: 'activity',
  titleKey: 'example.board.title', component: BoardPage,
})
homeNavigation.open('example.board', { tab: 'week' })
```

`component` 接收 `{ context }`：`context.t` 解析宿主语言键，`context.selection` 是调用 `homeNavigation.open(id, selection)` 时传入的不透明值。`badge` 为 `{ subscribe, getSnapshot }`，返回一个数量，为零时不显示。`icon` 指定共享图标，未知名称退回插件图标。`homeNavigation.close()` 回到对话区；`subscribe`、`getSnapshot` 给出当前请求的 `{ id, selection }`。宿主把请求写进地址 `?page=<id>`，selection 为 `{ tab: string }` 时再加 `&tab=<name>`，因此链接会在入口注册后打开对应页面。入口只负责导航，不授予能力，也不选择会话工具。侧栏使用 `data-testid="home-entries"` 和 `home-entry-<id>`；用宿主页面框架搭的页面使用 `home-page-<id>`。

register 返回幂等且绑定该注册项身份的卸载函数，须绑定到客户端模块的 effect 或销毁作用域。旧卸载函数不会删除后来使用同一 ID 的注册项。subscribe、getSnapshot 支持响应式宿主；entries 返回排序后的注册项；get 按 ID 查询。选中页面卸载后回到第一个内置分类。UI 注册项必须与已安装客户端模块的生命周期一致。

会话工具组和 session-info 数据结构属于后台。SessionToolsPanel 独立渲染 SessionCapabilitySet 的启用状态和 source/rule 来源说明，并兼容可选的旧 toolGroups；注册表不规范化、扩展或保存此数据。配置页面可通过下方链接的 schema UI API 声明后注册；保存和测试适配器不改变后台权限。

配置页面声明与 shared forms 见 [schema 配置 UI](../extend/configuration-ui.zh-CN.md)。设置 context 的翻译器可解析已注册的扩展目录键。

设置项可声明 `runtimeCatalog: false`，由自身服务提供刷新、加载和错误状态，不读取插件目录；标题与导航仍由统一 shell 管理。

[会话工作台面板](../extend/workbench-panels.zh-CN.md)介绍右侧和底部停靠面板的注册方式。

### 按需工作台面板

`WorkbenchPanel.visibility` 缺省为 `always`。依赖会话内容的面板可选择 `contextual`，并以仅用于呈现的 `when(context)` 判断是否显示。`icon` 指定共享图标名；可选的 `title(context)` 提供内容标题。这些字段不改变授权。内置面板使用右侧工作台；`bottom` 仍可供插件使用。
