# App Server v1

[English](app-server.md) | 简体中文

[文档](../README.zh-CN.md) · [API 合同](api.zh-CN.md)

每个 `AGH_HOME` 的 App Server 由一个 daemon 管理。CLI、TUI、Web、渠道、ACP、SDK 和 stdio 客户端使用同一套经过认证的方法合同。worker 执行任务；stdio bridge 只转发请求，不创建另一个服务。

`_agnes/v1/session.revealWorkspace` 是客户端层的本机桌面操作：输入 `{ sessionId }`，原生目录打开器启动后返回 `{ opened: true }`。它要求经过认证的本地 Unix/回环 Web 连接及会话所有权，重新验证会话的权威工作区绑定，不接受客户端路径。远程或无桌面运行环境、缺失或过期的工作区会被拒绝。它以分离进程和 argv 数组调用 `open`、`explorer.exe` 或 `xdg-open`，不经过 shell。可选的 `initialize._meta.agnes.platform`（SDK `InitializeInfo.platform`）提供 daemon 操作系统事实，供客户端选择标签。

## 会话、轮次、事件与审批

会话保存身份、历史、workspace 权限和固定的插件代码。`session/prompt` 启动轮次，`session/update` 推送预览。通过 `_agnes/v1/session.attach` 订阅持久化的 `_agnes/v1/session.event`；保存 ledger cursor 用于重连，预览不持久化。prompt 的响应报告停止原因。

可选的 `session/prompt._meta["ai.agnes.harness"].creditLimit` 是该轮次的总 credit 上限：有限、非负且不超过 `Number.MAX_SAFE_INTEGER / 1_000_000`。SDK 对应 `session.prompt(input, { creditLimit })`，并先检查 `initialize.agentCapabilities._meta["ai.agnes.harness"].hardTurnBudget: true`，拒绝旧服务端静默降级。Core 在 inbox 接收和轮次打开时持久绑定额度，使用现有预算存储预留模型请求的保守费用上界，恢复时保留未知占用。缺少存储或目录价格上界时停止执行。有界轮次不允许预算升级、自动标题、无预留的策略模型评审或子代理派发。价格和输出 token 上限仍依赖 provider 合同；缺失或不一致的账单须核对后才能释放调用者预留。

可选的 `session/prompt._meta["ai.agnes.harness"].maxSteps` 是 1 到 1000 的整数，限制这一轮的模型步数。SDK 对应 `session.prompt(input, { maxSteps })`，并先检查 `initialize.agentCapabilities._meta["ai.agnes.harness"].turnMaxSteps: true`，旧服务端不能静默忽略它。超出范围的值在入队之前以 `INVALID_PARAMS` 拒绝。Core 用两条 `ignorable` 账本行记录该上限：入队时的 `x/core/inbox-step-cap` 和开回合时的 `x/core/turn-step-cap`，所以恢复后上限仍在，旧版 core 则跳过这两行、不带上限运行。生效值取 preset 的 `budget.max_steps`（`null` 表示不限）与该上限中较小的一个，因此它只能调低。达到上限时该轮以 `max_steps` 结束。上限只属于这一轮，下一次提示词沿用 preset 的上限。

声明 `clientCapabilities._meta["ai.agnes.harness"].capabilities.permission: true` 的客户端可以接收服务端 `session/request_permission` 请求。使用原请求 id 和提供的 option id 回复。拒绝、断连和超时均保持拒绝语义。客户端应执行自己的人工确认策略；学习示例默认拒绝全部审批。

workspace 必须通过 `_agnes/v1/workspace.add` 登记，客户端提供 `cwd` 不会授予权限。不同传输访问同一个会话及其插件代际。

`_agnes/v1/profile.decisions.list` 列出已认证本地用户的待处理全局操作；`_agnes/v1/profile.decisions.answer` 提交带 revision 校验的回答。连接成功执行授权 list 后，可收到 `_agnes/v1/daemon.notice` 的 `kind: "decisions_changed"`，仅匹配服务端绑定的 profile 和已解析 principal（`detail: { profile, principal: { id, org } }`）。创建、回答、过期和撤回持久提交后会使列表失效。通知不含审批 ID、提示、操作内容、回答或数量，也不授予数据权限。收到通知、页面重新可见/聚焦和重连后重新调用授权 list；通知尽力投递，不提供重放游标。这是 v1 的新增通知类型。

## 认证与管理

本地 IPC 通过 daemon 的私有 Unix socket 或经过身份验证的 Windows pipe 验证 OS owner。`agh app-server --stdio` 在初始化时补充本地凭据，不把凭据输出到 stdout。此子进程具有可信本地管理员权限。EOF 和信号关闭该连接，共享 daemon 继续运行。

浏览器 WebSocket 保留 loopback、Origin、bearer 和会话权限检查。本地 BFF HTTP 保留同源和固定 scope 检查，通过私有 Node SDK 连接访问 daemon；浏览器拿不到本地 daemon 凭据。source-auth、portal 和渠道继续使用服务端授予的权限，client label 不是权限。

