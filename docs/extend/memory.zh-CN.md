# 记忆 providers

[English](memory.md) | 简体中文

每个会话选择并固定一个 **memory** provider。官方 `file@1.0.0` 由 `@agnes/base` 提供，实现在 `@agnes/memory-file`，只使用公开 [MemoryProvider 合同](../../packages/extension-api/src/memory.ts)。未安装记忆 provider 的部署保留原有行为。

插件注入 `providers`，以 `ctx.providers.register(memoryKind, enterpriseMemory)` 注册。导入 `memoryKind`、`MemoryProvider`、`ProviderPluginContext` 均从 `@agnes/extension-api`，不要依赖 Core 私有路径。

```ts
import { memoryKind, type MemoryProvider, type ProviderPluginContext } from '@agnes/extension-api'

export const enterpriseMemoryPlugin = {
  apply(ctx: ProviderPluginContext) {
    ctx.providers.register(memoryKind, enterpriseMemory)
  },
}
declare const enterpriseMemory: MemoryProvider
```

实现 `open({ home, workspaceRoot, sessionKey })` 返回 `MemorySession`。`snapshot(turn)` 通过普通请求 section 贡献有预算的索引，同轮重复调用必须使用同一修订。实时关闭策略不再贡献内容，并拒绝 Agent 后续读写。`files(fallback, source, signal, approve)` 包装普通文件工具：工作区路径交给 fallback，记忆路径执行受限读取、验证与原子写入。可选 `revision(path)` 为快照读取标记修订。`inspect/configure/readFile/editFile` 是明确的人工管理方法，独立于 Agent 关闭权限；`inspect` 只返回元数据，不返回正文。

配置档的 `providers.memory: { provider: enterprise, version: 1.0.0 }` 替换默认实现。明确选择不存在或无效实现时 fail closed，不回退文件 provider。安装多个实现不代表同时使用多个 store。知识库仍是多个独立 MCP、工具、Skill、FDE 能力，可与所选记忆共存。

`approve` 回调返回 `MemoryApprovalResult`：`{ status: 'approved' }`、真人拒绝的 `{ status: 'rejected' }`，或使用已有审批原因的 `{ status: 'unanswered', reason }`。询问模式要求精确且仅一次的决定：其他预设使用已验证真人的回答，完全访问使用持久化自动决定；缺少身份、agent 回答或未提供的 session/permanent 选项均无效。文件 provider 用 `MEMORY_APPROVAL_UNANSWERED` 保留原原因，不把断线变成拒绝或授权。

Core 已准入的文件调用中，平台持有的审批回调会在 provider 写入前阻止已拒绝或未答复的候选。Core 核对 proposal 的 session、turn 与 tool call 来源，将私有拒绝证明绑定到本次调用。工具返回带记忆诊断和 `effect: "none"` 的 `TOOL_REJECTED_BEFORE_EFFECT`，不发起 reconciliation、不 park。复制或插件自报的错误不携带该证明。provider 必须在任何 mutation 前 await 审批，且回调失败必须中止写入。已经准入写入、此前已有其他受控效果或另一个并发写入时不能声明无效果：CAS 冲突和文件提交后的失败仍为 unknown，不自动重放。exact 内容审核与未答复后的重新提案保持原状，不新增持久 memory continuation。

## 必须保持的行为

- Agent 默认关闭。询问模式在写入前审批精确文件候选，绑定 `baseHash`、`newHash`、完整 diff、会话/轮次；full-access 自动允许并记录每项精确提案，其他预设的宽泛授权不能代替该审批。拒绝、取消、冲突的候选不能注入。
- 同轮请求保持索引与主题修订。主题正文按需进入模型上下文；人工修改下轮可见。关闭在下次请求生效，即使该轮之前已生成快照。
- 存储上限与注入预算独立，两层与头部都计预算；有可见省略标记。超限整合失败不能截断索引文件。
- 审批后精确 CAS，串行写入、同步及原子替换完整文件，保留人工并发修改。先提交主题再链接索引，区分部分提交与没有写入。
- 普通工具仅访问该会话目录。Host 禁止原始文件及进程操作访问官方记忆树，拒绝未隔离执行；例外是显式 `full-access` 权限且没有可用 OS 边界时，命令不经隔离执行，官方 provider 以提示报告带外文件改动。企业 provider 需等效保护自己的后端，不通过 shell 或未认证管理暴露可写远端端口。
- 拒绝常见疑似凭据，说明检测局限；候选、索引、主题与回显记忆不进入诊断/遥测，只有结构计数、大小与写入来源。持久记忆不成为授权依据。

官方 **remembering** Skill 是通过公开 Skills 服务注册的官方运行时贡献，指导普通文件工具，不建立逐条记忆管理 API。AGENTS.md 与权威知识源优先，会话历史仍由 session-query 搜索。上限、编辑与隐私见[用户指南](../guide/memory.zh-CN.md)，生命周期见[插件注册](quickstart.zh-CN.md)。

`open` 应保持轻量；可选的 `close()` 在会话工作排空或管理操作结束后释放延迟打开的资源。
