# Web UI 一致性

[English](ui-consistency.md) | 简体中文

[文档](../README.zh-CN.md) · [前端](frontend.zh-CN.md) · [皮肤](skins.zh-CN.md) · [UI 覆盖](ui-coverage.zh-CN.md)

本文规定现有 Web 界面的呈现方式，复用 `@agnes/web-ui` 的公开出口和既有主题，不改变导航、后端决策、表单值或权限。当前界面与验证边界见 [UI 覆盖](ui-coverage.zh-CN.md)，归属模块见[源码导航](source-map.zh-CN.md)。

工作台布局由 `AppShell` 渲染。controller 快照和可替换 slot 区域共享一个 React root 与一个 antd `ConfigProvider`。controller 持有的挂载点使用 `mountRegion` / `renderRegion` / `unmountRegion`；这些接口渲染应用内 portal，不创建额外 root。组件直接渲染翻译文案；切换语言必须保留草稿、焦点和 controller 绑定的节点 ID。浮层共享壳容器；从原生 dialog 打开的 popup 留在该 dialog 的顶层中。

`createExternalStore` 保留 controller 的状态归属，默认同步通知以支持受控输入。组件通过 `useStoreSelector` 选择状态，可提供 equality。非输入类 controller 区域可以选择 `notify: 'animation-frame'`：多次写入每帧最多通知一次，命令和测试可用 `flush()` 同步发布。工作台 controller 刷新启用逐帧合并，首次挂载同步发布。区域 roster 与各区域内容分别持有小 store；对话流式更新继续走对话自己的 projection store，不经过外壳 store。

每个 controller 区域都有 `RegionErrorBoundary`，工作台 right/bottom portal 各有独立边界，异常只在本区域显示本地化重试，并进入脱敏的浏览器诊断日志；`SlotOutlet` 内部的插件边界继续负责插件错误。`--agh-z-*` 基准层级依次为 dropdown 1000、drawer 1100、modal 1200、tooltip 1300、notification 1400。`getOverlayContainer` 统一提供外壳 outlet 与弹窗内部的 popup 作用域；自定义/Radix portal 使用同一公开策略，使嵌套菜单留在当前焦点范围内。

## 页面与面板骨架

管理页使用 `SettingsPage`：一个包含本地化标题、简短说明、页面操作的页头；由 `SettingsCard` 或平面的 `SettingsList` / `SettingsRow` 组成的正文；相关表单末尾用 `SettingsToolbar` 放置操作。`SettingsPage` 已提供页头和正文栈；表单页脚通过组合实现，不另建页面框架。设置 hub 已拥有页头，子面板不要重复相同标题。

内嵌和独立的插件、资源页采用同样的页头、正文、列表行和操作结构，保持现有路由与导航。会话壳保留侧栏、输入区和停靠区；工作台面板复用标题/操作节奏与 `SettingsState`；会话卡片使用 `ConversationCardLayout` 及相应标题、状态。停靠区标签已承担标题时，不再重复添加标题。

页面操作放在标题旁，行操作放在行内，保存/取消放在字段之后。窄屏按源码顺序换行，字段降为一列。390 px 下内容必须可达，不出现页面级横向滚动。仅代码、终端输出、差异和确实很宽的表格可在有可访问名称的区域内部滚动。

内置侧栏在同一棵 React 树中渲染工作区标题、会话按钮与操作菜单。宿主的 `renderNavigation` 适配器返回 React 节点，不再填充 DOM 挂载点；控制器更新通过 `useSyncExternalStore` 进入组件。工作区选择和重命名使用 `Dialog`，保留选择器 ID、忙碌状态下禁止关闭与焦点返回。作为展示外壳的原生 dialog 保留皮肤钩子和 `open` 选择器，模态行为由共享组件负责。

## 控件与表单