`_agnes/v1/admin.*` 管理 daemon 侧设置：`bundles.get`、`bundles.save`、`composition.get`、`search.get`、`search.save`、`search.test`、`context`、`history.search`、`plan`、`mcp.oauth.save`。这些方法要求本地管理员授权；写入要求 activation 权限，context 和 plan 只检查已登记且可用的 workspace。bundle 保存返回 `restart-required`。已有 package、resource 和 config 方法也属于同一合同。

`/admin/plugins/api/*`、`/admin/resources/api/*`、`/api/context`、`/api/history-search`、`/api/plan-mode` 与 client-module service/effect HTTP 路径保留为兼容适配器。原生 workspace picker 和浏览器 OAuth redirect 是客户端传输能力；最终的 workspace 登记和凭据操作由 daemon 管理。

## 错误

公开拒绝码由 `packages/protocol/schema/app-server.json` 的 `AppServerErrorCause` 定义，注解生成共享的 RPC 分类及中英文原因和处理建议。错误 envelope 在 `diagnosticId` 旁新增 `data.publicReason`、`data.userAction`（固定英文文案）；多个拒绝共用 RPC 分类时，`data.cause.code` 仍保留具体拒绝码，SDK 原样传递。客户端可使用 `@agnes/protocol` 的 `publicErrorHelp(error, locale)`，Web 可使用 `@agnes/web-ui` 的 `appServerErrorMessage`。未知 domain 错误继续作为通用内部失败；不会从异常原文推断或翻译未知原因。`business.confirm` 等业务决策通过快照保留回答选项（包括 `reject`），业务回答被拒绝并不属于传输失败。

错误包含 JSON-RPC 数字代码、固定安全消息，以及 `data`：

```json
{"code":-32011,"message":"SEMANTIC_REJECTED","data":{"code":"SEMANTIC_REJECTED","reason":"CONFIG_CREDENTIAL_REJECTED","messageKey":"appServer.errors.credentialRejected","diagnosticId":"00000000-0000-0000-0000-000000000001","cause":{"code":"CONFIG_CREDENTIAL_REJECTED"}}}
```

数字代码保持兼容：JSON-RPC 使用 `-32700` 与 `-32600` 到 `-32603`，AGH 使用 `-32001` 到 `-32013`。`data.code` 保留稳定业务代码；`reason`、校验问题和代际元数据等结构化字段继续兼容。`data.cause` 只包含 Schema 白名单中的代码，包括凭据、provider 和 generation 错误；嵌套的 message、stack 和 data 会被丢弃。未知异常只返回固定内部错误，不返回私有异常文本。`diagnosticId` 用于关联错误；`diagnosticUnavailable` 表示审计写入失败，因此 envelope id 不保证存在审计记录。

界面用本地翻译显示 `data.messageKey`，不显示异常文本。HTTP status 是传输信息，HTTP 的 `error` 使用同样的数字 envelope。原先读取字符串 `error.code` 的客户端改读 `error.data.code`。`@agnes/web-ui` 提供中英文映射。

## 导出与版本

```sh
agh app-server schema --out ./app-server-contract
agh app-server --stdio --home /absolute/isolated-home --profile local-dev --cwd /absolute/project
```

Schema 导出不启动 daemon，输出 `app-server-v1.json` 和不依赖包导入的 `app-server.ts`。`x-version` 为 1，`x-methods` 列出方向、方法种类和 params/result 引用。它是方法目录，使用者按方法引用校验具体 params/result。`packages/protocol` 管理 Schema 与方法表，生成结果由 `pnpm gen:check` 检查。SDK 的 `client.request(method, params)` 使用生成的方法类型；原有 `client.call` 和便利 API 继续支持。

ACP 初始化版本仍为 1，AGH 扩展仍使用 `_agnes/v1`。v1 客户端应容忍新增方法和错误 data 字段；不兼容形状需要新版本，不应从 CLI 版本推断合同兼容性。

## JSONL 示例

每行一个 UTF-8 JSON 对象，原样转发 id、通知和服务端请求。stdout 只承载协议。SDK decoder 限制单帧大小，bridge 待发送输入和输出各限制为 32 MiB。格式错误会返回 parse error 并关闭 bridge。EOF 立即断连，不等待所有 prompt 响应；会话取消和恢复仍由 daemon 生命周期管理。

```json
{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":1,"clientCapabilities":{"fs":{"readTextFile":false,"writeTextFile":false}}}}
{"jsonrpc":"2.0","id":2,"method":"_agnes/v1/workspace.add","params":{"path":"/absolute/project"}}
{"jsonrpc":"2.0","id":3,"method":"session/new","params":{"cwd":"/absolute/project","mcpServers":[]}}
```

按顺序等待结果，然后使用返回的 session id 发送带文本内容的 `session/prompt`。[stdio 示例](../../examples/app-server/stdio.mjs) 执行此流程、在 stderr 打印事件、拒绝审批，并在轮次完成后关闭 stdin。`agh acp` 与 `--mode acp` 使用同一本地 bridge；embedded/ephemeral ACP 被拒绝；ACP `--connect` 保留通过 SDK 认证连接远程 daemon 的能力。

## 运行诊断

