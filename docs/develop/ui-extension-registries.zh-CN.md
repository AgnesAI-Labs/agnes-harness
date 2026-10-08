# 前端扩展注册表

[English](ui-extension-registries.md) | 简体中文

`@agnes/web-client` 导出平台单例 `settingsSections`、`conversationCards`，以及供独立宿主和测试使用的 `UiExtensionRegistry`。这些 API 只负责展示，不选择会话工具、不修改配置、不授予能力。使用宿主提供的 web-client 平台模块，避免打包出另一份注册表单例。

设置区注册 `{ group, id, titleKey, groupTitleKey, icon, order, component }`。ID 以小写字母开头，仅包含小写字母、数字、点和连字符，必须唯一；order 为有限数值。渲染前向现有语言服务注册标题键。icon 指定共享设置图标。component 接收 `{ context }`，包括取词函数、可选会话和资源服务，以及由宿主拥有的不透明 data。

```tsx
import { settingsSections } from '@agnes/web-client'
const dispose = settingsSections.register({
  group: 'tools', id: 'example.inspector', order: 52,
  titleKey: 'example.inspector.title', groupTitleKey: 'settings-shell.group.tools',
  icon: 'tools', component: Inspector,
})
```

统一设置外壳拥有分类导航、页签键盘操作、布局和 `?settings=<id>` 深链接。内置账户、资源、归档、Computer Use 和通用页通过原生面板生命周期桥接字段 nativePane、navigationId 保留已有 DOM、控制器和皮肤钩子，其余页面通过同一注册表在运行设置面板渲染。宿主的运行上下文不透明；扩展读取和操作自己的数据应使用已声明的客户端服务。

导航 test id 为 settings-navigation；分类按钮为 settings-nav-首个页面ID；组内页签为 settings-nav-ID-tab，保留 role=tab、aria-selected 和游走焦点。内置控制器 ID 保留，运行页面使用 settings-page-ID。SettingsPage、SettingsCard、Field、共享表单控件和 SettingsState 负责视觉模式。

会话卡片注册 `{ id, order, matches, component }`。matches 接收 `{ kind, data }`；按 order、ID 排序后第一个匹配的注册项负责渲染。匹配函数只检查展示数据，不发请求或执行副作用。组件接收 `{ card, context }`。具体渲染器应排在通用兜底之前。内置问题、计划、交付物、作业、子代理、工作流、目标、日程、插件和工具卡片均通过同一 API 注册。插件插槽归属及资源访问仍经过现有插槽与客户端资源服务。

```tsx
const disposeCard = conversationCards.register({
  id: 'example.result', order: -10,
  matches: (card) => card.kind === 'example-result',
  component: ResultCard,
})
```

使用 ConversationCardLayout 作为卡片表面、SettingsState 作为状态反馈。卡片状态为 ready、loading、empty、error、disabled。沿用稳定 test id 与有意义的 form/article/log 角色；已有 question-card、deliverable-card、background-job-card、child-agent-card、workflow-run-card、goal-bar、reminder-card 均保留。

register 返回幂等且绑定该注册项身份的卸载函数，须绑定到客户端模块的 effect 或销毁作用域。旧卸载函数不会删除后来使用同一 ID 的注册项。subscribe、getSnapshot 支持响应式宿主；entries 返回排序后的注册项；get 按 ID 查询。选中页面卸载后回到第一个内置分类。UI 注册项必须与已安装客户端模块的生命周期一致。

会话工具组和 session-info 数据结构属于后台。SessionToolsPanel 独立渲染 SessionCapabilitySet 的启用状态和 source/rule 来源说明，并兼容可选的旧 toolGroups；注册表不规范化、扩展或保存此数据。基于 schema 的配置表单和注册表 guard 策略由后续工作负责。