| 用途 | web-ui 公开组件 | 必须保留的合同 |
| --- | --- | --- |
| 文本、搜索、URL、密码、数字输入 | `SettingsInput` | type、ID、ref、自动填充、上限、校验及变更处理器 |
| 多行文本、Markdown、命令草稿 | `SettingsTextArea` | 选区、输入法、快捷键、ref 和草稿归属；`presentation="plain"` 保留 terminal 专用表面。composer 草稿使用 `@agnes/web-ui/x` 的 `Sender` |
| 依赖原生表单/控制器的选择器 | `SettingsSelect` / `SettingsOptionSelect` | 原生 value、选项、表单提交与事件 |
| 可搜索或丰富选择器 | `Select`；受支持的 DOM 桥接用 `createSelectPicker` | 可访问名称、键盘选择、调用方状态及弹层生命周期 |
| 布尔设置 | `Switch` / `StateSwitch` | 受控 checked/disabled；StateSwitch 保留行内事件传播语义 |
| 带标签的紧凑复选框 | `SettingsCheckbox` | checked、name/value、可访问标签与表单语义 |
| 单选组 | `SettingsChoice` | 保留 radio 语义、方向键行为及既有 name/value 选择器 |
| 操作 | `Button` | htmlType、禁用/忙碌态、可访问名称及处理器 |
| 关联视图 | `Tabs` | ID、焦点、aria-controls 与选中状态 |
| 模态/锚点弹层 | `Dialog` / `Popover` | Escape、焦点归还、层级及清理 |
| 字段 | `Field`；声明式 schema 用 `SchemaConfigForm` / `PluginSchemaFields` | 标签、提示、错误与调用方权威数据 |

**web-ui 内部**使用原生元素是合法实现：现有设置包装刻意保留原生表单语义。调用方必须使用出口，仅给普通 input 加 CSS 类不算组件迁移。不要把原生 select 控制器强行改为 antd 的 value/event 合同来实现纯样式修改。外部 UI 依赖仅位于 web-ui。

标签在控件上方可见，随后是帮助与字段错误。保留 htmlFor/ID、aria-describedby、aria-invalid、必填/禁用状态及稳定 test ID。placeholder 不能替代标签。schema 上限、revision 检查、凭据引用不变。不要在 Field 的 label 内嵌独立标签或交互操作。只读内容使用普通文本或 `SettingsCode`，不用禁用输入框模拟。

## 列表、状态与状态色

复用 `PluginList`、`ResourceListContent`、`SettingsList`、`SettingsRow`。行包含标题、次要元数据与操作组。表格保留 caption、scope 表头，横向溢出限制在表格区域。技术信息用 `SettingsDetails`，不要每个属性嵌套完整卡片。

使用 `SettingsState` 并明确指定 loading、empty、error、success tone。加载保留上下文并标记 aria-busy；空态说明缺少什么，有现成有用操作时提供入口；错误包含本地化说明及既有重试；成功确认操作。失败保留草稿。仅给段落设置 role=alert 不会获得错误视觉样式。会话卡片使用 `ConversationCardLayout` 对应状态。资源空态已有的多条操作指引应保留，再统一其呈现。

需要处理的异常用 `Tag tone="warn|bad|info"`，每行或卡最多一个；正常启用、连接和运行无需标签，描述信息用 MetaText。既有 Badge / StateLights 保留公共 tone。状态色同时配本地化文字。读取 `--agnes-status-success-*`、`--agnes-status-warning-*`、`--agnes-status-danger-*`、`--agnes-status-info-text` 与中性文字 token；不用页面自定义色，也不能将读取失败显示为成功。

## 对话框与图标

统一结构为本地化标题、可选说明、可滚动正文、字段/操作反馈及一组页脚操作。取消在主操作之前，危险操作保留明确确认。既有原生 `<dialog>` 宿主可保留：共享内容渲染在其中，控制器继续拥有 showModal、Escape、焦点归还和公共皮肤钩子。不要在其内部再嵌套第二个 modal。首次引导保留既有遮罩和进度布局。

使用既有 `.icon` SVG 呈现；设置导航用 `SettingsIcon` 组件。装饰图标 aria-hidden，纯图标按钮有本地化可访问名称。不用 emoji 替换图标，不把内部标识作为操作标签。

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

输入框的隐藏浏览器文件选择器（`attachment-file-input`）使用 `SettingsInput`，保留原有上传与无障碍合同。审批、队列、回合与工具动作使用 `Button`。回合动作的剪贴板回退通过共享控件工厂创建临时 textarea，在 `finally` 中移除。共享原语内部的原生控件仍属于实现细节。

