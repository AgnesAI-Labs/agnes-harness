# App Server v1

[English](app-server.md) | 简体中文

[文档](../README.zh-CN.md) · [API 合同](api.zh-CN.md)

每个 `AGH_HOME` 的 App Server 由一个 daemon 管理。CLI、TUI、Web、渠道、ACP、SDK 和 stdio 客户端使用同一套经过认证的方法合同。worker 执行任务；stdio bridge 只转发请求，不创建另一个服务。

## 会话、轮次、事件与审批

会话保存身份、历史、workspace 权限和固定的插件代码。`session/prompt` 启动轮次，`session/update` 推送预览。通过 `_agnes/v1/session.attach` 订阅持久化的 `_agnes/v1/session.event`；保存 ledger cursor 用于重连，预览不持久化。prompt 的响应报告停止原因。

声明 `clientCapabilities._meta["ai.agnes.harness"].capabilities.permission: true` 的客户端可以接收服务端 `session/request_permission` 请求。使用原请求 id 和提供的 option id 回复。拒绝、断连和超时均保持拒绝语义。客户端应执行自己的人工确认策略；学习示例默认拒绝全部审批。

workspace 必须通过 `_agnes/v1/workspace.add` 登记，客户端提供 `cwd` 不会授予权限。不同传输访问同一个会话及其插件代际。

## 认证与管理

本地 IPC 通过 daemon 的私有 Unix socket 或经过身份验证的 Windows pipe 验证 OS owner。`agh app-server --stdio` 在初始化时补充本地凭据，不把凭据输出到 stdout。此子进程具有可信本地管理员权限。EOF 和信号关闭该连接，共享 daemon 继续运行。

浏览器 WebSocket 保留 loopback、Origin、bearer 和会话权限检查。本地 BFF HTTP 保留同源和固定 scope 检查，通过私有 Node SDK 连接访问 daemon；浏览器拿不到本地 daemon 凭据。source-auth、portal 和渠道继续使用服务端授予的权限，client label 不是权限。

`_agnes/v1/admin.*` 管理 daemon 侧设置：`bundles.get`、`bundles.save`、`composition.get`、`search.get`、`search.save`、`search.test`、`context`、`history.search`、`plan`、`mcp.oauth.save`。这些方法要求本地管理员授权；写入要求 activation 权限，context 和 plan 只检查已登记且可用的 workspace。bundle 保存返回 `restart-required`。已有 package、resource 和 config 方法也属于同一合同。

`/admin/plugins/api/*`、`/admin/resources/api/*`、`/api/context`、`/api/history-search`、`/api/plan-mode` 与 client-module service/effect HTTP 路径保留为兼容适配器。原生 workspace picker 和浏览器 OAuth redirect 是客户端传输能力；最终的 workspace 登记和凭据操作由 daemon 管理。

## 错误

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
