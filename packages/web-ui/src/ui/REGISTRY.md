# A 线原语登记

| 组件 | 来源线 | antd 对应件 | 暴露约定 |
| --- | --- | --- | --- |
| `Button` | A | `Button` | 保留 antd `ButtonProps`，追加 `agnes-ui-button` 基础类 |
| `Dialog` | A | `Modal` | 保留 antd `ModalProps`，追加 `agnes-ui-dialog` 基础类 |
| `Field` | A | 原生 label | 语义 label、hint、error；允许透传 label 属性 |
| `Select` | A | `Select` | 保留 antd 泛型 `SelectProps`，追加 `agnes-ui-select` 基础类 |
| `Switch` | A | `Switch` | 保留 antd `SwitchProps`，追加 `agnes-ui-switch` 基础类 |
| `Tabs` | A | `Tabs` | 保留 antd `TabsProps`，追加 `agnes-ui-tabs` 基础类 |
