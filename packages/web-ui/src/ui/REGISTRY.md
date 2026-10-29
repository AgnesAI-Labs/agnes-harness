# A 线原语登记

| 组件 | 来源线 | antd 对应件 | 暴露约定 |
| --- | --- | --- | --- |
| `Button` | A | `Button` | 保留 antd `ButtonProps`，追加 `agnes-ui-button` 基础类 |
| `Dialog` | A | `Modal` | 保留 antd `ModalProps`，追加 `agnes-ui-dialog` 基础类；默认在调用处挂载，保持原生 dialog 的 top layer |
| `Field` | A | 原生 label | 语义 label、hint、error；允许透传 label 属性 |
| `Select` | A | `Select` | 保留 antd 泛型 `SelectProps`，追加 `agnes-ui-select` 基础类 |
| `Switch` | A | `Switch` | 保留 antd `SwitchProps`，追加 `agnes-ui-switch` 基础类 |
| `Tabs` | A | `Tabs` | 保留 antd `TabsProps`，追加 `agnes-ui-tabs` 基础类 |

# C 线原语登记

| 组件 | 来源线 | antd 对应件 | 暴露约定 |
| --- | --- | --- | --- |
| `StateLights` | C | 不采用 antd（Badge/Tag） | DOM 契约沿用 `.state-lights` 皮肤（data-tone 由 CSS token 决定）；antd 徽标会破坏现有红绿灯样式与特异性 ≤(0,1,0) 的皮肤规则 |
| `StateSwitch` | C | 不采用 antd（Switch） | `role="switch"` 行内动作语义 + `.switch` 皮肤 + stopPropagation 保真；antd Switch 的 DOM/样式/事件模型与列表行交互契约不符 |

| `Popover` | A | `Popover` | Anchored picker surface; theme token bridge and caller-owned open state |
| `Sender` (`@agnes/web-ui/x`) | Shared | Ant Design X `Sender` | Same props plus `inputAttributes` for the textarea (id, `data-*`, `aria-*`); `agnes-ui-sender` base class leaves border, fill and shadow to the host region; callers own the value, the keyboard contract (`onKeyDown` returning `false`) and the actions |

| `SettingsPage` / `SettingsCard` | A | 模型与账户布局 | 标题、说明、操作区和卡片栈；共享主题间距 |
| `SettingsState` | A | 共享状态 | 空白、加载、错误和成功；live region |
| `SettingsInput` / `SettingsTextArea` / `SettingsSelect` | A | 账户表单原生控件 | 表单语义、ref 与主题 token；不暴露外部 UI 库 |
| `ConversationCardLayout` | A | 会话卡片布局 | 标题、操作、ready/loading/empty/error/disabled；保留调用方稳定 test id 与语义角色 |
| `SettingsIcon` | A | 设置导航图标 | 分类图标共用 `icon` 皮肤钩子和主题尺寸；装饰性图标不进入无障碍名称 |

| `SettingsList` / `SettingsRow` | A | 平面设置列表 | 同账户页标题、说明与操作对齐；无嵌套卡片 |
| `SettingsDetails` | A | 原生 details | 默认折叠的高级信息；键盘可展开；`compact` 用于行内无嵌套卡片的技术信息 |
| `SettingsAdvanced` / `useAdvancedSettings` | A | 高级折叠 | 只在「显示高级设置」打开时存在：虚线卡片 +「高级」标记，标题行右侧显示当前值；开关默认打开，只有用户明确关闭（本机浏览器 `agnes.settings.advanced` 存 `0`）才隐藏，未存或读不到都算打开 |
| `SettingsToolbar` | A | 设置筛选操作栏 | 表单控件与按钮底部对齐，窄屏自动换行 |

| `ConversationInteractionResult` / `interactionToolPresentation` | A | 会话交互结果 | 从工具生命周期生成本地化摘要；原始结果置于“查看详情”，不修改协议数据 |

