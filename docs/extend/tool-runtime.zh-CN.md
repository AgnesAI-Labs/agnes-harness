# 工具运行时与权限策略

[English](tool-runtime.md) | 简体中文

完成校验保留 `RepairSeam.decide` 明确返回的 `complete`，不会把未通过的校验改记为通过。Core 将继续修正或升级的请求限制为一次自动修正。校验或修复基础设施故障会结束本轮，并以可信恢复审计记录未能完成校验；内容拒绝与此分开。已移除校验器 `park` 创建的未知结果人工接受请求（包括原来的 `always`/`budget` 风险）；操作审阅、未知业务副作用核对和预算报价仍使用原有决策通道。

`@agnes/extension-api` 提供两个合同：`ToolRuntimeProvider.create({ maxParallel })` 创建会话级运行时，支持单次执行、批量执行、取消和销毁；`ToolPolicy.decide(input, signal, ports?)` 返回带原因的 `allow`、`ask` 或 `deny`。

普通 Cordis 插件注入 `providers`，通过 `providers.register(toolRuntimeKind, provider)` 或 `providers.register(toolPolicyKind, policy)` 注册，注册由调用插件的 fiber 所有。读取 `providers.catalog()` 并按 `kind` 筛选；目录包含 id、版本、来源包、能力和选型/生命周期元数据。卸载选中的提供方会取消其生命周期，后续调用明确失败。

```yaml
providers:
  tool-runtime: { provider: default }
  tool-policy: { provider: default }
tools:
  max_parallel: 4
```

预设在 `providers` 表里配置 `tool-runtime: { provider: default }` 和 `tool-policy: { provider: default }`，并用 `tools.max_parallel: 4` 设置并发。省略字段保持默认行为；并发上限为 1–64。默认运行时并行执行相邻的并发安全工具，独占工具等待前面的调用完成，返回结果保持输入顺序。取消或失败会停止启动新调用并等待已经启动的调用结束。

Core 继续负责主体授权、审批决策请求、沙箱、效果记录和恢复；单次执行端口不允许修改已授权的参数或重复派发。策略的硬拒绝仍生效；完全访问权限会自动允许权限裁决，不交付人工审批。默认策略由现有审批扩展注册，命令规则和人工审批沿用审批 seam。实例保留到会话关闭，避免预设切换销毁正在执行的批次。

Core 在 hook、授权和副作用之前拒绝无效工具参数，并返回指出字段与允许值的简短提示。同一工具连续两次参数错误后，本轮停用，包括嵌套调用和自定义 Loop 请求。达到上限之前，参数验证通过会重置该工具的计数。可用 `meta.invalidArgumentLimit` 指定 1 至 5 的整数，覆盖默认值 2。不同工具分别计数，压缩或重开会话不会清除本轮计数，新一轮则重新开始。恢复设置不绕过验证，也不授予权限。

发现工具可读取 `ctx.tools.availability?.(name)`，得到产生本次调用的模型请求的只读 `{ status, reason?, message }` 投影。`offered` 表示已发送 schema；`deferred` 表示需先调用 `tool_describe`，供后续请求使用；`unavailable` 提供安全的原因类别和下一步。类别区分模式、策略、模型能力、显式请求选择、不在目录及请求状态未知。目录成员身份和 `deferLoading` 不能单独证明已披露。没有投影时（例如作者测试宿主，或恢复后缺少请求快照）必须视为未知。加载 schema 不授予权限。当前预算只准入或拒绝整次请求，不会静默删掉单个工具。

工具权限请求由 Core 持有，保存在 `decision/state` 中。deferred invocation 的 `approvalId` 引用原 decision handle ID，会话重开后仍恢复原调用，不另建票据。没有 handler 只结束投递，请求继续等待。在隔离 author testkit 中，返回带合成 `answeredBy` 身份的 verdict，才能验证经过认证的答复。

策略可在 `ask` 决策中附带 `approval: { reviewerRequirement: 'human', grantConstraints: 'once', subjectRevision }`。`subjectRevision` 是待审领域状态的 SHA-256。Core 只提供单次批准/拒绝，跳过 session/permanent grants，将决策绑定到该 revision 与精确调用。执行端得到只读事实 `ToolContext.approval`（`requestId`、`subjectRevision`、`answeredBy`）；领域 continuation 必须先原子比较当前 revision，才能应用变更。这些事实字段不会给 extension-api 增加决策方法。

