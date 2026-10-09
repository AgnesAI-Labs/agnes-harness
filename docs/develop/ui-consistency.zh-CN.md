# Web UI 一致性

[English](ui-consistency.md) | 简体中文

[文档](../README.zh-CN.md) · [前端](frontend.zh-CN.md) · [皮肤](skins.zh-CN.md) · [UI 覆盖](ui-coverage.zh-CN.md)

本文规定现有 Web 界面的呈现方式，复用 `@agnes/web-ui` 的公开出口和既有主题，不改变导航、后端决策、表单值或权限。[源码清单与实施顺序](ui-consistency-audit.md) 区分现有能力与待完成工作。

## 页面与面板骨架

管理页使用 `SettingsPage`：一个包含本地化标题、简短说明、页面操作的页头；由 `SettingsCard` 或平面的 `SettingsList` / `SettingsRow` 组成的正文；相关表单末尾用 `SettingsToolbar` 放置操作。`SettingsPage` 已提供页头和正文栈；表单页脚通过组合实现，不另建页面框架。设置 hub 已拥有页头，子面板不要重复相同标题。

内嵌和独立的插件、资源页采用同样的页头、正文、列表行和操作结构，保持现有路由与导航。会话壳保留侧栏、输入区和停靠区；工作台面板复用标题/操作节奏与 `SettingsState`；会话卡片使用 `ConversationCardLayout` 及相应标题、状态。停靠区标签已承担标题时，不再重复添加标题。

页面操作放在标题旁，行操作放在行内，保存/取消放在字段之后。窄屏按源码顺序换行，字段降为一列。390 px 下内容必须可达，不出现页面级横向滚动。仅代码、终端输出、差异和确实很宽的表格可在有可访问名称的区域内部滚动。

## 控件与表单

| 用途 | web-ui 公开组件 | 必须保留的合同 |
| --- | --- | --- |
| 文本、搜索、URL、密码、数字输入 | `SettingsInput` | type、ID、ref、自动填充、上限、校验及变更处理器 |
| 多行文本、Markdown、命令草稿 | `SettingsTextArea` | 选区、输入法、快捷键、ref 和草稿归属 |
| 依赖原生表单/控制器的选择器 | `SettingsSelect` / `SettingsOptionSelect` | 原生 value、选项、表单提交与事件 |
| 可搜索或丰富选择器 | `Select`；受支持的 DOM 桥接用 `createSelectPicker` | 可访问名称、键盘选择、调用方状态及弹层生命周期 |
| 布尔设置 | `Switch` / `StateSwitch` | 受控 checked/disabled；StateSwitch 保留行内事件传播语义 |
| 带标签的紧凑复选框 | `SettingsCheckbox` | checked、name/value、可访问标签与表单语义 |
| 单选组 | web-ui 内共享的选择组呈现 | 保留 radio 语义、方向键行为及既有 name/value 选择器；仍待实现 |
| 操作 | `Button` | htmlType、禁用/忙碌态、可访问名称及处理器 |
| 关联视图 | `Tabs` | ID、焦点、aria-controls 与选中状态 |
| 模态/锚点弹层 | `Dialog` / `Popover` | Escape、焦点归还、层级及清理 |
| 字段 | `Field`；声明式 schema 用 `SchemaConfigForm` / `PluginSchemaFields` | 标签、提示、错误与调用方权威数据 |

**web-ui 内部**使用原生元素是合法实现：现有设置包装刻意保留原生表单语义。调用方必须使用出口，仅给普通 input 加 CSS 类不算组件迁移。不要把原生 select 控制器强行改为 antd 的 value/event 合同来实现纯样式修改。外部 UI 依赖仅位于 web-ui。

标签在控件上方可见，随后是帮助与字段错误。保留 htmlFor/ID、aria-describedby、aria-invalid、必填/禁用状态及稳定 test ID。placeholder 不能替代标签。schema 上限、revision 检查、凭据引用不变。不要在 Field 的 label 内嵌独立标签或交互操作。只读内容使用普通文本或 `SettingsCode`，不用禁用输入框模拟。

## 列表、状态与状态色

复用 `PluginList`、`ResourceListContent`、`SettingsList`、`SettingsRow`。行包含标题、次要元数据与操作组。表格保留 caption、scope 表头，横向溢出限制在表格区域。技术信息用 `SettingsDetails`，不要每个属性嵌套完整卡片。

