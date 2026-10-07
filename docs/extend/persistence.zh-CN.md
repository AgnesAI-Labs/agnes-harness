# 持久化提供器

[English](persistence.md) | 简体中文

[作者工具包](README.zh-CN.md) · [安全](../guide/security.zh-CN.md) · [会话](../guide/sessions.zh-CN.md)

完整提供器可以替代整个 Host 的 SQLite。通过 `@agnes/extension-api` 的 `definePersistenceProvider` 定义并导出 `persistenceProvider`，声明 `state: { effect: 'restart-required' }` 和能力 `{ ledger: true, metadata: true, childControl: true, reclaim: true, integrity: true }`，并提供相应方法和端口。缺失能力时拒绝启动并关闭候选存储。专门依赖 SQL 的扩展可使用可选的 `sqlite: { dialect: 'sqlite', tables(owner) }`。

[JSONL 示例](../../examples/persistence/) 用 Node 内置模块实现完整端口。先安装、启用该包，再在用户配置选择 `persistence: { provider: jsonl }`。省略时仍使用 SQLite。设置 → 提供器展示当前后端和能力；切换重启后生效，原会话和文件仍归原提供器。

## 包存储与兼容

默认用量计费、refine 提案、MCP 索引、审批授权和锁定包操作回执均使用按所有者隔离的 metadata。包 seam 使用 `adapters.storage.namespace(name)`；Host 绑定所有者，包不能通过该句柄选择其他所有者。值必须可序列化为 JSON，读取返回独立副本。`transaction(fn)` 同步且原子，抛错或返回 Promise 会回滚。子任务身份和树预算仍归 `childControl`，过期租约及操作状态检查归 `reclaim`。

旧 SQL 扩展仍可调用 `adapters.storage.table(name)`，非 SQL 后端会明确拒绝。仅提供表的旧 seam 嵌入者保持兼容，官方 Host 默认选择 metadata。SQLite 保持账本和子任务格式兼容，将旧所有者文件中的 KV 一次性复制到独立 metadata 文件。用量/refine 数据一次性迁移，MCP 索引启动时重建。Host 授权及操作回执先通过现有严格 schema 和行校验，再原子复制。保留旧 SQL 文件用于回退核验；新 KV 更新不反写旧表，降级必须显式迁移数据。

运行 `@agnes/extension-api/testkit/persistence-contract` 的 `persistenceContract` 和 `persistenceHostContract`，仅声明 SQL 时运行 `persistenceSqliteContract`。还需通过真实 Host 注册端口运行 `persistenceConformance`，验证完整回合和冷恢复。持久化方法没有 `AbortSignal`，应明确标记不支持取消，同时验证卸载等待在途操作结束。

## 在提供器之间迁移会话

通过受支持的导出/导入迁移会话历史。迁移不复制提供器文件，也不向目标授予权限。先让来源停止执行任务，备份完整 home，使用来源提供器导出所需会话：

```sh
AGH_HOME=/path/to/source-home node packages/cli/dist/local/agnes.mjs export SESSION_ID --format agnes -o session.jsonl
```

停止来源进程。准备独立目标 home，在其中启用并配置目标提供器。使用未占用的新 key 导入：

```sh
AGH_HOME=/path/to/destination-home node packages/cli/dist/local/agnes.mjs import session.jsonl --from auto --key agnes:local:default:import:dm:migrated
```

打开导入会话，检查消息及导入警告，执行合成后续请求，停止并重启目标后核验历史。验收前保留来源 home 和导出文件。回退时停止目标，以原配置和提供器重启来源。在同一目录直接切换 id 不构成迁移。

原生导入记录来源并创建新会话，不恢复活动写者、审批、永久授权、子任务预算/预留身份、插件世代固定关系或工作区所有权。需要子任务历史时分别导出。通过受支持的 artifact 流程转移所需附件字节；会话导出不等于附件备份。目标端重新授权操作。完整提供器迁移需要覆盖这些域的专用离线转换器；本示例不宣称提供该转换器。
