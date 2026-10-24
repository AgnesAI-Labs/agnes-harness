# MCP：连接外部工具

[English](mcp.md) | 简体中文

[文档导航](../README.zh-CN.md) · [安全](security.zh-CN.md)

已有 MCP 工具服务时，可以把它接入 AGH 的任务流程。本页带你添加服务、审核工具范围、建立连接，并在配置变化后检查实际状态。

控制面仍分别管理定义、安全审核、期望启用状态与实际连接状态。Web 中只需审核定义并点击一次“启用”，AGH 会先完成安全校验，再继续启用。看到工具目录后，再验证具体调用。

在 Web 中选择“添加 MCP 服务”，再选“本地命令”或“远程服务”，填写名称与命令或网址。命令中的带引号参数会保留，不通过 shell 执行。需要认证时，从已保存的凭据中选择；本地命令选择凭据后，须按服务文档明确填写令牌环境变量名，例如 Context7 的 `CONTEXT7_API_KEY`，页面不再预填通用的 `TOKEN`。

本地命令的沙箱选项直接显示在连接表单中。默认 `strict` 禁止联网；需要下载包或访问在线 API 时，须明确选择 `network` 并审核。允许联网仍保留文件访问限制，不能保证任意本机启动脚本可用。服务端会将可识别的启动环境缺失、程序或模块不可用、访问被拒绝、网络失败、握手前退出、超时与 HTTP 401/403 转为对应的安全错误类别；这些分类来自有限证据，不代表完整的根因诊断。原始子进程标准错误不会显示或写入连接状态。

工作区目录也直接显示在本地命令的基础表单中。识别到 Node/Python 命令的首个参数为绝对脚本路径时，使用沙箱须在保存前明确填写工作区绝对路径，目录应包含脚本及其依赖。页面会建议脚本所在文件夹；对于 npm 包，则建议 `node_modules` 上一级的安装根目录。点击“使用建议目录”才会采用，修改命令不会覆盖已有目录。浏览器无法解析服务端的软链接和实际文件权限，已填写但与建议范围不同的目录仍可审核保存。`npx` 等包启动器及内联命令仍可按原有方式省略工作区。允许联网不会扩大文件读取权限。

“高级选项”包含服务标识、允许的工具与自定义凭据绑定。本地 stdio、HTTP 和旧版 SSE 仍受支持。已有服务可从行菜单或详情中选择“编辑”。保存仍需确认，新服务须启用后才连接。选择“测试连接”后，查看连接状态和工具目录，核对实际可用性。

新增服务后显示“已添加，当前未启用”的成功通知，三秒后自动消失，也可按 Esc 提前关闭。需要使用时，可从服务详情中启用；页面顶部不再常驻“检查配置并启用”警告。连接进度或失败原因仍显示在服务行中。

工具目录默认按工具显示名称和简短用途。展开单个工具可查看完整说明、参数类型与必填状态；复杂约束可通过“查看输入定义”检查。说明使用服务返回的原文，列表摘要仅用于浏览，不改变智能体收到的工具定义。

编辑命令、地址或凭据等连接配置后，新版本会以未信任、未启用状态保存，旧版本的启用请求不会用于连接新配置。重新审核并启用后才会连接。仅修改工具加载方式仍保留信任与启用状态。

