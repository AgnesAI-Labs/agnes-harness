# Plugin purpose content proposal

English | [简体中文](CONTENT.zh-CN.md)

[Design](DESIGN.md) · [设计](DESIGN.zh-CN.md)

Proposed author-owned metadata, not a runtime lookup table. English text is the default; Chinese text belongs in `locales.zh-CN`. Each row below gives exact summary copy. Descriptions in implementation will add scope and prerequisites without stronger claims.

## Official extension manifests (37)

| Manifest ID | Category | Display name (en / zh-CN) | Summary (en) | Summary (zh-CN) |
| --- | --- | --- | --- | --- |
| `agnes/approval-policy` | Safety & Approval | Approval rules / 审批规则 | Decides which tool actions need approval under the selected session policy. | 按会话策略判断哪些工具操作需要先获得批准。 |
| `agnes/artifacts-local` | Developer | Local artifacts / 本地附件存储 | Stores tool outputs and attachments locally so they can be retrieved later. | 在本地保存工具产物和附件，便于之后查看与取回。 |
| `agnes/budget` | Observability | Usage accounting / 用量记录 | Records model usage and cost estimates to help track a task's spending. | 记录模型用量与费用估算，帮助掌握任务开销。 |
| `agnes/compaction` | Memory & Context | Conversation compaction / 对话压缩 | Lets the agent shorten a long conversation to make room for continuing work. | 让 Agent 压缩过长的对话，为继续处理任务腾出上下文空间。 |
| `agnes/computer-use` | Tools | Computer actions / 电脑操作 | Lets the agent inspect the screen and operate supported desktop applications. | 让 Agent 查看屏幕并操作受支持的桌面应用。 |
| `agnes/context-rules` | Memory & Context | Workspace instructions / 工作区规则 | Includes relevant workspace instructions when the agent works with project files. | 在 Agent 处理项目文件时带入相关工作区规则。 |
| `agnes/deliverables` | UI | Deliverables / 交付成果 | Makes the agent's output files available to open or download from the conversation. | 把 Agent 生成的文件呈现在对话中，方便打开或下载。 |
| `agnes/fs-checkpoint` | Safety & Approval | File checkpoints / 文件检查点 | Saves file checkpoints so supported workspace changes can be inspected and rewound. | 保存文件检查点，便于检查和回退受支持的工作区改动。 |
| `agnes/goal` | Agent Loop | Task goals / 任务目标 | Keeps an explicit task goal and its progress visible while the agent continues working. | 在 Agent 持续工作时跟踪明确的任务目标，并展示进度。 |
| `agnes/hooks-runner` | Integrations | Workflow hooks / 工作流钩子 | Runs configured commands or HTTP hooks at selected stages of an agent task. | 在任务的指定阶段执行已配置的命令或 HTTP 钩子。 |
| `agnes/intelligent-ui` | UI | Interactive task forms / 交互任务表单 | Lets the agent present forms and interactive views for people to review and act on. | 让 Agent 展示表单与交互视图，供用户查看并执行操作。 |
| `agnes/interaction` | Tools | User questions / 向用户提问 | Lets the agent ask focused questions and continue with the user's answers. | 让 Agent 提出明确的问题，并根据用户回答继续工作。 |
| `agnes/jobs` | Tools | Background jobs / 后台任务 | Lets the agent inspect and control background commands and interactive terminals. | 让 Agent 查看和控制后台命令及交互终端。 |
| `agnes/jobs-web` | UI | Jobs and terminal controls / 任务与终端控制 | Connects Web job and terminal controls to the session's background processes. | 把 Web 中的任务与终端控件连接到会话的后台进程。 |
| `agnes/loop-hygiene` | Agent Loop | Progress checks / 执行进度检查 | Detects repeated writes and stalled work, then requests revision or escalation within configured limits. | 发现重复写入和停滞的执行，并按配置限制要求修正或升级处理。 |
| `agnes/mcp-resources` | Integrations | MCP reference materials / MCP 参考资料 | Lets the agent list and read reference materials supplied by connected MCP servers. | 让 Agent 列出和读取已连接 MCP 服务提供的参考资料。 |
| `agnes/mcp-search` | Integrations | Tool discovery / 工具发现 | Helps the agent find connected MCP tools and inspect their inputs before use. | 帮助 Agent 找到已连接的 MCP 工具，并在使用前查看输入要求。 |
| `agnes/mcp-server` | Integrations | MCP connections / MCP 连接 | Connects configured MCP servers and manages their tools, resources and reconnections. | 连接已配置的 MCP 服务，管理其工具、资源和断线重连。 |
| `agnes/plan-mode` | Safety & Approval | Plan approval / 计划审批 | Lets the agent prepare a plan and request approval before leaving plan mode. | 让 Agent 先制定计划，并在退出计划模式前请求批准。 |
| `agnes/plugin-creator` | Developer | Plugin drafting / 插件编写 | Helps the agent draft and test plugins, then submit them for review and installation. | 帮助 Agent 编写、测试插件，并提交审核与安装。 |
| `agnes/principals-local` | Safety & Approval | Local machine owner / 本机所有者 | Treats callers as one local machine owner for single-user deployments. | 在单用户部署中，将调用方统一视为本机所有者。 |
| `agnes/privacy` | Safety & Approval | Telemetry consent / 遥测授权 | Controls supported trajectory exports using session consent and sensitive-text redaction. | 根据会话授权和敏感文本脱敏规则控制受支持的轨迹导出。 |
| `agnes/refine` | Memory & Context | Reviewed improvements / 改进提案 | Lets the agent propose evidence-backed changes to prompts, memory, Skills and child-agent definitions. | 让 Agent 根据执行证据提出提示、记忆、技能和子 Agent 定义的改进建议。 |
| `agnes/sandbox` | Safety & Approval | Execution boundaries / 执行边界 | Supplies the default policy for checking command execution against configured isolation boundaries. | 提供默认策略，按配置的隔离边界检查命令执行。 |
| `agnes/schedule` | Integrations | Scheduled tasks / 定时任务 | Lets the agent create and manage tasks that run at scheduled times. | 让 Agent 创建和管理按指定时间运行的任务。 |
| `agnes/session-query` | Memory & Context | Session history search / 会话历史检索 | Lets the agent search readable session history and inspect the events behind a result. | 让 Agent 检索有权读取的会话历史，并查看结果对应的事件。 |
| `agnes/skills` | Memory & Context | Reusable playbooks / 可复用操作手册 | Lets the agent discover and read reusable Skills and their supporting files. | 让 Agent 发现和读取可复用技能及其配套文件。 |
| `agnes/subagent` | Collaboration | Child-agent coordination / 子 Agent 协作 | Lets the agent delegate work to child agents, exchange messages and collect their results. | 让 Agent 分派子任务、与子 Agent 交换消息并收集结果。 |
| `agnes/subagent-acp` | Collaboration | ACP child agents / ACP 子 Agent | Connects an external ACP agent process to handle delegated tasks. | 连接外部 ACP Agent 进程来处理分派的任务。 |
| `agnes/subagent-claude-code` | Collaboration | Claude Code child agents / Claude Code 子 Agent | Uses a configured Claude Code process to handle delegated coding tasks. | 使用已配置的 Claude Code 进程处理分派的编程任务。 |
| `agnes/subagent-codex` | Collaboration | Codex child agents / Codex 子 Agent | Uses a configured Codex process to handle delegated coding tasks. | 使用已配置的 Codex 进程处理分派的编程任务。 |
| `agnes/subagent-sdk` | Collaboration | Built-in child agents / 内置子 Agent | Runs delegated tasks in child sessions through AGH's built-in agent engine. | 通过 AGH 内置 Agent 引擎，在子会话中执行分派的任务。 |
| `agnes/time-context` | Memory & Context | Current time context / 当前时间上下文 | Includes the current time and timezone so the agent can interpret time-sensitive requests. | 带入当前时间与时区，帮助 Agent 理解与时间相关的请求。 |
| `agnes/tools-core` | Tools | Files and commands / 文件与命令 | Lets the agent read and edit files, run shell commands and maintain a task list. | 让 Agent 读写文件、执行 shell 命令并维护任务清单。 |
| `agnes/tools-search` | Tools | Project file search / 项目文件搜索 | Lets the agent find project files and search their contents. | 让 Agent 查找项目文件并检索文件内容。 |
| `agnes/tools-web` | Tools | Web research / 网页检索 | Lets the agent search the web and fetch readable page content. | 让 Agent 搜索网页并获取可读的页面内容。 |
| `agnes/workflow` | Collaboration | Coordinated workflows / 协同工作流 | Lets the agent run multi-step tool and child-agent workflows and inspect their progress. | 让 Agent 执行由工具和子 Agent 组成的多步骤工作流，并查看进度。 |