迁移后静态 HTML/模板壳不得保留重复的编辑控件。固定表单用 `template[data-agnes-control]` 声明，在控制器绑定前由 web-ui 的 `materializeSettingsControls` 创建统一 token 的原生等价控件；ID、选项、校验和宿主节点所有权不变。删除过时回退表单或移到共享 React 内容，保留 DOM ID、选择器、公共钩子和控制器生命周期。隐藏的重复控件不算例外。

按清单逐项检查 en/zh-CN、浅/深色、桌面/390 px，包含溢出、键盘焦点及相关状态。通过仓库现有截图 harness 采集对应前后证据，一次只开一个浏览器页面。截图是呈现证据，不能代替行为测试通过结论。

SettingsPage 的 `headingId` / `bodyClassName` 保留原有标题 ID 与正文滚动类。React 动作用 Button；命令式控制器使用 `createSettingsButton`，继续拥有节点、事件、焦点与清理，不引入第二份状态。静态控件工厂与 React 控件消费相同 token。截图证据须记录源码 revision、语言、主题、宽度及缺失的基线，不能把未执行的行为测试写成通过。

## 共享呈现原语

`@agnes/web-ui` 提供 `Button`、`IconButton`、`Icon`、`Tag`、`MetaText`、`Count`、
`Menu`、`Tooltip`、`Toast`、`EmptyState`、`Banner`、`ListRow`、`Drawer`、`Skeleton`、`Field`、
`SettingsPageHeader`、`SettingsSaveBar`，保留既有 props 和钩子。

`ListRow` 的 `variant="file"` 用于紧凑文件卡片，复用现有交付物皮肤钩子与主题 token。预览内容放在行外，保持文件操作相互独立。
`Button` 新增 `appearance="primary|secondary|ghost|danger|link"`；
`dangerFilled` 只用于破坏性确认。用 `disabledReason` 解释不可用动作。
纯图标动作必带 label 和共享 tooltip。动作菜单用 `role="menu"`，值选择器用 `role="listbox"`。
原生 `positionSubmenu` 优先放在父面板右/左侧；两侧空间不足时回退到上/下方。
`Toast` 支持 `tone="success|info|error"`（默认 `success`）；导航提示用 `info`，失败操作用 `error`。
`duration` 仍以毫秒为单位。

设置页顺序为页头 → 提示 → 工具栏 → 内容 → 有改动才出现的保存条。
`SettingsPage variant="form|list"` 最大宽度为 720/960px；工具栏支持 `search`、
`filters`、`controls` 槽。调用方持有 dirty/busy 状态与持久化操作。
Field 自动关联说明/错误，错误取代说明。Drawer 桌面宽 480px、≤767px 全屏；
打开前关闭其它 modal。`Dialog size="sm|md|lg"` 为 420/560/720px，窄屏为底部抽屉。
原生宿主用 `bindDialogSheets(document)`：拖动请求原生 cancel，忙碌拒绝与焦点恢复
继续归宿主；pagehide 时释放返回的绑定。关闭或删除弹层时清理监听，语言变化更新把手的无障碍名。

页面迁移期间保留旧紧凑控件的窄屏 32px 最小尺寸；≤767px 扩大命中区到 44px，
新 IconButton 保持 28px 视觉。不得降低既有 narrow 验收阈值。

稳定公共 CSS API 位于 `@agnes/web-ui/components.css`：`.agh-btn` 及
`--primary|secondary|ghost|danger|link`、`--sm|md`、`--icon`、`--danger-filled`，
以及 `.agh-tag`（`data-tone="warn|bad|info"`）、`.agh-meta`、`.agh-count`、
`.agh-banner`、`.agh-empty-state`、`.agh-list-row`、`.agh-field`。
Web 主题桥已包含规则，静态按钮可使用相同契约类。
`.primary-button`、`.secondary-button`、`.icon-button` 是内部别名；新增业务代码
使用公共组件/契约类和语义颜色。呈现守卫只允许已登记的旧页面基线，迁移时删除对应项，
不得为新增页面样式增加豁免。