| `ConversationToolCard` | A | 会话工具行 | 唯一详情按钮；可选 `resultAppendix` 将模型原样回显合并入原始结果详情，保持协议文本可查阅 / One details action; optional `resultAppendix` preserves verbatim result echoes in the same details panel |

| `SchemaControl` / `SchemaConfigFields` / `SchemaConfigForm` | A | 既有 Field / Settings 控件 | JSON schema 子集、本地化元数据、按字段错误、受控保存/测试；凭据只传引用 / JSON schema subset, localized metadata, field errors and caller-controlled actions; credentials use references |
| `ProviderConfigForm` / `providerConfigSchemas` | A | 协议生成配置约束 | 沙箱、压缩、持久化表单；调用方提供权威值和权限，不存在任意配置写接口 / Generated sandbox, compaction and persistence constraints; caller owns authoritative values and grants |
| `createSchemaSettingsComponent` | A | 设置页 registry 桥接 | 插件声明 schema / 权限 / load-save-test，工厂处理读取、失败重试、草稿和 revision；仍由唯一设置壳挂载 / Declarative schema-backed settings section with caller-controlled permissions and revision-aware adapters |

StateSwitch also renders Boolean schema/settings fields; optional id/testId and validation ARIA attributes preserve labels and selectors. Controlled state, keyboard button behavior and plugin-row propagation rules are shared.

| `FirstRunGuide` / `DoctorNotice` / `DoctorChecks` / `DoctorGroups` | A | 既有 Dialog / Field / Select / SettingsList / Badge | 可跳过引导、非阻断诊断提示与只读检查行与紧凑分组；数据和操作由 Host 控制器提供 / Skippable setup and local diagnostics, with caller-owned state and actions |
| `SettingsCheckbox` | A | 原生 checkbox | 紧凑标签与共享字段尺寸；避免全局输入框样式撑大 |
| `SettingsCode` | A | 原生 pre | 只读代码区域；可用键盘滚动，来源名称由调用方提供 |

`terminalScreen` / `terminalKey` are shared pure-text VT and keyboard helpers for session and settings terminals; they do not create processes or render HTML. / 两者是会话与设置终端共用的纯文本 VT 和键盘辅助函数，不创建进程或渲染 HTML。

| `SettingsChoice` | A | 原生 radio/checkbox | 共享外观选择呈现；保留 name/value 与方向键、表单语义 / Shared choice presentation preserves native group and form semantics |

`createSettingsButton` / `createSettingsControl` / `materializeSettingsControls` provide token-styled native equivalents for fixed static shells. Materialization happens before controller binding, retaining form semantics and host-owned node lifetimes. / 固定静态壳在控制器绑定前生成与 SettingsInput/Select/TextArea 相同的 token 控件；宿主继续拥有节点、值和事件，不新增 React root。

SettingsPage accepts `headingId` and `bodyClassName` for existing native pane IDs and scroll bodies. / SettingsPage 可保留原生设置面板的标题 ID 与正文滚动类。

| `Tag` / `MetaText` / `Count` | Shared | Contract CSS | Actionable warn/bad/info tags; descriptive metadata stays text; zero counts are omitted. |
| `Menu` | Shared | antd Dropdown / Menu | Action menu with optional `tone="neutral"` (grey hover, focus ring, aligned 16px icon slots), `dividerBefore` groups, danger variant, arrows, Home/End, typeahead, Enter/Space, Escape/focus return and danger-last grouping. Value selection uses a listbox instead. |
| `Tooltip` / `IconButton` | Shared | Tooltip / Button | 500ms hover, immediate focus, mandatory icon-action label, keyboard-accessible disabled explanation. |
| `Icon` / `SettingsIcon` | Shared | Vendored Lucide | One geometry table including the project-authored compose symbol, 24px view box, 1.5 stroke (`--icon-stroke`; 1.75 in a primary button and on the selected navigation item), currentColor; sizes 16/18/20/48. |
| `Toast` | Shared | antd message hook | Three-second nonmodal status, Escape dismissal and lifecycle cleanup; `tone="success|info|error"` selects outcome colours; existing outcome class names remain supported. Duration remains milliseconds. |
| `SettingsPageHeader` / `SettingsSaveBar` | Shared | SettingsPage / Button | One header line (`PushHeader line`): title, page actions before the dialog's ×, no description line; caller-owned dirty state; discard/save order; busy guard; two-second saved feedback. |
| `EmptyState` / `Banner` / `ListRow` | Shared | Contract CSS | Teaching empty state; one inline notice/action; flat detail rows with independent trailing actions. |
| `Drawer` | Shared | antd Drawer | 480px right detail surface, narrow full screen, Escape and focus return. Close other modal hosts before opening. |

