# UI 数据源

[English](ui-data-source.md) | 简体中文

[Intelligent UI 合同](intelligent-ui.zh-CN.md#ui-数据源)

本页是 UI 数据源合同的索引。完整规则在该节。Kind、provider 与实例类型、结果枚举和失败码位于 `@agnes/intelligent-ui-contract`。该包只依赖 `@agnes/extension-api` 与 `@agnes/protocol`。没有单独的数据源包，该 kind 也不是 `KindMap` 条目。

Surface 保存绑定 `{ "$source": "<id>", "params": {} }`。当数据源位于会话钉住的 generation 目录中、其包仍然启用，且信任决定的 `capabilityHash` 仍覆盖该快照和精确 atom `uiData:<permission>` 时，Host 才解析它。`permission` 是清单列表 `agnes.capabilities.uiData` 中的名称。该列表不接受 `*` 通配。解析使用信任或加载时由 `capabilityHash` 密封的声明。之后改包目录不会新增 atom。Ledger 保存绑定和哈希。冷恢复重新查询，失败则降级。解析后的行只走已认证读取。`details.surface` 保留绑定。

被禁用或失去信任的数据源，也会拒绝依赖它的动作。数据源结果形状不符时降级该组件。字面量形状不符仍拒绝整个 surface。浏览器在渲染就绪结果之前执行既有的结构检查。