内置 approval-policy 插件注册默认策略。预设的 `approval.command_policy` 命令表是安全底线，由 Core 包在会话所选的任何工具策略（包括自定义策略）外面：命中 deny 的调用被拒绝；命中 allow 的调用，若所选策略给出 `ask`，则不再询问（`always` 工具、仅限人工的审核、被污染的上下文除外）；所选策略可以收紧、但不能放宽命令表的结论。生效的是会话所用预设里的那张表：写在非默认预设里的规则对选用该预设的会话生效，默认预设的规则不会作用到使用其他预设的会话。读不懂的命令表会让该预设被拒绝，并指出预设和出错的规则：默认预设在装配时，其他预设在会话以它打开时。

规则用完全锚定的 `tool` 模式指明它覆盖的工具，并与调用的身份匹配：

| 工具 | 规则的 `argv` 匹配的身份 |
| --- | --- |
| 声明了 `ToolMeta.commandArg` 的工具：`shell`（`command`）、`pty_send`（`text`）、`run_code`（`code`），以及声明了它的插件工具 | 该参数的文本，连续空白折叠为一个空格 |
| `read`、`write`、`edit`、`ls`、`grep`、`find` | 工作区内解析后的绝对路径；无法归一为唯一身份的路径会被拒绝 |
| 其他工具 | 全部参数的规范 JSON |

命令表匹配的是文本，不是沙箱。为 `shell` 写的规则不会覆盖别的工具，除非 `tool` 模式写上它（`shell|pty_send`）。发给 PTY 的文本可以拆成多次调用，shell 或 `run_code` 程序也可以在运行时拼出命令，所以 deny 规则拦住的是命令的直接写法，隔离边界仍然是沙箱预设。没有声明 `commandArg` 却会执行命令的插件工具按参数 JSON 匹配。`schedule_create`、`schedule_update` 接收的是提示词而不是命令；它们启动的轮次和其他轮次一样受命令表约束。人工审批与持久工具请求走 Core 决策。永久授权由 Host 存储和撤销，绑定批准人与工具定义；审批 provider 只负责送达问题（`ask`）。

主体的硬拒绝和自定义策略的 deny 仍有效；full-access 权限会自动允许 ask 产生的权限请求，策略可通过 input.fullAccess 判断。只读策略在 full-access 会话也可拒绝写入和破坏性工具；在预设中选择 providers.tool-policy: { provider: read-only } 后，新会话的默认及自定义 Loop 均受它约束。

参见[只读策略示例](../../examples/policies/read-only/)和[循环事件](loop-events.zh-CN.md)。

设置 `meta.deferLoading: true` 可从初始模型请求中省略工具 schema。官方 `tool_search` 同时搜索当前可用的延迟插件工具与 MCP 索引。查询按词计分，含确切工具名的词优先（例如 `ui_render render detail card UI`）；结果上限与显式 Skill 发现槽位仍生效；`tool_describe` 调用可选端口 `ToolContext.tools.disclose(name): Promise<void>`，使可用 schema 出现在后续请求中。Core 持久化这项选择，并拒绝冻结的 turn 目录之外或当前模型能力不支持的名称。披露与授权独立：调用仍经过原有参数校验、策略、审批与取消通道。已知工作流所需工具的自定义 Loop，可以通过 `prepareRequest({ tools: [...] })` 显式选择确切名称。

何时延迟：每个可见 schema 都会随每次请求发送，模型很少用到的工具每一轮都在消耗 tokens。多数会话都会用到、或必须不经搜索直接调用的工具保持可见（省略 `deferLoading`）。偶尔使用的工具设为 `true`，例如历史查询或管理操作，schema 较大时尤其如此。数量取决于部署的一类工具设为 `'auto'`：turn 目录中的自动工具不超过 15 个且 schema 合计不超过约 4,000 tokens 时，Core 保持它们全部可见，超过任一上限则一起延迟。MCP 服务器默认使用 `'auto'`。延迟工具在一个会话中首次使用时多一次往返；工作流总是连续调用的一组工具应一起保持可见，而不是逐个加载。

自动延迟还要求目录中存在模型可见、直接披露的 `tool_search` 与 `tool_describe`；仅支持图像输入或自身延迟披露的发现工具不满足条件。缺少这对发现工具时，所有 auto 工具保持可见，包括第三方 auto 工具；显式 `true`、`false` 声明不变。官方后台任务/PTY、子代理、计划任务、工作流和目标工具采用 auto 模式，交付物工具 `present`、日常工具与发现工具保持直接披露。

