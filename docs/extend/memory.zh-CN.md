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

## 可选的受管段落（5.2.0）

Extension API 5.2.0 新增三个可选成员。不实现它们的 provider 照常编译、行为不变；Host 不会把任务经验保存到它的记忆里。

- `open` 可能收到 `validity`，即只读的 `MemoryValidityView`。`validity(paragraphId)` 同步回答 `valid`、`expired` 或 `unknown`，不抛错；任何回答可能变化时 `revision()` 随之变化。保存受管段落的 provider 要在快照和智能体的所有读取中略去 `expired` 与 `unknown` 的段落。只有存储文件里有受管段落时，才把略去的集合和 `revision()` 计入快照 revision；没有受管段落时，revision 与快照字节保持不变。没有 `validity` 视图时，所有受管段落对智能体一律略去。人工的 `readFile`/`editFile`/`inspect` 仍返回存储原文。
- `MemorySession.paragraphs?(source, signal)` 返回 `MemoryParagraphPort`，它读当前存储文件而不是某个 turn 的快照。`list()` 返回 `{ hash, paragraphs }`，hash 指明所读的文件。`propose(changes, baseHash?)` 接受一条或一组修改（`{ op: 'put', id, text }` 插入或原位替换，`{ op: 'remove', id }` 删除），返回同时应用全部修改的一个提案；任一成员无法应用（例如删除文件里没有的 id，或同一 id 出现两次）时整次拒绝；给了 `baseHash` 而存储文件此后已变时，以 `MEMORY_CONFLICT` 拒绝。`commit(proposal, admission?)` 以 `proposal.baseHash` 做一次 CAS 写入整个提案（过时则 `MEMORY_CONFLICT`），并仍按工作区记忆模式：off 拒绝；ask 由调用方事先取得对该确切提案的批准。被拒绝时什么都不写。有这个方法即表示支持；`@agnes/extension-api/testkit` 的 `memoryParagraphConformance` 在新的存储上检查这些规则。后台写入把 `source.maintenance` 设为运行 id，`source.turn` 设为证据所在的 turn。
- 记忆文件端口上的 `replaceExact?(path, oldText, newText)` 在存储文件里替换 `oldText` 唯一的一处精确匹配，其余字节原样保留，包括智能体视图略去的内容。它与 `write` 走同一条审阅、审批与 CAS 链路。只有所选 provider 的文件端口有它时，Core 才把它作为 `ToolContext.fs.replaceExact` 交给工具，并按写入计；对受管记忆文件以外的路径可以拒绝。

## 可选的用户记忆段落（5.3.0）

Extension API 5.3.0 为用户记忆（每个工作区都可能读取的记忆）新增两个可选成员。没有它们的 provider 行为不变，Host 也不会通过它把任务经验晋升到用户记忆。

- `open` 可能收到 `userValidity`：用于用户记忆中受管段落的 `MemoryValidityView`，规则与 `validity` 相同。支持它的 provider 先向智能体展示人写的用户记忆，之后只展示仍有效的段落，因此用户记忆预算总是先截掉保存的文字，而不是人写的内容。没有标记的用户记忆文件按原样展示，revision 也不变。
- `MemorySession.userParagraphs?(source, signal)` 返回作用于用户记忆索引的 `MemoryParagraphPort`。它不受工作区记忆模式影响：智能体仍然不能写用户记忆，何时可以写入由 Host 自己判定。人写内容、有效段落与新写入段落合计超出智能体看到的用户记忆预算，或索引会超过大小或行数上限时，`propose` 以 `MEMORY_USER_BUDGET` 拒绝；它从不为腾出空间而截断、合并或删除任何内容。凭据形状的内容与工作区记忆一样以 `MEMORY_SECRET_LIKE_CONTENT` 拒绝。人写内容与标记行从不改动。`memoryParagraphConformance` 可以像检查 `paragraphs` 一样检查它。

- Agent 默认关闭。询问模式在写入前审批精确文件候选，绑定 `baseHash`、`newHash`、完整 diff、会话/轮次；full-access 自动允许并记录每项精确提案，其他预设的宽泛授权不能代替该审批。拒绝、取消、冲突的候选不能注入。
- 同轮请求保持索引与主题修订。主题正文按需进入模型上下文；人工修改下轮可见。关闭在下次请求生效，即使该轮之前已生成快照。
- 存储上限与注入预算独立，两层与头部都计预算；有可见省略标记。超限整合失败不能截断索引文件。
- 审批后精确 CAS，串行写入、同步及原子替换完整文件，保留人工并发修改。先提交主题再链接索引，区分部分提交与没有写入。
- 普通工具仅访问该会话目录。Host 禁止原始文件及进程操作访问官方记忆树，拒绝未隔离执行；例外是显式 `full-access` 权限且没有可用 OS 边界时，命令不经隔离执行，官方 provider 以提示报告带外文件改动。企业 provider 需等效保护自己的后端，不通过 shell 或未认证管理暴露可写远端端口。
- 拒绝常见疑似凭据，说明检测局限；候选、索引、主题与回显记忆不进入诊断/遥测，只有结构计数、大小与写入来源。持久记忆不成为授权依据。

官方 **remembering** Skill 是通过公开 Skills 服务注册的官方运行时贡献，指导普通文件工具，不建立逐条记忆管理 API。AGENTS.md 与权威知识源优先，会话历史仍由 session-query 搜索。上限、编辑与隐私见[用户指南](../guide/memory.zh-CN.md)，生命周期见[插件注册](quickstart.zh-CN.md)。

`open` 应保持轻量；可选的 `close()` 在会话工作排空或管理操作结束后释放延迟打开的资源。
