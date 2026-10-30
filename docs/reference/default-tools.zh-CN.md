# 官方默认工具

[English](default-tools.md) | 简体中文

标准预设通过官方 `defineTool` 插件披露以下工具。部署能力和文件系统策略仍然生效。新的 local-dev 和 enterprise 模板允许问答与交付物需要的投影能力；现有托管配置需要显式允许该能力。

标准预设直接提供 `ui_render`、`ui_update`、`ui_close` 和 `ui_guide`。构造界面前调用 `ui_guide` 获取完整组件 schema、数据契约和示例；render/update 的模型参数采用精简结构，服务仍在发布前执行完整协议、动作和数据校验。插件/Skill 创作、Skill 管理、MCP 连接管理、文档读取与 Computer Use 通过 `tool_search` 与 `tool_describe` 按意图加载。创作指引由版本匹配的指南工具返回，不再注入普通会话。`ui_submit` 是内部界面动作目标，不进入模型工具 schema 或发现目录。历史会话工具（`session_search`、`session_trace`、`session_event_search`、`session_event_read`、`session_event_trace`）与 MCP 资源工具（`list_mcp_resources`、`list_mcp_resource_templates`、`read_mcp_resource`）按需加载，每类在列表中占一行。MCP 服务器的工具遵循该服务器的工具加载方式（见 [MCP](../guide/mcp.zh-CN.md#mcp-工具如何提供给模型)）。延迟工具在每次请求的 `available_deferred_tools` 提示段中按名称排序，每项一句话，或每个 `discoveryGroup` 一行并附工具数量；描述最多 250 个字符，目录最多 8 KiB，省略项通过 `tool_search` 查找。通过 `tool_describe` 加载匹配工具后，schema 会进入后续模型请求；加载状态跨压缩和会话重开保留，工具调用仍受会话目录、模型能力、参数验证和授权约束。`ask_user_question` 和四个界面工具声明了 `requiresUser`，无人值守的轮次（`agh -p`、`agh run`）不提供它们（见[无人值守的轮次](../guide/headless.zh-CN.md#无人值守的轮次)）。业务 Loop 可通过 `prepareRequest({ tools: [...] })` 选择模型工具，或通过受控工具端口执行。

把独立的读取、搜索和状态查询放在同一模型回复中；只读调用并发执行，其他调用保持给定顺序。依赖前一步结果的工作须先检查结果。见[程序化批处理](../guide/code-workflows.zh-CN.md#批量调用独立工具)。

| 工具 | 输入与行为 |
| --- | --- |
| `read` | 读取受工作区权限约束的文本、会话附件及原图。对支持视觉的模型，本地单帧 PNG/JPEG 通过 artifact 成为模型图片输入；输入上限为 20 MiB、6400 万像素与 256 MiB 解码采样内存；渐进或隔行输入限制为 1600 万像素与 64 MiB 解码采样内存。进程最多同时解码两张图片，整个准备流程共享 30 秒时限；可选的原生 codec 只在读取图片时加载。按当前模型/运行时的字节、尺寸及像素限制等比例缩小，并去掉元数据。Web 沿用工具图片卡片；非视觉模型收到明确未检查像素的文字说明。`max_edge`（8–1456）可进一步降低输出尺寸。对单个 session-file/session-image 原件使用 `save_to`，可在正常写授权下通过独占、不跟随符号链接的创建能力复制到新的工作区相对路径，禁止覆盖。每份最多 100 MiB，每会话同时一份、每进程两份；更大的原件需客户端按字节窗口下载。其他格式需相应工具。 |
| `web_search` | `{"queries":["主题"]}`；一至四条非空查询。宿主提供搜索标题、链接和摘要。没有配置搜索提供方或密钥时返回 `WEB_SEARCH_UNAVAILABLE`，可改用已知 URL 调用 `web_fetch`。 |
| `ask_user_question` | `{"questions":[{"id":"route","question":"请选择路线","options":["A","B"]}]}`。省略 options 使用自由文本；`multiple:true` 允许多选，`allowFreeText:true` 允许补充答案。一至四个问题，id 必须唯一。`timeoutMs` 默认为 0（立即继续），1–60000 可选择等待至持久化截止时间。同批其他工具仍可执行；晚答作为新输入送达。 |
| `present` | `{"files":[{"path":"report.pdf","name":"Report.pdf","description":"供审阅"}]}`。注册已存在、可读取的普通文件，将内容复制为会话产物。最多十六个文件，每个文件和总量都不超过 32 MiB。surface 列出名称、说明及产物身份；工具结果保留需授权读取的 artifact 引用。 |
| `shell` | `{"command":"npm run build","background":true}` 启动会话任务。`timeoutMs` 设置前台等待时间；超时或等满 2 分钟（取较早者）后，同一个进程作为后台任务继续运行，结果会给出任务 ID。`timeoutToBackground:false` 则在 `timeoutMs` 时终止进程，不受 2 分钟上限约束。结果只提及该次请求中完整提供的任务工具。在有时间上限的回合（`agh -p --timeout`）中，前台等待还会在回合截止前结束，预留 15 秒与上限 5% 中的较大者；此时结果会说明回合时间即将用完以及还剩多少。后台任务不受此限制。 |
| `job_list` | `{}` 列出当前会话与分支的运行中和已完成任务。 |
| `job_output` | `{"jobId":"返回的任务ID","waitMs":1000}` 读取输出和状态，可选等待最多 60 秒，并受工具期限限制；在有时间上限的回合中，等待也像前台 `shell` 一样在回合截止前结束。长输出存为可读取产物。 |
| `job_kill` | `{"jobId":"返回的任务ID"}` 终止当前会话拥有的任务及进程组。 |
| `lsp_diagnostics` | `{"paths":["src/a.ts"],"severity":"error"}` 向语言服务器查询最多 20 个文件的错误（TypeScript/JavaScript、Python、Go；Rust 仅限受信任的工作区）；`severity` 为 `error`、`warning` 或 `all`。按需加载。只读：服务器以不执行工作区代码的静态分析模式启动。`write` 和 `edit` 也会把被修改文件的错误附在结果后。详见[代码诊断](../guide/lsp.zh-CN.md)。 |
| `schedule_create` | 创建定时任务。`after_seconds`、`at`、`every_seconds`、`daily`、`weekly`、`cron` 只能提供其中一项，并用 `target` 选择在哪里运行：`new_session` 每次运行都在当前会话的工作区开一个新会话（适合重复的工作）；`current_session` 把提示发到当前会话，空闲时开始一轮，运行中则并入（适合一次性提醒）。结果里的 `runsIn` 说明在哪里运行。 |
| `schedule_list` | 列出当前会话创建或接收的有效定时任务、运行位置、下次运行和最近的运行记录。 |
| `schedule_update` | 修改当前会话创建或接收的定时任务。`after_seconds` 只能在创建时使用；不传 `target` 则保持不变。运行过程中修改提示、日程或运行位置返回 `schedule_conflict`。 |
| `schedule_delete` | 归档定时任务。未知或已归档的 id 返回 `deleted: false`。已经排队的消息不会撤回。 |
| `grep` / `find` | 使用固定版本的内置 ripgrep，跳过依赖、构建目录、禁止路径和符号链接。超过请求行数的输出存为 `artifact://…?size=…`；将完整定位符交给 `read`，使用 `offset`/`limit` 分页。`ls`、`find` 和 `grep` 还会把它们显示的工作区路径（最多 100 条）作为给循环的 `structured` 数据返回（schema 为 `agh.path-references/1`）；文本不变。 |

搜索路径可以直接指定一个文件，包括可读取的文件符号链接；显式指定文件时 grep 不应用 glob。目录遍历不跟随符号链接。无法启动搜索程序时，使用同一工作区策略下的有界文件系统回退。结果会列出有限数量的不可读路径及原因，并统计跳过的二进制文件；无法搜索任何可读文本时返回错误，正常的无匹配仍是成功结果。

<a id="path-references"></a>

`structured` 里的路径相对于工作区根目录、以 `/` 分隔，只取自文本显示出来的内容：`ls` 在 `limit` 之内列出的条目、`find` 显示的文件、`grep` 显示的行里有匹配的文件。显示出来但在工作区之外的路径、写成 JSON 字符串后超过 1024 字节的路径，以及在分隔符是 `/` 的系统上名字里含反斜杠的路径不会列入；`total` 计入工具找到的每条路径，包括这些路径和超出行数限制后找到的路径。因策略拒绝而跳过的路径既不列入也不计数，也不会让列表标记为 truncated。列表比 `total` 短、搜索本身不完整，或输出防护截断了文本时，`truncated` 为 true；截断之后，只有完整名字仍显示在文本里的路径保留引用。失败的结果和对已存产物的 `grep` 不带 `structured`。任何工具的结果只要 `structured` 带这个 schema，`run_code` 脚本拿到的就是它的文本。

使用 `write` 或 `edit` 修改已有文本文件之前，必须在同一会话读取该文件。缺少观察记录时返回 `FS_NOT_OBSERVED`；成功修改会记录新版本。新文件可以直接创建。观察记录有数量上限，且仅在当前进程有效：宿主重启或记录被淘汰后需要重新读取。二进制读取、失败读取和产物读取不会解锁工作区修改。过期版本检查仍然生效。`write` 还会拒绝看起来被截断的覆盖写入（`FS_TRUNCATION_GUARD`）：新内容不足原内容的 40%，或较短的改写留下原文件没有的未闭合括号。文件末尾未闭合的双引号字符串在文件增长时仍会检查。括号配对只是启发式信号，因此等长或增长的改写不检查此项，避免语言特有引号和普通文本造成误拦。确实要大幅缩小文件（包括清空文件）时，用 `allowShrink: true` 确认；它只豁免大小检查，不会绕过先读后写和过期版本检查。`edit` 不做截断检查，因为删除的每个字节都由精确匹配的 `oldText` 指明。`write` 为 `.bat`/`.cmd` 使用 CRLF，并保留已有文件一致的 CRLF；`edit` 可用 LF 文本匹配并替换一致 CRLF 文件中的多行内容。两者保留已有 UTF-8 BOM；版本记录、字节数和审阅回执均对应实际写入字节。

精确编辑失败时，`FS_EDIT_NOT_FOUND` 最多返回三个候选区域、从 1 开始的行号与 JSON 转义的短摘录；可检测时说明空白/缩进、换行、引号/Unicode 差异、同次调用中前项已替换，或读取后文件已变更。诊断不会自动应用模糊替换。候选扫描上限为文件 256 Ki 字符/20,000 行、查找块 8,192 字符/80 行；超限时建议先 grep，再读取小范围。歧义匹配返回 `FS_AMBIGUOUS_EDIT` 及前 20 个匹配起始行号。任一编辑失败，整批均未写入；修正后须重新发送整批。失败摘录先脱敏，再经过既有输出防护。文件系统拒绝返回稳定错误码及恢复动作，不回显底层原始异常。

Web 问答使用同一个预设 surface 表单，提供单选、多选与自由文本控件。TUI 读取同一批 surface：单个问题可输入标签或编号，多选使用逗号分隔标签或编号，多个问题使用以问题 id 为键的 JSON 对象。两者均通过 `ui.action` 进入普通 deferred `ui_submit` 收集工具。无效、陈旧回答及普通工具策略拒绝保留表单；成功回答关闭表单，经 SC1 保留认证 actor 与 untrusted 内容送达 Agent。回答不授予工具权限。`timeoutMs` 只限制等待，晚答仍有效。重新加载从账本恢复表单与动作回执。渠道显示编号选项，通过需认证的 Web 链接回答；`outbound.webUrl` 应配置为可访问的 Web 基址。

Shell 命令默认获得 `PYTHONUNBUFFERED=1` 和 `PYTHONUTF8=1`。PowerShell 使用 Host 选定的解释器；5.1 以命令文本启动，避免序列化 CLIXML。非 UTF-8 输出按行回退到受支持的实测控制台代码页。超时结果说明空输出和重复超时次数，不猜测原因；命令自己放到后台的进程（`server &`、`nohup server &`、`setsid server &`）作为该命令的任务继续运行：命令本身结束时调用即返回，带上它的退出码，并说明任务仍在运行。任务的 shell 退出时，进程组中其余仍在运行的进程（例如子 shell 启动的）会被停止，结果会说明停止了几个并提示改用 `background: true`。Linux 上从 `/proc` 计数，因此没有 `ps` 的镜像同样会报告。离开进程组的进程（自行守护化的程序）不会被停止。命令的 shell 被并非 AGH 发出的信号终止时，结果会说明；命令里用了 `pkill -f` 或 `killall` 时，还会说明它们会匹配到自己所在 shell 的命令行。

后台任务跨轮次保留，但不跨宿主重启。会话关闭时终止并清理全部所属任务。活跃进程句柄会阻止会话因空闲而休眠。清理失败保持可见，并保留句柄供后续重试关闭。每个任务最多捕获 4 MiB 输出，达到上限时会提示。每个会话与分支最多保留 128 个任务，优先淘汰已完成项。进程由选定沙箱提供方负责；缺失交互进程入口时明确拒绝，不回退本地执行。前台调用取消会终止任务；成功返回后台任务的工具调用结束不会终止任务。

五段 cron 遵循 Vixie。日或星期字段的文本以 `*` 开头时不受限制；两者都受限制时，日期只要满足其中一项即匹配。星期 `7` 是星期日。带时区时，不存在的本地时间会被跳过，重复的本地时间只在较早的瞬间触发一次。停机之后，重复提醒只补上最近一次错过的运行。删除提醒不会撤回已经排队的消息。搜索范围是 366 天。

文件搜索对进程捕获量和累计匹配文本设有上限，累计匹配文本最多 4 MiB。达到捕获上限会明确标记结果不完整；产物包含全部已捕获行，不包含未捕获数据。文件访问仍通过公开上下文与受约束执行器检查。发行包携带固定版本的平台可执行文件及许可声明，无须系统安装 `rg`。

本地 artifact 存储接受零到 100 MiB 的配置读取上限，硬上限为 100 MiB。daemon 授权最多 100 MiB 的原件下载；交付物和工具输出读取仍保留各自的 32 MiB 上限。有界窗口读取先按 64 KiB 窗口核验整份原件摘要，再返回请求的响应范围。ripgrep 保留独立的捕获输出上限。Computer Use 图片仍单独受 4 MiB 上限约束，RPC 响应分块也有独立限制。

问答、提醒/工作流表格和交付物列表使用统一的 Intelligent UI surface 投影，同时显示在会话与工作台中，不再填充专用 `tool.card.inline` 载荷。交付物采用既有 text 预设，不增加专用下载控件或新组件。

产物消费方使用已有的会话与分支授权产物 RPC，按有界分块读取。客户端校验大小与 SHA-256 后创建临时 URL。HTML 等主动内容格式按普通字节下载。注册文件不会授予访问任意宿主路径或 URL 的权限。

部署方通过公开宿主依赖嵌入搜索：

```ts
import type { SearchProvider } from '@agnes/extension-api'

const searchProvider: SearchProvider = {
  async search(queries, { signal, timeoutMs }) {
    return deploymentSearch.search(queries, { signal, timeoutMs })
  },
}
// 在已有 createHost(profile, dependencies) 参数中加入 searchProvider。
```

提供方负责凭据、传输和厂商选择。工具不接收密钥，也不选择厂商。「插件 → 内置 → 网页搜索」可配置 Brave、Tavily、Exa、Perplexity 或自建 SearXNG。端点、结果上限、超时和速率限制保存在配置档数据目录。保存启用的连接或新密钥前，会先用候选配置进行一次最小搜索；验证失败会保留原配置和密钥。停用或移除密钥不需要联网。验证、工具调用和设置页测试共用同一速率窗口，也可能消耗服务商额度。API 密钥只写入 `secret://search/<provider>`，位于主目录的 secrets（`<home>/secrets`）。配置档未指定其他路径时，文件适配器也读取该目录。原先落在 `<dataDir>/secrets` 的存储会迁移过去。没有就绪的默认提供方时，工具返回 `WEB_SEARCH_UNAVAILABLE`。部署方传入的 `SearchProvider` 会替换该注册表。规范化摘要包含 Citations 列表。页面区分“已配置，尚未验证”和本次页面中“测试通过”的状态。失败按认证、权限、付费、限流、超时和连接问题显示固定提示，不在日志中泄露凭据。官方结果行通过可选的 `SearchResult.provider` 字段声明实际使用的服务；全部结果都标明同一服务时，工具会在 `Search service` 标题和 `details.provider` 中明确返回。空结果、混合服务结果或未声明身份的自定义提供方不推断服务名称。

持久 shell：为 `shell` 设置 `persistent:true`，可选择 `shell:"bash"|"zsh"|"pwsh"`。返回命令的 `jobId` 与解释器的 `sessionId`，后续调用保留 cwd、环境变量和解释器变量。可传 `sessionId` 选择现有解释器；忙碌时拒绝另一条命令，终止命令会关闭解释器。交互式 stdin 请使用 PTY。

PTY 工具：`pty_open/read/send/signal/resize/list/close` 分别负责打开、读取、发送原始文本、发信号、调整尺寸、列出和关闭。所有操作按返回的 `jobId` 定位。统一 `job_list/output/kill` 也支持 PTY、持久解释器和子代理（`child:<id>`），完成通知出现在后续模型上下文及 Web 作业面板。任务跨轮次保留，Host 重启不恢复。

本地 PTY 支持构建原生助手后的 macOS/Linux；Windows 支持管道执行，PTY 需提供方实现。Shell 必须已安装。远端和其他沙箱提供方必须实现公共 process 入口，缺失时明确拒绝，不回退本地执行。捕获上限 4 MiB，每会话/分支最多保留 128 个作业。

## 持久目标工具

goal_get {} 读取会话目标、续轮与额度用量。goal_update 接受 status "complete" 或 "blocked" 和非空 reason。模型不能创建或恢复目标。通过 Web 目标卡片或 [会话指南](../guide/sessions.zh-CN.md#persistent-goals) 中的 /goal 命令控制。

已存附件在 inbox 和消息中保留 artifact 引用。Core 在接纳前核验精确的 session/lane 授权、MIME、大小和摘要；fork 只能读取父会话的可见前缀。普通 CAS 对象至少保留 24 小时，只有在持锁核验完整 ledger 与回执根、确认不可达后才可回收。原件、缩略图与派生产物引用都作为根保留；索引损坏或不完整时禁止删除。

编辑失败保留原错误码，并附结构化 `category`、`index`、`written` 和 `hint`。相同的短 JSON 也放入 content，让标准模型请求与程序调用方都能读取。分类为 `not_read`、`not_found`、`ambiguous`、`invalid_args`、`write_failed`；`index` 从 0 开始，文件或整批失败时为 `null`。匹配失败不会落盘，即使前面的编辑已在内存中匹配成功；写入后端失败且不能排除部分写入时，返回 `written: "unknown"`，重试前须重新读取。意外 I/O 错误仍向上传播，在错误结果文本中携带这些安全 JSON 反馈。执行前的 schema 拒绝使用 `invalid_args` 和首个失败数组项索引（或 `null`）；嵌套调用的错误文本也包含相同反馈的 JSON。精确唯一匹配和针对中间态的顺序语义保持不变。