`Dialog` adds `size="sm|md|lg"` (420/560/720px) while retaining all existing Modal props,
including explicit width. Narrow confirmations use a bottom sheet with a draggable close handle.
`Field` replaces help with errors, connects descriptions/invalid state and supports optional labels.
The public `.agh-btn*`, `.agh-tag`, `.agh-banner` and other `.agh-*` classes live in
`components.css`; legacy `.primary-button` / `.secondary-button` / `.icon-button` are internal aliases.
Both Web build paths compose the component rules into the existing theme bridge asset.

`bindDialogSheets(document)` renders `NativeSheetHandles`, which portals the same `SheetHandle` the
`Dialog` primitive draws into every open native dialog. It preserves autofocus, routes dragging
through the native cancel contract (including busy vetoes), follows locale changes, and returns a
disposer. Hosts release it on pagehide. Existing IDs and controllers remain authoritative.

| `SessionPicker` | Shared | Select | Caller-owned session titles, workspace names and relative dates; identities only in values; searchable above seven choices. |

`releaseDialogModal(host)` temporarily keeps a native settings host visible without modal focus, then restores it after an owned detail surface closes if its owner has kept it open. Cleanup is idempotent and preserves an owner's closed state.

| `Skeleton` | Shared | Contract CSS | Decorative loading lines, semantic surface tokens and no motion. `SettingsState tone="loading"` supplies it with a localized live announcement and busy state. |


| `Table` | Shared | antd Table | Generic `TableProps<T>` / antd columns, caller sorters, sticky header and responsive overflow; plain text uses ellipsis + tooltip. `caption`, `captionRepeatsHeading`, `scrollLabel`, `testId` and `empty` preserve labelled tables and empty states. |
| `DataList` | Shared | Custom ListRow | `items`, `rowKey`, `renderRow` produce flat rows with independent `onOpen` and `actions`; caller supplies `empty`. |
| `ConfirmDialog` | Shared | Dialog / Button | `onConfirm`, `onCancel`, `confirmLabel`, `cancelLabel`, `destructive`, `busy`, `confirmDisabled`; one primary action, filled destructive confirmation, Enter/Escape and busy refusal. Remaining Dialog props pass through. |
| `Chart` | Shared | Recharts | `chartType="bar|line|area|pie"`, `title`, `categoryKey`, `series`, `rows`, `dataLabel`, optional `formatValue`; token colours, responsive sizing, quiet rendering and an accessible source table. |

Dialog and Drawer use the antd modal focus trap, Escape cancellation and trigger focus return.
Popover and Menu remain nonmodal: Escape returns focus and Tab keeps the natural navigation order.
All four overlays respect reduced motion through component-layer motion rules. Drawer retains the
480px right surface and becomes full width below 768px; its native-dialog attributes now target
an antd div surface, and `onCancel` receives the antd close event.

Recharts and its React-18-matched `react-is` peer are owned by web-ui. Both Web build paths externalize
`recharts`, supply `/vendor/recharts.js` and keep React/ReactDOM resolved through the existing import map.
The Chart primitive supports area plots; the Intelligent UI surface contract remains bar/line/pie.
Badge, Tag, EmptyState, Skeleton, ListRow, Banner, Icon and SheetHandle remain custom.