智能体非空的 `profile.tools` 选择或会话显式的 `tools.allow`，是直接提供 schema 的工作集：即使工具全局声明 `true` 或 `auto` 延迟加载，名单内工具也从首次请求提供。不隐式加入发现工具，名单外工具仍不可访问。未设置选择时继续使用普通延迟规则。空 `profile.tools` 保留既有的默认选择语义；会话显式的空 `tools.allow` 仍不暴露任何工具。模型可见性、图像能力、自定义 Loop 选择、参数验证与审批独立生效。角色子智能体只取得角色与父工具快照的交集，此规则不扩大权限。

设置 `meta.discoveryGroup` 为一行标签（最多 120 个字符），同属一组的延迟工具在列表中合为一行并显示数量，例如 `"Earlier sessions (search, read and trace past sessions)"`。`tool_search` 也会匹配这个标签。不设置时每个延迟工具单独一行。

导出证据或生成声称会话历史完整性的报告工具，应声明 `meta.attestsHistory: true`。Core 在调度（含嵌套调用）前等待完整后台哈希校验；普通工具和 artifact 字节存储仍可在校验期间使用。该标记纳入快照和定义指纹，不授予授权，也不验证外部业务数据。

可选的 `meta.isPresentational: true` 表示效果只向用户公布展示状态，没有外部副作用。它不能与 `isDestructive` 或 `isOpenWorld` 同时为真。默认工具策略不会仅因 turn 被污染而升级一个非只读的 presentational 工具。`requiresApproval: always` 和破坏性审批档仍然询问。省略该标志时，工具仍受污染写入的审批约束。[工具元数据参考](../../packages/extension-api/docs/tools-meta.md) 与其他元数据键一起列出该标志。

工具可以通过公开 `ToolMeta` 合同声明 `meta.paths: [{ arg: 'path', access: 'read' | 'write' }]`。每项指定顶层字符串参数，可选 `default` 指定省略参数时的路径，`nonWorkspaceSchemes` 将声明的 URI scheme 交给工具自身的资源服务。Core 在选择策略之前通过实时工作区文件系统预检这些路径，manual、smart、auto-review、off 模式使用相同检查，不认识官方工具名或参数名。没有此元数据的工具保持原有行为。预检不替代执行时的文件系统限制；资源 scheme 不扩大文件系统权限。元数据会被快照并纳入工具定义指纹。

## 模型辅助策略

官方 `@agnes/base` 注册 `auto-review` 策略。可在 preset 或配置档中选择 `providers.tool-policy: { provider: auto-review }`，或在默认策略的 Web 设置卡中启用；可信 profile 也支持 `approvals.mode: auto-review`。设置卡不会替换自定义、只读或完全访问策略。

输入可带 `config: AutoReviewConfig`、`read/write/external` 类别、保留的可信人工 `instructions`，以及待调用工具的说明、参数 schema 和定义指纹。工具参数与说明属于数据，不能授予权限。可选 `ToolPolicyPorts` 提供会话级持久尝试预算 `reserve(limit)` 与无工具模型操作 `model({ slot: 'fast' | 'verifier', prompt }, signal, onUsage?)`。模型返回 `{ text, model, cost, costSource? }`；不会自动重试，遵守当前请求成本上限，并记录用量。用量回调返回 `{ model, cost, costSource }`，中断时可提供估算。中断的预算预留不退还；传播取消，端口不可用时转为 `ask`。

策略结果可以携带协议拥有的 `ToolReviewFact`：模型、提示词哈希、参数/范围哈希、`allow/deny/escalate` 决定、风险、理由、延迟、成本、成本来源，以及 `model/human-override/fallback` 来源。决定必须与 effect 一致（`escalate` 对应 `ask`）。Core 在副作用之前保存并复用绑定事实。可选 `scopePreview` 包含有长度限制的 `args`、`cwd` 和 `mode` 展示文本。工具节点与轨迹跨度使用相同的 `ToolReviewFact` 契约；预览文本不授予权限。公开 `_agnes/v1/autoReview.get` 与 `.save` 使用 `AutoReviewConfig`；Node SDK 提供 `client.autoReview.get()` 和 `.save(config)`，浏览器通过同源管理接口操作。

输出一致性、工具范围、自动放行风险和显式未来规则由策略插件拥有；Core 仅提供模型执行、预算预留与事实持久化，不内置审查算法。硬拒绝与私有状态限制不可由模型推翻。默认值和操作流程见[安全与信任](../guide/security.zh-CN.md#审批)。
