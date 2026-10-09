# 官方默认工具

[English](default-tools.md) | 简体中文

标准预设通过官方 `defineTool` 插件披露以下工具。部署能力和文件系统策略仍然生效。新的 local-dev 和 enterprise 模板允许问答与交付物需要的投影能力；现有托管配置需要显式允许该能力。

Intelligent UI 工具（`ui_render`、`ui_update`、`ui_close`、`ui_submit`）按需披露。先用 `tool_search` 找到匹配的延迟工具，再用 `tool_describe` 指定确切名称，使完整 schema 出现在后续模型请求中。发现记录跨压缩与会话恢复保留；每次调用仍受当前会话目录、模型能力、参数校验与工具授权约束。`ask_user_question` 始终立即可用，并通过普通内部工具通道渲染表单。业务 Loop 可以用 `prepareRequest({ tools: [...] })` 显式选择工具，或通过受控工具端口执行；金融示例使用该执行端口，说明文本请求保持 `tools: []`。

| 工具 | 输入与行为 |
| --- | --- |
| `read` | 读取受工作区权限约束的文本、会话附件及原图。对支持视觉的模型，本地单帧 PNG/JPEG 通过 artifact 成为模型图片输入；输入上限 4 MiB、1600 万像素。按当前模型/运行时的字节、尺寸及像素限制等比例缩小，并去掉元数据。Web 沿用工具图片卡片；非视觉模型收到明确未检查像素的文字说明。其他格式需相应工具。 |
| `web_search` | `{"queries":["主题"]}`；一至四条非空查询。宿主提供搜索标题、链接和摘要。没有配置搜索提供方或密钥时返回 `WEB_SEARCH_UNAVAILABLE`，可改用已知 URL 调用 `web_fetch`。 |
| `ask_user_question` | `{"questions":[{"id":"route","question":"请选择路线","options":["A","B"]}]}`。省略 options 使用自由文本；`multiple:true` 允许多选，`allowFreeText:true` 允许补充答案。一至四个问题，id 必须唯一。`timeoutMs` 默认为 0（立即继续），1–60000 可选择等待至持久化截止时间。同批其他工具仍可执行；晚答作为新输入送达。 |
| `present` | `{"files":[{"path":"report.pdf","name":"Report.pdf","description":"供审阅"}]}`。注册已存在、可读取的普通文件，将内容复制为会话产物。最多十六个文件，每个文件和总量都不超过 32 MiB。surface 列出名称、说明及产物身份；工具结果保留需授权读取的 artifact 引用。 |
| `shell` | `{"command":"npm run build","background":true}` 启动会话任务。`timeoutMs` 设置前台等待时间；超时后同一个进程继续在后台运行。`timeoutToBackground:false` 则终止进程。 |
| `job_list` | `{}` 列出当前会话与分支的运行中和已完成任务。 |
| `job_output` | `{"jobId":"返回的任务ID","waitMs":1000}` 读取输出和状态，可选等待最多 60 秒，并受工具期限限制。长输出存为可读取产物。 |
| `job_kill` | `{"jobId":"返回的任务ID"}` 终止当前会话拥有的任务及进程组。 |
| `schedule_create` | 在当前会话创建提醒。`after_seconds`、`at`、`every_seconds`、`daily`、`weekly`、`cron` 只能提供其中一项。提示会启动空闲会话，或恢复正在运行的会话。 |
| `schedule_list` | 列出当前会话的有效提醒、下次运行和最近送达记录。 |
| `schedule_update` | 修改当前会话拥有的提醒。`after_seconds` 只能在创建时使用。运行过程中修改提示或日程返回 `schedule_conflict`。 |
| `schedule_delete` | 归档提醒。未知或已归档的 id 返回 `deleted: false`。已经排队的消息不会撤回。 |
| `grep` / `find` | 使用固定版本的内置 ripgrep，跳过依赖、构建目录、禁止路径和符号链接。超过请求行数的输出存为 `artifact://…?size=…`；将完整定位符交给 `read`，使用 `offset`/`limit` 分页。 |

使用 `write` 或 `edit` 修改已有文本文件之前，必须在同一会话读取该文件。缺少观察记录时返回 `FS_NOT_OBSERVED`；成功修改会记录新版本。新文件可以直接创建。观察记录有数量上限，且仅在当前进程有效：宿主重启或记录被淘汰后需要重新读取。二进制读取、失败读取和产物读取不会解锁工作区修改。已有的过期版本检查和截断防护仍然生效。