## Example packages (56 files, including version and failure fixtures)

All paths are relative to `examples/`. Version variants share purpose text; deliberately broken fixtures have their own explicit failure-purpose summary. The demos package is a runnable demonstration harness, not an installable business plugin. Persistence and Docker export provider libraries; descriptions must not imply that installation alone selects them.

| package.json directory | Package | Category | Display name (en / zh-CN) | Summary (en) | Summary (zh-CN) |
| --- | --- | --- | --- | --- | --- |
| `bundles/research` | `@agnes-example/research-bundle` | Agent Loop | Research bundle / 研究组合包 | Demonstrates a read-only research agent assembled from a task graph and profile presets. | 演示如何用任务图和配置预设组合一个只读研究 Agent。 |
| `community/dag-loop-adapter` | `@community/dag-loop-adapter` | Agent Loop | Task graph and model adapter / 任务图与模型适配器 | Demonstrates a task-graph agent paired with a deterministic local model adapter. | 演示任务图 Agent 如何搭配确定性的本地模型适配器。 |
| `community/mcp-skills` | `@community/mcp-skills` | Integrations | MCP and Skills example / MCP 与技能示例 | Demonstrates a local MCP tool and reference resource used with a packaged Skill. | 演示本地 MCP 工具和参考资源如何与随包技能配合使用。 |
| `community/tool-panel` | `@community/tool-panel` | UI | Tool result panel / 工具结果面板 | Demonstrates an echo tool with an interactive result panel. | 演示一个回声工具及其交互结果面板。 |
| `compaction/sliding-window` | `@agnes-example/compaction-sliding-window` | Memory & Context | Recent conversation window / 近期对话窗口 | Keeps recent turns and pinned context while dropping older context without a model call. | 保留近期对话与固定上下文，无需调用模型即可移除较早的上下文。 |
| `demos` | `@agnes-examples/demos` | Developer | Product demonstrations / 产品演示 | Runs isolated examples of business agents, retained versions and human-reviewed plugin growth. | 运行隔离的业务 Agent、旧版本保留和人工审核插件成长示例。 |
| `fde/code-review` | `@agnes-fde/code-review` | Developer | Code review example / 代码审查示例 | Reviews a synthetic patch for selected risks and prepares an evidence-linked report for a maintainer. | 检查模拟补丁中的特定风险，为维护者生成附带证据的审查报告。 |
| `fde/compliance-audit` | `@agnes-fde/compliance-audit` | Safety & Approval | Compliance evidence example / 合规证据示例 | Checks local sample evidence against a checklist and reports gaps for human follow-up. | 按清单检查本地样例证据，列出需要人工跟进的缺项。 |
| `fde/contract-review` | `@agnes-fde/contract-review` | Tools | Contract review example / 合同审查示例 | Reviews sample contract clauses in parallel and prepares a risk draft for a qualified reviewer. | 并行检查样例合同条款，为专业审核者准备风险草稿。 |
| `fde/crm-assistant` | `@agnes-fde/crm-assistant` | Integrations | CRM follow-up example / CRM 跟进示例 | Uses sample customer health and tickets to draft a renewal note and record it in a local CRM simulator after approval. | 根据样例客户健康度与工单起草续约备注，经批准后写入本地 CRM 模拟器。 |
| `fde/data-report` | `@agnes-fde/data-report` | Tools | Data report example / 数据报告示例 | Turns a sample CSV into calculated figures, charts and shareable reports. | 把样例 CSV 转成计算结果、图表和可分享的报告。 |
| `fde/device-inspection` | `@agnes-fde/device-inspection` | Integrations | Device inspection simulator / 设备巡检模拟器 | Checks simulated device state and prepares a constrained adjustment for human approval, with preview mode on by default. | 检查模拟设备状态并准备受限调整供人工批准，默认仅预览。 |
| `fde/finance-reconcile` | `@agnes-fde/finance-reconcile` | Tools | Ledger reconciliation example / 账目核对示例 | Compares sample bank and book ledgers, then prepares balanced simulated adjustments for approval. | 核对样例银行账与账簿，准备平衡的模拟调整分录供批准。 |
| `fde/knowledge-qa` | `@agnes-fde/knowledge-qa` | Memory & Context | Knowledge answer example / 知识问答示例 | Searches local sample documents and drafts an answer with source citations. | 检索本地样例文档，并起草带来源引用的回答。 |
| `fde/meeting-actions` | `@agnes-fde/meeting-actions` | Collaboration | Meeting actions example / 会议行动项示例 | Turns a sample meeting transcript into action items and drafts tasks for approval before simulated creation. | 把样例会议逐字稿转成行动项，起草任务并在模拟创建前请求批准。 |
| `fde/ops-runbook` | `@agnes-fde/ops-runbook` | Tools | Operations runbook example / 运维手册示例 | Reviews sample incidents, runs bounded diagnostics and requests approval before a simulated remediation. | 检查样例事件、执行受限诊断，并在模拟修复前请求批准。 |
| `fde/recruiting-screen` | `@agnes-fde/recruiting-screen` | Tools | Recruiting review example / 招聘审核示例 | Scores synthetic applications against a fixed rubric and prepares a report for human review. | 按固定标准评估模拟申请材料，并生成供人工审核的报告。 |
| `fde/support-triage` | `@agnes-fde/support-triage` | Agent Loop | Support triage example / 客服分流示例 | Classifies sample support tickets and requests approval before recording a simulated reply. | 对样例客服工单分类，并在记录模拟回复前请求批准。 |
| `loops/dag-loop` | `@agnes-example/dag-loop` | Agent Loop | Task graph Loop / 任务图 Loop | Runs a validated task graph, allowing independent tools to execute in parallel. | 按经过校验的任务图执行，允许独立工具并行运行。 |
| `loops/react-loop` | `@agnes-example/react-loop` | Agent Loop | Reasoning and tools Loop / 推理与工具 Loop | Alternates model reasoning and tool calls to carry a task through successive steps. | 交替执行模型推理与工具调用，逐步推进任务。 |
| `packages/acme-dashboard/v1` | `acme/dashboard` | UI | Sample dashboard / 样例仪表盘 | Demonstrates a separately served dashboard backed by a versioned plugin data service. | 演示由版本化插件数据服务支持的独立仪表盘页面。 |
| `packages/acme-dashboard/v2` | `acme/dashboard` | UI | Sample dashboard / 样例仪表盘 | Demonstrates a separately served dashboard backed by a versioned plugin data service. | 演示由版本化插件数据服务支持的独立仪表盘页面。 |
| `packages/client-multi-panel/v1` | `@agnes-examples/client-multi-panel` | UI | Multiple panels example / 多面板示例 | Demonstrates two independently owned workbench panels from one plugin package. | 演示一个插件包如何提供两个各自归属明确的工作台面板。 |
| `packages/client-multi-panel/v2` | `@agnes-examples/client-multi-panel` | UI | Multiple panels example / 多面板示例 | Demonstrates two independently owned workbench panels from one plugin package. | 演示一个插件包如何提供两个各自归属明确的工作台面板。 |
| `packages/client-panel/v1` | `@agnes-examples/client-panel` | UI | Workbench panel example / 工作台面板示例 | Demonstrates a workbench panel loaded from a versioned browser plugin. | 演示从版本化浏览器插件加载工作台面板。 |
| `packages/client-panel/v2` | `@agnes-examples/client-panel` | UI | Workbench panel example / 工作台面板示例 | Demonstrates a workbench panel loaded from a versioned browser plugin. | 演示从版本化浏览器插件加载工作台面板。 |
| `packages/client-service-panel/v1` | `@agnes-examples/client-service-panel` | UI | Service-backed panel example / 服务面板示例 | Demonstrates a workbench panel reading a plugin service through the restricted browser bridge. | 演示工作台面板如何通过受限浏览器桥接读取插件服务。 |
| `packages/client-service-panel/v2` | `@agnes-examples/client-service-panel` | UI | Service-backed panel example / 服务面板示例 | Demonstrates a workbench panel reading a plugin service through the restricted browser bridge. | 演示工作台面板如何通过受限浏览器桥接读取插件服务。 |
| `packages/cordis-greeting` | `@agnes-examples/cordis-greeting` | Developer | Greeting service example / 问候服务示例 | Demonstrates a configurable greeting service with automatic cleanup when its plugin unloads. | 演示可配置的问候服务，以及插件卸载时的自动清理。 |
| `packages/dsh-input-controls/broken` | `@agnes-examples/dsh-input-controls` | UI | Composer controls example (failure fixture) / 输入区控件示例（失败测试包） | Deliberately fails composer controls example validation or loading to demonstrate refusal and recovery. | 故意使输入区控件示例的校验或加载失败，用于演示拒绝和恢复。 |
| `packages/dsh-input-controls/v1` | `@agnes-examples/dsh-input-controls` | UI | Composer controls example / 输入区控件示例 | Demonstrates extra controls beside the chat input and their removal when disabled. | 演示聊天输入框旁的附加控件及其停用后的清理。 |
| `packages/dsh-input-controls/v2` | `@agnes-examples/dsh-input-controls` | UI | Composer controls example / 输入区控件示例 | Demonstrates extra controls beside the chat input and their removal when disabled. | 演示聊天输入框旁的附加控件及其停用后的清理。 |
| `packages/dsh-model-picker-a/broken` | `@agnes-examples/dsh-model-picker-a` | UI | Primary model entry example (failure fixture) / 主模型入口示例（失败测试包） | Deliberately fails primary model entry example validation or loading to demonstrate refusal and recovery. | 故意使主模型入口示例的校验或加载失败，用于演示拒绝和恢复。 |
| `packages/dsh-model-picker-a/v1` | `@agnes-examples/dsh-model-picker-a` | UI | Primary model entry example / 主模型入口示例 | Demonstrates the preferred model-entry panel when multiple plugins compete for the same input slot. | 演示多个插件竞争同一输入区位置时优先显示的模型入口面板。 |
| `packages/dsh-model-picker-a/v2` | `@agnes-examples/dsh-model-picker-a` | UI | Primary model entry example / 主模型入口示例 | Demonstrates the preferred model-entry panel when multiple plugins compete for the same input slot. | 演示多个插件竞争同一输入区位置时优先显示的模型入口面板。 |
| `packages/dsh-model-picker-b/broken` | `@agnes-examples/dsh-model-picker-b` | UI | Fallback model entry example (failure fixture) / 备用模型入口示例（失败测试包） | Deliberately fails fallback model entry example validation or loading to demonstrate refusal and recovery. | 故意使备用模型入口示例的校验或加载失败，用于演示拒绝和恢复。 |
| `packages/dsh-model-picker-b/v1` | `@agnes-examples/dsh-model-picker-b` | UI | Fallback model entry example / 备用模型入口示例 | Demonstrates a model-entry panel that appears when the preferred contribution yields or is disabled. | 演示在首选贡献让出位置或停用后显示的备用模型入口面板。 |
| `packages/dsh-model-picker-b/v2` | `@agnes-examples/dsh-model-picker-b` | UI | Fallback model entry example / 备用模型入口示例 | Demonstrates a model-entry panel that appears when the preferred contribution yields or is disabled. | 演示在首选贡献让出位置或停用后显示的备用模型入口面板。 |
| `packages/dsh-tool-view/broken` | `@agnes-examples/dsh-tool-view` | UI | Tool display example (failure fixture) / 工具展示示例（失败测试包） | Deliberately fails tool display example validation or loading to demonstrate refusal and recovery. | 故意使工具展示示例的校验或加载失败，用于演示拒绝和恢复。 |
| `packages/dsh-tool-view/v1` | `@agnes-examples/dsh-tool-view` | UI | Tool display example / 工具展示示例 | Demonstrates custom displays for running tool calls and completed tool results. | 演示运行中工具调用与已完成工具结果的自定义展示。 |
| `packages/dsh-tool-view/v2` | `@agnes-examples/dsh-tool-view` | UI | Tool display example / 工具展示示例 | Demonstrates custom displays for running tool calls and completed tool results. | 演示运行中工具调用与已完成工具结果的自定义展示。 |
| `packages/hook-context-note` | `@agnes-examples/hook-context-note` | Developer | Context hook example / 上下文钩子示例 | Demonstrates adding a context note through a plugin-owned observation hook. | 演示通过归属插件的观察钩子加入上下文说明。 |
| `packages/hook-runner-takeover` | `@agnes-examples/hook-runner-takeover` | Developer | Hook replacement example / 钩子替换示例 | Demonstrates replacing the complete default hook row and refusing a marked sample tool call. | 演示替换整行默认钩子并拒绝一个带标记的样例工具调用。 |
| `packages/hot-service/broken` | `@agnes-examples/hot-service` | Developer | Upgradable text service (failure fixture) / 可升级文本服务（失败测试包） | Deliberately fails upgradable text service validation or loading to demonstrate refusal and recovery. | 故意使可升级文本服务的校验或加载失败，用于演示拒绝和恢复。 |
| `packages/hot-service/v1` | `@agnes-examples/hot-service` | Developer | Upgradable text service / 可升级文本服务 | Demonstrates upgrading a text-statistics service while earlier sessions retain their version. | 演示升级文本统计服务，同时让较早会话保留原版本。 |
| `packages/hot-service/v2` | `@agnes-examples/hot-service` | Developer | Upgradable text service / 可升级文本服务 | Demonstrates upgrading a text-statistics service while earlier sessions retain their version. | 演示升级文本统计服务，同时让较早会话保留原版本。 |
| `packages/hot-tool-plugin` | `@agnes-examples/hot-tool-plugin` | Tools | Text statistics tool / 文本统计工具 | Adds a sample text-statistics tool to demonstrate plugin installation and lifecycle. | 加入样例文本统计工具，用于演示插件安装与生命周期。 |
| `packages/skin-example/broken` | `@agnes-examples/skin-example-broken` | UI | Appearance example (failure fixture) / 外观示例（失败测试包） | Deliberately fails appearance example validation or loading to demonstrate refusal and recovery. | 故意使外观示例的校验或加载失败，用于演示拒绝和恢复。 |
| `packages/skin-example/v1` | `@agnes-examples/skin-example` | UI | Appearance example / 外观示例 | Demonstrates a selectable appearance theme with light and dark variants. | 演示可选外观主题及其浅色、深色变体。 |
| `packages/skins-builtin/broken` | `@agnes-examples/skins-builtin` | UI | Appearance presets (failure fixture) / 外观预设（失败测试包） | Deliberately fails appearance presets validation or loading to demonstrate refusal and recovery. | 故意使外观预设的校验或加载失败，用于演示拒绝和恢复。 |
| `packages/skins-builtin/v1` | `@agnes-examples/skins-builtin` | UI | Appearance presets / 外观预设 | Provides four sample appearance presets, each with light and dark variants. | 提供四套样例外观预设，每套均包含浅色和深色变体。 |
| `packages/skins-builtin/v2` | `@agnes-examples/skins-builtin` | UI | Appearance presets / 外观预设 | Provides four sample appearance presets, each with light and dark variants. | 提供四套样例外观预设，每套均包含浅色和深色变体。 |
| `persistence` | `@agnes-examples/persistence-jsonl` | Developer | JSONL persistence example / JSONL 持久化示例 | Stores session records and metadata in local JSONL files as an alternative persistence provider. | 作为替代持久化提供方，将会话记录与元数据保存到本地 JSONL 文件。 |
| `policies/read-only` | `@agnes-example/read-only-policy` | Safety & Approval | Read-only policy / 只读策略 | Allows read-only tools and refuses write or destructive tools, including in full-access sessions. | 允许只读工具，拒绝写入或破坏性工具，包括完全访问会话中的调用。 |
| `sandbox/docker` | `@agnes-examples/sandbox-docker` | Safety & Approval | Docker command sandbox / Docker 命令沙箱 | Runs commands in a Docker container and refuses execution when Docker is unavailable. | 在 Docker 容器中运行命令，并在 Docker 不可用时拒绝执行。 |
| `third-party-plugin` | `@example/agnes-echo-plugin` | Developer | Echo service example / 回声服务示例 | Demonstrates a configurable echo service in both in-process and isolated plugin rows. | 演示在进程内与隔离插件行中运行可配置的回声服务。 |