| `@agnes/web-ui/x` (`XProvider`, `Bubble`, `Sender`, `Conversations`, `ThoughtChain`, `Think`, `Actions`, `Welcome`, `Prompts`, `Attachments`, `FileCard`, `Sources`, `Suggestion`) | Shared | Ant Design X | Presentational conversation components fed from caller-owned stores; no x-sdk runtime, Mermaid or CodeHighlighter. Every use sits under `XProvider`, which keeps the application nonce, locale and overlay layers and lets X generate its styles in the `vendor` layer under the `agnes-theme` variable key. Served as the `/vendor/x.js` import-map entry. |
| `Disclosure` / `setDisclosureOpen` / `isDisclosureOpen` | Shared | Contract CSS | The one collapsible section: a `button.agh-disclosure-summary` (`aria-expanded`, `aria-controls`) and its region, with `data-open` on the root. `summary`, optional `summaryProps` / `summaryRef`, controlled `open` or `defaultOpen`, `onOpenChange`; `dismissible` closes on Escape or an outside click; `variant="plain|row|card"` adds the shared chevron; `card` is a grouped card whose header takes an `icon` tile, a one-line `description` and the current value as `meta`, and whose content opens inside the same outline (height motion, instant under reduced motion). The title alone is the accessible name; description and value are its description. Content stays mounted while closed. Controllers reveal a field with `setDisclosureOpen(element, true)`. No native `<details>`. |
| `Kbd` / `shortcutLabel` | Shared | Contract CSS | Keyboard hint chip beside an action; `keys` are spelled for the platform (`⌘N` / `Ctrl+N`), never translated. |
| `StatusDot` | Shared | Contract CSS | 6px state mark: `tone="accent|success|warning|danger|info|neutral"`, `running` breathes unless reduced motion is requested; decorative unless `label` is given. |
| `CompletionCheck` | Shared | Icon | Check mark with a visually hidden `label` and optional tabular detail such as a duration. |
| `CopyButton` | Shared | IconButton | `text` or caller-owned `onCopy`; the icon and accessible name become the confirmation for 1.6s after success, with a polite status announcement; `onCopied(false)` hands failures to the caller. |

| `SettingsPage` / `SettingsPageActions` | Shared | Settings template | The one page template: title, one-line description and page actions in the header, then the body. A page nested inside another hands its description and actions to the outer header and keeps a visually hidden heading for labels; `SettingsPageActions` sends actions declared anywhere in a page to that header. |
| `SettingsSection` / `SettingsGroup` / `SettingsItem` / `SettingsList` | Shared | Contract CSS | Section title with content directly beneath; one grouped card around setting rows divided by inset hairlines (optional `icon` tile, name and description left, control right, `stacked` puts the control below). `SettingsList` is the same card for list rows (`ListRow`, `SettingsRow`), which round on hover inside it. `IconTile` is the tinted square that leads a row. `SettingsCard` is a section whose content is one outlined block. |
| `SettingsDetails` / `SettingsTechnicalDetails` | Shared | `Disclosure` | Settings disclosures on the shared chevron: on the page a grouped card of its own (optional `icon`, `description`, `summary` of the current value); inside a group, a list row or another disclosure a divided row; a quiet text toggle when `compact`. Technical details hold diagnostics a user rarely needs, collapsed under one fixed name. |
| `SearchBar` | Shared | Native search input | One labelled search field with optional `filters` and `actions`; a search landmark, not a form, so Enter calls `onSubmit` without submitting a host form. |
| `LabeledSwitch` | Shared | StateSwitch | A switch with its state in words beside the knob (`onLabel` / `offLabel`, default On / Off). |

| `Segmented` | Shared | Native radios | Two to six short exclusive choices; rounded-rectangle track with a raised block on the picked one; one radio group with arrow keys and form semantics; caller-owned value; `block` stretches it. / 2–6 个互斥短选项；圆角矩形轨道 + 浮起选中块；原生单选组，值由调用方持有。 |
| `PageHeader` | Shared | Contract CSS | Full-page head: 26px bold title (`h1`, `headingId`), one line of description, page actions. / 整页页头：26px 粗体标题、一句说明、页面操作。 |