`_agnes/v1/doctor.run({probeAccounts?: boolean})` 是生成合同中的本地所有者专用方法。浏览器通过精确同源 BFF 的 `POST /admin/api/doctor` 调用，不能指定 home 或配置档。返回 `DoctorResult`：汇总 `status`、顺序固定的 `checks`（`id`、`status`、`fixHintKey`，以及可选计数、磁盘字节数、`probed`），可选不透明 `homeId` 用于隔离浏览器偏好。默认不连接模型服务，只有 `probeAccounts: true` 主动测试已启用账户；取消会传递到模型探测。提示键由客户端语言目录翻译，不返回密钥、账户名称、URL 或异常正文。见[首次运行](../guide/getting-started.zh-CN.md)。

## 会话工作区文件

`_agnes/v1/session.workspace.list` 接收 `{ sessionId, path? }`，返回 `{ path, truncated, entries }`（最多 500 个条目，可选 git 标记）。`_agnes/v1/session.workspace.read` 接收 `{ sessionId, path }`，返回 `{ path, size, binary, truncated, text? }`。两者均要求会话所有权与工作区相对路径，拒绝符号链接及安装目录，规范路径限于已准入工作区。文本预览上限为 1 MiB；二进制或超大文件省略正文。这是通过 `Session.workspaceList`/`workspaceRead` 使用的只读会话方法，不是管理 API。

`_agnes/v1/session.workspace.changes` 接收 `{ sessionId, scope?: 'session' | 'turn', path?, expectedRevision? }`，返回有上限的已确认 write/edit 副作用、增删行数、当前新鲜度、覆盖标记，以及可选的只读文件 diff 与实际账本坐标。它要求与 list/read 一致的会话所有权和当前工作区权限。历史凭据不授予路径权限，也不会把后续外部修改纳入智能体 diff。SDK 提供 `Session.workspaceChanges`；参见[工作台审阅上限与来源说明](../extend/workbench-panels.zh-CN.md#变更文件审阅)。

`_agnes/v1/session.undo.preview` 接收 `{ sessionId, turn? }`，只读：对最近一个改过文件的轮次（或指定的 `turn`）列出每个文件撤销时会做什么（`restore` 恢复旧内容、`delete` 删除本轮新建的文件、`unchanged` 无需处理）、能否撤销以及不能的原因（`legacy-receipt`、`no-checkpoint`、`checkpoint-collected`、`changed-since`、`missing`、`unreadable`），并给出 `busy`、`blockedBy`、必须先撤销的更晚轮次，以及该轮是否还运行过 shell 命令（它们的改动不会被恢复）。`_agnes/v1/session.undo` 接收 `{ sessionId, turn, commandId }`，按 `commandId` 幂等，仅限会话的 owner principal 调用。有轮次在运行时返回 `SESSION_BUSY`，只读会话返回 `UNDO_READ_ONLY`；只要有文件不再是本轮最后一次写入的内容就返回 `UNDO_CONFLICT`（并列出文件），没有 force，也不做部分恢复。每个文件按路径顺序、经会话的工作区围栏恢复到本轮第一次写入之前的内容。结果如实列出 `restored` 和 `failed`，并写入 `x/core/workspace-undo` 账本事实。旧 daemon 会返回 method-not-found。

本地 App Server 的 owner、启动锁与 discovery 位于 `<AGH_HOME>/daemon`，以规范化 home（含符号链接别名）为身份。配置档和数据目录是该实例的受校验配置，不会产生额外服务身份；更改前须停止已有服务。从旧数据目录 owner 布局升级时须先停止旧服务。诊断日志查询最多扫描最近 `4096 × limit` 字节，limit 限于 1–1000，精确 ID 查询也受限。精确 ID 使用 limit 1，因此重启后较旧 ID 可能不可用，即使日志行仍存在。见[诊断保留规则](../guide/observability.zh-CN.md)。

## 会话进程任务

`_agnes/v1/session.jobs.read({sessionId, jobId?})` 返回有上限的任务快照。`_agnes/v1/session.jobs.control({sessionId, commandId, operation, ...})` 经既有服务命令 journal 执行终端副作用。两者校验会话所有权；控制操作拒绝另一会话或 agent 所有的任务。打开终端、运行命令和输入遵守会话权限策略；打开时使用已准入 cwd 与会话 sandbox。`operation: "run"` 接受 `command`（1 到 8 KiB，不含 NUL）和可选的 `timeoutMs`（1 秒到 10 分钟，默认 120 秒），在会话 cwd 里经与 `open` 相同的 sandbox 与授权，把它作为非交互 shell 任务执行一次，并返回属主为 human 的 `SessionJob`；用 `session.jobs.read({sessionId, jobId})` 轮询输出和退出码，用 `signal` 或 `kill` 取消。超时先发 SIGTERM，2 秒后 SIGKILL，状态为 `killed`。run 任务不会进入模型的「Jobs completed」上下文。关闭 dock 和分离会话不会结束任务。见[工作台面板](../extend/workbench-panels.zh-CN.md)。

`_agnes/v1/admin.feedback`: `list`, `put`, `withdraw`, `generate`. [反馈服务](../extend/feedback.zh-CN.md).