使用 `SettingsState` 并明确指定 loading、empty、error、success tone。加载保留上下文并标记 aria-busy；空态说明缺少什么，有现成有用操作时提供入口；错误包含本地化说明及既有重试；成功确认操作。失败保留草稿。仅给段落设置 role=alert 不会获得错误视觉样式。会话卡片使用 `ConversationCardLayout` 对应状态。资源空态已有的多条操作指引应保留，再统一其呈现。

使用 `Badge` / `StateLights` 和可见的本地化状态文字：ok 表示成功，warn 表示注意，bad 表示失败，off/unknown 表示中性或未知。颜色只是补充。读取 `--agnes-status-success-*`、`--agnes-status-warning-*`、`--agnes-status-danger-*`、`--agnes-status-info-text` 与中性文字 token；不用页面自定义色，也不能将读取失败显示为成功。

## 对话框与图标

统一结构为本地化标题、可选说明、可滚动正文、字段/操作反馈及一组页脚操作。取消在主操作之前，危险操作保留明确确认。既有原生 `<dialog>` 宿主可保留：共享内容渲染在其中，控制器继续拥有 showModal、Escape、焦点归还和公共皮肤钩子。不要在其内部再嵌套第二个 modal。首次引导保留既有遮罩和进度布局。

使用既有 `.icon` SVG 呈现；设置导航用 `createSettingsIcon`。装饰图标 aria-hidden，纯图标按钮有本地化可访问名称。不用 emoji 替换图标，不把内部标识作为操作标签。

## 尺度与主题

权威源是 `packages/web/public/styles/01-tokens.css`；`packages/web-ui/src/tokens.css` 将语义角色桥接到静态 antd 变量。使用现有尺度，不重复写字面值：

| 用途 | 现有 token |
| --- | --- |
| 间距 | `--s2`、`--s4`、`--s8`、`--s10`、`--s12`、`--s16`、`--s20`、`--s24`、`--s32`、`--s48` |
| 字体 | `--font-sans`、`--font-mono`、`--font-size-xs`（12）、sm（13）、body（14）、md（16）、lg（18）、xl（20）、2xl（默认尺度 24 px） |
| 行高 | `--line-xs`、`--line-sm`、`--line-md`、`--line-lg` |
| 控件 | `--control-height`、`--control-height-form`、`--control-height-touch` |
| 表面几何 | `--radius-*`、`--shadow-*`、`--admin-content-width`、`--dialog-max-height` |

字段/行内部优先 8–12 px，区块之间 16–24 px，页面内边距 24–32 px，均用对应 token。先复用组件间距，再补 CSS。不要为凑尺度修改 trace/diff 专用几何而改变行为。

颜色消费语义 `--agnes-*`。`.dark` 提供覆盖和 color-scheme，不增加第二套主题开关或运行时 ConfigProvider 色板。编辑控件用 `--agnes-input-surface`，保留焦点、悬停、禁用和校验状态。确需新增语义色时，浅深成对，并遵守现有公共皮肤 token 生成合同。保留 data-agnes-region 钩子及表面特异性，尊重 reduced-motion，保留键盘焦点。

宿主标签、帮助、空态和错误都有 en/zh-CN 文案；日期和数字按当前语言格式化。插件/模型 ID、用户内容、协议值保持原文。

## 原生例外与验收

web-ui 之外只保留 `packages/web-units/src/composer.ts` 中用于浏览器上传选择器的隐藏文件输入（`attachment-file-input`），保留既有可访问属性与上传生命周期。web-ui 内 `conversation/turn-actions.tsx` 临时 textarea 是平台剪贴板回退，在 finally 中移除，不是用户编辑字段。共享库内部的原生控件属于实现细节，包括可访问的 checkbox/radio 语义。

迁移后静态 HTML/模板壳不得保留重复的编辑控件。删除过时回退表单或移到共享 React 内容，保留 DOM ID、选择器、公共钩子和控制器生命周期。隐藏的重复控件不算例外。

按清单逐项检查 en/zh-CN、浅/深色、桌面/390 px，包含溢出、键盘焦点及相关状态。通过仓库现有截图 harness 采集对应前后证据，一次只开一个浏览器页面。截图是呈现证据，不能代替行为测试通过结论。
