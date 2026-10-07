# 官方默认工具

[English](default-tools.md) | 简体中文

标准预设通过官方 `defineTool` 插件披露以下工具。部署能力和文件系统策略仍然生效。新的 local-dev 和 enterprise 模板允许问答与交付物需要的投影能力；现有托管配置需要显式允许该能力。

| 工具 | 输入与行为 |
| --- | --- |
| `web_search` | `{"queries":["主题"]}`；一至四条非空查询。宿主提供搜索标题、链接和摘要。没有配置搜索提供方或密钥时返回 `WEB_SEARCH_UNAVAILABLE`，可改用已知 URL 调用 `web_fetch`。 |
| `ask_user_question` | `{"questions":[{"id":"route","question":"请选择路线","options":["A","B"]}]}`。省略 options 使用自由文本；`multiple:true` 允许多选，`allowFreeText:true` 允许补充答案。一至四个问题，id 必须唯一。`timeoutMs` 默认为 0（立即继续），1–60000 可选择等待至持久化截止时间。同批其他工具仍可执行；晚答作为新输入送达。 |
| `present` | `{"files":[{"path":"report.pdf","name":"Report.pdf","description":"供审阅"}]}`。注册已存在、可读取的普通文件，将内容复制为会话产物。最多十六个文件，每个文件和总量都不超过 32 MiB。Web 卡片提供打开和下载。 |
| `shell` | `{"command":"npm run build","background":true}` 启动会话任务。`timeoutMs` 设置前台等待时间；超时后同一个进程继续在后台运行。`timeoutToBackground:false` 则终止进程。 |
| `job_list` | `{}` 列出当前会话与分支的运行中和已完成任务。 |
| `job_output` | `{"jobId":"返回的任务ID","waitMs":1000}` 读取输出和状态，可选等待最多 60 秒，并受工具期限限制。长输出存为可读取产物。 |
| `job_kill` | `{"jobId":"返回的任务ID"}` 终止当前会话拥有的任务及进程组。 |
| `grep` / `find` | 使用固定版本的内置 ripgrep，跳过依赖、构建目录、禁止路径和符号链接。超过请求行数的输出存为 `artifact://…?size=…`；将完整定位符交给 `read`，使用 `offset`/`limit` 分页。 |

使用 `write` 或 `edit` 修改已有文本文件之前，必须在同一会话读取该文件。缺少观察记录时返回 `FS_NOT_OBSERVED`；成功修改会记录新版本。新文件可以直接创建。观察记录有数量上限，且仅在当前进程有效：宿主重启或记录被淘汰后需要重新读取。二进制读取、失败读取和产物读取不会解锁工作区修改。已有的过期版本检查和截断防护仍然生效。

Web 问答提供选项控件与自由文本输入。TUI 显示问题提示：单个问题可输入选项标签或编号，多选可输入逗号分隔的标签或编号。多个问题需要输入以问题 id 为键的 JSON 对象，多选答案使用数组。答案经校验后持久化为普通用户消息账本事件；无效答案不会恢复推理。重新加载投影会从账本恢复待回答问题与已接受的答案。

后台任务跨轮次保留，但不跨宿主重启。会话关闭时终止并清理全部所属任务。每个任务最多捕获 4 MiB 输出，达到上限时会提示。每个会话与分支最多保留 128 个任务，优先淘汰已完成项。进程由选定沙箱提供方负责；缺失交互进程入口时明确拒绝，不回退本地执行。前台调用取消会终止任务；成功返回后台任务的工具调用结束不会终止任务。

文件搜索对进程捕获量和累计匹配文本设有上限，累计匹配文本最多 4 MiB。达到捕获上限会明确标记结果不完整；产物包含全部已捕获行，不包含未捕获数据。文件访问仍通过公开上下文与受约束执行器检查。发行包携带固定版本的平台可执行文件及许可声明，无须系统安装 `rg`。

本地 artifact 存储接受零到 32 MiB 的配置读取上限，硬上限为 32 MiB。CLI 和 daemon 使用 32 MiB，与交付物及可读溢出产物的最大大小一致。ripgrep 在两种溢出存储路径写入前拒绝超过此上限的已捕获搜索输出，并提示缩小搜索范围。Computer Use 图片仍单独受 4 MiB 上限约束，RPC 响应分块也有独立限制。

自动问题卡和交付物卡附着在已有的已返回结果的工具节点上。实时更新使用 journal patch；首次打开及历史读取只填充当前有界页，并重新计算卡片字节。显式传入、会生成额外节点的动态投影 fills 仍走完整视图路径。

交付物下载使用已有的会话与分支授权产物 RPC，按有界分块读取。客户端校验大小与 SHA-256 后创建临时 URL。HTML 等主动内容格式按普通字节下载。注册文件不会授予访问任意宿主路径或 URL 的权限。

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

提供方负责凭据、传输和厂商选择。工具不接收密钥，也不选择厂商。设置中的网页搜索可配置 Brave、Tavily、Exa、Perplexity 或自建 SearXNG。端点、结果上限、超时和速率限制保存在配置档数据目录。API 密钥只写入 `secret://search/<provider>`。没有就绪的默认提供方时，工具返回 `WEB_SEARCH_UNAVAILABLE`。部署方传入的 `SearchProvider` 会替换该注册表。规范化摘要包含 Citations 列表。提供方失败返回通用错误，不在日志中泄露凭据。

持久 shell：为 `shell` 设置 `persistent:true`，可选择 `shell:"bash"|"zsh"|"pwsh"`。返回命令的 `jobId` 与解释器的 `sessionId`，后续调用保留 cwd、环境变量和解释器变量。可传 `sessionId` 选择现有解释器；忙碌时拒绝另一条命令，终止命令会关闭解释器。交互式 stdin 请使用 PTY。

PTY 工具：`pty_open/read/send/signal/resize/list/close` 分别负责打开、读取、发送原始文本、发信号、调整尺寸、列出和关闭。所有操作按返回的 `jobId` 定位。统一 `job_list/output/kill` 也支持 PTY、持久解释器和子代理（`child:<id>`），完成通知出现在后续模型上下文及 Web 作业面板。任务跨轮次保留，Host 重启不恢复。

本地 PTY 支持构建原生助手后的 macOS/Linux；Windows 支持管道执行，PTY 需提供方实现。Shell 必须已安装。远端和其他沙箱提供方必须实现公共 process 入口，缺失时明确拒绝，不回退本地执行。捕获上限 4 MiB，每会话/分支最多保留 128 个作业。

## 持久目标工具

goal_get {} 读取会话目标、续轮与额度用量。goal_update 接受 status "complete" 或 "blocked" 和非空 reason。模型不能创建或恢复目标。通过 Web 目标卡片或 [会话指南](../guide/sessions.zh-CN.md#persistent-goals) 中的 /goal 命令控制。
