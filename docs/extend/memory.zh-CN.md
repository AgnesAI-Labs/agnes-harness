# 记忆 providers

[English](memory.md) | 简体中文

每个会话选择并固定一个 **memory** provider。官方 `file@1.0.0` 由 `@agnes/base` 提供，实现在 `@agnes/memory-file`，只使用公开 [MemoryProvider 合同](../../packages/extension-api/src/memory.ts)。未安装记忆 provider 的部署保留原有行为。

插件注入 `providers`，以 `ctx.providers.register(memoryKind, '@acme/memory', enterpriseMemory)` 注册。导入 `memoryKind`、`MemoryProvider`、`ProviderPluginContext` 均从 `@agnes/extension-api`，不要依赖 Core 私有路径。

实现 `open({ home, workspaceRoot, sessionKey })` 返回 `MemorySession`。`snapshot(turn)` 通过普通请求 section 贡献有预算的索引，同轮重复调用必须使用同一修订。实时关闭策略不再贡献内容，并拒绝 Agent 后续读写。`files(fallback, source, signal, approve)` 包装普通文件工具：工作区路径交给 fallback，记忆路径执行受限读取、验证与原子写入。可选 `revision(path)` 为快照读取标记修订。`inspect/configure/readFile/editFile` 是明确的人工管理方法，独立于 Agent 关闭权限；`inspect` 只返回元数据，不返回正文。

包 `config.memory: { provider: "enterprise", version: "1.0.0" }` 替换默认实现。多个包同时选择记忆会拒绝；明确选择不存在或无效实现时 fail closed，不回退文件 provider。安装多个实现不代表同时使用多个 store。知识库仍是多个独立 MCP、工具、Skill、FDE 能力，可与所选记忆共存。

## 必须保持的行为

- Agent 默认关闭。询问模式在写入前审批精确文件候选，绑定 `baseHash`、`newHash`、完整 diff、会话/轮次；full-access 或宽泛授权不能代替审批。拒绝、取消、冲突的候选不能注入。
- 同轮请求保持索引与主题修订。主题正文按需进入模型上下文；人工修改下轮可见。关闭在下次请求生效，即使该轮之前已生成快照。
- 存储上限与注入预算独立，两层与头部都计预算；有可见省略标记。超限整合失败不能截断索引文件。
- 审批后精确 CAS，串行写入、同步及原子替换完整文件，保留人工并发修改。先提交主题再链接索引，区分部分提交与没有写入。
- 普通工具仅访问该会话目录。Host 禁止原始文件及进程操作访问官方记忆树，拒绝未隔离执行。企业 provider 需等效保护自己的后端，不通过 shell 或未认证管理暴露可写远端端口。
- 拒绝常见疑似凭据，说明检测局限；候选、索引、主题与回显记忆不进入诊断/遥测，只有结构计数、大小与写入来源。持久记忆不成为授权依据。

官方 **remembering** Skill 是通过公开 Skills 服务注册的官方运行时贡献，指导普通文件工具，不建立逐条记忆管理 API。AGENTS.md 与权威知识源优先，会话历史仍由 session-query 搜索。上限、编辑与隐私见[用户指南](../guide/memory.zh-CN.md)，生命周期见[插件注册](quickstart.zh-CN.md)。

`open` 应保持轻量；可选的 `close()` 在会话工作排空或管理操作结束后释放延迟打开的资源。
