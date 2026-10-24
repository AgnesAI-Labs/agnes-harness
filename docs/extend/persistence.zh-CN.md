# 持久化提供器

[English](persistence.md) | 简体中文

[作者工具包](README.zh-CN.md) · [安全](../guide/security.zh-CN.md) · [会话](../guide/sessions.zh-CN.md)

完整提供器可以替代整个 Host 的 SQLite。通过 `@agnes/extension-api` 的 `definePersistenceProvider` 定义并导出 `persistenceProvider`，声明 `state: { effect: 'restart-required' }` 和能力 `{ ledger: true, metadata: true, childControl: true, reclaim: true, integrity: true }`，并提供相应方法和端口。缺失能力时拒绝启动并关闭候选存储。专门依赖 SQL 的扩展可使用可选的 `sqlite: { dialect: 'sqlite', tables(owner) }`。

[JSONL 示例](../../examples/persistence/) 用 Node 内置模块和现有 `@agnes/system-node` 同步接口实现完整端口，兼顾 Windows、macOS 和 Linux。独立打包时需包含其原生依赖。先安装、启用该包，再在用户配置选择 `providers.persistence: { provider: jsonl }`。省略时仍使用 SQLite。设置 → 提供器展示当前后端和能力；切换重启后生效，原会话和文件仍归原提供器。

提供器可以返回可选 `open().recovery: { diagnosticId, quarantineFile, validThroughSeq }`，但必须先持久隔离损坏字节并保留有效前缀。在同一恢复事务内持久保存禁止重放的取消/失败围栏：即使 Host 处理报告前崩溃，在途副作用也不得重新执行。Host 关闭在途操作并记录本地化恢复诊断。不得丢弃校验有效的后续事件，也不得将此入口用于格式迁移。

Core 冷打开检查序号/链结构并只哈希尾部，随后自动后台哈希完整前缀，不阻塞普通工作。仅在完整哈希成功后写 verified-head checkpoint；证据型决策、最终 verifier 门和审计导出等待校验。损坏会封存会话、删除 checkpoint 并保留证据。提供方可通过 `readIntegrityFailure` / `writeIntegrityFailure` 持久化已知损坏，使后续打开在后台校验前就拒绝。审计 RPC、状态字段和精确保证见[会话指南](../guide/sessions.zh-CN.md)。

## 包存储与兼容

默认用量计费、refine 提案、MCP 索引、审批授权和锁定包操作回执均使用按所有者隔离的 metadata。包 seam 使用 `adapters.storage.namespace(name)`；Host 绑定所有者，包不能通过该句柄选择其他所有者。值必须可序列化为 JSON，读取返回独立副本。`transaction(fn)` 同步且原子，抛错或返回 Promise 会回滚。子任务身份和树预算仍归 `childControl`，过期租约及操作状态检查归 `reclaim`。

包 seam 必须收到 `adapters.storage.namespace(name)`：Host 始终提供，手工构造的 seam 视图也必须提供。包状态保存在该命名空间的 metadata 中，没有 SQL 回退（`storage.sql` 已在扩展 API 5.0.0 中移除，见[变更记录](../../packages/extension-api/docs/CHANGELOG.md)）。`adapters.storage.table(name)` 仅保留给声明 SQL 支持的扩展，非 SQL 后端会明确拒绝。SQLite 内置 provider 在 `sessions.db` 的 `PRAGMA user_version` 中统一标记数据目录格式，覆盖账本、子任务控制与插件表。不兼容存储在打开前以 `E_DATA_DIR_STALE` 或 `E_DATA_DIR_NEWER` 拒绝；见[重置与升级](../guide/install.zh-CN.md#数据格式与升级)。不再从旧表复制任何数据：用量、refine、审批授权和锁定包操作回执只从 metadata 读取，MCP 索引启动时重建。存储发现旧布局时会拒绝打开，并在报错中指明需要删除或重置的对象，而不是迁移。旧数据不会被转换，删除前请先备份。

运行 `@agnes/extension-api/testkit/persistence-contract` 的 `persistenceContract` 和 `persistenceHostContract`，仅声明 SQL 时运行 `persistenceSqliteContract`。还需通过真实 Host 注册端口运行 `persistenceConformance`，验证完整回合和冷恢复。持久化方法没有 `AbortSignal`，应明确标记不支持取消，同时验证卸载等待在途操作结束。

## 在提供器之间迁移会话

通过受支持的导出/导入迁移会话历史。迁移不复制提供器文件，也不向目标授予权限。先让来源停止执行任务，备份完整 home，使用来源提供器导出所需会话：

```sh
AGH_HOME=/path/to/source-home node agnes.mjs export SESSION_ID --format agnes -o session.jsonl
```

停止来源进程。准备独立目标 home，在其中启用并配置目标提供器。使用未占用的新 key 导入：

```sh
AGH_HOME=/path/to/destination-home node agnes.mjs import session.jsonl --from auto --key agnes:local:default:import:dm:migrated
```

打开导入会话，检查消息及导入警告，执行合成后续请求，停止并重启目标后核验历史。验收前保留来源 home 和导出文件。回退时停止目标，以原配置和提供器重启来源。在同一目录直接切换 id 不构成迁移。

原生导入记录来源并创建新会话，不恢复活动写者、审批、永久授权、子任务预算/预留身份、插件世代固定关系或工作区所有权。需要子任务历史时分别导出。通过受支持的 artifact 流程转移所需附件字节；会话导出不等于附件备份。目标端重新授权操作。完整提供器迁移需要覆盖这些域的专用离线转换器；本示例不宣称提供该转换器。
