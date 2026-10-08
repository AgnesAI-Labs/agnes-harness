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

| `SettingsPage` / `SettingsCard` | A | 模型与账户布局 | 标题、说明、操作区和卡片栈；共享主题间距 |
| `SettingsState` | A | 共享状态 | 空白、加载、错误和成功；live region |
| `SettingsInput` / `SettingsTextArea` / `SettingsSelect` | A | 账户表单原生控件 | 表单语义、ref 与主题 token；不暴露外部 UI 库 |
| `ConversationCardLayout` | A | 会话卡片布局 | 标题、操作、ready/loading/empty/error/disabled；保留调用方稳定 test id 与语义角色 |
| `createSettingsIcon` | A | 原生设置导航图标 | 分类图标共用 `icon` 皮肤钩子和主题尺寸；装饰性图标不进入无障碍名称 |
