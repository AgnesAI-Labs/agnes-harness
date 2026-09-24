# MCP：连接外部工具

[English](mcp.md) | 简体中文

[文档导航](../README.zh-CN.md) · [安全](security.zh-CN.md)

已有 MCP 工具服务时，可以把它接入 AGH 的任务流程。本页带你添加服务、审核工具范围、建立连接，并在配置变化后检查实际状态。

定义、信任、期望启用状态与实际连接状态分别管理。完成下面流程并看到工具目录后，再验证具体调用。

**当前源码：** 会话中的 MCP 服务以逐服务器 Host 行运行；OAuth 绑定仍会在该会话路径被跳过，详见[运行方式与版本](#运行方式与版本)。已执行的版本化验证见[验证记录](../maintainers/verification.zh-CN.md)。

## 在会话中接入

在本地 AGH 会话中，可以直接说“帮我接入这个 MCP”，并提供项目地址或连接信息。助手默认将服务接入当前 AGH；确认具体配置后，你可以在 **设置 → MCP** 查看登记与连接状态。连接和工具列表在轮次边界更新，接入后可在同一会话的下一轮继续使用。

此入口由 `@agnes/mcp-helper` 插件提供，默认安装并启用；已有配置首次升级也会补装缺失的助手。曾禁用或移除该插件时，可从[插件管理](packages.zh-CN.md)检查或安装。禁用此插件会撤下会话管理工具，已经接入的 MCP 服务保持独立管理。

会话接入目前支持无需凭据的 stdio、HTTP 和 SSE 配置。需要凭据时，通过下方命令行的 SecretRef 配置流程完成，勿在聊天中粘贴密钥。没有会话管理能力的宿主也可使用命令行添加。Blender 等应用所需的插件安装、应用启动与 MCP 连接是独立步骤；以实际工具调用确认最终可用。

本地 stdio 服务的确认仅授权该服务的具体配置启动。显式配置的部署 allowlist 始终有效；会话不能覆盖管理员的限制。更新定义或撤销信任后，原配置的本地启动批准失效，需要重新审核。

## 配置并验证

Web 设置的 MCP 页面可查看服务、连接与工具目录。需要手动配置 stdio、HTTP 或 SSE 服务时，可使用命令行；`MCP_URL` 应是你已审核并可访问的 MCP endpoint，不是普通网页或模型 Base URL：

```sh
node packages/cli/dist/local/agnes.mjs mcp add docs-tools --name docs-tools --http "$MCP_URL"
node packages/cli/dist/local/agnes.mjs mcp get docs-tools
```

创建默认为 untrusted、disabled。记录输出的当前 revision，审核地址/进程、凭据引用与工具范围后，交互确认：

```sh
node packages/cli/dist/local/agnes.mjs mcp trust docs-tools --expected-revision REVISION
node packages/cli/dist/local/agnes.mjs mcp get docs-tools
node packages/cli/dist/local/agnes.mjs mcp enable docs-tools --expected-revision REVISION
node packages/cli/dist/local/agnes.mjs mcp status docs-tools
node packages/cli/dist/local/agnes.mjs mcp tools docs-tools
```

每次写操作前都以 `get` 的最新 revision 为准，不假定上一步不会修改它。revision 冲突意味着并行或在途变更，应重新读取，不能反复盲重试。

stdio 使用 `--stdio EXECUTABLE` 与重复的 `--arg VALUE`；不要把完整 shell 命令当 executable，也不能通过 `--arg -c` 绕到 shell。可用 executable 还由部署策略决定。HTTP/SSE 的地址、重定向和 loopback 可达性也受 Host 策略约束。

凭据使用已有 secret 引用：`--secret-env NAME=secret://namespace/name`（stdio）、`--bearer-ref secret://namespace/name` 或 `--header-ref x-api-key=secret://namespace/name`（HTTP/SSE）。不把真实密钥放在命令行、截图或文档中。`--allow-tool TOOL_NAME` 可以重复指定允许的工具。

## 调试、变更与清理

```sh
node packages/cli/dist/local/agnes.mjs mcp test docs-tools --expected-revision REVISION
node packages/cli/dist/local/agnes.mjs mcp reconnect docs-tools --expected-revision REVISION
node packages/cli/dist/local/agnes.mjs mcp disable docs-tools --expected-revision REVISION
node packages/cli/dist/local/agnes.mjs mcp remove docs-tools --expected-revision REVISION
```

`test/reconnect` 会真的连接目标，读取到目录不等于每个工具效果都已验证。更新用 `mcp update`，携带最新 revision 及完整的新定义，更新后重新审核信任。操作会返回 operation ID；超时后先用 `resources operation OPERATION_ID` 查询，可用 `resources cancel OPERATION_ID` 请求取消。

模型可通过已启用目录搜索/调用工具，但服务端内容仍是外部输入。断线、凭据失效或工具列表变化时，先看 `status` 的连接状态、观测 revision、catalog revision 和安全错误，不用重装包代替诊断。

## 运行方式与版本

session worker 启动及资源变化后的轮次边界调用 `createMcpRowRuntime()` 所创建运行器的 `apply()`，从快照为每个启用且受信的服务器派生 Host `ext:` 行。各行拥有自己的连接，管理命令经共享 worker 处理。验证方法与范围见[验证记录](../maintainers/verification.zh-CN.md)。

修改定义会改变该行的 revision，未改变的服务器可以保留连接；禁用或删除会撤下对应行。派生前逐服务器校验，不合格定义被跳过并附原因。首轮连接等待有上限，行挂载完成不等于远端一定连接成功。跨服务器的工具搜索由 `agnes/mcp-search` 与 catalog hub 提供，旧 `agnes/mcp-client` 聚合扩展已从该主线移除。

**OAuth 限制：** 当前逐服务器行路径跳过 `secretBinding.kind === 'oauth'` 的定义。专用资源管理 service worker 保留 manager 路径，所以管理面连接/测试成功不等于该服务在会话内可调用。需要在目标会话验证实际工具调用；不要把管理状态当作 OAuth 会话支持证明。

逐服务器运行器的源码与测试可在下方查阅。实际运行版本及外部服务验证范围见[验证记录](../maintainers/verification.zh-CN.md)。

源码入口：[管理命令](../../packages/resource-control-cli/src/resources.ts)、[Schema](../../packages/protocol/schema/resource-control.json)、[资源启动](../../packages/resource-control-worker/src/runtime-bootstrap.ts)、[Worker 启动](../../packages/worker-runtime/src/main.ts)、[轮次重载](../../packages/worker-runtime/src/commands.ts)、[逐服务器运行器](../../packages/worker-runtime/src/mcp-row-runtime.ts)与[派生](../../packages/worker-runtime/src/mcp-server-rows.ts)。校验位置记录在[源码锚点清单](../../tools/public-docs/source-checks.json)。
