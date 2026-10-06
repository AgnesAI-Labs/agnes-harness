# A 线原语登记

| 组件 | 来源线 | antd 对应件 | 暴露约定 |
| --- | --- | --- | --- |
| `Button` | A | `Button` | 保留 antd `ButtonProps`，追加 `agnes-ui-button` 基础类 |
| `Dialog` | A | `Modal` | 保留 antd `ModalProps`，追加 `agnes-ui-dialog` 基础类 |
| `Field` | A | 原生 label | 语义 label、hint、error；允许透传 label 属性 |
| `NotificationHost` | A | `notification` | 只暴露 `NotificationHost` + `Notifier`，不转发 antd 的 `ArgsProps`；宿主给 `{ text, kind? }`，组件补 `placement: topRight`、`duration: 6`、`closable`、`role: alert`，根节点带 `agnes-ui-notification` 基础类；文案由调用方提供，组件不内置语言包——antd 自带的只有关闭按钮的 aria-label，中文界面下仍是英文（已知项） |
| `Select` | A | `Select` | 保留 antd 泛型 `SelectProps`，追加 `agnes-ui-select` 基础类 |
| `Switch` | A | `Switch` | 保留 antd `SwitchProps`，追加 `agnes-ui-switch` 基础类 |
| `Tabs` | A | `Tabs` | 保留 antd `TabsProps`，追加 `agnes-ui-tabs` 基础类 |
| `Tooltip` | A | `Tooltip` | 保留 antd `TooltipProps`，不转发渲染函数式 `title` 之外的扩展；基础类加在弹层根节点，走 `rootClassName`——antd 的 Tooltip 不消费 `className`，与 `Button`/`Tabs` 的挂法不同 |

# C 线原语登记

| 组件 | 来源线 | antd 对应件 | 暴露约定 |
| --- | --- | --- | --- |
| `StateLights` | C | 不采用 antd（Badge/Tag） | DOM 契约沿用 `.state-lights` 皮肤（data-tone 由 CSS token 决定）；antd 徽标会破坏现有红绿灯样式与特异性 ≤(0,1,0) 的皮肤规则 |
| `StateSwitch` | C | 不采用 antd（Switch） | `role="switch"` 行内动作语义 + `.switch` 皮肤 + stopPropagation 保真；antd Switch 的 DOM/样式/事件模型与列表行交互契约不符 |
