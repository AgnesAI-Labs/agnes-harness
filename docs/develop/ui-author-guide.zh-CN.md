# 构建符合 Agnes 风格的界面

[English](ui-author-guide.md) | 简体中文

[前端生命周期](frontend.zh-CN.md) · [界面一致性](ui-consistency.zh-CN.md) · [术语](ui-glossary.zh-CN.md) · [皮肤](skins.zh-CN.md)

组件从 `@agnes/web-ui` 公共出口导入，注册表从 `@agnes/web-client` 导入。复用宿主的平台单例，不直接引用 antd，也不打包第二份 React 或注册表。后台授权与会话事实由原服务负责。

## 按钮与页面结构

使用 `Button` 和 `IconButton`。静态插件界面可直接使用宿主已提供的公共 CSS 契约：

```html
<button type="button" class="agh-btn agh-btn--primary agh-btn--md">保存</button>
<button type="button" class="agh-btn agh-btn--ghost agh-btn--sm">详情</button>
```

必须有 `.agh-btn`；变体选择 `--primary`、`--secondary`、`--ghost`、`--danger` 或 `--link`，尺寸选择 `--sm` 或 `--md`。`--danger-filled` 仅用于破坏性确认。每个视图最多一个主动作。`.primary-button` 等内部别名不是作者 API。图标动作必须有本地化无障碍名和提示，优先用 `IconButton name="…" label="…"`。

设置界面用 `SettingsSection`、`SettingsGroup` / `SettingsItem`（一行设置：名称和说明在左，控件在右）、`SettingsDetails`、`SearchBar`、`LabeledSwitch` 和 `SettingsSaveBar` 组合。设置宿主已提供页面模板和页头，子面板不要重复。页面的一行说明用 `SettingsPageDescription` 声明，页面操作用 `SettingsPageActions` 声明，两者都会进入宿主的页头。用户很少需要的诊断信息放进 `SettingsTechnicalDetails`。`SchemaConfigForm` 提供 schema 表单。失败保留草稿。使用 `SettingsState tone="loading|empty|error|success"`；加载状态包含装饰性的 `Skeleton` 和带 busy 状态的播报区域。单独用 Skeleton 时必须另有本地化加载说明。空态用 `EmptyState` 教用户下一步；`Tag` 只标出需要处理的异常。

## 工作台注册

```tsx

const dispose = ctx.workbenchPanels.register({
  id: 'example.notes', order: 50, edge: 'right',
  titleKey: 'example.notes.title', icon: 'file',
  visibility: 'contextual',
  when: (context) => Boolean(context.session),
  component: NotesPanel,
})
```

渲染前注册 en 和 zh-CN 词条，注销函数绑定客户端模块生命周期。`icon` 取共享图标目录的名称。仅有相关内容时才有用的面板用 `contextual`，通过 `when(context)` 控制显示；省略 visibility 时为现有贡献保留 `always`。`title(context)` 可提供界面自己的动态标题。这些字段只影响呈现，不授予权限。标签、更多菜单、尺寸、F6 导航和焦点返回由宿主负责。详见[工作台面板](../extend/workbench-panels.zh-CN.md)。

## 设置分组

通过 `settingsSections` 注册 `SettingsSection`，提供稳定 `id`、`titleKey`、`groupTitleKey`、`group`、`icon`、有限数值 `order` 和 `component`。日常设置复用 `accounts`、`plugins`、`skills`、`tools`、`automation`、`security`、`history` 或 `general`。`agent` 和 `diagnostics` 位于高级，技术实现选项放在那里。插件可使用自己的分组，但须提供本地化标题。不要设置内置桥专用的 `nativePane` 或 `navigationId`。面板自行管理加载和失败时设 `runtimeCatalog: false`。

## Intelligent UI 摘要

每个界面给出有意义的 `title` 和一句话 `summary`（最多 1,024 个字符）。同时启用 `placement.inline` 与 `placement.workbench` 时，对话展示摘要与展开入口，工作台展示完整界面；对应工作台打开时收起内联摘要，避免内容重复。省略摘要会回退到文本内容或本地化动作计数，显式摘要更能说明用户正在做什么。复用受支持的预设，保留后台动作与审批合同。

## Token 与无障碍

颜色使用语义 `var(--agnes-*)`，间距用 `--s4/8/12/16/24/32/48`，圆角用 `--radius-control/card/surface/pill`，字重和动效用共享 token。原始色值仅进入色板或皮肤浅深成对覆盖。品牌色用于主动作、选择、链接和焦点；状态色同时配文字。不自写按钮样式，不用 `!important` 覆盖共享控件。保留 `data-agnes-region` 钩子。

交付前检查两种语言、两种主题、桌面与 390px。Tab 顺序自然，焦点可见，对话框和抽屉关闭后回到触发器，窄屏命中区至少 44px。共享按钮扩大命中区并保留图标视觉尺寸，相邻动作留足空间。紧凑的自定义指针控件可用 `.agh-touch-target` 扩大命中区，只读代码块保留键盘滚动。F6/Shift+F6 循环可见任务区域，不干扰弹窗焦点。检查加载、空态、失败重试和成功，尊重 reduced-motion。颜色对使用[token 对比度测试](../../packages/web-ui/test/token-contrast.test.ts)验证，再运行受影响的行为与无障碍检查。