`Select` without `showSearch` or `mode` is a popup button: a raised surface ending in the accent block with up/down chevrons (`.agh-popup-chevrons`); pass `suffixIcon` to replace it. Control proportions, hairlines, continuous corners and motion live in `refinement.css` and read scale tokens only. / 不带搜索与多选的 `Select` 是弹出按钮；控件比例、发丝线、连续圆角与动效集中在 `refinement.css`，只读取尺度 token。

| `SettingsSubpageFrame` / `SettingsDrill` / `SettingsExpand` | A | 设置二级页 | 带 › 的行打开同一弹框内的二级页（顶部一行面包屑即标题「通用 › 记忆文件」，上级可点返回，页面操作同行，无「返回」、大标题与说明行；浏览器后退与前进；`routeId` 为设置页提供 `?settings=<page>/<sub>`，`settings-subsection-<id>` 旧深链仍可打开）；`SettingsExpand` 在行下就地展开；`SettingsPage` 顶层自带二级页框架 |
| `PushStack` / `PushPage` / `usePushStack` / `usePushNavigation` / `searchParamRoute` | Shared | 导航 | 唯一的「进入新页面」：区域内替换内容，顶部面包屑「上一级 › 当前」（无前导 ‹，上一级即返回），浏览器后退返回一级，`route` 让地址带上打开的页面（深链、刷新可直达）；`replace` 用于流程换步不留历史；`finish` 完成深链页面也同步父级地址；设置二级页同用此引擎 |
| `useResource` / `invalidateResource` / `setResource` / `trackPageRequest` | Shared | 数据 | 唯一的读接口钩子：本次页面会话内存缓存，再次进入先显示缓存、后台刷新（SWR）；写后按前缀失效；提交版本禁止旧读覆盖新写；`scopedResourceKey` 绑定 API 身份，`queueResourceWrite` 按资源串行写入，可选 owner 合并该编辑来源未发送的完整值并按最新意图排序；页面级请求驱动顶部进度条 |
| `Loadable` / `TopProgress` | Shared | 加载 | 200 ms 内不显示；之后通用占位（可传形状）；3 s 后「仍在读取…」；失败显示原因 + 重试且不清空数据；内容淡入 160 ms（减少动态时不做）；全局 2px 顶部进度条 |
| `SettingsBlock` / `SettingsTag` / `SettingsInfo` | A | 设置分组 | 分组标题是名词，右侧放分组操作；保存失败只在标题处显示「保存失败 · 重试」；读取失败一行 + 重试且不清空；同一套状态小标；说明文字收进名称旁 ⓘ |
| `useAutosave` / `SettingsUndoScope` | A | 自动保存 | 开关/选择立即保存，文字停 1 秒或失焦保存；`resourceKey` 共用跨组件写队列，同一实例的等待编辑只发送最新值；不显示「已保存」；⌘Z 在文本框外撤销最近一次保存 |
| `SettingsPresetSelect` / `SettingsChips` / `SettingsChipToggle` | A | 人话取值 | 毫秒 ↔ 秒/分钟档位（默认 / 档位 / 自定义保留原值）；逗号列表 ↔ 标签；固定选项多选标签 |

`preserveRouteParams(url)` keeps the existing `view` and `settings` level encoding when the host edits unrelated URL metadata; explicit `searchParamRoute().href()` changes its own route and preserves the other. / `preserveRouteParams(url)` 在宿主修改其他 URL 元数据时保留已有层级编码；`searchParamRoute().href()` 只改自身路由并保留另一路由。

| `Notifications` | Shared | React portal | Top-right transient error stack; independent six-second expiry, labelled close buttons, pagehide and unmount cleanup. Action banners remain caller-owned. |
| `DecisionFields` / `decisionPresentation` | Shared | Persisted decision presentation | Exact locale, language, then English; plain labelled fields and same-origin links. Submit the bound response value unchanged. |