**当前源码：** 会话中的 MCP 服务以逐服务器 Host 行运行；OAuth 绑定仍会在该会话路径被跳过，详见[运行方式与版本](#运行方式与版本)。资源、提示模板与 OAuth 等支持与不支持的行为见 [MCP 与 Skills 支持范围](mcp-skills-support.zh-CN.md)。已执行的版本化验证见[验证记录](../maintainers/verification.zh-CN.md)。

每个远端工具只有一个本地名称：`mcp__<server>__<tool>`。清洗、长度限制或重名需要改写时会加入哈希，名称始终不超过 64 字符。每个服务器只获得自己的前缀授权；执行时仍发送原始远端工具名。单服务器资源桥接工具使用相同命名规则。

## 在会话中接入

完全访问下，助手的 MCP 注册、信任、启用和本地启动决定自动允许，不再弹出审批，记录精确配置和 `full-access` 原因。管理页面的人工编辑仍由管理权限约束，部署硬拒绝和连接失败仍会生效。

自动注册／启动授权绑定精确配置、会话、主体和有效期。退出完全访问、取消或关闭会话会停止剩余效果，包括排队写入；重启不能恢复未完成的自动授权。已经完成的管理变更不会回滚。继续前先重读定义和操作回执；管理员仍可走正常审核流程。

`tool_search` 按名称、描述和参数关键词检索会话可见的全部工具，包括已经提供给模型的工具。延迟与非延迟工具共用排序且只出现一次，ready Skills 保留发现名额。使用 `tool_describe` 加载延迟工具 schema。Tavily 等服务商名称指 `web_search` 背后的已配置服务商，并非独立工具。发现工具不等于连通性验证；应调用工具或在设置中测试服务状态。描述中的服务商例子是静态文本，配置变化不会改写工具 schema。

在本地 AGH 会话中，可以直接说“帮我接入这个 MCP”，并提供项目地址或连接信息。助手默认将服务接入当前 AGH；确认具体配置后，你可以在 **插件 → 连接（MCP）** 查看登记与连接状态。连接和工具列表在轮次边界更新，接入后可在同一会话的下一轮继续使用。

此入口由 `@agnes/mcp-helper` 插件提供，默认安装并启用；已有配置首次升级也会补装缺失的助手。曾禁用或移除该插件时，可从[插件管理](packages.zh-CN.md)检查或安装。禁用此插件会撤下会话管理工具，已经接入的 MCP 服务保持独立管理。

会话接入目前支持无需凭据的 stdio、HTTP 和 SSE 配置。需要凭据时，通过下方命令行的 SecretRef 配置流程完成，勿在聊天中粘贴密钥。没有会话管理能力的宿主也可使用命令行添加。Blender 等应用所需的插件安装、应用启动与 MCP 连接是独立步骤；以实际工具调用确认最终可用。

本地 stdio 服务的确认仅授权该服务的具体配置启动。显式配置的部署 allowlist 始终有效；会话不能覆盖管理员的限制。更新定义或撤销信任后，原配置的本地启动批准失效，需要重新审核。

## 浏览器自动化：Playwright MCP 与 Computer Use 如何选择？

对于具有可访问页面控件的业务网站，例如 CRM 导航、表单填写、表格读取或流程检查，使用 **Playwright MCP**。它通过浏览器无障碍树操作页面，可以无头运行，不占用桌面。原生桌面应用、可视化或画布控件，以及需要真实屏幕截图和像素点击的流程，使用 **Computer Use**（`agnes/computer-use`，Cua 驱动）。根据目标界面选择；Playwright MCP 仍是普通的实时 MCP 资源。

在 **插件 → 连接（MCP） → 添加预设** 中选择 **Playwright MCP**。AGH 在现有可编辑表单中预填 `npx --yes @playwright/mcp@0.0.83 --headless --isolated` 和 `network` 沙箱配置。包名、版本和参数已按 [npm 包](https://www.npmjs.com/package/@playwright/mcp/v/0.0.83) 与[上游文档](https://github.com/microsoft/playwright-mcp#configuration)核对。审核命令、工作区、沙箱和工具范围，再通过普通确认保存。资源仍为**未信任、禁用**。明确选择“启用”并确认，才会信任该修订并请求激活。选择或保存预设不会安装或启动任何程序。

CLI 使用现有 `mcp` 命令形态，创建相同的受管定义：

```sh
node agnes.mjs mcp add --preset playwright
# 可选：独立服务器 ID，以及 daemon 所在机器上的明确工作区：
node agnes.mjs mcp add billing-browser --preset playwright --sandbox-workspace /workspace/billing
node agnes.mjs mcp get playwright
node agnes.mjs mcp trust playwright --expected-revision REVISION
node agnes.mjs mcp get playwright
node agnes.mjs mcp enable playwright --expected-revision REVISION
```

非交互调用必须为每次修改明确提供 `--yes`。CLI 创建预设不会授予信任或启用。修改已保存的定义仍使用提交完整定义的 `mcp update` 流程；修改后需要重新审核。

`--isolated` 将每个浏览器连接的配置保存在内存中，不复用用户浏览器的登录状态，也不会在关闭浏览器后保留登录。自动输出使用可写工作区中的上游隐藏目录 `.playwright-mcp`。现有 `network` 沙箱使工作区只读，因此上游会回落到服务器私有 `TMPDIR`（`<profile-data>/mcp/<server-id>`）下的 `.playwright-mcp`。明确命名的文件仍按工作区解析，可能被沙箱拒绝。预设有意不设置 `--output-dir`，以保留可写回落路径，不扩大沙箱权限。

AGH 不打包或安装浏览器。使用前，请按上游浏览器安装说明准备 daemon 执行环境可访问的兼容浏览器，并在信任前审核 `--browser` / `--executable-path` 等修改。明确启用（或确认连接测试）之后，npx 可能将固定版本的包下载到服务器环境。部署的可执行文件限制、网络权限和沙箱可用性仍然生效。查看 `mcp status playwright` 并验证真实浏览器工具调用；预设只是配置便利入口，不代表所有平台都已验证浏览器启动。

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

AGH 会把空输入 schema，以及缺少 `type` 但含对象约束的 schema，规范为 `type: "object"`。真正的非对象或非法根只跳过该工具，并在目录中显示 `invalid-schema` 原因；同一服务器的其他工具仍可使用。

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

stdio 使用 `--stdio EXECUTABLE` 与重复的 `--arg VALUE`；不要把完整 shell 命令当 executable，也不能通过 `--arg -c` 绕到 shell。可用 executable 还由部署策略决定。HTTP/SSE 的地址、重定向和 loopback 可达性也受 Host 策略约束。GET SSE 在长时间没有事件时保持连接。部署侧的空闲计时和请求截止时间作用于普通响应和 POST 流，不作用于 GET `text/event-stream`；部署客户端同时关闭 undici 的五分钟响应体超时。

凭据使用已有 secret 引用：`--secret-env NAME=secret://namespace/name`（stdio）、`--bearer-ref secret://namespace/name` 或 `--header-ref x-api-key=secret://namespace/name`（HTTP/SSE）。不把真实密钥放在命令行、截图或文档中。`--allow-tool TOOL_NAME` 可以重复指定允许的工具。

## MCP 工具如何提供给模型

模型可调用的每个工具 schema 都会随每次请求发送，MCP 目录一大，每一轮都要多付上下文和费用。以官方工具集实测：一个含 15 个常见工具的服务器每次请求约增加 2,750 tokens，十个这样的服务器约 27,500。

你不需要做任何选择。每个服务器的工具加载方式默认为**自动**：会话中的自动工具不超过 15 个、且 schema 合计不超过约 4,000 tokens 时，照常发送；超过任一上限，所有自动工具改由 `tool_search` 发现，模型只看到每个服务器一行：名称、工具数量和其中几个工具名。模型按任务或服务器名搜索，用 `tool_describe` 加载工具，加载后在本会话内一直可用，压缩和重新打开后也是如此。加载不授予任何权限：参数校验、策略与审批和其他调用完全相同。

开启「显示高级设置」后，服务器详情页有**工具加载方式**：自动、始终可见（总是发送 schema）或按需（总是经 `tool_search` 发现）。它对应定义中的 `toolDisclosure` 字段（`auto`、`always` 或 `on-demand`，省略即 `auto`），经正常的 `mcp update` 路径保存。只改加载方式时，服务器保持受信和启用，因为运行和连接的内容都没有变化；其他任何修改仍需重新审核。会话运行时对话框会标出按需加载的工具。

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

修改定义会改变该行的 revision，未改变的服务器可以保留连接；禁用或删除会撤下对应行。派生前逐服务器校验，不合格定义被跳过并附原因。新启用服务器的首次连接，一轮最多等待 10 秒；仍在连接的服务器不参与本轮，对话中会出现一条安静提示，例如「Docs Tools 还在连接，本轮先不使用它」，连上后从之后的轮次开始可用。因此行挂载完成不等于远端一定连接成功。跨服务器的工具搜索由 `agnes/mcp-search` 与 catalog hub 提供，旧 `agnes/mcp-client` 聚合扩展已从该主线移除。

**大结果：** MCP 工具结果与内置工具走同一个输出守卫（见 `tools.output_max_bytes`）：模型看到头部和尾部，完整文本存在 `artifact://…?size=…` 路径下，`read` 与 `grep` 都认。一次调用返回多个块、总量超过该上限四倍时，模型只看到前面几块，完整文本集合以同样方式存储，每块前有一行 `=== text block N of M ===`。一次调用最多保留 4 MiB 文本：超过的部分在字符边界处截断，其后的文本块被丢弃，结果开头的说明会写明服务器返回了多少字节、保留了多少；其余内容不会存储，也无法读回。MCP 客户端会先把整个响应读进内存，之后才适用这些限制，所以上限约束的是复制与存储的量，不是最初那一份缓冲。

MCP 集合成功应用后，即使独立的 Skills 刷新失败，也保留新的 MCP 集合；该失败不会恢复已禁用或删除的服务器。若 MCP 应用后状态不确定，Worker 会拒绝后续轮次，直到完成恢复。

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

连接管理复用已有 command sandbox 的探测和编译入口（macOS Seatbelt 或实际可用的 Linux bubblewrap）。Host 提供实际安装 home 和配置的文件凭据目录。所有受限配置都排除工作区的 `.agh/secrets`、旧数据凭据目录，以及安装 home 的凭据、认证和 profile 配置目录，覆盖 canonical 路径和绑定别名。工作区可写授权不能覆盖这些排除。若只读挂载需要已有挂载点，Host 会在隔离前以 `0700` 模式预留空的受保护目录；准备失败就拒绝连接。更改受保护目录的祖先名称不能使内容暴露。

缺少实际 home 信息或隔离不可用时，以 `E_MCP_SANDBOX_UNAVAILABLE` 拒绝连接，并在 MCP 诊断中显示；不会静默裸启动。Windows 当前需要显式批准 `off-with-warning`。该配置允许子进程访问完整主机，请先审阅可执行程序再确认。HTTP/SSE 是远程服务器，继续使用已有 URL、凭据及工具策略。

## 管理通用凭据

通过[凭据管理合同](credentials.zh-CN.md)创建只写密钥，再把返回的 `secret://generic/<UUID>` id 放入现有 MCP secret 绑定。