内部 `--agnes-ui-input-font-size` 角色供显式字号的选择器、归档搜索和终端输入消费；桌面保留原字号，手机即使选择小字号也至少为 16px。

## 导航、加载与键盘

[UI 作者指南](ui-author-guide.zh-CN.md)说明公共注册与类契约。设置包含通用、模型、权限、应用，可选插件设置列在扩展下，另有高级分组；工作台固定文件、目标、改动、执行记录，业务界面与终端按内容显示。双位置 Intelligent UI 在对话中用摘要。加载使用共享 SettingsState/Skeleton，不另造私有骨架。F6/Shift+F6 在可见侧栏、对话或轨迹、工作台、插件面板及输入区间循环；弹窗不参与。关闭抽屉或对话框须还焦点。窄屏测试保留 375/768px，并增加 390px；手机命中区检查为 44px（计入实际可点击伪元素），图标必须有无障碍名。

新增代码使用 `--s4/8/12/16/24/32/48`、`--radius-control/card/surface/pill`、`--elevation-0/1/2`、三档共享字重和 `--motion-fast/base/ease`；旧尺度保留为既有调用的别名。

## 异步状态归属

会话事实、执行结果和授权由后端与 SDK 投影持有。应用协调层统一拥有当前会话选择、连接及订阅生命周期。远程快照（设置、列表、插件名册）由带作用域的资源存储持有；组件持有草稿、展开状态和本地交互。

资源写入提交新版本，早于该提交开始的读取不能用数据或错误覆盖它；同一资源的写入队列跨组件生命周期共享。自动保存合并每个编辑来源尚未发送的完整值，并按最新意图的位置排队；旧写失败不能阻断新值。读取最新快照后修改的操作继续保持 FIFO 顺序。会话和名册操作在 await 后、修改共享状态前必须重新核验选择或请求身份。过期任务可以释放自己的句柄，但不能重置其他选择的渲染器或恢复目标。各模块独立加载，区域失败相互隔离，卸载回收全部注册。

完成带路由的页面时，始终将当前 URL 替换为父级栈；直接深链进入、没有框架历史状态时也一样。刷新和历史恢复不得重新打开已完成的页面。

更新会话、账户等 URL 元数据时保留 `view` 和 `settings` 路由原有编码，避免把页级分隔符与标识符中的斜杠混为一谈。

已完成的操作通过 shell 持有的反馈出口发布本地化结果。每个操作标识只显示一条持续 3 秒、不改变焦点的 polite `Toast`。字段校验使用 `Field.error`；操作失败在所属区域用 `StatusMessage` 并提供真实恢复动作；重启、扫描、重连、启用等尚未解除的后果，每个资源保留一条 notice。pending、unknown、partial 不得显示为成功。仅作用范围不同的效果放在 toast 第二句和稳定帮助中。`SettingsSaveBar` 只处理未保存编辑。

字段使用 `SettingsInput`、`SettingsTextArea`、`SettingsSelect`、`Select` 和 `SearchBar`，共用 `--agnes-input-surface` 与状态 token，保留已保存但不可用的值。符合固定短标签条件的单选组使用 `Segmented`，其轨道、测量定位的滑块、动画与“对话/轨迹”开关相同，保留单选组方向键和可见焦点。主题预览块和多选标签维持各自语义。显式旧调用清单之外，guard 拒绝 web-ui 外新增裸输入框、下拉框和颜色字面量。


`Segmented` **仅用于 2–5 个短标签**：选项数量固定且少，无描述或副文案，中英文均能单行完整显示。`radiogroup` 是单选语义，不代表必须使用分段外观。含描述、来源插件、版本、能力或长标签的选择使用现有 `SettingsChoice` 描述式单选列表；长列表使用 `Select`。运行时或插件驱动的选项使用描述式单选列表或 `Select`，不得使用 Segmented。保留所有选项信息、保存行为和确认流程，不得通过缩短标签或删除描述硬塞进 Segmented。UI guard 允许描述式单选组，拒绝手写分段外观、动态选项数量及数量越界；翻译后的单行适配须同时检查中英文。
