# PC-HARNESS-SURVEY：AGH 应吸收哪些 Agent Harness 能力

核验日期：**2026-10-17**（UTC）；交付状态：研究完成，供评审，不是功能实现或发行验收。

## 1. 执行摘要

**建议吸收“可验证的工作方法和插件体验”，保持 AGH 的业务 Agent 插件、不中断旧工作的升级、经人审成长三条主线。** 本次覆盖 30 个项目/产品线：15 个 coding CLI/IDE Agent、10 个框架/运行时，以及 Hermes、Pi、DeepSeek Harness、Deep Agents、Microsoft Agent Framework。AutoGen 与 AG2 分开判断；商业产品仅研究公开功能。

AGH 已经具备相当完整的底座：Plan mode、Skills、MCP 延迟发现、子 Agent、Git worktree、持久分阶段工作流、终端/jobs、schedule、webhook trigger、deliverables、Computer Use、审批/auto-review、文件记忆、headless/replay、OTLP、FDE bundles、热升级和 previous-build upgrade gate。把这些重新列为“缺失”会浪费开发窗口。真正值得补的是：可比较的 eval、Skill 发布质量证据、上下文/费用可解释性、子工作成果集成、语义代码导航、记忆整合，以及业务配方的发现和运行体验。[AGH 总览](https://github.com/AgnesAI-Labs/agnes-harness/blob/70537f56b638345b8c2137eb7ea9d176f6fa66a1/README.md)、[源码导航](https://github.com/AgnesAI-Labs/agnes-harness/blob/70537f56b638345b8c2137eb7ea9d176f6fa66a1/docs/develop/source-map.md)。

优先交付 **15 项**（§5）：先做评测、成长质量、上下文和费用四项；并行推进业务配方、知识来源和自动化运维；Git 集成、checkpoint 恢复和子会话接管先冻结最小通用合同。多数能力可以是普通插件或外部 SDK 客户端；**插件可注册，不等于插件已获所有后台端口权限**。

本次发现的时效纠偏：Goose 已迁到 AAIF；OpenCode 的当前上游为 `anomalyco/opencode`；Roo Code 已归档；Continue README 声明停止积极维护并发布最终 2.0.0；AutoGen README 声明归档并指向 MAF；Letta 当前实现移到 `letta-code`；Pi 旧地址重定向到 `earendil-works/pi`；Windsurf 文档重定向到 Devin Desktop。不能用旧项目名单推断当前维护活跃度或购买可用性。见各项目来源。[S03](#s03) [S05](#s05) [S07](#s07) [S11](#s11) [S13](#s13) [S15](#s15) [S21](#s21) [S22](#s22) [S27](#s27)

许可结论：只独立实现能力思想，不复制代码、提示词、图标、截图或专有协议实现。Crush 当前是 **FSL-1.1-MIT**，存在竞争用途限制及按版本两年后转 MIT 的安排；Mastra 的 `ee/` 有单独企业许可；Claude Code、Cursor、Windsurf/Devin 是专有产品；Letta Code 的品牌资产不随 Apache-2.0 授权。宽松许可也不免除归属与依赖核验。[Crush 许可](https://github.com/charmbracelet/crush/blob/main/LICENSE.md)、[Mastra 许可](https://github.com/mastra-ai/mastra/blob/main/LICENSE.md)、[Letta Code 许可](https://github.com/letta-ai/letta-code/blob/main/LICENSE)。

### 1.1 方法、基线与边界

- AGH 源码调研基线：开工工作树 `70537f56b638345b8c2137eb7ea9d176f6fa66a1`，分支 `review/agh-pc-harness-survey`；开工 clean。远端核验的 `feat/agh-plugin-core` 同 SHA。`feat/agh-mainport` 为 `1bcf197114c7c26240ec2db2f40328a65346dd51`，是开工 HEAD 的祖先（172 个提交在其后），报告最终按任务公共规则以该 mainport SHA 为交付父提交，只移植本报告提交，不重放两基线间的产品提交。本文的 “TODAY” 指源码调研 SHA；全部 AGH 引用已固定到该版本，不能当成最终交付父树或旧 mainport 的能力清单。
- 阅读当前 README、docs 索引、source map、公开 author contracts、相关实现与已有测试断言。**源码存在/测试存在**与**本次运行通过**分开记；本次不启动产品、不连接真实业务系统、不做性能/模型胜率实验。
- 外部使用官方仓库、官方文档、release/changelog；检查日期统一为 2026-10-17。版本证据在 §7；rolling docs 不保证与最近 release 完全同版。GitHub `releases/latest` 在多包仓可能返回 SDK/IDE 发行，本文明确标组件，不称其为最新 CLI。
- GitHub 匿名 API 后半程触发 403 限流，改用官方 raw README、文档与 `git ls-remote HEAD`，未读取任何凭据；没有核实的 release 不填写版本。部分旧 URL 无法访问，已用当前官方入口替代；无法确认的能力保留 `?`。
- DeepSeek Harness 仅只读本地源码，固定 `86a402200d95fecef4529d969836f1fe13c6cb0d`；其本地树 clean，不 fetch、不修改、不运行。报告使用该 SHA 的公开路径链接，**不宣称它是远端最新**。
- “用户喜欢”在本文指官方重点提供、能解释用户收益的设计，**不是本次做过用户访谈、留存分析或满意度调查**。优先级、价值、工作量与风险都是研究判断，不是产品承诺。

## 2. 项目 × 能力矩阵

### 2.1 能力与标记

`●`＝官方来源明确提供；`△`＝通过集成/可选包/实验特性/另一个产品面提供，或仅有局部能力；`?`＝本轮来源不足，不应读作缺失。框架的 `●` 代表开发者 API，不代表开箱即用 UI、安全沙箱或托管服务。商业产品的团队/云能力可能受套餐限制，本报告不核价、不承诺账号可用性。Roo、Continue、AutoGen 的矩阵描述留存设计；其维护状态见 §2.5。

| 编号 | 定义 | 编号 | 定义 |
| --- | --- | --- | --- |
| C01 | 项目/工作区上下文管理 | C17 | 后台任务、可观察的异步工作 |
| C02 | 跨会话记忆（不把普通 chat history 当完整长期记忆） | C18 | 定时任务/调度 |
| C03 | 上下文 compaction/裁剪/offload | C19 | cost/usage/预算控制（强度另述） |
| C04 | 子 Agent/并行/多 Agent 编排 | C20 | 多模型选择/路由（不等同自动降本） |
| C05 | checkpoint/undo/rewind（文件、对话、执行分别看） | C21 | eval/评测 |
| C06 | Git/worktree/PR 工作流 | C22 | tracing/observability |
| C07 | sandbox/隔离执行 | C23 | 会话导出/分享/跨端继续（不等同多人共同编辑） |
| C08 | 权限、审批、人类介入 | C24 | headless/CI/API/SDK |
| C09 | MCP/工具生态 | C25 | IDE 集成 |
| C10 | Skills/按需方法包 | C26 | 语音输入/实时语音 |
| C11 | hooks/middleware/lifecycle 扩展 | C27 | 图像/其他多模态 |
| C12 | slash/custom commands | C28 | 插件/配方/扩展分发目录（不等同受审市场） |
| C13 | custom agents/modes/业务 Loop | C29 | 团队/企业治理（不把 group chat 当 RBAC） |
| C14 | LSP/代码语义/诊断 | C30 | 本地/离线模型（不保证质量或全流程离线） |
| C15 | browser use | C31 | i18n 产品界面/文档（不只是模型会中文） |
| C16 | computer use/桌面操作 |  |  |

### 2.2 上下文、执行、扩展（C01–C11）

| 项目/来源 | C01 | C02 | C03 | C04 | C05 | C06 | C07 | C08 | C09 | C10 | C11 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Codex CLI [S01](#s01) | ● | △ | ● | ● | △ | ● | ● | ● | ● | ● | ● |
| Claude Code [S02](#s02) | ● | ● | ● | ● | ● | ● | ● | ● | ● | ● | ● |
| Gemini CLI [S03](#s03) | ● | △ | ● | ● | ● | △ | ● | ● | ● | ● | ● |
| Qwen Code [S04](#s04) | ● | ● | △ | ● | ? | △ | △ | ● | ● | ● | △ |
| OpenCode [S05](#s05) | ● | ? | △ | ● | △ | △ | △ | ● | ● | ● | ● |
| Crush [S06](#s06) | ● | ? | △ | ? | ? | ? | ? | △ | ● | ? | ? |
| Goose [S07](#s07) | ● | △ | ● | ● | ? | △ | △ | ● | ● | △ | ? |
| Aider [S08](#s08) | ● | ? | ● | ? | ● | ● | ? | △ | ? | ? | ? |
| OpenHands [S09](#s09) | ● | △ | △ | ● | △ | ● | △ | ● | △ | △ | △ |
| Cline [S10](#s10) | ● | △ | △ | ● | ● | △ | △ | ● | ● | ● | △ |
| Roo Code（留存） [S11](#s11) | ● | ? | △ | ● | △ | △ | △ | ● | ● | ? | ? |
| Kilo Code [S12](#s12) | ● | ? | △ | △ | △ | △ | △ | ● | ● | ● | △ |
| Continue（最终版） [S13](#s13) | ● | ? | △ | ? | ? | △ | ? | ● | ● | ? | ? |
| Cursor [S14](#s14) | ● | △ | △ | ● | △ | ● | △ | ● | ● | ● | ● |
| Windsurf/Devin Desktop [S15](#s15) | ● | ? | ? | △ | ? | △ | ? | △ | △ | ? | ? |
| LangGraph [S16](#s16) | ● | ● | △ | ● | ● | ? | △ | ● | △ | ? | ● |
| OpenAI Agents SDK [S17](#s17) | ● | △ | △ | ● | △ | ? | △ | ● | ● | ? | ● |
| Mastra [S18](#s18) | ● | ● | ● | ● | ● | ? | △ | ● | ● | △ | ● |
| Agno/AgentOS [S19](#s19) | ● | ● | △ | ● | △ | △ | △ | ● | ● | △ | ● |
| smolagents [S20](#s20) | ● | ? | △ | ● | ? | ? | △ | △ | ● | ? | △ |
| Letta/Letta Code [S21](#s21) | ● | ● | △ | △ | △ | ● | △ | ● | △ | ● | ● |
| AutoGen（留存） [S22](#s22) | ● | △ | △ | ● | △ | ? | △ | ● | ● | ? | ● |
| AG2（新版） [S23](#s23) | ● | ● | ● | ● | △ | ? | △ | ● | △ | ? | ● |
| CrewAI [S24](#s24) | ● | ● | △ | ● | ● | ? | △ | ● | △ | △ | ● |
| PydanticAI [S25](#s25) | ● | ● | ● | ● | △ | △ | △ | ● | ● | ● | ● |
| Hermes [S26](#s26) | ● | ● | ● | ● | △ | △ | △ | ● | ● | ● | △ |
| Pi [S27](#s27) | ● | △ | ● | △ | △ | ? | △ | △ | △ | ● | ● |
| DeepSeek Harness（固定版本） [S28](#s28) | ● | ? | ● | ● | ? | ? | △ | ● | ● | ● | ● |
| Deep Agents [S29](#s29) | ● | ● | ● | ● | ● | △ | △ | ● | ● | ● | △ |
| Microsoft Agent Framework [S30](#s30) | ● | △ | △ | ● | ● | ? | △ | ● | ● | ● | ● |

### 2.3 工作流与可观测性（C12–C22）

| 项目/来源 | C12 | C13 | C14 | C15 | C16 | C17 | C18 | C19 | C20 | C21 | C22 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Codex CLI [S01](#s01) | ● | ● | ? | △ | △ | ● | △ | ● | △ | △ | ● |
| Claude Code [S02](#s02) | ● | ● | △ | △ | △ | ● | △ | ● | △ | ? | ● |
| Gemini CLI [S03](#s03) | ● | ● | ? | ? | ? | △ | ? | ● | ● | △ | ● |
| Qwen Code [S04](#s04) | ● | ● | ● | ? | ? | △ | ? | △ | ● | ● | △ |
| OpenCode [S05](#s05) | ● | ● | △ | ? | ? | △ | ? | △ | ● | ? | △ |
| Crush [S06](#s06) | △ | ? | ● | ? | ? | ? | ? | △ | ● | ? | ? |
| Goose [S07](#s07) | ● | ● | ? | △ | △ | ● | △ | ● | ● | △ | △ |
| Aider [S08](#s08) | ● | △ | △ | ? | ? | ? | ? | ● | ● | △ | ? |
| OpenHands [S09](#s09) | △ | ● | △ | △ | ? | ● | ● | △ | △ | △ | △ |
| Cline [S10](#s10) | ● | ● | ● | △ | ? | ● | ● | △ | ● | ? | △ |
| Roo Code（留存） [S11](#s11) | ● | ● | △ | △ | ? | △ | ? | △ | ● | ? | ? |
| Kilo Code [S12](#s12) | ● | ● | △ | △ | ? | △ | ? | △ | ● | ? | △ |
| Continue（最终版） [S13](#s13) | ● | ● | △ | ? | ? | ? | ? | △ | ● | ? | ? |
| Cursor [S14](#s14) | ● | ● | ● | △ | △ | ● | △ | △ | ● | △ | △ |
| Windsurf/Devin Desktop [S15](#s15) | ? | △ | ? | ? | ? | △ | ? | ? | △ | ? | ? |
| LangGraph [S16](#s16) | ? | ● | ? | △ | ? | ● | △ | △ | △ | △ | △ |
| OpenAI Agents SDK [S17](#s17) | ? | ● | ? | △ | △ | △ | ? | ● | △ | △ | ● |
| Mastra [S18](#s18) | ? | ● | ? | △ | ? | △ | △ | ● | ● | ● | ● |
| Agno/AgentOS [S19](#s19) | ? | ● | ? | △ | ? | ● | ● | △ | △ | ● | ● |
| smolagents [S20](#s20) | ? | ● | ? | △ | ? | ? | ? | △ | △ | △ | △ |
| Letta/Letta Code [S21](#s21) | ● | ● | ? | ? | ? | △ | △ | △ | ● | △ | △ |
| AutoGen（留存） [S22](#s22) | ? | ● | ? | △ | △ | △ | ? | △ | △ | △ | △ |
| AG2（新版） [S23](#s23) | ? | ● | ? | △ | ? | △ | ? | △ | △ | ● | ● |
| CrewAI [S24](#s24) | ? | ● | ? | △ | ? | △ | △ | △ | △ | △ | △ |
| PydanticAI [S25](#s25) | ? | ● | ? | △ | ? | △ | △ | ● | ● | ● | ● |
| Hermes [S26](#s26) | ● | ● | ? | △ | △ | ● | ● | ● | ● | △ | ● |
| Pi [S27](#s27) | ● | △ | ? | ? | ? | △ | ? | △ | ● | ? | △ |
| DeepSeek Harness（固定版本） [S28](#s28) | ● | ● | ● | △ | △ | ● | ● | △ | △ | △ | △ |
| Deep Agents [S29](#s29) | ? | ● | ? | △ | ? | △ | ? | △ | △ | △ | △ |
| Microsoft Agent Framework [S30](#s30) | ? | ● | ? | △ | ? | △ | ? | △ | △ | △ | △ |

### 2.4 交付与生态（C23–C31）

| 项目/来源 | C23 | C24 | C25 | C26 | C27 | C28 | C29 | C30 | C31 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Codex CLI [S01](#s01) | ● | ● | ● | ● | ● | △ | △ | △ | ? |
| Claude Code [S02](#s02) | ● | ● | ● | ? | △ | ● | △ | ? | ? |
| Gemini CLI [S03](#s03) | ● | ● | ● | ? | ● | ● | △ | ? | ? |
| Qwen Code [S04](#s04) | △ | ● | ● | △ | △ | △ | ? | ● | △ |
| OpenCode [S05](#s05) | △ | ● | ● | ? | △ | ● | △ | ● | △ |
| Crush [S06](#s06) | △ | ● | ? | ? | △ | ? | ? | ● | △ |
| Goose [S07](#s07) | ● | ● | △ | ? | △ | ● | △ | ● | ? |
| Aider [S08](#s08) | ? | ● | △ | ● | ● | ? | ? | ● | ? |
| OpenHands [S09](#s09) | ● | ● | △ | ? | △ | ? | △ | △ | ? |
| Cline [S10](#s10) | △ | ● | ● | ? | △ | ● | △ | ● | ? |
| Roo Code（留存） [S11](#s11) | △ | △ | ● | ? | △ | △ | ? | △ | ● |
| Kilo Code [S12](#s12) | △ | ● | ● | ? | △ | ● | △ | △ | △ |
| Continue（最终版） [S13](#s13) | ? | ● | ● | ? | △ | ? | ? | ● | ? |
| Cursor [S14](#s14) | ● | ● | ● | ? | ● | ● | △ | ? | ? |
| Windsurf/Devin Desktop [S15](#s15) | ? | △ | ● | ? | △ | ? | △ | ? | ? |
| LangGraph [S16](#s16) | △ | ● | ? | ? | △ | ? | △ | △ | ? |
| OpenAI Agents SDK [S17](#s17) | △ | ● | ? | ● | △ | ? | △ | △ | ? |
| Mastra [S18](#s18) | △ | ● | ? | △ | △ | △ | △ | △ | ? |
| Agno/AgentOS [S19](#s19) | △ | ● | ? | △ | △ | ? | ● | △ | ? |
| smolagents [S20](#s20) | △ | ● | ? | ? | ● | △ | ? | ● | ? |
| Letta/Letta Code [S21](#s21) | ● | ● | △ | ? | △ | △ | △ | △ | ? |
| AutoGen（留存） [S22](#s22) | △ | ● | ? | ? | △ | ? | ? | △ | ? |
| AG2（新版） [S23](#s23) | △ | ● | ? | ? | △ | ? | ? | ● | ? |
| CrewAI [S24](#s24) | △ | ● | ? | ? | △ | △ | △ | △ | ? |
| PydanticAI [S25](#s25) | △ | ● | △ | ● | ● | △ | △ | △ | ? |
| Hermes [S26](#s26) | ● | ● | △ | ● | ● | ● | △ | ● | △ |
| Pi [S27](#s27) | ● | ● | △ | ? | △ | ● | ? | ● | ? |
| DeepSeek Harness（固定版本） [S28](#s28) | ● | ● | △ | ? | ● | △ | ? | △ | ● |
| Deep Agents [S29](#s29) | △ | ● | △ | ? | △ | ? | △ | ● | ? |
| Microsoft Agent Framework [S30](#s30) | △ | ● | ? | △ | △ | ? | △ | △ | ? |

### 2.5 每个项目值得吸收的独特设计

以下行与矩阵同源；具体状态和限制优先于矩阵符号。所有链接的检查日期均为 2026-10-17。

| 项目 | 值得吸收的设计与使用者收益 | 对 AGH 的处理与边界 |
| --- | --- | --- |
| Codex CLI [S01](#s01) | repository-aware CLI、可恢复会话、专门 review、子 Agent、Skills/hooks；沙箱与审批分层，auto-review 降低有明确授权任务的打断；CLI/IDE/App Server 连接同一工作方式。 | 吸收 review/eval、上下文和审批解释。AGH 已有 auto-review；不重做整套权限系统，不把 Codex 云/App 的能力一律算作 CLI 内建。 |
| Claude Code [S02](#s02) | Skills、hooks、插件打包、专用子 Agent；checkpoint 支持回到先前工作点；routines、IDE、remote control 让长期任务易于继续。 | 借鉴 Skill 的发现与领域配方、恢复选择 UI。检查点不撤回 shell/network 外部效果；只研究文档，未读取专有代码。 |
| Gemini CLI [S03](#s03) | GEMINI.md 上下文、extension bundle、Skills/hooks、MCP、headless；checkpoint 记录文件/对话/调用；worktree、auto memory 等有实验标识。 | 吸收扩展发现和 context 诊断。README 已提示最新 Gemini 体验推荐其他产品；不据此宣称 CLI 仓已停止，也不把实验能力写成默认开启。 |
| Qwen Code [S04](#s04) | 当前 README 明列 Auto-Memory、Auto-Skills、SubAgents、Agent Teams、多协议、本地模型、LSP、daemon 和多端；Agent Arena 提供同任务多模型比较入口。 | 借鉴模型/Loop 对照和多语言 onboarding；官方 parity/benchmark 声明不视为本次复现结果，也不照搬其自动成长授权策略。 |
| OpenCode（原 sst）[S05](#s05) | build/plan/general Agent、可替换模型、插件事件、ACP；LSP 诊断可以按项目启用并避免默认资源负担。 | 选装 code-intelligence 插件；当前 docs 明说 LSP 默认禁用，且 lint/typecheck 可能更合适。无需为业务 Agent 默认安装所有语言服务器。 |
| Crush [S06](#s06) | 高质量终端交互、保留上下文的模型切换、LSP、MCP、多平台。 | 借鉴 TUI 选择、诊断和可发现性。当前 FSL 存竞争限制，不能因历史 MIT 印象复制其实现或布局资产。 |
| Goose（Block → AAIF）[S07](#s07) | 通用任务 Agent；Recipe 把 prompts、extensions、参数和设置组成可分享工作法，subrecipes 可并行；ACP/MCP 扩展模型与工具。 | 用 AGH bundle + Skills + Loop 组织业务配方；不再造 recipe 执行引擎。最新 release 还强调跨 ACP→MCP trace context。 |
| Aider [S08](#s08) | 紧凑 repo map 挑选关键符号、Git 自动记录与 undo、architect/edit 分工、lint/test 反馈、voice-to-code、本地模型。 | 吸收有预算的代码地图和变更 review；不以 auto-commit 替代 AGH 授权。最近可核实 release 较旧，设计价值与活跃度分开。 |
| OpenHands [S09](#s09) | 当前入口为 Agent Canvas：把多个 ACP Agent、local/remote/cloud backends、conversation 和 automations 放进自托管控制台。 | 借鉴工作与运行环境可视化；旧 OpenHands runtime、当前 Canvas、独立 SDK 的能力不互相代指。采用适配器，不把第二套 runtime 嵌进 Core。 |
| Cline [S10](#s10) | Plan/Act、可审 diff、shadow-Git checkpoint、诊断闭环；当前 README 覆盖 SDK/CLI/Desktop、teams、cron、connectors。 | 吸收恢复比较和任务图。checkpoint 已有底座；不宣称 checkpoint 能消除外部操作风险。JetBrains 插件当前未开源，不按 Apache 覆盖所有产品面。 |
| Roo Code [S11](#s11) | 自定义 modes、工具范围、角色编排与编辑器内任务分工；多语言资料。 | 适合转成领域 preset/bundle 设计；仓库已于 2026-05-15 归档，作为历史设计参考，不作为新增关键运行依赖。 |
| Kilo Code [S12](#s12) | 模型中途切换、专用/自定义 Agent、VS Code/JetBrains/CLI、marketplace 分发 agents/skills/MCP/plugins。 | 借鉴按任务发现业务插件和展示真实模型成本；当前 CLI 基于 OpenCode、仓根 MIT，不能沿用旧 fork 架构/许可结论。 |
| Continue [S13](#s13) | Chat/Edit/Agent/Autocomplete、按角色配置模型、规则/提示/MCP；自托管与离线指南。 | 吸收薄 IDE 客户端与配置可解释性；当前 README 明说最终 2.0.0、read-only，不沿用旧云 Hub/auth 企业能力作现状。 |
| Cursor [S14](#s14) | 代码/选区上下文、Agent/Plan、review、plugins/rules/skills/hooks/subagents；cloud automations 连接事件任务。 | 先做 AGH SDK/ACP 的薄 IDE bridge，借鉴任务完成后的 review。不开 IDE fork；云自动化不证明本地 Agent 有同等隔离或 SLA。 |
| Windsurf → Devin Desktop [S15](#s15) | 当前官方文档已品牌迁移；桌面编辑器、Agent 工作台及既有 Windsurf 安装连续更新的体验值得研究。 | 保留历史 Cascade 的工作流动机，但矩阵仅认当前文档能核实的 IDE/项目上下文等；未验证旧 memories/workflows/credits 的现行等价物。 |
| LangGraph [S16](#s16) | 有状态 graph、durable execution、interrupt/HITL、checkpoint；确定步骤与模型步骤混合，便于定位恢复点。 | 给 AGH 业务 Loop 提供分支/恢复设计参考；graph state rewind 不等于撤销外部效果。LangSmith 的 eval/Studio/托管不是 MIT runtime 自带产品。 |
| OpenAI Agents SDK [S17](#s17) | 明确区分 handoff 与 agents-as-tools；sessions、guardrails、人审和默认 tracing；SDK 可扩展模型、MCP 与语音。 | 以 AGH ChildAgent/Loop/DecisionPort 表达所有权，避免同时运行第二个审批/状态权威；Agents API 托管 harness 另属产品。 |
| Mastra [S18](#s18) | TypeScript workflows、Studio、eval/traces；Observational Memory 用观察/反思压缩长历史以保持连贯。 | 优先吸收记忆整合的候选/对照评测；不直接替换记忆默认授权。核心 Apache 与 `ee/` 企业目录区别核验。 |
| Agno [S19](#s19) | SDK + AgentOS runtime/control plane；自有存储、teams/workflows、schedule、JWT/RBAC、OTel、eval 和知识源。 | 借鉴业务 Agent 的运行治理和状态面板；“团队 Agent”与真正的多租户隔离分开。AGH 不是仅添加 UI 就达到 AgentOS 的部署边界。 |
| smolagents [S20](#s20) | 用代码表达工具组合，MCP/Hub 工具复用，远端或容器 executor。 | AGH 已有 TypeScript PTC；可吸收受控批处理教材。官方明确 LocalPythonExecutor 不是安全沙箱，不能把它接成可信执行后门。 |
| Letta [S21](#s21) | 现在的 Letta Code 强调 identity、memory blocks、skill learning、MemFS Git 记录、dreaming/doctor/memory 浏览。 | 借鉴“学了什么、来源何处、如何修正”的可视化；保留 AGH memory off 默认和精确人审。旧 V1 server 已退到 archive，不能混成当前 API。 |
| AutoGen [S22](#s22) | 历史 AgentChat/team、message-driven 编排、MCP 与 Studio；当前 README 明确归档并推荐 MAF。 | 研究职责分工、终止与有界协作；不引入已停维护 runtime。代码 MIT、文档 CC-BY-4.0，根 LICENSE 不能单独代表代码许可。 |
| AG2 [S23](#s23) | 当前 README 区分 Classic `autogen.*` 与新 AgentOS：Network/typed channels、HITL、可选 knowledge/context/compaction、中间件/telemetry/eval。 | 借鉴协作者消息归属与状态，不把 AG2 和 Microsoft AutoGen 当同一当前项目，也不把 Classic 示例当新版 API。 |
| CrewAI [S24](#s24) | Crew 的角色/任务组织加 Flow 的显式状态、分支、持久化、HITL；业务流程易于表达和复用。 | 做领域 Loop 配方与成功标准；不把顺序和层级角色名称本身当性能提升，AMP/企业控制台另计。 |
| PydanticAI [S25](#s25) | 类型化结果和工具、usage limits、评测；当前 Harness 有 memory/skills/subagents/compaction，持久执行可接 Temporal/DBOS/Prefect，另有实时语音。 | 吸收类型化验收、工具轨迹 eval 和恢复合同；不能仍按早期“只有类型校验的 SDK”评价，也不把外部 workflow engine 当自带安全保证。 |
| Hermes [S26](#s26) | 经验→Skill→改进的学习循环、跨会话检索、memory/user profile、messaging gateway、cron 和可换 terminal backend。 | 最贴合“成长”：采用候选、质量分数和回归样例；不吸收无人审自改权限/安装，也不做跨产品 secret/home 导入。 |
| Pi [S27](#s27) | 极小工具面、extensions/skills/prompt templates/themes 用 npm/git 分发；会话分支、compaction、SDK/RPC；隔离通过容器/扩展组合。 | 借鉴小核心与外置体验包。旧长版 README 与当前简版可能不同；不根据缓存页宣称当前每项可选能力是 core 内建。 |
| DeepSeek Harness [S28](#s28) | Cordis 可逆注册、service definition/provider/consumer 分离、独立 LSP seam、terminal/sidebar 所有权、logged context、插件计划/调度/compaction。 | 与 AGH 最接近的结构参考；AGH Core 的事实/授权权威仍保留。只借鉴设计，不照搬“所有组件均无特权核心”的架构口号。 |
| Deep Agents [S29](#s29) | LangGraph 之上的长任务 harness：隔离子上下文、工具输出 offload、可插拔文件/沙箱、memory、Skills、人审。 | 吸收 context retention 的评测案例；AGH 已有大输出 artifact 引用和子 Agent，不为同名能力新造 Core 模块。 |
| Microsoft Agent Framework [S30](#s30) | AutoGen 后继；Python/.NET、graph 顺序/并行/handoff/group、checkpoint/time travel、Skills、DevUI 和可观测/治理。 | 借鉴可恢复多语言 worker 适配与工作图；仅需互操作时接 MCP/child provider，不替换 AGH runtime。 |

## 3. AGH TODAY：逐能力对照与证据

`有`＝当前合同/实现覆盖基础需求；`部分`＝有可用子集或重要平台/体验限制；`缺`＝在本次 docs/owning modules 搜索中未发现对应一等产品能力。缺失判断是有边界的静态审查，不证明任何第三方插件都不存在。下表中的测试链接只是阅读证据，运行范围见 §8。

| 能力 | 现状 | 当前证据与实际限制 | 对应增量 |
| --- | --- | --- | --- |
| C01 上下文 | 有；解释性部分 | [context guide](https://github.com/AgnesAI-Labs/agnes-harness/blob/70537f56b638345b8c2137eb7ea9d176f6fa66a1/docs/guide/context.md)、[rules 实现](https://github.com/AgnesAI-Labs/agnes-harness/blob/70537f56b638345b8c2137eb7ea9d176f6fa66a1/packages/base/extensions/context-rules/src/index.ts)、[hooks](https://github.com/AgnesAI-Labs/agnes-harness/blob/70537f56b638345b8c2137eb7ea9d176f6fa66a1/packages/extension-api/src/hooks.ts)。规则分层、每请求刷新、bounded references；没有完整各组件实际 token 归因面板。 | G03 |
| C02 记忆 | 部分 | [memory guide](https://github.com/AgnesAI-Labs/agnes-harness/blob/70537f56b638345b8c2137eb7ea9d176f6fa66a1/docs/guide/memory.md)、[memory contract](https://github.com/AgnesAI-Labs/agnes-harness/blob/70537f56b638345b8c2137eb7ea9d176f6fa66a1/packages/extension-api/src/memory.ts)、[provider](https://github.com/AgnesAI-Labs/agnes-harness/tree/70537f56b638345b8c2137eb7ea9d176f6fa66a1/packages/memory-file/src)、[tests](https://github.com/AgnesAI-Labs/agnes-harness/blob/70537f56b638345b8c2137eb7ea9d176f6fa66a1/packages/memory-file/test/memory.test.ts)。默认 off，ask/automatic、workspace 隔离、CAS/预算；不是跨工作区全局知识图谱或自动遗忘系统。 | G07/G09 |
| C03 压缩 | 有；质量比较部分 | [compaction contract](https://github.com/AgnesAI-Labs/agnes-harness/blob/70537f56b638345b8c2137eb7ea9d176f6fa66a1/packages/extension-api/src/compaction-engine.ts)、[engine](https://github.com/AgnesAI-Labs/agnes-harness/blob/70537f56b638345b8c2137eb7ea9d176f6fa66a1/packages/base/extensions/compaction/src/engine.ts)、[tests](https://github.com/AgnesAI-Labs/agnes-harness/blob/70537f56b638345b8c2137eb7ea9d176f6fa66a1/packages/core/test/compaction.test.ts)、[author guide](https://github.com/AgnesAI-Labs/agnes-harness/blob/70537f56b638345b8c2137eb7ea9d176f6fa66a1/docs/extend/compaction-engines.md)。有 provider、summary/elision、安全 range、pins 和 tool-pair 约束。 | G01/G03，不重写 |
| C04 子 Agent/并行 | 部分 | [child contract](https://github.com/AgnesAI-Labs/agnes-harness/blob/70537f56b638345b8c2137eb7ea9d176f6fa66a1/packages/extension-api/src/child-agent.ts)、[subagent](https://github.com/AgnesAI-Labs/agnes-harness/blob/70537f56b638345b8c2137eb7ea9d176f6fa66a1/packages/base/extensions/subagent/src/tools.ts)、[workflow guide](https://github.com/AgnesAI-Labs/agnes-harness/blob/70537f56b638345b8c2137eb7ea9d176f6fa66a1/docs/guide/code-workflows.md)。spawn/fork、budget/depth、并行 stage、receipts；in-process child 的 daemon adoption/ownership 链接有明确未完成项。 | G05/G10 |
| C05 checkpoint/rewind | 部分 | [sessions](https://github.com/AgnesAI-Labs/agnes-harness/blob/70537f56b638345b8c2137eb7ea9d176f6fa66a1/docs/guide/sessions.md)、[checkpoint seam](https://github.com/AgnesAI-Labs/agnes-harness/blob/70537f56b638345b8c2137eb7ea9d176f6fa66a1/packages/base/extensions/fs-checkpoint/src/seam.ts)、[tests](https://github.com/AgnesAI-Labs/agnes-harness/blob/70537f56b638345b8c2137eb7ea9d176f6fa66a1/packages/base/extensions/fs-checkpoint/test/seam.test.ts)。存在 shadow-Git 文件 snapshot/rewind；TUI `/rewind`/Web fork 是新对话分支，不自动恢复文件。没有统一可比较、分选恢复 UX。 | G13 |
| C06 Git | 部分 | [worktree contract](https://github.com/AgnesAI-Labs/agnes-harness/blob/70537f56b638345b8c2137eb7ea9d176f6fa66a1/packages/git-worktree-contract/src/index.ts)、[Host](https://github.com/AgnesAI-Labs/agnes-harness/blob/70537f56b638345b8c2137eb7ea9d176f6fa66a1/packages/host/src/runtime/services/git-worktrees.ts)、[tests](https://github.com/AgnesAI-Labs/agnes-harness/blob/70537f56b638345b8c2137eb7ea9d176f6fa66a1/packages/base/extensions/subagent/test/worktree.test.ts)。官方子 Agent 可建/list/clean，不 force 删脏或未合并树；工具不能直接操作 `.git`，不自动 merge。 | G05 |
| C07 沙箱 | 部分 | [sandbox guide](https://github.com/AgnesAI-Labs/agnes-harness/blob/70537f56b638345b8c2137eb7ea9d176f6fa66a1/docs/guide/sandbox-providers.md)、[contract](https://github.com/AgnesAI-Labs/agnes-harness/blob/70537f56b638345b8c2137eb7ea9d176f6fa66a1/packages/extension-api/src/sandbox-provider.ts)、[limitations](https://github.com/AgnesAI-Labs/agnes-harness/blob/70537f56b638345b8c2137eb7ea9d176f6fa66a1/docs/reference/limitations.md)。macOS Seatbelt/Linux bwrap、remote provider 合同；Windows 无已验证 L1；host allowlist 缺过滤代理；普通 JS 插件是 fully trusted。 | G16（暂不排前 15） |
| C08 审批/auto-review | 有 | [DecisionPort](https://github.com/AgnesAI-Labs/agnes-harness/blob/70537f56b638345b8c2137eb7ea9d176f6fa66a1/packages/extension-api/src/decisions.ts)、[auto-review](https://github.com/AgnesAI-Labs/agnes-harness/blob/70537f56b638345b8c2137eb7ea9d176f6fa66a1/packages/base/extensions/approval-policy/src/auto-review.ts)、[tests](https://github.com/AgnesAI-Labs/agnes-harness/blob/70537f56b638345b8c2137eb7ea9d176f6fa66a1/packages/base/extensions/approval-policy/test/auto-review.test.ts)。base deny 不放宽，异常升级人审，精确调用/来源审计；问答或业务 Proceed 不等于工具许可。 | G01 中测负例 |
| C09 MCP/工具生态 | 有；生态治理部分 | [MCP](https://github.com/AgnesAI-Labs/agnes-harness/blob/70537f56b638345b8c2137eb7ea9d176f6fa66a1/docs/guide/mcp.md)、[tools](https://github.com/AgnesAI-Labs/agnes-harness/blob/70537f56b638345b8c2137eb7ea9d176f6fa66a1/docs/reference/default-tools.md)、[resource runtime](https://github.com/AgnesAI-Labs/agnes-harness/tree/70537f56b638345b8c2137eb7ea9d176f6fa66a1/packages/resource-control-runtime/src)。定义/资源为 live、按 composition 过滤、tool_search/tool_describe 延迟 schema；不是所有外部 MCP 都可信或已审。 | G06/G08 |
| C10 Skills | 有；质量运营部分 | [skills](https://github.com/AgnesAI-Labs/agnes-harness/blob/70537f56b638345b8c2137eb7ea9d176f6fa66a1/docs/guide/skills.md)、[candidate guide](https://github.com/AgnesAI-Labs/agnes-harness/blob/70537f56b638345b8c2137eb7ea9d176f6fa66a1/docs/extend/agent-built-plugins.md)、[candidate 实现](https://github.com/AgnesAI-Labs/agnes-harness/blob/70537f56b638345b8c2137eb7ea9d176f6fa66a1/packages/package-manager/src/authoring-candidates.ts)。有 invoke/trust/revision、候选测试和人审发布；缺按效果退化/来源/覆盖度组织的质量闭环。 | G02 |
| C11 hooks | 有 | [hooks 类型](https://github.com/AgnesAI-Labs/agnes-harness/blob/70537f56b638345b8c2137eb7ea9d176f6fa66a1/packages/extension-api/src/hooks.ts)、[plugin facets](https://github.com/AgnesAI-Labs/agnes-harness/blob/70537f56b638345b8c2137eb7ea9d176f6fa66a1/packages/extension-api/src/plugin-context.ts)。16 个支持事件、observe/transform/intercept；hook 声明不是任意插件 JS 的安全隔离。 | G03/G04 |
| C12 slash commands | 有；可发现性部分 | [CLI](https://github.com/AgnesAI-Labs/agnes-harness/blob/70537f56b638345b8c2137eb7ea9d176f6fa66a1/docs/guide/cli.md)、[context](https://github.com/AgnesAI-Labs/agnes-harness/blob/70537f56b638345b8c2137eb7ea9d176f6fa66a1/docs/guide/context.md)、[composer registry](https://github.com/AgnesAI-Labs/agnes-harness/blob/70537f56b638345b8c2137eb7ea9d176f6fa66a1/docs/develop/ui-extension-registries.md)。`/skill invoke`、客户端 composerCommands 已有；不应 fork TUI 路由器做配方。 | G08 |
| C13 modes/业务 Agent | 有 | [Plan mode policy](https://github.com/AgnesAI-Labs/agnes-harness/blob/70537f56b638345b8c2137eb7ea9d176f6fa66a1/packages/base/extensions/plan-mode/src/policy.ts)、[state](https://github.com/AgnesAI-Labs/agnes-harness/blob/70537f56b638345b8c2137eb7ea9d176f6fa66a1/packages/base/extensions/plan-mode/src/state.ts)、[workflow Loop](https://github.com/AgnesAI-Labs/agnes-harness/blob/70537f56b638345b8c2137eb7ea9d176f6fa66a1/docs/extend/workflow-loops.md)、[FDE](https://github.com/AgnesAI-Labs/agnes-harness/blob/70537f56b638345b8c2137eb7ea9d176f6fa66a1/examples/fde/README.md)。独立 Loop/preset/bundle，Plan 出口走受控决策。 | G08/G12 |
| C14 LSP/code intelligence | 缺一等内建；文本搜索有 | 全仓文件名/文档搜索未发现 LSP provider/tool；已有 read/grep、规则、lint/test 命令与文件面板，不能据此称有语义导航。 | G06 |
| C15 browser | 部分 | [security](https://github.com/AgnesAI-Labs/agnes-harness/blob/70537f56b638345b8c2137eb7ea9d176f6fa66a1/docs/guide/security.md)、[Host Computer Use](https://github.com/AgnesAI-Labs/agnes-harness/tree/70537f56b638345b8c2137eb7ea9d176f6fa66a1/packages/host-computer-use/src)、[tools source](https://github.com/AgnesAI-Labs/agnes-harness/tree/70537f56b638345b8c2137eb7ea9d176f6fa66a1/packages/base/src)。有浏览器/网页工具；真实浏览器、部署系统和模型适配须另验，不意味着通用录制回放成功率已知。 | 可选业务连接器 |
| C16 computer use | 部分 | [limitations](https://github.com/AgnesAI-Labs/agnes-harness/blob/70537f56b638345b8c2137eb7ea9d176f6fa66a1/docs/reference/limitations.md)、[host-computer-use](https://github.com/AgnesAI-Labs/agnes-harness/tree/70537f56b638345b8c2137eb7ea9d176f6fa66a1/packages/host-computer-use/src)。有本机操作路径，Linux unavailable；物理设备与远程桌面未获本轮验证。 | 不另造核心 |
| C17 后台任务/终端 | 有；恢复视图部分 | [jobs](https://github.com/AgnesAI-Labs/agnes-harness/blob/70537f56b638345b8c2137eb7ea9d176f6fa66a1/packages/base/extensions/jobs/README.md)、[workbench](https://github.com/AgnesAI-Labs/agnes-harness/blob/70537f56b638345b8c2137eb7ea9d176f6fa66a1/docs/guide/workbench.md)、[loop jobs ports](https://github.com/AgnesAI-Labs/agnes-harness/blob/70537f56b638345b8c2137eb7ea9d176f6fa66a1/packages/extension-api/src/loop.ts)。终端和 jobs、join/cancel 可用；进程活着不等于业务完成，artifact async jobs 仍是 stub。 | G10/G11 |
| C18 schedule | 有 | [schedule](https://github.com/AgnesAI-Labs/agnes-harness/blob/70537f56b638345b8c2137eb7ea9d176f6fa66a1/packages/base/extensions/schedule/README.md)、[runtime](https://github.com/AgnesAI-Labs/agnes-harness/blob/70537f56b638345b8c2137eb7ea9d176f6fa66a1/packages/base/extensions/schedule/src/runtime.ts)、[daemon scheduler](https://github.com/AgnesAI-Labs/agnes-harness/tree/70537f56b638345b8c2137eb7ea9d176f6fa66a1/packages/daemon-foundation/src)。有持久调度和 Automation 页面，不是缺少 cron 引擎。 | G11 只补运营体验 |
| C19 cost/usage | 部分 | [budget seam](https://github.com/AgnesAI-Labs/agnes-harness/blob/70537f56b638345b8c2137eb7ea9d176f6fa66a1/packages/base/extensions/budget/src/seam.ts)、[headless metrics](https://github.com/AgnesAI-Labs/agnes-harness/blob/70537f56b638345b8c2137eb7ea9d176f6fa66a1/docs/guide/headless.md)、[goal/session limits](https://github.com/AgnesAI-Labs/agnes-harness/blob/70537f56b638345b8c2137eb7ea9d176f6fa66a1/docs/guide/sessions.md)。成本账本/额度 admission/slots/goal 已有；parent headless summary 不自动汇总 child，估算不是供应商最终账单。 | G04 |
| C20 多模型/路由 | 部分 | [configuration](https://github.com/AgnesAI-Labs/agnes-harness/blob/70537f56b638345b8c2137eb7ea9d176f6fa66a1/docs/reference/configuration.md)、[adapters](https://github.com/AgnesAI-Labs/agnes-harness/blob/70537f56b638345b8c2137eb7ea9d176f6fa66a1/packages/model-adapters/README.md)、[Loop ports](https://github.com/AgnesAI-Labs/agnes-harness/blob/70537f56b638345b8c2137eb7ea9d176f6fa66a1/packages/extension-api/src/loop.ts)。主/fast/verifier/compaction、模型切换、side-call 均有；缺经评测、带预算和失败解释的通用任务路由配方。 | G12 |
| C21 eval | 部分 | [headless/replay](https://github.com/AgnesAI-Labs/agnes-harness/blob/70537f56b638345b8c2137eb7ea9d176f6fa66a1/docs/guide/headless.md)、[author tests](https://github.com/AgnesAI-Labs/agnes-harness/blob/70537f56b638345b8c2137eb7ea9d176f6fa66a1/docs/extend/testing.md)、[execution contract](https://github.com/AgnesAI-Labs/agnes-harness/blob/70537f56b638345b8c2137eb7ea9d176f6fa66a1/docs/extend/workflow-loops.md)。有 deterministic replay、batch、合同套件；缺用户可用数据集/评分/对照实验面板。 | G01 |
| C22 traces/observability | 有；质量运用部分 | [OTLP](https://github.com/AgnesAI-Labs/agnes-harness/blob/70537f56b638345b8c2137eb7ea9d176f6fa66a1/docs/guide/observability.md)、[request traces](https://github.com/AgnesAI-Labs/agnes-harness/blob/70537f56b638345b8c2137eb7ea9d176f6fa66a1/docs/guide/system-prompt-trace.md)、[fact chain](https://github.com/AgnesAI-Labs/agnes-harness/blob/70537f56b638345b8c2137eb7ea9d176f6fa66a1/docs/guide/fact-chain.md)。默认 metadata/off、可替换 exporter；遥测 best effort，不能代替 ledger。 | G01/G03/G04 |
| C23 sharing | 部分 | [session export/import/raw bundles](https://github.com/AgnesAI-Labs/agnes-harness/blob/70537f56b638345b8c2137eb7ea9d176f6fa66a1/docs/guide/sessions.md)、[export command](https://github.com/AgnesAI-Labs/agnes-harness/blob/70537f56b638345b8c2137eb7ea9d176f6fa66a1/packages/cli/src/commands/export.ts)。支持 redacted/native/ShareGPT/HTML 和受权 artifact；没有已验证的公开托管分享与实时多人共编。 | G15 |
| C24 headless/CI | 有 | [guide](https://github.com/AgnesAI-Labs/agnes-harness/blob/70537f56b638345b8c2137eb7ea9d176f6fa66a1/docs/guide/headless.md)、[SDK](https://github.com/AgnesAI-Labs/agnes-harness/blob/70537f56b638345b8c2137eb7ea9d176f6fa66a1/packages/sdk/src/headless.ts)。JSONL v1、batch、退出码、缺事件告警、无人值守拒审批；replay 仍会执行真实工具，必须控 effect fixture。 | G01 |
| C25 IDE | 部分 | [App Server](https://github.com/AgnesAI-Labs/agnes-harness/blob/70537f56b638345b8c2137eb7ea9d176f6fa66a1/docs/reference/app-server.md)、[CLI ACP handler](https://github.com/AgnesAI-Labs/agnes-harness/blob/70537f56b638345b8c2137eb7ea9d176f6fa66a1/packages/daemon-rpc/src/local/methods/acp.ts)、[CLI](https://github.com/AgnesAI-Labs/agnes-harness/blob/70537f56b638345b8c2137eb7ea9d176f6fa66a1/docs/guide/cli.md)。有 SDK/ACP 接口基础，未发现官方完整 IDE 编辑/diff/诊断扩展。 | G14 |
| C26 voice | 缺完整一等入口 | [ACP capabilities](https://github.com/AgnesAI-Labs/agnes-harness/blob/70537f56b638345b8c2137eb7ea9d176f6fa66a1/packages/daemon-rpc/src/local/methods/acp.ts) 宣告 audio false；存在音频附件/渠道传输，不等于 STT/TTS 或打断式实时语音。 | G18（延后） |
| C27 multimodal | 部分 | [media request assembly](https://github.com/AgnesAI-Labs/agnes-harness/blob/70537f56b638345b8c2137eb7ea9d176f6fa66a1/packages/core/src/orchestrator/request-media.ts)、[session attachments](https://github.com/AgnesAI-Labs/agnes-harness/blob/70537f56b638345b8c2137eb7ea9d176f6fa66a1/docs/guide/sessions.md)。有图像/附件、原件保存/引用/adapter 能力检查；并非每模型均能直接读 audio/video/PDF。 | 连接器按需 |
| C28 marketplace | 部分 | [packages](https://github.com/AgnesAI-Labs/agnes-harness/blob/70537f56b638345b8c2137eb7ea9d176f6fa66a1/docs/guide/packages.md)、[package manager](https://github.com/AgnesAI-Labs/agnes-harness/tree/70537f56b638345b8c2137eb7ea9d176f6fa66a1/packages/package-manager/src)、[bundled examples](https://github.com/AgnesAI-Labs/agnes-harness/blob/70537f56b638345b8c2137eb7ea9d176f6fa66a1/docs/develop/ui-extension-registries.md)。install/trust/enable、catalog/provenance/examples 已有；缺成熟社区质量与发现运营，不缺第二套安装器。 | G08/G02 |
| C29 enterprise | 部分 | [principals/approval seams](https://github.com/AgnesAI-Labs/agnes-harness/blob/70537f56b638345b8c2137eb7ea9d176f6fa66a1/docs/extend/seams.md)、[deployment](https://github.com/AgnesAI-Labs/agnes-harness/blob/70537f56b638345b8c2137eb7ea9d176f6fa66a1/docs/guide/deployment.md)、[security](https://github.com/AgnesAI-Labs/agnes-harness/blob/70537f56b638345b8c2137eb7ea9d176f6fa66a1/docs/guide/security.md)。有 owner/auth/审计/provider 插口；未证实成套 SSO/SCIM/org RBAC/配额/多租户部署可用。 | G17（延后） |
| C30 local/offline | 有；环境有限 | [local models](https://github.com/AgnesAI-Labs/agnes-harness/blob/70537f56b638345b8c2137eb7ea9d176f6fa66a1/docs/guide/local-model.md)、[replay](https://github.com/AgnesAI-Labs/agnes-harness/blob/70537f56b638345b8c2137eb7ea9d176f6fa66a1/docs/guide/headless.md)。OpenAI-compatible 本地模型、scripted/replay；不代表联网 tools、包下载和所有模型质量能离线等价。 | G01 的离线 fixtures |
| C31 i18n | 有；插件覆盖需验 | [locale UI](https://github.com/AgnesAI-Labs/agnes-harness/tree/70537f56b638345b8c2137eb7ea9d176f6fa66a1/packages/web-ui/src/locales)、[双语导航](https://github.com/AgnesAI-Labs/agnes-harness/blob/70537f56b638345b8c2137eb7ea9d176f6fa66a1/docs/README.md)、[TUI](https://github.com/AgnesAI-Labs/agnes-harness/tree/70537f56b638345b8c2137eb7ea9d176f6fa66a1/packages/cli-tui/src)。中英基础与语言键；新增插件仍须提供对应文案、键盘/读屏验收。 | 每项验收要求 |
| C32 authenticated triggers | 有 | [webhooks](https://github.com/AgnesAI-Labs/agnes-harness/blob/70537f56b638345b8c2137eb7ea9d176f6fa66a1/docs/guide/webhooks.md)、[provider contract](https://github.com/AgnesAI-Labs/agnes-harness/blob/70537f56b638345b8c2137eb7ea9d176f6fa66a1/packages/extension-api/src/webhook-trigger.ts)。HMAC/bearer、replay/dedup、normal session admission、unknown 不自动重试。 | G11 |
| C33 deliverables | 有 | [presentation role](https://github.com/AgnesAI-Labs/agnes-harness/blob/70537f56b638345b8c2137eb7ea9d176f6fa66a1/docs/develop/ui-extension-registries.md)、[gallery example](https://github.com/AgnesAI-Labs/agnes-harness/blob/70537f56b638345b8c2137eb7ea9d176f6fa66a1/examples/community/deliverables-gallery/README.md)。immutable ArtifactRef、版本与 source 分离，可换 UI 不换授权。 | G01/G08/G15 |
| C34 reviewed growth/FDE | 有；效果验证部分 | [candidate tests](https://github.com/AgnesAI-Labs/agnes-harness/blob/70537f56b638345b8c2137eb7ea9d176f6fa66a1/packages/package-manager/test/authoring-candidates.test.ts)、[FDE](https://github.com/AgnesAI-Labs/agnes-harness/blob/70537f56b638345b8c2137eb7ea9d176f6fa66a1/examples/fde/README.md)。candidate→tests→human review→publish，安装/信任/启用独立确认。 | G02 |
| C35 hot upgrade | 有；平台范围有限 | [pinned code/live resources](https://github.com/AgnesAI-Labs/agnes-harness/blob/70537f56b638345b8c2137eb7ea9d176f6fa66a1/docs/develop/architecture-plugins.md)、[hot reload](https://github.com/AgnesAI-Labs/agnes-harness/blob/70537f56b638345b8c2137eb7ea9d176f6fa66a1/docs/extend/hot-reload.md)。旧 session 固定 backend code；UI 来自安装版；Skills/MCP/model config 是 live；storage/sandbox restart-required。 | 不重建 |
| C36 upgrade gate | 有；本次未运行 | [verification](https://github.com/AgnesAI-Labs/agnes-harness/blob/70537f56b638345b8c2137eb7ea9d176f6fa66a1/docs/maintainers/verification.md)、[real previous-build test](https://github.com/AgnesAI-Labs/agnes-harness/blob/70537f56b638345b8c2137eb7ea9d176f6fa66a1/tools/upgrade/previous-build.e2e.test.ts)、[baselines](https://github.com/AgnesAI-Labs/agnes-harness/blob/70537f56b638345b8c2137eb7ea9d176f6fa66a1/tools/upgrade/distributions.mjs)。真实旧发行、clean/unclean、fork/settings/schedule/trigger/history；不是一句“热更”宣传，也不是 arbitrary version migration 保证。 | 中央集成门继续拥有 |

### 3.1 DeepSeek Harness 的只读专项结论

已读固定版本的 README、architecture、LSP/terminal 子系统，以及 LSP service registry、sidebar terminal 的源码。它把服务定义、provider 与 model/tool/UI consumer 分开，LSP 查询限制在明确语义操作，终端区分 `waitReason` 与 shell `status`，sidebar 的关闭与资源释放有独立所有权。这三点适合 AGH 插件设计：不把底层 JSON-RPC 暴露成万能逃生口；不把安静输出当工作完成；UI unload 及时撤销注册而后台仍按自身合同清理。[DSH LSP](https://github.com/deepseek-ai/deepseek-harness/blob/86a402200d95fecef4529d969836f1fe13c6cb0d/docs/subsystems/lsp.md)、[DSH terminal](https://github.com/deepseek-ai/deepseek-harness/blob/86a402200d95fecef4529d969836f1fe13c6cb0d/docs/subsystems/terminal.md)、[sidebar consumer](https://github.com/deepseek-ai/deepseek-harness/blob/86a402200d95fecef4529d969836f1fe13c6cb0d/packages/client/ui-sidebar-terminal/src/client/index.ts)。

AGH 已有可逆注册、presentation roles、jobs/terminal、compaction/provider 和授权 Core；DSH 有类似模块不构成 AGH 缺口证据。LSP 是可独立吸收的真实增量；其其他设计先用在现有 provider/slot 上。DSH 本地 MIT/third-party notices 只用于来源判断，本次没有复制实现。

## 4. 缺口评估：价值、三条主线、插件适配、成本与风险

三条主线：B＝业务 Agent 插件，T＝热升级/可信执行，G＝经评审的技能成长。每项记 `0/1/2`（无直接贡献/辅助/直接贡献）；价值 V 用 1–5 表示对目标 FDE/开发者任务的预期帮助。S＝单包小增量，M＝多面集成，L＝跨后端/授权/平台；它们不是人日承诺。风险综合数据泄露、外部副作用、恢复、依赖和效果不确定性。顺序由用户价值、现有合同可交付性及三条主线共同决定，不是竞品打勾数。

所有方案均为独立实现；参考项目代码许可不决定 AGH 新实现许可。插件建议可采用仓库现行 Apache-2.0；若接第三方服务/模型/语言服务器，应另核它们的许可、服务条款和数据流。

| Gap | 对应能力 / 预期价值 | V；B/T/G | 可用合同 / 最小通用增量 | 工作量；风险；取舍 |
| --- | --- | --- | --- | --- |
| G01 可比较的 eval | C03/21/22/24；同输入对照 Loop、Skill、模型/压缩策略，发现质量回退 | 5；2/2/2 | SDK headless、model-adapter replay、artifacts、服务/投影和 UI；先外部 runner，不加 Core 状态 | M；中；replay 不复现世界，LLM judge 必须另记成本/不确定性 |
| G02 成长的质量证据 | C10/28/34；候选携带失败样例、效果和来源后再发布 | 5；2/2/2 | 现有 candidate 工具/人审 UI、Loop、deliverables；评测报告先独立 artifact，强制发布门若要采用需单独通用合同 | M；中；不能伪造测试证明或让 agent 自批 |
| G03 context doctor | C01/03；解释固定指令/记忆/工具 schema/历史预算及 compaction 发生原因 | 5；1/2/1 | `context`/`compact` hooks、自有 projection、panel。精确每组件 wire-token/hash/cache 归因需新只读诊断端口 | M；中；估算/实际/未知必须分开，不能持久化完整敏感请求 |
| G04 usage cockpit | C19/20/22；看清 parent/child/summary/reviewer/side-call 的代价 | 5；2/2/1 | 授权 SDK 事件、现有 cost facts 和 UI；跨 session 汇总若无读权限必须增加聚合授权合同，不能读数据库 | M；中；去重 effectId、未知费用、adjustment、取消/迟到 usage 不能漏计 |
| G05 worktree 成果集成 | C04/06；并行任务真正进入可评审主工作区 | 5；2/2/1 | 现有 receipts/worktree 是基础；新 workspace-scoped Git inspect/apply 服务，Host 决策、CAS 和执行回执 | L；高；`.git` 为后台边界，不能“bash git merge”绕开；冲突/并发保留 |
| G06 选装语义导航 | C09/14；减少大仓 grep 与无关上下文 | 4；1/1/1 | MVP 用受管 stdio MCP + Skill + 结果卡，不新增 Core；如原生化，只定义 language service kind/provider/consumer | M；中；超时、UTF-16、跨根 URI、server 启动资源与许可；先用 lint 基线对照 |
| G07 记忆整合/纠错 | C02；过时冲突偏好可发现、可修正、可回看 | 4；2/2/2 | 现有 MemoryProvider、普通受控文件读写、审批、panel；不增加第二个 memory writer | M；高；ask/off 和 exact diff、同 turn revision、CAS、multi-file partial 均不可放宽 |
| G08 业务配方发现 | C09/10/12/13/28/34；首次用插件能看到适用任务、参数、所需权限和产出 | 4；2/1/2 | bundles/presets/Skills、profile homeEntries、examples launch/review；现有安装器足够 | M；中；不把模板值当可信输入，不在 launch 时偷偷安装/扩大权限 |
| G09 可引用知识源 | C02/09；业务回答可追溯原文版本与权限 | 4；2/2/1 | tool/MCP、artifact、service/projection、citation card；知识不是 memory provider | M；高；来源 ACL、撤权、陈旧引用、prompt injection；不默认抓全盘向量化 |
| G10 工作图/子会话接管 | C04/17；知道谁仍在运行、结果在哪、失败为何 | 4；2/2/1 | 现有 workflow receipts/child provider/panel。只读图无需 Core 增量；可交互 child 链接需要 generic daemon adoption/owner grant | M（图）/L（接管）；高；parent 关系不是访问权，missing receipt 不算成功 |
| G11 自动化运维体验 | C17/18/32；统一查看 schedule/trigger 的输入来源、停用、unknown 与结果 | 4；2/2/1 | 现有 schedule/trigger SDK、Automation 页面、profile UI；复用 durable admission | M；中；不实现第二调度器，不做未知结果自动重放 |
| G12 可解释模型路由 | C13/20；按任务与预算选已批准模型并提供原因 | 4；2/2/1 | 独立 Loop、`prepareRequest` slots、`sideCall`、budget/effects/checkpoints；不能用 before_request hook 偷换 route | M；高；多次发送计费、凭据/数据目的地、未知 send 不重发；效果需 G01 支撑 |
| G13 恢复比较体验 | C05/06；明确恢复文件还是仅分叉对话，避免覆盖人类编辑 | 4；1/2/1 | checkpoint provider/现有 fork API/Changes panel；补 scoped checkpoint preview 与 apply-if-unchanged 合同 | M；高；不承诺外部效果撤销，不能把 raw seam.rewind 暴露浏览器 |
| G14 IDE bridge | C14/25；选区/诊断/变更能进入同一个 AGH session | 3；1/1/1 | 独立薄 IDE 扩展 + SDK/App Server/ACP，插件 panel/Skill；无需新 Core 状态 | M；中；IDE 文件缓冲与磁盘 revision 冲突、token 存放和工作区绑定 |
| G15 可审核分享 | C23/33；支持/评审只收到选择的、可核验且脱敏的会话与交付物 | 3；2/2/1 | 现有 redacted exports/artifact authority、工具/UI；先本地 bundle，不提供公网 hosting | M；高；敏感正文不能靠 regex 保证去净，缺 artifact 拒绝或明确清单 |
| G16 隔离能力补齐 | C07；企业部署的 remote/file/network 一致性和 allowlist 强制执行 | 5；2/2/0 | `SandboxProvider`/remote channel；过滤网络 provider 与跨平台 enforcement 需安全合同/实机验收 | L；高；是采用场景的前置门，不是能靠普通 UI 插件“补好”的功能；独立基础设施轨 |
| G17 企业身份/租户 | C29；受控共享 Agent、配额和可审计管理员操作 | 4；2/2/0 | principals/billing seams、部署边界；SSO/SCIM/tenant-aware 存储与credential范围需端到端设计 | L；高；先单租户 FDE，用 UI role 或 trusted JS 不能提供租户隔离 |
| G18 语音 | C26；现场免手输入、可访问性 | 3；2/1/0 | 先选装 STT/MCP、composer 生成待确认文本；实时双工另需 streaming/cancel/consent 合同 | M（语音便笺）/L（实时）；高；录音私密性/误听/打断中的 effect；先验证现场需求 |
| G19 浏览器/桌面场景包 | C15/16；可审表单/业务回执 | 3；2/2/1 | 现有 tool/computer backend、Skill/Loop、deliverables；Linux 桌面不是写提示词能解锁 | M–L；高；视觉误判、登录态、未知外部效果；按一个业务场景验收，不做泛化成功率宣称 |
| G20 模态连接器 | C27；音频转写/文档解析/视频抽帧等有证据的输入 | 3；2/1/0 | tool/MCP/managed service、artifact 原件和引用；新模型适配遵循 media capabilities | M；中高；不得将附件“已收到”说成“已理解”，缺 decoder 明确失败 |
| G21 插件 i18n/a11y 质量 | C12/31；非技术现场人员能使用扩展 | 4；2/1/1 | shared web-ui/locale、slots、schema settings、author tests；每个新插件验收项，不再造语言框架 | S/插件；中；文案覆盖、键盘焦点/读屏、卸载回退 |
| G22 异步 artifact jobs | C17/33；大导出/解析不堵交互 | 3；2/2/0 | artifacts seam 目前 async jobs stub；需 generic job/artifact ownership/收据/取消合同 | M–L；高；先确认真实大任务，不能把现有 shell jobs 名称相同视为已完成 |

### 4.1 插件可行性的硬边界

- `@agnes/plugin-runtime` 的 `defineTool`/`defineWorkflowLoop`、`@agnes/extension-api` 的 providers、tools、hooks、services、projections 是现有公开接口；`defineKind` 不是自动获得 Host 权限的万能入口。`OwnerLedgerPort.scanOwn` 只能读自己的 namespace；跨 session facts 要走已授权 SDK 或新的 scoped facade。[service-provider](https://github.com/AgnesAI-Labs/agnes-harness/blob/70537f56b638345b8c2137eb7ea9d176f6fa66a1/packages/extension-api/src/service-provider.ts)
- hook 的 `before_request.request` 是 `ReadonlyRequestView`（model、slot、messageCount、toolNames、sampling 等），没有完整 messages/system/tools schema。G03 的 metadata MVP 可以现做；精确 wire-token/cache breakdown 必须走经隐私审查的新端口。`context.sections/getSurface` 的估算不能冒充供应商 tokenizer 真值。[hooks](https://github.com/AgnesAI-Labs/agnes-harness/blob/70537f56b638345b8c2137eb7ea9d176f6fa66a1/packages/extension-api/src/hooks.ts)
- 当前 `gitWorktreeKind` 注释与常量明确限定官方 `agnes/subagent`、`@agnes/base`，只有 Host 注册。G05 新包不能直接 bind 它或通过 `.git` 文件工具扩权。[worktree contract](https://github.com/AgnesAI-Labs/agnes-harness/blob/70537f56b638345b8c2137eb7ea9d176f6fa66a1/packages/git-worktree-contract/src/index.ts)
- managed services/streams 是受审 artifact、profile/安装 scope、live activation 和 lease；可用于连接器，不授予任意 process、secret 或跨 profile 数据权限。新服务的停用/升级须撤销连接、等待清理，未知操作结果仍未知。[transports](https://github.com/AgnesAI-Labs/agnes-harness/blob/70537f56b638345b8c2137eb7ea9d176f6fa66a1/docs/extend/transports.md)
- UI 的 homeEntries、workbenchPanels、presentationRoles、composerCommands 是展示入口，不是授权。旧 session 固定 backend、新安装版 UI 的兼容要单测；缺后台 row 时 UI 应降级或隐藏。[UI contracts](https://github.com/AgnesAI-Labs/agnes-harness/blob/70537f56b638345b8c2137eb7ea9d176f6fa66a1/docs/develop/ui-extension-registries.md)

## 5. 排名前 15 项：可派发的插件设计

以下包名均是**建议名，尚未创建**。每项验收先用 synthetic/offline fixtures；真实模型、外部服务、平台和 heavy/release 验证由相应集成门补，不把本研究的静态判断写成通过结果。新增 UI 一律中英、键盘可用、失败状态可读、卸载释放注册；不修改业务客户数据。

### P01 / G01：`@agnes/eval-studio`（M，中风险）

目标：让一次业务行为变化有可复查的质量/成本证据，优先于新增更复杂的 Agent。参考 Pydantic Evals、LangSmith、Qwen Arena、Mastra。[S04](#s04) [S16](#s16) [S18](#s18) [S25](#s25)

合同与界面：SDK `runHeadless` + `@agnes/model-adapters` scripted/replay，独立 Node runner 使用授权的隔离 home/workspace；插件 tools/service 接收版本化数据集和结果、artifacts 存报告；profile homeEntry “评测”、workbench 展示 case 差异。MVP 无新 Core seam；judge 是明确计费的独立模型调用。

验收：同一数据集绑定 prompt/tool/fixture/model/Loop/Skill/pin hashes、seed（支持时）和预算；区分 strict replay 与 sequence replay；结构断言+效果 fixture+可选 judge 分别显示；故意引入越权/漏步骤/错误输出能失败；每个 case 有实际执行数，0 case 不通过；取消停止后续 case；无 usage 显示 unknown；对照报告可导出，replay 不触发真实业务 effect。真实模型胜率另测。

### P02 / G02：`@agnes/skill-quality`（M，中风险）

目标：把“长出 Skill”推进到“知道为什么值得保留”。参考 Hermes/Letta 的学习循环，保留 AGH 人审发布。[S21](#s21) [S26](#s26)

合同与界面：`defineWorkflowLoop` 调受控 candidate create/read/write/test/submit 工具，候选关联 eval artifact；自有 service/projection 记录 Skill revision、来源 session 和质量摘要；候选 UI 的独立质量 panel，不替代原 approve/reject。先支持人工导入 P01 报告，故无硬依赖；自动运行评测是后续集成。

验收：候选文字或 installed base 变化使旧质量摘要标 stale；展示成功/失败样例和评测环境；拒绝发布仍不能安装/启用；agent 不能伪造人审或把自评当 test runner 结果；发布后新代码 pin/Skills live 的差异有说明；有负样例可复现，失败升级不会污染旧会话。若要“评分不达标禁止发布”，单独评审候选证据的通用签发/校验合同，不用 UI 按钮隐藏冒充门禁。

### P03 / G03：`@agnes/context-doctor`（M，中风险）

目标：回答“为什么上下文满了、压缩后保留了什么”。参考 Aider repo map、Deep Agents offload、Mastra 观察记忆。[S08](#s08) [S18](#s18) [S29](#s29)

合同与界面：`context`、`before_compact`、`compact` observe hooks + 自有有界 projection + workbench “上下文”；metadata MVP 只显示已公开的 section/surface estimates、model slot、工具名数、压缩范围与 omission。**精确版需 G0a 新只读 request-diagnostics facade**：由 Core 派生分类计数/来源 hash，不暴露 messages/keys；无端口时标 unknown，禁止 import Core 私有请求构造器。

验收：固定规则与 memory 的预算分别显示；compaction 后保留 tool-call/result 配对、pins；未知字段不以 0 代替；中英文输入、超大输出 offload、模型 window 变化可解释；metadata 存储不出现正文或路径隐私；停用释放 hook；只读诊断不能更改请求/权限；精确版的历史数据缺字段时诚实退化。

### P04 / G04：`@agnes/usage-cockpit`（M，中风险）

目标：清晰回答一次任务的总开销与“开销未知在哪里”，不重复实现 billing。参考 Agents SDK tracing、Goose trace propagation。[S07](#s07) [S17](#s17)

合同与界面：独立授权 SDK collector 读该 owner/session 允许的 cost/subagent facts；plugin 服务/投影保存自身聚合，homeEntry “用量”、session/turn 卡显示 primary、summary、reviewer、side-call、child。使用现有 billing admission，MVP 不改变额度。如果公共读口无法覆盖全部后代，显示 coverage gap；全树账单需 G0d 授权聚合 facade。

验收：effect/request 去重、adjustment 与 cumulative usage 正确；迟到/取消费用保留；child 不双计，unadopted/foreign child 不越权读取；实际/估计/未知费用分开；headless 汇总口径差异可见；切模型/路由/重启能回放同账；面板故障不阻断账本写入或放宽预算。

### P05 / G05：`@agnes/git-review`（L，高风险，G0b 后）

目标：把子 worktree 的产出变成可核验、可冲突处理的主工作区变更。参考 Aider Git 和 coding agents 的 review/worktree。[S01](#s01) [S08](#s08)

合同与界面：**需要新通用 Host Git 服务**，限定 workspace、注册 worktree、owner 和具体操作；`inspect` 给 base/target/tree hash 与 diff，`prepareApply` 生成有时效的精确 review，`apply` 走 Core/DecisionPort/效果回执和 compare-and-swap。浏览器只用公共服务；panel “子任务变更”。不直接允许 agent 写 `.git`。

验收：仅处理已授权来源树；preview 后人改文件/HEAD/工作区归属变化使 review 失效；脏树、冲突、未合并分支保留；重复 operationId 读同一回执；在 dispatch/receipt 间崩溃不自动再 apply；拒绝不改 index/worktree；有真实集成回执后才允许 UI 声称已合入；清理必须独立审查，不 force 删除。

### P06 / G06：`@agnes/code-intelligence`（M，中风险）

目标：选装 definition/references/hover/diagnostics，先用 TypeScript/Python 两种语言验证价值。参考 DSH 的独立 LSP seam 和 OpenCode 默认关闭策略。[S05](#s05) [S28](#s28)

合同与界面：MVP 为已审 stdio MCP definition + Skill + 结果卡，运行进程使用 AGH 现有 MCP confinement；用户显式配置语言服务器，不自动下载安装。原生多 provider 需求证实后才新增插件间的 `language-service` kind（定义/provider/consumer），无需把 LSP 放进 Core。UI 显示位置、文件 revision、诊断陈旧性。

验收：跨根/symlink/外部 URI 拒绝或只返回不可读定位；UTF-16/一基工具坐标转换正确；取消/超时/服务退出不挂 turn；停用关闭进程；单项目有界结果/内存；不支持语言有结构化错误；与 grep+lint baseline 比较成功率、成本和耗时，不把启用 LSP 本身当改进。

### P07 / G07：`@agnes/memory-review`（M，高风险）

目标：识别重复、矛盾和失效记忆，提出有依据的整合。参考 Letta memory 可视化、Mastra observational memory。[S18](#s18) [S21](#s21)

合同与界面：独立 Skill + Loop 用现有 read/write 和 MemoryProvider policy；panel 显示冲突组、来源、完整 diff 和 revision。保持 file provider；无需新 Core writer、全局向量存储或后台直接改文件。

验收：off 时 agent 无权读写；ask 审批绑定 base/new hash 和完整 diff，Full access 不替代；并发人改触发 CAS 冲突；同 turn snapshot 不漂移；topic 成功/index 失败显示 partial；坏凭据样式文本拒绝；删除/整合后能从 provenance 知道依据但不向 telemetry/export 泄露记忆；权威 AGENTS/知识源优先。不自动跨 workspace 合并。

### P08 / G08：`@agnes/business-recipes`（M，中风险）

目标：按业务任务找到可运行、可审查的 Agent 组合。参考 Goose Recipes、Kilo marketplace、Claude plugins。[S02](#s02) [S07](#s07) [S12](#s12)

合同与界面：现有 bundle/preset/Skills、metadata examples/launch、profile homeEntries/schema forms；每个配方是独立插件包，展示所需模型/工具权限、输入和产出样例。先精选 3 个 synthetic FDE 场景，不建新 package registry/安装器。

验收：未安装/未信任/未启用与可启动状态区分；参数验证、权限审查、bundle pin 均走现有路径；同 launch operationId 不重复 session/input；依赖停用马上撤掉 launch；配置/模型缺失给可行动错误；升级只影响新 backend session；启动和网络上传不能由预览页访问自动触发。

### P09 / G09：`@agnes/knowledge-sources`（M，高风险）

目标：业务回答可见原文、版本、读取权限与过期状态。参考 Agno context providers、Letta 的 memory/knowledge 分工。[S19](#s19) [S21](#s21)

合同与界面：tool/MCP 查询已有受权数据源，结果包含 source id/revision、retrievedAt、bounded excerpt/hash；artifact 留审查证据，自有 citation projection 和 knowledge panel。连接器私有存储/managed service 可复用现有授权；无需替换 memory。先做本地文档+一个 synthetic API。

验收：两租户/owner 的检索结果隔离；撤权后不得重新读取或下载，历史来源状态明确；引用能定位具体版本，内容变更标 stale；untrusted 原文不能当系统指令；无凭据入 prompt/log；抓取失败不捏造引用；写业务系统用另一个有审批的工具，不把 read connector 变成万能 API。

### P10 / G10：`@agnes/workflow-inspector`（M；接管 L，高风险）

目标：用工作图查看执行事实、失败/等待位置和成果所在树。参考 LangGraph/MAF graph、Cline teams。[S10](#s10) [S16](#s16) [S30](#s30)

合同与界面：只读 MVP 解析受权 workflow/run receipts，workbench graph + stage/member 列表、tool evidence 与 child-authored report 分栏。复用现有 workflow_status/children。**可继续 child session 链接依赖 G0c daemon adoption/ownership 合同**，完成前显示当前限制而不生成能用的假链接。

验收：多 stage/并行 member/failed/cancelled/parked/unknown 均有准确状态；partial receipts 标截断；重启复用原 child identity；无已记录 child id 时拒绝重复 dispatch；foreign child 不可读；图渲染失败有列表回退；结果在 worktree 时不得显示已集成；adoption 后单 owner、失权立即拒绝读/控。

### P11 / G11：`@agnes/automation-ops`（M，中风险）

目标：把现有 schedule、trigger 和结果组织成可运营视图。参考 Claude routines、Cursor automations、Goose scheduled recipes。[S02](#s02) [S07](#s07) [S14](#s14)

合同与界面：现有 schedule/trigger SDK/管理 API，profile homeEntry 或已有 Automation 页扩展；只读 feed 展示来源、下次运行、最近 receipt、linked session、unknown 原因。管理操作仍由人经现有 local owner admin action 完成；普通工具不持有 admin token。MVP 不自动重试，不另建 scheduler。

验收：时区/DST 与 missed-run 口径明确；重复签名/过期 delivery 保持后端拒绝；unknown 操作只能观察/人工 reconcile；禁用阻止新 admissions，旧 session 状态如实保留；停机后恢复不自动补发外部消息；UI 参数不能改变 webhook trust；private payload/secret refs 的值不进入 feed。

### P12 / G12：`@agnes/loop-router`（M，高风险）

目标：在一个有固定测试数据集的领域中，按任务复杂度/预算选模型并解释决策。参考 Aider architect/edit、SDK handoff、Gemini routing。[S03](#s03) [S08](#s08) [S17](#s17)

合同与界面：独立版本化 Loop，使用 `prepareRequest({slot})`、受控 `model`、可选 `sideCall`、effects/checkpoints/budget；profile 显式选 loop，model routes 必须预配置。decision 卡展示选槽依据和完整已知成本；MVP 手工规则，后续用 P01 评测后再启发式自动选择。

验收：不存在/禁用路线直接拒绝；不在 hook 中偷改模型，不把业务数据发到未获批准账户；未知发送不 fallback 重发；失败重试次数/费用有上限；primary/fast/summary/reviewer 的成本不漏记；决策代码旧 session pin 不变、live route 更新按现有边界解释；同质量阈值下再报告成本差异。

### P13 / G13：`@agnes/checkpoint-review`（M，高风险，G0e 后）

目标：先看差异，再选择“仅分叉对话”或“恢复这些文件”。参考 Cline/Gemini/Claude checkpoint 的可发现性。[S02](#s02) [S03](#s03) [S10](#s10)

合同与界面：复用 checkpoint seam 和 session fork；需要 **scoped preview + guarded restore** 后台 facade，提供 base/current/captured hash、可恢复范围与 external-effect 提示，DecisionPort 精确确认，Changes panel 发起。seam 方法存在不能证明普通插件/浏览器已经有安全 restore 权限。

验收：preview 后当前文件改变拒绝 stale apply；未捕获/二进制/大文件/越界路径明确不可恢复；人类改动不静默覆盖；文件 absent tombstone 正确；对话 fork 不动文件；恢复不删除 ledger/过去授权、不重放工具；多文件中途失败显示 partial 并阻止假装全成；所有写均可审计，外部消息永不声称撤回。

### P14 / G14：`@agnes/ide-bridge`（M，中风险）

目标：IDE 内选区、诊断、diff 与 Web/TUI 共用会话。参考 Continue/Cursor/Codex IDE。[S01](#s01) [S13](#s13) [S14](#s14)

合同与界面：独立 VS Code 扩展作为 `@agnes/sdk`/App Server 或 ACP 客户端；可选 AGH panel/Skill 接受显式附加的 selected-file revision/context。支持已有 session，不嵌另一套 agent runtime。无 Core 增量；JetBrains 后续单独验证。

验收：两 workspace 不串 context；未保存 buffer 与磁盘差异明确，hash 变更不覆盖；IDE approve 仍是 backend decision、不能由 edit diff 当授权；重连按 commandId 去重；无 daemon 时可行动错误；插件卸载关闭连接；模型输出/诊断文本视为不可信，Webview CSP 和 token 不泄露。

### P15 / G15：`@agnes/review-bundle`（M，高风险）

目标：把选定问题/交付物交给评审者，而无需公开整份私有会话。参考 Pi 会话分享的可复现动机，保留 AGH 数据最小化。[S27](#s27)

合同与界面：调用现有 export/ArtifactRef 读取权限，独立 tool/SDK helper 产生本地 bundle；panel 逐项预览事件/文件/脱敏结果/来源 hash，再由用户选择文件保存。MVP 不连接上传服务；模型不能自动公开任何 bundle。

验收：导出前完整选择和预览，不把 redaction 当绝对隐私保证；缺 artifact 显式拒绝或产生“未包含”的 manifest，不能成功假报；hash/size 校验、同名不覆盖；foreign session/撤权引用拒绝；memory 内容遵从现有保护；原始 raw bundle 与 redacted review bundle 格式区别清楚；恶意 HTML/Markdown 导出不执行内容。

### 5.1 独立批次与最小合同窗口

批次是依赖组织方式，无日历门。表中是可供未来并行窗口承接的建议，本次未启动实施窗口。

| 批次 | 可独立承接的项目 | 文件/权限边界 | 前置与集成方式 |
| --- | --- | --- | --- |
| A：质量与诊断 | P01 eval、P03 metadata context、P04 selected-session usage | 各自新插件包、外部 SDK runner、各自 UI/测试；不共改 Core | 现有合同即可。P03 精确版/P04 全树版等 G0a/G0d；各自先交 synthetic 数据 |
| B：业务复用与成长 | P02 Skill-quality、P07 memory-review、P08 recipes、P09 knowledge | 各包自有服务/事件 namespace；继续用现有 candidate/memory/launch | 不互相等待：P02 先支持人工导入 eval artifact，P07 正常审批，P08 不绑定新市场 |
| C：现有交互增量 | P06 MCP code intelligence、P10 只读图、P11 automation ops、P12 router、P14 IDE、P15 review bundle | 独立插件/客户端；普通 UI 无 admin 权限 | P12 先自带 fixtures 后接 P01；P10 可读原 receipts；不把新后台权限混在 UI PR |
| G0：通用合同先行 | G0a diagnostics、G0b Git review/apply、G0c child adoption、G0d usage aggregate、G0e checkpoint preview/restore | 各合同分别设计，Host/Core 权威，protocol/extension-api/SDK 对应边界 | 只冻结确有消费者的最小合同。安全/兼容性评审后分别提交，其他窗口消费公开 exports，不提前复制 DTO |
| D：依赖合同的完整功能 | P05、P13；P03 精确、P04 全树、P10 可接管版 | 新插件消费 G0，相应 owning module 由合同窗口维护 | G0b→P05；G0e→P13；G0a→P03；G0d→P04；G0c→P10，各边互不捆绑 |
| E：后续基础设施/场景 | G16 sandbox、G17 tenant、G18 voice、G19/20、G22 | 独立基础设施或业务场景设计；不扩大本轮前 15 范围 | 在具体部署/需求成立后做；已有拒绝路径继续保留。G21 是所有批次的质量项 |

G0a 不返回 prompt 正文，只返回授权 session/request 的派生结构和估算/实际来源；G0d 对每个 child 重新校验可读范围，不能因是 parent 就授予全局账单。G0b/G0e 都以 inspected revision + reviewed action + stable operationId + refusal/partial/unknown 为最低合同。G0c adoption 明确 child 持久身份、owner、pin、lease、控制范围及重启恢复，不接受由浏览器提供 principal 或路径作为授权依据。

公共合同要做 additive/版本化演进，旧 UI/SDK/历史 session 缺字段时显示 unknown。新增 effect/持久状态不承诺原子覆盖外部世界；测试至少覆盖拒绝、撤权、取消、stale review、并发、cold resume 与 lost receipt。维护现有 upgrade gate，新增安全合同不通过修改 guard allowance 掩盖回归。

## 6. 不做什么，以及原因

| 不做/暂缓 | 原因与已有替代 |
| --- | --- |
| 再造 Plan mode、Skills/MCP、cron、terminal、deliverables、基础 trace 或热升级引擎 | AGH 已有实际合同与代码。做发现、诊断、质量和有限体验增量，避免重复权威。 |
| 将 LangGraph/CrewAI/Agents SDK 整套状态机塞入 Core | 第二套 checkpoint/审批/恢复权威会破坏 session pins 与 effect receipts。互操作先用 MCP、ChildAgent provider、独立 Loop。 |
| 把所有竞品能力默认开启 | 业务 Agent 应只获得自身 composition；LSP/browser/voice/cloud 成本和授权不同。选装包比全局工具膨胀更符合第一条主线。 |
| 为 LSP 默认下载几十个服务器或全仓持久索引 | 资源/供应链/许可成本，业务用户价值不确定。先两种语言、预算内语义查询，对照 grep+lint。 |
| 自动 Git commit/merge/force-clean，或以 shell 绕过 `.git` fence | AGH 后端拥有 Git 管理边界；子报告不能证明合并。通过 G05 的精确 review 和收据集成。 |
| 把 rewind 叫“撤销一切” | 对话分支、文件恢复、账本恢复、远程系统补偿是四件事。外部消息/交易和缺回执操作不能因 checkpoint 消失。 |
| Agent 自动启用自己写的插件、扩大权限、改官方 runtime | AGH 已有人审候选链；学习只能产生可审候选，测试脚本也不是恶意 JS sandbox。 |
| 自动收集全会话/记忆上传到分享站或遥测 | 违背默认隐私与知识授权；P15 先选定内容本地导出，OTLP 继续 metadata/off。 |
| 移植其他产品的凭据、旧 home、旧 schema/table 或私有账户状态 | 本研究无此需求；新插件架构不继承旧产品数据，且长期记忆/工具安装不是导入 secrets 的理由。 |
| 默认跨工作区 user-model/全局自动记忆/知识图谱 | 难撤权、污染权限来源、敏感推断成本高。先现有 workspace memory + 经审纠错 + 分开的知识连接器。 |
| 为市场规模建独立计费 SaaS/插件安装器/重资产云控制台 | 尚未证明需要；现有 package provenance、trust、catalog、headless/SDK 足以支撑前期生态。 |
| 做 Cursor/Windsurf 的 IDE fork、完整 autocomplete 产品 | 偏离业务平台，长期维护与模型体验成本高；薄 IDE bridge 能复用 AGH session。 |
| 把旧 Roo/Continue/AutoGen 活跃度、旧 Windsurf/Letta 文档当现状 | 官方已经说明归档/终版/迁移。保留设计经验，新增依赖需维护/许可复核。 |
| 宣称普通后端 JS 插件已被 capability 清单强隔离 | 当前 fully trusted，不存在该保证；多租户企业部署必须独立完成 G16/G17。 |
| 未测就声称更便宜、更强、无限并行、exactly-once 或所有平台可用 | P01 用固定案例、工具环境与预算验证；Windows/Linux Computer Use/PTC/remote 支持保持明确限制。 |
| 此时优先做实时语音、开放公网协作编辑、大规模群体 Agent、无限后台重试 | 使用场景和效益未证，且取消、私密性、费用、外部副作用风险显著。语音便笺或单一连接器可在需求成立时独立验证。 |
| 复制 Crush/专有产品代码、提示词、UI 资产，或把 Mastra `ee/` 混入 Apache 包 | 研究采用思想不授予复制权；新实现从 AGH 合同和验收样例出发。 |

## 7. 一手来源与检查日期

**本节所有来源检查日：2026-10-17。** “已读”指本次浏览器抓取/官方 raw 文本或指定本地源码；链接为支持相应论断的官方入口。HEAD 是采样瞬间的默认分支，不是 release 稳定性证明；docs 会滚动更新。未运行任何参考项目。

### 7.1 项目来源、维护状态与许可

<a id="s01"></a>
**S01 OpenAI Codex CLI** — [CLI 当前功能](https://learn.chatgpt.com/docs/codex/cli)、[subagents](https://learn.chatgpt.com/docs/agent-configuration/subagents)、[auto-review](https://learn.chatgpt.com/docs/sandboxing/auto-review)、[hooks](https://learn.chatgpt.com/docs/hooks)、[官方仓库](https://github.com/openai/codex)、[release rust-v0.163.0](https://github.com/openai/codex/releases/tag/rust-v0.163.0)（2026-10-15）。CLI 源码 Apache-2.0；云/App/订阅服务另有条款。旧 developers CLI 地址重定向到 ChatGPT Learn；本文据实际打开页而不是旧 URL 印象。

<a id="s02"></a>
**S02 Claude Code** — [overview](https://code.claude.com/docs/en/overview)、[checkpointing](https://code.claude.com/docs/en/checkpointing)、[plugins](https://code.claude.com/docs/en/plugins)、[subagents](https://code.claude.com/docs/en/sub-agents)、[routines](https://code.claude.com/docs/en/routines)。changelog 页面本轮超过抓取上限，未用它断言最新版本。专有产品，只研究功能/文档；本次不对可下载 CLI 包做源码分析。routines 为云能力，不能据此推断离线可用。

<a id="s03"></a>
**S03 Gemini CLI** — [官方 README](https://github.com/google-gemini/gemini-cli)、[当前 commands](https://github.com/google-gemini/gemini-cli/blob/main/docs/reference/commands.md)、[checkpointing](https://geminicli.com/docs/cli/checkpointing/)、[release v0.64.0](https://github.com/google-gemini/gemini-cli/releases/tag/v0.64.0)（2026-10-13）。Apache-2.0。checkpoint docs 标最近更新 2026-04-10，默认关闭；与 10 月 release 的 ACP/headless 修复分开引用，不推断所有功能默认启用。

<a id="s04"></a>
**S04 Qwen Code** — [当前 README/功能表](https://github.com/QwenLM/qwen-code)、[官方 docs 入口](https://qwenlm.github.io/qwen-code-docs/)、[SDK TypeScript v0.1.20 release](https://github.com/QwenLM/qwen-code/releases/tag/sdk-typescript-v0.1.20)（2026-10-15）。Apache-2.0；release body 提到 bundled CLI 0.25.2，**该 tag 是 SDK 发行，不作为最新 CLI 版本**。某旧 features 目录页抓取失败，功能表以本次 raw README 为准。

<a id="s05"></a>
**S05 OpenCode** — [当前官方仓库](https://github.com/anomalyco/opencode)、[docs](https://opencode.ai/docs/)、[plugins](https://opencode.ai/docs/plugins/)、[LSP](https://opencode.ai/docs/lsp/)、[release v1.19.3](https://github.com/anomalyco/opencode/releases/tag/v1.19.3)（2026-10-16）。MIT。任务称 sst，本文跟踪当前 anomalyco 上游；旧 share 页面抓取失败，分享不评为已核实完整服务。

<a id="s06"></a>
**S06 Crush** — [README](https://github.com/charmbracelet/crush)、[LICENSE.md](https://github.com/charmbracelet/crush/blob/main/LICENSE.md)、[release v0.98.1](https://github.com/charmbracelet/crush/releases/tag/v0.98.1)（2026-10-09）。**FSL-1.1-MIT**；限制 competing use、每版两年后获得 MIT 附加授权，历史部分还保留 MIT notices。这里只独立借鉴产品思想，不将当前整个项目称为无条件 MIT。

<a id="s07"></a>
**S07 Goose** — [原 Block 地址重定向后的仓库](https://github.com/aaif-goose/goose)、[Recipes](https://goose-docs.ai/docs/guides/recipes/)、[release v1.55.0](https://github.com/aaif-goose/goose/releases/tag/v1.55.0)（2026-10-16）。Apache-2.0；当前 docs 明示 AAIF 迁移。旧 block.github 文档部分抓取失败，使用当前 goose-docs.ai。

<a id="s08"></a>
**S08 Aider** — [docs](https://aider.chat/docs/)、[repo map](https://aider.chat/docs/repomap.html)、[当前 README](https://github.com/Aider-AI/aider)、[release v0.86.0](https://github.com/Aider-AI/aider/releases/tag/v0.86.0)（2025-08-09）。Apache-2.0；本轮 API 可见 pushed_at 为 2026-05-22。保留有用设计，不由旧 release 声称已归档或当前效果领先。

<a id="s09"></a>
**S09 OpenHands** — [当前 Agent Canvas README](https://github.com/OpenHands/OpenHands)、[docs](https://docs.openhands.dev/overview/introduction)、[release v1.27.1](https://github.com/OpenHands/OpenHands/releases/tag/v1.27.1)（2026-10-12）。当前仓根 MIT；历史组件/SDK/企业服务应分别核许可，不从当前仓名推出历史发行的一致性。

<a id="s10"></a>
**S10 Cline** — [README](https://github.com/cline/cline)、[overview](https://docs.cline.bot/cline-overview)、[checkpoint design/restore](https://docs.cline.bot/core-workflows/checkpoints)、[Desktop v0.0.48](https://github.com/cline/cline/releases/tag/desktop-v0.0.48)（2026-10-17）。仓根 Apache-2.0；README 明确 JetBrains 插件未开源，SDK/CLI/Desktop/IDE 发行分别管理；该 release tag 不代表所有组件同版本。

<a id="s11"></a>
**S11 Roo Code** — [官方归档仓库与 README](https://github.com/RooCodeInc/Roo-Code)、[保留 docs](https://roocodeinc.github.io/Roo-Code/)、[最后可核 release v3.54.0](https://github.com/RooCodeInc/Roo-Code/releases/tag/v3.54.0)（2026-05-15）。Apache-2.0；GitHub 明确 2026-05-15 archived，旧设计可研究，维护承诺不可沿用。

<a id="s12"></a>
**S12 Kilo Code** — [当前 README](https://github.com/Kilo-Org/kilocode)、[docs](https://kilo.ai/docs)、[agents](https://kilo.ai/docs/code-with-ai/agents/using-agents)、[JetBrains v7.1.11 release](https://github.com/Kilo-Org/kilocode/releases/tag/jetbrains/v7.1.11)（2026-10-16，说明 bundled CLI v7.8.13）。当前仓根 MIT，README 说明 CLI 是 OpenCode fork；旧 Roo 分支时代材料不可代替现状。托管模型/云服务另核条款。

<a id="s13"></a>
**S13 Continue** — [当前 README/停止维护说明](https://github.com/continuedev/continue)、[docs/最终功能](https://docs.continue.dev/)、[v2.0.0-vscode](https://github.com/continuedev/continue/releases/tag/v2.0.0-vscode)（2026-06-19）。Apache-2.0。GitHub API archived 字段当时为 false，但 README 明确不积极维护、read-only 和最终 2.0.0；以此精确描述，不伪称 API 已 archived。auth/匿名 telemetry 已从最终版移除，旧企业资料不作为当前完整能力。

<a id="s14"></a>
**S14 Cursor** — [当前 docs](https://cursor.com/docs)、[Agent](https://cursor.com/docs/agent/overview)、[cloud automations](https://cursor.com/docs/cloud-agent/automations)。专有产品，研究公开功能；未访问专有代码，也未验证套餐/购买价格。IDE 原生 code intelligence 与云主机上的执行能力分别理解。

<a id="s15"></a>
**S15 Windsurf / Devin Desktop** — [旧文档入口](https://docs.windsurf.com/)、[重定向后的 getting started](https://docs.devin.ai/desktop/getting-started)、[introducing Devin Desktop](https://docs.devin.ai/desktop/introducing-devin-desktop)。专有产品。当前页面明确软件包叫 `devin-desktop`、旧 Windsurf 仓地址/包名用于连续更新；旧 Cascade overview 路径抓取失败，不据此推断功能被删除，也不把旧能力全打勾。

<a id="s16"></a>
**S16 LangGraph** — [official overview/产品分层](https://docs.langchain.com/oss/python/langgraph/overview)、[源码](https://github.com/langchain-ai/langgraph)、[1.2.16 release](https://github.com/langchain-ai/langgraph/releases/tag/1.2.16)（2026-10-16；修复 resume/subgraph 已完成任务重跑等）。MIT runtime；LangSmith 的 tracing/eval/Studio/hosting 是相关平台，矩阵用集成标识。

<a id="s17"></a>
**S17 OpenAI Agents SDK** — [官方 SDK guide](https://developers.openai.com/api/docs/guides/agents/sdk)、[integrations/tracing](https://developers.openai.com/api/docs/guides/agents/integrations-observability)、[handoff ownership](https://developers.openai.com/api/docs/guides/agents/orchestration)、[Python 源码](https://github.com/openai/openai-agents-python)。SDK MIT；可选 transport/model/tool 与托管服务另计。本轮匿名 API 对其 release 请求 403，未宣称最新 SDK 版本。

<a id="s18"></a>
**S18 Mastra** — [docs](https://mastra.ai/docs)、[observational memory](https://mastra.ai/docs/memory/observational-memory)、[README](https://github.com/mastra-ai/mastra)、[license](https://github.com/mastra-ai/mastra/blob/main/LICENSE.md)。核心/大部分代码 Apache-2.0；任意 `ee/` 目录使用 Mastra Enterprise License，生产需有效企业许可。GitHub 的 NOASSERTION 提醒需看文件，不能直接当无许可证或全 Apache。

<a id="s19"></a>
**S19 Agno** — [README](https://github.com/agno-agi/agno)、[docs](https://docs.agno.com/)、[security/auth](https://docs.agno.com/features/security-and-auth)、[官方 docs index](https://docs.agno.com/llms.txt)。Apache-2.0；官方描述涵盖 SDK、AgentOS runtime/control plane、schedules、OTel、JWT/RBAC/tenant，本文未实测它们的隔离强度或部署完整性。

<a id="s20"></a>
**S20 smolagents** — [官方 HF docs](https://huggingface.co/docs/smolagents/index)、[README/安全边界](https://github.com/huggingface/smolagents)、[Apache license](https://github.com/huggingface/smolagents/blob/main/LICENSE)。代码执行是其核心工具组合方式；官方 README 明确本地 Python executor 不是 security sandbox，隔离依赖 Docker/云 executor。

<a id="s21"></a>
**S21 Letta** — [原仓库迁移说明](https://github.com/letta-ai/letta)、[当前 Letta Code](https://github.com/letta-ai/letta-code)、[docs](https://docs.letta.com/)、[V1 stateful concepts（明确 legacy）](https://docs.letta.com/v1-sdk/concepts/stateful-agents)、[当前 license/品牌排除](https://github.com/letta-ai/letta-code/blob/main/LICENSE)。当前代码 Apache-2.0，品牌资产排除；memory blocks 的历史概念和当前 MemFS/learning 入口分开。原仓 default branch 只用于迁移状态，不当当前 server 实现。

<a id="s22"></a>
**S22 Microsoft AutoGen** — [当前 README/归档与迁移说明](https://github.com/microsoft/autogen)、[代码 MIT LICENSE-CODE](https://github.com/microsoft/autogen/blob/main/LICENSE-CODE)、[文档 CC-BY-4.0 LICENSE](https://github.com/microsoft/autogen/blob/main/LICENSE)。研究历史多 Agent 设计，当前不作为维护中的默认 runtime；后继 MAF 见 S30。

<a id="s23"></a>
**S23 AG2** — [当前 README/Classic 与 v1 分层](https://github.com/ag2ai/ag2)、[docs](https://docs.ag2.ai/)、[Apache license](https://github.com/ag2ai/ag2/blob/main/LICENSE)。Classic 已另仓维护，新顶层 `ag2` API 与 `autogen.*` 不兼容；本报告矩阵主要采用新 README 中的 harness/network 能力。旧 `latest/docs/...` 深链接抓取失败，未将它们作为唯一证据。

<a id="s24"></a>
**S24 CrewAI** — [README](https://github.com/crewAIInc/crewAI)、[docs](https://docs.crewai.com/)、[Flow 文档（抓取解析到 v1.15.28）](https://docs.crewai.com/v1.15.28/en/concepts/flows)、[MIT license](https://github.com/crewAIInc/crewAI/blob/main/LICENSE)。开源框架与商业 AMP Suite 的托管治理/支持分开，矩阵中的企业能力是集成/另产品。

<a id="s25"></a>
**S25 PydanticAI** — [当前 docs/完整产品分层](https://pydantic.dev/docs/ai/overview/)、[README](https://github.com/pydantic/pydantic-ai)、[MIT license](https://github.com/pydantic/pydantic-ai/blob/main/LICENSE)。本轮读取的 README 已包括 Harness、StepPersistence、durable engines、Realtime、Evals；不以早期版本范围评价当前项目。Logfire/第三方执行引擎是另外部署与条款。

<a id="s26"></a>
**S26 Hermes Agent** — [当前 README](https://github.com/NousResearch/hermes-agent)、[Skills Hub](https://hermes-agent.nousresearch.com/docs/skills)、[MIT license](https://github.com/NousResearch/hermes-agent/blob/main/LICENSE)。只借鉴 learned skills、memory、session recall、cron/backends；没有跟随 README 的安装、凭据迁移或防病毒配置建议。

<a id="s27"></a>
**S27 Pi** — [旧地址重定向后的当前仓库](https://github.com/earendil-works/pi)、[coding-agent 包](https://github.com/earendil-works/pi/tree/main/packages/coding-agent)、[MIT license](https://github.com/earendil-works/pi/blob/main/LICENSE)。已读本次 raw 根/包 README；web 的较旧长版包说明含 branching/compaction/RPC 和“部分能力通过扩展提供”，故 matrix 对可选能力谨慎标 △，不假定当前所有包都默认装入。容器/VM 模式与本机权限分开理解。

<a id="s28"></a>
**S28 DeepSeek Harness（本地只读固定样本）** — [README](https://github.com/deepseek-ai/deepseek-harness/blob/86a402200d95fecef4529d969836f1fe13c6cb0d/README.md)、[architecture](https://github.com/deepseek-ai/deepseek-harness/blob/86a402200d95fecef4529d969836f1fe13c6cb0d/docs/architecture.md)、[LSP service 实现](https://github.com/deepseek-ai/deepseek-harness/blob/86a402200d95fecef4529d969836f1fe13c6cb0d/packages/lsp/lsp/src/index.ts)、[terminal contract](https://github.com/deepseek-ai/deepseek-harness/blob/86a402200d95fecef4529d969836f1fe13c6cb0d/docs/subsystems/terminal.md)、[MIT license](https://github.com/deepseek-ai/deepseek-harness/blob/86a402200d95fecef4529d969836f1fe13c6cb0d/LICENSE)。只从指定本地文件阅读以上 revision，不声称最新远端或已经运行验收。

<a id="s29"></a>
**S29 Deep Agents** — [official overview](https://docs.langchain.com/oss/python/deepagents/overview)、[README](https://github.com/langchain-ai/deepagents)、[MIT license](https://github.com/langchain-ai/deepagents/blob/main/LICENSE)。长任务 harness 建于 LangGraph/LangChain，其 LangSmith 部署/评测是相关平台，不作为 AGH 采用整套 runtime 的理由。

<a id="s30"></a>
**S30 Microsoft Agent Framework** — [当前 README](https://github.com/microsoft/agent-framework)、[MIT license](https://github.com/microsoft/agent-framework/blob/main/LICENSE)。作为 AutoGen 的当前后继补充研究；graph/checkpoint/time travel/Skills/DevUI 从官方 README 读取，未验证所有 Python/.NET/Go 组件同等成熟。

### 7.2 可复查 revision / release 采样

| 官方仓库 | 默认分支 HEAD / 本地样本（2026-10-17） | 本轮 release 证据 |
| --- | --- | --- |
| Aider-AI/aider | [`5dc9490bb35f9729ef2c95d00a19ccd30c26339c`](https://github.com/Aider-AI/aider/commit/5dc9490bb35f9729ef2c95d00a19ccd30c26339c) | [v0.86.0](https://github.com/Aider-AI/aider/releases/tag/v0.86.0)，2025-08-09 |
| Kilo-Org/kilocode | [`1552877e82ceaecc79a9fd4be7859518745e6f56`](https://github.com/Kilo-Org/kilocode/commit/1552877e82ceaecc79a9fd4be7859518745e6f56) | [jetbrains/v7.1.11](https://github.com/Kilo-Org/kilocode/releases/tag/jetbrains/v7.1.11)，2026-10-16 |
| OpenHands/OpenHands | [`045290739f0af2ae4cc89d2a209c6bd930bb81ee`](https://github.com/OpenHands/OpenHands/commit/045290739f0af2ae4cc89d2a209c6bd930bb81ee) | [v1.27.1](https://github.com/OpenHands/OpenHands/releases/tag/v1.27.1)，2026-10-12 |
| QwenLM/qwen-code | [`3547398d2b1aa76bce1276d654ac9299cfb0c5a3`](https://github.com/QwenLM/qwen-code/commit/3547398d2b1aa76bce1276d654ac9299cfb0c5a3) | [sdk-typescript-v0.1.20](https://github.com/QwenLM/qwen-code/releases/tag/sdk-typescript-v0.1.20)，2026-10-15 |
| RooCodeInc/Roo-Code | [`b867ec9145750d0ae1ff7f02d35406e9bf2a0b16`](https://github.com/RooCodeInc/Roo-Code/commit/b867ec9145750d0ae1ff7f02d35406e9bf2a0b16) | [v3.54.0](https://github.com/RooCodeInc/Roo-Code/releases/tag/v3.54.0)，2026-05-15 |
| aaif-goose/goose | [`bfcc6ee6f1ee18d0c4c852a65c49b25f87ee40dc`](https://github.com/aaif-goose/goose/commit/bfcc6ee6f1ee18d0c4c852a65c49b25f87ee40dc) | [v1.55.0](https://github.com/aaif-goose/goose/releases/tag/v1.55.0)，2026-10-16 |
| agno-agi/agno | [`6e434823383280f33465121d3eeedeada2ff27d3`](https://github.com/agno-agi/agno/commit/6e434823383280f33465121d3eeedeada2ff27d3) | release API 限流；未定最新版本 |
| anomalyco/opencode | [`22e771f5893e255ea78fc10557ed3fb98d3a1072`](https://github.com/anomalyco/opencode/commit/22e771f5893e255ea78fc10557ed3fb98d3a1072) | [v1.19.3](https://github.com/anomalyco/opencode/releases/tag/v1.19.3)，2026-10-16 |
| charmbracelet/crush | [`78b6edb353f3fb11178c7e38bbac762772dfb8b0`](https://github.com/charmbracelet/crush/commit/78b6edb353f3fb11178c7e38bbac762772dfb8b0) | [v0.98.1](https://github.com/charmbracelet/crush/releases/tag/v0.98.1)，2026-10-09 |
| cline/cline | [`a42df8c8d5fd9d9f9a9073589baffe32ea9bb2f0`](https://github.com/cline/cline/commit/a42df8c8d5fd9d9f9a9073589baffe32ea9bb2f0) | [desktop-v0.0.48](https://github.com/cline/cline/releases/tag/desktop-v0.0.48)，2026-10-17 |
| continuedev/continue | [`5522c6f44ca0ac3528b37244818fbfa39b5af470`](https://github.com/continuedev/continue/commit/5522c6f44ca0ac3528b37244818fbfa39b5af470) | [v2.0.0-vscode](https://github.com/continuedev/continue/releases/tag/v2.0.0-vscode)，2026-06-19 |
| google-gemini/gemini-cli | [`ed96faedfd5571f055c44f2c9509d62321d1138d`](https://github.com/google-gemini/gemini-cli/commit/ed96faedfd5571f055c44f2c9509d62321d1138d) | [v0.64.0](https://github.com/google-gemini/gemini-cli/releases/tag/v0.64.0)，2026-10-13 |
| huggingface/smolagents | [`96f33faaf028479119ec8d34507b47694cf14e34`](https://github.com/huggingface/smolagents/commit/96f33faaf028479119ec8d34507b47694cf14e34) | release API 限流；未定最新版本 |
| langchain-ai/langgraph | [`41c9c22fdc83d68a2859d0c9a2b627c8615a792f`](https://github.com/langchain-ai/langgraph/commit/41c9c22fdc83d68a2859d0c9a2b627c8615a792f) | [1.2.16](https://github.com/langchain-ai/langgraph/releases/tag/1.2.16)，2026-10-16 |
| mastra-ai/mastra | [`7e8ff7a76a162d11cd0bd1c9fda62e5200746bf2`](https://github.com/mastra-ai/mastra/commit/7e8ff7a76a162d11cd0bd1c9fda62e5200746bf2) | release API 限流；未定最新版本 |
| openai/codex | [`ce0323f2f2d3b25e82806cd555237da3db4e1897`](https://github.com/openai/codex/commit/ce0323f2f2d3b25e82806cd555237da3db4e1897) | [rust-v0.163.0](https://github.com/openai/codex/releases/tag/rust-v0.163.0)，2026-10-15 |
| openai/openai-agents-python | [`9abc9182d06dbd28330af888306031269d57a175`](https://github.com/openai/openai-agents-python/commit/9abc9182d06dbd28330af888306031269d57a175) | release API 限流；未定最新版本 |
| NousResearch/hermes-agent | [`0ab43d4f67e41be75f4f6c0fa14a86dbcfd3e5b3`](https://github.com/NousResearch/hermes-agent/commit/0ab43d4f67e41be75f4f6c0fa14a86dbcfd3e5b3) | 只采样 HEAD；未定最新 release |
| ag2ai/ag2 | [`599e8ef16ad34f10cd3f171aa6c4ec2fcce5063d`](https://github.com/ag2ai/ag2/commit/599e8ef16ad34f10cd3f171aa6c4ec2fcce5063d) | 只采样 HEAD；未定最新 release |
| crewAIInc/crewAI | [`40bb2d3b586e8367d206090cc62df5242206008f`](https://github.com/crewAIInc/crewAI/commit/40bb2d3b586e8367d206090cc62df5242206008f) | 只采样 HEAD；未定最新 release |
| earendil-works/pi | [`8efd314fa3d3232ce197d8d7a6a5660530b9d83e`](https://github.com/earendil-works/pi/commit/8efd314fa3d3232ce197d8d7a6a5660530b9d83e) | 只采样 HEAD；未定最新 release |
| langchain-ai/deepagents | [`0c99fd026c4c41a08e6725a5e45d5ac111dcc6bb`](https://github.com/langchain-ai/deepagents/commit/0c99fd026c4c41a08e6725a5e45d5ac111dcc6bb) | 只采样 HEAD；未定最新 release |
| letta-ai/letta-code | [`0d3ad1239ef0c15108e274f28e4f7cf08a79c305`](https://github.com/letta-ai/letta-code/commit/0d3ad1239ef0c15108e274f28e4f7cf08a79c305) | 只采样 HEAD；未定最新 release |
| microsoft/agent-framework | [`44fe223da7ea6853eefb7053e25c2c213a2e5c15`](https://github.com/microsoft/agent-framework/commit/44fe223da7ea6853eefb7053e25c2c213a2e5c15) | 只采样 HEAD；未定最新 release |
| microsoft/autogen | [`004749e6b7102c8fd317b9b1499ce5807223c278`](https://github.com/microsoft/autogen/commit/004749e6b7102c8fd317b9b1499ce5807223c278) | 只采样 HEAD；未定最新 release |
| pydantic/pydantic-ai | [`11025a1f395d29dbe50af2b30f7429574b9a79c1`](https://github.com/pydantic/pydantic-ai/commit/11025a1f395d29dbe50af2b30f7429574b9a79c1) | 只采样 HEAD；未定最新 release |
| deepseek-ai/deepseek-harness | `86a402200d95fecef4529d969836f1fe13c6cb0d` | 指定本地只读版本；不代表最新 |

版本表用于重找研究样本，不表示这些项目已经进入 AGH 依赖。各项目的完整 LICENSE/NOTICE、目录排除和外部服务条款在真正接入时仍须针对选定版本核验。

## 8. 本次交付与验证

本次只新增 `reports/mp/PC-HARNESS-SURVEY.md`，没有产品代码、schema、依赖、fixture 或运行配置变更；无旧 main 行为移植，因此 main SHA→行为→实现提交映射不适用。AGH 能力映射为开工 SHA→§3 源码/文档证据→本研究提交。

以下公开 docs/guards 检查最初在源码调研基线加报告的树上执行；最终交付再核对报告与固定版本引用。验证环境：macOS/Darwin arm64；mise Node 24.20.0；pnpm 使用仓库固定 10.34.5。只读核验和报告结构检查不启动 AGH、daemon、真实模型或外部业务 effect。

| 实际执行的检查 | 结果 / 范围 |
| --- | --- |
| 报告结构与引用的 Python 检查 | 通过：30 项目 × 31 能力（930 单元格），36 行 AGH 对照，30 个来源锚点，15 个建议；最终 82 个去重 AGH 路径以 `git cat-file -e SHA:path` 核验存在，全部引用固定到源码调研 SHA、内部引用可定位；不含个人绝对路径/私有设计仓引用。没有把 `?` 当缺失。 |
| `mise exec node@24 -- node tools/public-docs/verify.mjs` | 通过：源码调研树 197 Markdown、95 双语配对、2607 本地链接、56 source checks；交付 mainport 树复核为 195 Markdown、94 配对、2569 本地链接、55 source checks；两次均 0 errors。这是既有公开 docs 一致性检查，报告引用由上一项另查。 |
| 官方外链批量只读抓取 | 初稿 137 个去重 URL：134 HTTP 成功；2 个 Python HTTP 308（OpenHands/Windsurf）已通过浏览工具核实重定向及正文，HF smolagents 1 个 TLS 超时也经浏览工具成功读取。未把传输异常判成能力不存在。Claude changelog 超出浏览抓取上限，已撤掉作为版本证据的引用。 |
| `mise exec node@24 -- /…/heavy-lock.sh pnpm exec vitest run tools/guards/src --project fast --maxWorkers=1` | **未执行到测试**：遵守双槽锁排队后，命令退出 254，`ERR_PNPM_RECURSIVE_EXEC_FIRST_FAIL: Command "vitest" not found`。该工作树依赖/测试可执行文件未就绪；没有借用其他工作树、绕锁或把空跑记为通过。本次纯报告不为此安装全仓依赖。 |
| Git diff / 分支整合审查 | 报告提交仅一个文件。默认 rebase 试图重放继承的产品提交并冲突，已 abort；改用 `rebase --onto` 只重放开工 SHA 之后的本报告提交，交付父树为经核验的 mainport，不混入产品改动。固定版本引用检查、`git diff --cached --check` 通过。 |

未做：完整 fast/heavy/e2e/browser/release build、previous-build upgrade gate、真实模型/benchmark/现场业务/跨平台验证。没有修改或覆盖 heavy-lock 的容量和内存设置；未读取 API keys，未修改任何参考项目/其他 worktree。本文是 **ready for review 的研究结论**，15 项建议全部尚未实施；G0 合同、新模型效果与具体部署支持仍须在后续各自任务验收。