## Additional official package / row coverage

The 37 manifests are not the complete runtime inventory. Phase B must also annotate ordinary official package/row contracts (including provider rows) so the page does not stop at the manifest subset. These verified entry points supply additional purpose copy; row-specific metadata takes precedence over package metadata.

| Public contract owner | Category | Summary (en) | Summary (zh-CN) |
| --- | --- | --- | --- |
| `packages/loop-default/package.json` | Agent Loop | Runs the default agent workflow through model calls, tools, approvals and continuation. | 通过模型调用、工具、审批与续接执行默认 Agent 工作流。 |
| `packages/memory-file/package.json` | Memory & Context | Keeps reviewed workspace preferences in local files for later sessions, with agent access off by default. | 在本地文件中保留经审核的工作区偏好供后续会话使用，默认关闭 Agent 访问。 |
| `packages/observability/package.json` | Observability | Exports configured task telemetry to help operators diagnose execution and usage. | 导出已配置的任务遥测，帮助运维人员诊断执行与用量。 |
| `packages/package-manager/bundled-plugins/document-reader/package.json` | Tools | Reads PDF, Word, image text and ZIP attachments offline. | 离线读取 PDF、Word、图片文字和 ZIP 附件。 |
| `packages/package-manager/bundled-plugins/mcp-helper/package.json` | Integrations | Helps connect MCP servers through reviewed requests. | 通过审核后的请求帮助连接 MCP 服务。 |
| `packages/package-manager/bundled-plugins/plugin-helper/package.json` | Developer | Helps create, inspect and install plugins through reviewed requests. | 通过审核后的请求帮助创建、检查和安装插件。 |
| `packages/package-manager/bundled-plugins/skill-helper/package.json` | Memory & Context | Helps create and import reusable Skills through reviewed requests. | 通过审核后的请求帮助创建和导入可复用技能。 |
| `packages/base/package.json` (package overview) | Developer | Supplies the default tools and runtime services used by AGH agents. | 提供 AGH Agent 使用的默认工具与运行时服务。 |
