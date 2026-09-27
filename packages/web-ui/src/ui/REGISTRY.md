# A 线原语登记

| 组件 | 来源线 | antd 对应件 | 暴露约定 |
| --- | --- | --- | --- |
| `Button` | A | `Button` | 保留 antd `ButtonProps`，追加 `agnes-ui-button` 基础类 |
| `Dialog` | A | `Modal` | 保留 antd `ModalProps`，追加 `agnes-ui-dialog` 基础类 |
| `Field` | A | 原生 label | 语义 label、hint、error；允许透传 label 属性 |
| `Select` | A | `Select` | 保留 antd 泛型 `SelectProps`，追加 `agnes-ui-select` 基础类 |
| `Switch` | A | `Switch` | 保留 antd `SwitchProps`，追加 `agnes-ui-switch` 基础类 |
| `Tabs` | A | `Tabs` | 保留 antd `TabsProps`，追加 `agnes-ui-tabs` 基础类 |

# C 线原语登记

| 组件 | 来源线 | antd 对应件 | 暴露约定 |
| --- | --- | --- | --- |
| `StateLights` | C | 不采用 antd（Badge/Tag） | DOM 契约沿用 `.state-lights` 皮肤（data-tone 由 CSS token 决定）；antd 徽标会破坏现有红绿灯样式与特异性 ≤(0,1,0) 的皮肤规则 |
| `StateSwitch` | C | 不采用 antd（Switch） | `role="switch"` 行内动作语义 + `.switch` 皮肤 + stopPropagation 保真；antd Switch 的 DOM/样式/事件模型与列表行交互契约不符 |
