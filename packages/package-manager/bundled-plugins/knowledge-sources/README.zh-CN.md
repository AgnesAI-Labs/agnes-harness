# @agnes/knowledge-sources

[English](README.md) | 简体中文

可选官方知识连接器插件。在内置插件目录中安装**知识来源**，审核能力后信任并显式启用。新 profile 不会自动安装或启用它。唯一的延迟加载工具仅在包含此插件的会话中可用。

配置和操作示例见[使用指南](../../../../docs/guide/knowledge-sources.zh-CN.md)。后端只消费公开的工具、服务、事件、projection、文件/制品端口与 profile managed resource，不增加 Core/Host 合同。Web 面板使用共享 web-ui 组件，卸载时释放注册。

- `knowledge_query({})`：列出此会话获授权的来源 ID。
- `knowledge_query({sourceId, query?})`：获取一次字面匹配的有限摘录与引用。
- `knowledge.history`：按会话返回来源列表和最近 32 条引用回执，实时核对权限与版本。
- `knowledge.preview({id})`：重新验证后，仅在原版本仍可读时返回当时的准确摘录。
- `knowledge.configure`：现有 managed resource 的 profile effect，需要操作员原生审批。默认配置为 `{ "sources": [] }`。

首批连接器为显式选择的本地文档和**离线进程内 synthetic API**。两者不开放任意 API 地址，不加载凭据，不写业务系统。生产远程适配器须使用审核过的 managed transport 与凭据引用，不能暴露凭据值。知识不属于 memory provider，不改变记忆、系统指令、Skills 或 AGENTS.md。

上限：16 个来源，每个来源 32 个会话授权，文档 64 KiB，摘录 2 KiB UTF-8，每会话保留 32 条元数据回执。来源原文保持 untrusted 并按纯文本展示。可检查 revision、全文/摘录 SHA-256、摘录位置和获取时间。审查制品仅包含元数据；撤权不能抹除此前已进入会话的文字。回执通过 Host 绑定的工作区和会话 key 隔离，存于 Host 拥有的 profile/package store。这是来源 ACL，不是新增企业多租户系统。

从仓库根运行：

```sh
pnpm exec tsc -b packages/package-manager/bundled-plugins/knowledge-sources packages/package-manager/bundled-plugins/knowledge-sources/tsconfig.test.json
pnpm exec vitest run packages/package-manager/bundled-plugins/knowledge-sources/test --project fast --maxWorkers=1
pnpm --filter @agnes/knowledge-sources gen:check
```

配置与 manifest 合同由 `src/contracts.ts` 维护；修改后运行 `pnpm --filter @agnes/knowledge-sources manifest` 同步包能力声明。代码为独立 Apache-2.0 实现；此功能未导入其他 harness 的代码、提示词、资产或依赖。