Web 问答使用同一个预设 surface 表单，提供单选、多选与自由文本控件。TUI 读取同一批 surface：单个问题可输入标签或编号，多选使用逗号分隔标签或编号，多个问题使用以问题 id 为键的 JSON 对象。两者均通过 `ui.action` 进入普通 deferred `ui_submit` 收集工具。无效、陈旧回答及普通工具策略拒绝保留表单；成功回答关闭表单，经 SC1 保留认证 actor 与 untrusted 内容送达 Agent。回答不授予工具权限。`timeoutMs` 只限制等待，晚答仍有效。重新加载从账本恢复表单与动作回执。渠道显示编号选项，通过需认证的 Web 链接回答；`outbound.webUrl` 应配置为可访问的 Web 基址。

后台任务跨轮次保留，但不跨宿主重启。会话关闭时终止并清理全部所属任务。每个任务最多捕获 4 MiB 输出，达到上限时会提示。每个会话与分支最多保留 128 个任务，优先淘汰已完成项。进程由选定沙箱提供方负责；缺失交互进程入口时明确拒绝，不回退本地执行。前台调用取消会终止任务；成功返回后台任务的工具调用结束不会终止任务。

五段 cron 遵循 Vixie。日或星期字段的文本以 `*` 开头时不受限制；两者都受限制时，日期只要满足其中一项即匹配。星期 `7` 是星期日。带时区时，不存在的本地时间会被跳过，重复的本地时间只在较早的瞬间触发一次。停机之后，重复提醒只补上最近一次错过的运行。删除提醒不会撤回已经排队的消息。搜索范围是 366 天。

文件搜索对进程捕获量和累计匹配文本设有上限，累计匹配文本最多 4 MiB。达到捕获上限会明确标记结果不完整；产物包含全部已捕获行，不包含未捕获数据。文件访问仍通过公开上下文与受约束执行器检查。发行包携带固定版本的平台可执行文件及许可声明，无须系统安装 `rg`。

本地 artifact 存储接受零到 32 MiB 的配置读取上限，硬上限为 32 MiB。CLI 和 daemon 使用 32 MiB，与交付物及可读溢出产物的最大大小一致。ripgrep 在两种溢出存储路径写入前拒绝超过此上限的已捕获搜索输出，并提示缩小搜索范围。Computer Use 图片仍单独受 4 MiB 上限约束，RPC 响应分块也有独立限制。

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

提供方负责凭据、传输和厂商选择。工具不接收密钥，也不选择厂商。设置中的网页搜索可配置 Brave、Tavily、Exa、Perplexity 或自建 SearXNG。端点、结果上限、超时和速率限制保存在配置档数据目录。工具调用和设置页测试共用该目录中的同一速率窗口。API 密钥只写入 `secret://search/<provider>`，位于主目录的 secrets（`<home>/secrets`）。配置档未指定其他路径时，文件适配器也读取该目录。原先落在 `<dataDir>/secrets` 的存储会迁移过去。没有就绪的默认提供方时，工具返回 `WEB_SEARCH_UNAVAILABLE`。部署方传入的 `SearchProvider` 会替换该注册表。规范化摘要包含 Citations 列表。提供方失败返回通用错误，不在日志中泄露凭据。

持久 shell：为 `shell` 设置 `persistent:true`，可选择 `shell:"bash"|"zsh"|"pwsh"`。返回命令的 `jobId` 与解释器的 `sessionId`，后续调用保留 cwd、环境变量和解释器变量。可传 `sessionId` 选择现有解释器；忙碌时拒绝另一条命令，终止命令会关闭解释器。交互式 stdin 请使用 PTY。

PTY 工具：`pty_open/read/send/signal/resize/list/close` 分别负责打开、读取、发送原始文本、发信号、调整尺寸、列出和关闭。所有操作按返回的 `jobId` 定位。统一 `job_list/output/kill` 也支持 PTY、持久解释器和子代理（`child:<id>`），完成通知出现在后续模型上下文及 Web 作业面板。任务跨轮次保留，Host 重启不恢复。

本地 PTY 支持构建原生助手后的 macOS/Linux；Windows 支持管道执行，PTY 需提供方实现。Shell 必须已安装。远端和其他沙箱提供方必须实现公共 process 入口，缺失时明确拒绝，不回退本地执行。捕获上限 4 MiB，每会话/分支最多保留 128 个作业。

## 持久目标工具

goal_get {} 读取会话目标、续轮与额度用量。goal_update 接受 status "complete" 或 "blocked" 和非空 reason。模型不能创建或恢复目标。通过 Web 目标卡片或 [会话指南](../guide/sessions.zh-CN.md#persistent-goals) 中的 /goal 命令控制。
