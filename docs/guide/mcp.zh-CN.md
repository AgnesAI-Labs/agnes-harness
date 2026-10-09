# MCP：连接外部工具

[English](mcp.md) | 简体中文

[文档导航](../README.zh-CN.md) · [安全](security.zh-CN.md)

已有 MCP 工具服务时，可以把它接入 AGH 的任务流程。本页带你添加服务、审核工具范围、建立连接，并在配置变化后检查实际状态。

控制面仍分别管理定义、安全审核、期望启用状态与实际连接状态。Web 中只需审核定义并点击一次“启用”，AGH 会先完成安全校验，再继续启用。看到工具目录后，再验证具体调用。

**当前源码：** 会话中的 MCP 服务以逐服务器 Host 行运行；OAuth 绑定仍会在该会话路径被跳过，详见[运行方式与版本](#运行方式与版本)。资源、提示模板与 OAuth 等支持与不支持的行为见 [MCP 与 Skills 支持范围](mcp-skills-support.zh-CN.md)。已执行的版本化验证见[验证记录](../maintainers/verification.zh-CN.md)。

## 在会话中接入

在本地 AGH 会话中，可以直接说“帮我接入这个 MCP”，并提供项目地址或连接信息。助手默认将服务接入当前 AGH；确认具体配置后，你可以在 **设置 → MCP** 查看登记与连接状态。连接和工具列表在轮次边界更新，接入后可在同一会话的下一轮继续使用。

此入口由 `@agnes/mcp-helper` 插件提供，默认安装并启用；已有配置首次升级也会补装缺失的助手。曾禁用或移除该插件时，可从[插件管理](packages.zh-CN.md)检查或安装。禁用此插件会撤下会话管理工具，已经接入的 MCP 服务保持独立管理。

会话接入目前支持无需凭据的 stdio、HTTP 和 SSE 配置。需要凭据时，通过下方命令行的 SecretRef 配置流程完成，勿在聊天中粘贴密钥。没有会话管理能力的宿主也可使用命令行添加。Blender 等应用所需的插件安装、应用启动与 MCP 连接是独立步骤；以实际工具调用确认最终可用。

本地 stdio 服务的确认仅授权该服务的具体配置启动。显式配置的部署 allowlist 始终有效；会话不能覆盖管理员的限制。更新定义或撤销信任后，原配置的本地启动批准失效，需要重新审核。

## 可直接复制的本地 stdio 示例

在源码仓库构建 CLI 后执行。此例只需 Node，不依赖网络包或 API key；使用全新的 AGH_HOME 和 local-dev profile。完成信任与启用后 daemon 会启动服务，无需另开进程。

```sh
export AGNES_PROFILE=local-dev
export AGH_HOME="$(mktemp -d)"
cat > "$AGH_HOME/hello-mcp.mjs" <<'JS'
import { createInterface } from 'node:readline';
const lines = createInterface({ input: process.stdin });
lines.on('line', (line) => {
  const request = JSON.parse(line);
  if (request.id === undefined) return;
  let result = {};
  if (request.method === 'initialize') result = {
    protocolVersion: request.params.protocolVersion,
    capabilities: { tools: {} },
    serverInfo: { name: 'hello-local', version: '1.0.0' },
  };
  if (request.method === 'tools/list') result = { tools: [{
    name: 'hello', description: 'Return a local greeting',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  }] };
  if (request.method === 'tools/call') result = {
    content: [{ type: 'text', text: 'Hello from local MCP' }],
  };
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }) + '\n');
});
JS
node agnes.mjs mcp add hello-local --name hello-local --stdio node --arg "$AGH_HOME/hello-mcp.mjs" --yes
MCP_REVISION=$(node agnes.mjs mcp get hello-local | sed -n 's/.*revision=\([a-f0-9]*\).*/\1/p')
node agnes.mjs mcp trust hello-local --expected-revision "$MCP_REVISION" --yes
MCP_REVISION=$(node agnes.mjs mcp get hello-local | sed -n 's/.*revision=\([a-f0-9]*\).*/\1/p')
node agnes.mjs mcp enable hello-local --expected-revision "$MCP_REVISION" --yes
node agnes.mjs mcp status hello-local
node agnes.mjs mcp tools hello-local
node agnes.mjs mcp test hello-local --expected-revision "$MCP_REVISION" --yes
```

预期看到 `connection=ready`、`hello` 工具和 succeeded 测试。在已配置模型的会话中让代理调用 hello-local 的 hello。

local-dev 默认允许 PATH 上的 stdio `node`、`npx`、`python`、`python3`，以及 loopback HTTP（`127.0.0.1`、`localhost`、`[::1]`）。这只是部署默认值，服务定义仍须审核并启用。启动 daemon 前设置 `AGNES_MCP_LOCAL_DEV_DEFAULTS=0` 可关闭两项默认值。`AGNES_MCP_STDIO_ALLOWLIST` 是逗号分隔的精确 executable 名称/路径列表（可为空），会替代默认列表；`AGNES_MCP_ALLOW_LOOPBACK_HTTP=0` 禁用 loopback HTTP，`1` 则显式允许。修改部署设置后重启 daemon。enterprise 与其他生产 profile 保持原有策略。非 TTY 写操作须加 `--yes`；`agh mcp --help` 不启动后台。enable/test 失败会显示具体、安全的状态原因。

## 配置并验证

Web 设置的 MCP 页面可查看服务、连接与工具目录。需要手动配置 stdio、HTTP 或 SSE 服务时，可使用命令行；`MCP_URL` 应是你已审核并可访问的 MCP endpoint，不是普通网页或模型 Base URL：

```sh
node agnes.mjs mcp add docs-tools --name docs-tools --http "$MCP_URL"
node agnes.mjs mcp get docs-tools
```

创建后默认停用。Web 中审核地址/进程、凭据引用与工具范围后直接点击“启用”，无需单独处理信任状态。开关跟随你的启用请求：请求过启用它就保持打开，连接或策略检查失败也照样开着，错误码和原因显示在同一行。关掉开关就是撤回启用请求，也是移除该服务的前置条件。命令行仍显式暴露底层审核与启用步骤，因此需要记录当前 revision 并依次执行：

```sh
node agnes.mjs mcp trust docs-tools --expected-revision REVISION
node agnes.mjs mcp get docs-tools
node agnes.mjs mcp enable docs-tools --expected-revision REVISION
node agnes.mjs mcp status docs-tools
node agnes.mjs mcp tools docs-tools
```

每次写操作前都以 `get` 的最新 revision 为准，不假定上一步不会修改它。revision 冲突意味着并行或在途变更，应重新读取，不能反复盲重试。

stdio 使用 `--stdio EXECUTABLE` 与重复的 `--arg VALUE`；不要把完整 shell 命令当 executable，也不能通过 `--arg -c` 绕到 shell。可用 executable 还由部署策略决定。HTTP/SSE 的地址、重定向和 loopback 可达性也受 Host 策略约束。

凭据使用已有 secret 引用：`--secret-env NAME=secret://namespace/name`（stdio）、`--bearer-ref secret://namespace/name` 或 `--header-ref x-api-key=secret://namespace/name`（HTTP/SSE）。不把真实密钥放在命令行、截图或文档中。`--allow-tool TOOL_NAME` 可以重复指定允许的工具。

## 调试、变更与清理

```sh
node agnes.mjs mcp test docs-tools --expected-revision REVISION
node agnes.mjs mcp reconnect docs-tools --expected-revision REVISION
node agnes.mjs mcp disable docs-tools --expected-revision REVISION
node agnes.mjs mcp remove docs-tools --expected-revision REVISION
```

`test/reconnect` 会真的连接目标，读取到目录不等于每个工具效果都已验证。更新用 `mcp update`，携带最新 revision 及完整的新定义，更新后重新审核信任。操作会返回 operation ID；超时后先用 `resources operation OPERATION_ID` 查询，可用 `resources cancel OPERATION_ID` 请求取消。

模型可通过已启用目录搜索/调用工具，但服务端内容仍是外部输入。断线、凭据失效或工具列表变化时，先看 `status` 的连接状态、观测 revision、catalog revision 和安全错误，不用重装包代替诊断。

## 运行方式与版本

session worker 启动及资源变化后的轮次边界调用 `createMcpRowRuntime()` 所创建运行器的 `apply()`，从快照为每个启用且受信的服务器派生 Host `ext:` 行。各行拥有自己的连接，管理命令经共享 worker 处理。验证方法与范围见[验证记录](../maintainers/verification.zh-CN.md)。

修改定义会改变该行的 revision，未改变的服务器可以保留连接；禁用或删除会撤下对应行。派生前逐服务器校验，不合格定义被跳过并附原因。首轮连接等待有上限，行挂载完成不等于远端一定连接成功。跨服务器的工具搜索由 `agnes/mcp-search` 与 catalog hub 提供，旧 `agnes/mcp-client` 聚合扩展已从该主线移除。

**大结果：** MCP 工具结果与内置工具走同一个输出守卫（见 `tools.output_max_bytes`）：模型看到头部和尾部，完整文本存在 `artifact://…?size=…` 路径下，`read` 与 `grep` 都认。一次调用返回多个块、总量超过该上限四倍时，模型只看到前面几块，完整文本集合以同样方式存储，每块前有一行 `=== text block N of M ===`。一次调用最多保留 4 MiB 文本：超过的部分在字符边界处截断，其后的文本块被丢弃，结果开头的说明会写明服务器返回了多少字节、保留了多少；其余内容不会存储，也无法读回。MCP 客户端会先把整个响应读进内存，之后才适用这些限制，所以上限约束的是复制与存储的量，不是最初那一份缓冲。

**OAuth 限制：** 当前逐服务器行路径跳过 `secretBinding.kind === 'oauth'` 的定义。专用资源管理 service worker 保留 manager 路径，所以管理面连接/测试成功不等于该服务在会话内可调用。需要在目标会话验证实际工具调用；不要把管理状态当作 OAuth 会话支持证明。

逐服务器运行器的源码与测试可在下方查阅。实际运行版本及外部服务验证范围见[验证记录](../maintainers/verification.zh-CN.md)。

源码入口：[管理命令](../../packages/resource-control-cli/src/resources.ts)、[Schema](../../packages/protocol/schema/resource-control.json)、[资源启动](../../packages/resource-control-worker/src/runtime-bootstrap.ts)、[Worker 启动](../../packages/worker-runtime/src/main.ts)、[轮次重载](../../packages/worker-runtime/src/commands.ts)、[逐服务器运行器](../../packages/worker-runtime/src/mcp-row-runtime.ts)与[派生](../../packages/worker-runtime/src/mcp-server-rows.ts)。校验位置记录在[源码锚点清单](../../tools/public-docs/source-checks.json)。

## 社区本地服务器沙箱

管理的社区 stdio 服务器默认使用 `strict`。在 MCP 设置中选择 `sandboxProfile` 后，再信任对应定义：

| 配置 | 工作区 | 自身 MCP 数据目录 | 网络 |
| --- | --- | --- | --- |
| `strict` | 只读 | 读写 | 禁止 |
| `workspace-write` | 读写 | 读写 | 禁止 |
| `network` | 只读 | 读写 | 允许 |
| `off-with-warning` | 完整主机访问 | 完整主机访问 | 允许 |

沙箱配置属于信任对话框批准的修订。修改后需要新的信任决定，并重新连接服务器。只有管理员签名官方目录验证过的精确定义默认关闭沙箱；手动和本地定义仍视为社区来源。

受限子进程可读取工作区、自身数据目录及必要的只读可执行程序和系统文件。`HOME` 和 `TMPDIR` 指向 `<profile-data>/mcp/<server-id>`；不能读取用户家目录中的私密文件或任意写入外部路径。运行依赖放在工作区，或将入口打包为自包含文件。可在服务器设置中声明可选绝对路径 `workspacePath`（CLI：`--sandbox-workspace /workspace/project`，并配置 `--sandbox-profile strict`）。该目录属于审阅过的定义，修改会撤销之前的信任决定。未声明工作区的共享 worker 只授予服务器数据目录；连接不会悄悄采用另一个会话的工作区。

连接管理复用已有 command sandbox 的探测和编译入口（macOS Seatbelt 或实际可用的 Linux bubblewrap）。Host 提供实际安装 home 和配置的文件凭据目录。所有受限配置都排除工作区的 `.agh/secrets`、`.agnes/secrets`、旧数据凭据目录，以及安装 home 的凭据、认证和 profile 配置目录，覆盖 canonical 路径和绑定别名。工作区可写授权不能覆盖这些排除。若只读挂载需要已有挂载点，Host 会在隔离前以 `0700` 模式预留空的受保护目录；准备失败就拒绝连接。更改受保护目录的祖先名称不能使内容暴露。

缺少实际 home 信息或隔离不可用时，以 `E_MCP_SANDBOX_UNAVAILABLE` 拒绝连接，并在 MCP 诊断中显示；不会静默裸启动。Windows 当前需要显式批准 `off-with-warning`。该配置允许子进程访问完整主机，请先审阅可执行程序再确认。HTTP/SSE 是远程服务器，继续使用已有 URL、凭据及工具策略。
