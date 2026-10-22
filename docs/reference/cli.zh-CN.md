# CLI 命令参考

[English](cli.md) | 简体中文

[文档导航](../README.zh-CN.md) · [使用指南](../guide/cli.zh-CN.md)

按“会话运行 → 管理 → 扩展”查找命令。想看连续操作示例，先读[CLI / TUI 指南](../guide/cli.zh-CN.md)。

下表的 `agh` 是阅读简写；源码分发实际执行为 `node agnes.mjs`。以下均按源码分发方式使用。

## 会话与运行

| 语法 | 用途/注意 |
| --- | --- |
| `agh run --bundle ID_OR_PATH --input FILE_OR_DASH --json [--batch]` | 新会话无界面运行和版本化 JSONL，见[指南](../guide/headless.zh-CN.md) |
| `agh [prompt]` | TTY 为 TUI；非 TTY 为 print |
| `agh -p [prompt]` | 一次性任务，读取管道输入 |
| `agh -p --output-schema FILE` | 要求最终回复是一个符合 `FILE` 里 JSON Schema（2020-12，最大 64 KiB）的 JSON 值并加以校验；不符合时退出码 6，文件不可用时退出码 2 |
| `agh --mode text\|json\|stream-json` | 自动 print（`stream-json`：每个事件一行，最后是结果行）；ACP 为单独模式 |
| `agh --model main=ROUTE/MODEL` | 显式槽位与运行目录中的路由/模型 |
| `agh --profile NAME --preset NAME --permission LEVEL --cwd DIR` | 普通运行选项，不是所有转发子命令均支持。`LEVEL` 为 `read-only`、`workspace-write`、`full-access` 或 `default`（部署默认），只作用于新会话 |
| `agh --continue` / `agh --resume ID` | 互斥；恢复最近/指定会话 |
| `agh --no-alt-screen` | 仅交互模式：保留 shell 屏幕，把已定稿的回合写入终端自己的滚动区；限制见 [CLI 指南](../guide/cli.zh-CN.md) |
| `agh (--ephemeral\|--standalone) --ignore-rules` / `--safe-mode` | 仅私有 host（共享 daemon 或 `--connect` 下以退出码 2 拒绝）：跳过自定义斜杠命令 / 另外关闭非内置插件并在 TUI 状态栏标记。指令文件、hooks 和 MCP server 暂不跳过，见 [CLI 指南](../guide/cli.zh-CN.md) |
| `agh resume ID [-p prompt]` | 恢复入口 |
| `agh sessions [list --cwd DIR] [--archived] [--limit N] [--all] [--last] --json` / `agh sessions show ID` | 列表，每个会话一行、制表符分隔：id、最后序号、preset、`pinned` 或 `-`、最近活动时间（最后一条消息，没有则取创建时间）、cwd、标题（文本列可能调整，脚本请用 `--json`）；默认一页 50 条，`--limit N`（1 到 500）设置页大小，`--all` 翻完所有页（与 `--limit` 同用时 `--limit` 是总条数上限），`--last` 只打印最近活动的一个会话，还有更多时 stderr 给出提示；`--archived` 只看已归档；机器契约用 `--json` / 详情 |
| `agh sessions pin\|unpin\|archive\|unarchive ID` / `rename ID TITLE...` | 会话偏好；`--json` 输出已保存的偏好 |
| `agh sessions deliverables ID [--json]` / `--save N\|ID [--out PATH] [--force]` | 列出会话交付的文件/下载一个：校验 sha256 与大小，只取名称最后一段路径，目标已存在时须加 `--force` |
| `agh sessions undo KEY [--turn N] [--yes] [--json]` | 打印撤销最近一次改过文件的轮次（或第 N 轮）会做什么；加 `--yes` 才执行。有文件在该轮之后被改动、有轮次运行中、非属主或只读会话时整轮拒绝；被拒绝或有文件未能恢复时退出码为 1。 |
| `agh approvals grants SESSION [--json]` / `agh approvals revoke SESSION GRANT [--json]` | 列出会话生效中的审批授权/撤销一条（需管理员连接，拒绝原样输出）|
| `agh approvals suggest [--days N] [--min-count N] [--limit N] [--json]` | 读取过去的会话，提出你常批准的命令前缀（默认 90 天、至少 2 次、显示 20 条）。只读：在审批卡上采用前缀。凭据会被屏蔽；没有管理员连接时会注明未与现有授权比对 |
| `agh schedules [list [--session KEY] [--archived]] / show ID [--json]` | 列出定时任务（默认全部）/查看一个任务及其最近运行 |
| `agh schedules add --prompt TEXT (--every 30m\|--cron EXPR\|--at ISO\|--daily HH:MM\|--weekly mon,wed@HH:MM) [--tz ZONE] [--title T] [--session KEY \| --new-session [--cwd DIR]] [--unattended notify\|refuse]` / `edit ID [同上]` | 新建或修改任务；`--every` 范围为 60 秒到 366 天，未给 `--session` 或 `--new-session` 时在当前目录新开会话运行，`edit` 只改动给出的参数 |
| `agh schedules pause\|resume\|run\|archive ID [--json]` | 暂停、恢复、立即运行或归档任务（需管理员连接；拒绝时打印 code 并以 1 退出）|
| `agh triggers [list] [--json]` / `agh triggers remove RULE` | 列出 webhook 触发规则和监听配置/删除一条规则 |
| `agh triggers add --file RULE.json\|-` / `edit RULE --file RULE.json\|-` / `configure --file CONFIG.json\|-` | 用 JSON 保存规则或配置（`-` 读标准输入）；发送前先按协议 schema 校验 |
| `agh triggers test RULE [--payload FILE\|-]` | 用模拟投递跑一次规则；投递未被接受时打印状态并以 1 退出。`deliver` 仅限 webhook 入站，CLI 不提供 |
| `agh settings [--json]` | 列出全部设置 section 及一行说明 |
| `agh settings SECTION [get] [--json]` | 每个值一行输出一个 section（`model-slots`、`child-engines`、`auto-review`、`system-prompt`、`memory`、`observability`、`search`、`session-defaults`），`--json` 输出 daemon 返回；`memory` 使用 `--cwd` |
| `agh settings SECTION set --file FILE\|-` | 用 JSON 保存 section（`-` 读标准输入）；发送前先按协议 schema 校验。`system-prompt` 还接受 `--text TEXT`（替换整个提示词，需要 `--yes`；为空则移除） |
| `agh settings search test --text QUERY [PROVIDER]` | 用某个提供商（默认用默认提供商）跑一次搜索；测试失败时打印原因并以 1 退出 |
| `agh credentials [list] [--json]` / `agh credentials rename ID NAME...` | 列出通用凭据（id、名称、类型、创建时间、引用；从不含密钥）/改名 |
| `agh credentials delete ID [--yes] [--force]` | 不带 `--yes` 只显示将删除的对象且不发请求；仍被使用的凭据还需要 `--force` |
| `agh agents [--all] [--json]` | 会话及其状态（`paused`、`queued`、`open`、`closed`、`unknown`）、排队条数和最近活动；默认最近 50 个未归档会话，`--all` 不设上限；每个会话一次只读 `session.controls` |
| `agh queue KEY [--steer] [--json] 文本...\|-` | 通过 SDK 命令路径往已有会话注入 follow-up（默认，当前 turn 之后执行）或 `--steer`（引导当前 turn）；`-` 读 stdin；拒绝打印 `refused: CODE: message`（退出码 1）；结果未确认时提示且不重发 |
| `agh api METHOD [--params JSON\|-] [--json]` | 调用一个协议方法，先在本地校验 params schema；`agh api --help` 列出可调用方法和层级；流式、attach 和命令类方法会被拒绝（请用 `agh queue`）；daemon 拒绝输出到 stderr（退出码 1） |
| `agh sessions search QUERY... [--cwd DIR] --json` / `agh sessions groups` | 按会话搜索历史（需管理员连接，拒绝原样输出）/会话分组 |
| `agh sessions verify ID [--json]` | 重新完整校验历史，报告已验证序号/时间或失败序号；失败返回非零退出码。 |
| `agh export ID --format agnes\|sharegpt\|claude-code [-o FILE]` | 导出；另有 `--html`、`--raw` |
| `agh import FILE --from claude-code\|codex\|pi\|auto [--key KEY]` | 转换导入 |
| `agh --connect TARGET` | 只连接目标，失败不回退 |
| `agh --standalone` / `agh --ephemeral` | 嵌入/临时执行 |
| `agh acp` / `agh --mode acp` | ACP 协议入口 |

`--preset` 选择配方（`standard`、`minimal`、`ptc` 或其他允许的预设），`--permission` 选择会话能做什么；任何允许的组合均可，例如 `agh --preset ptc --permission read-only`，或只写 `agh --permission read-only`。旧的权限配方别名（`read-only`、`workspace-write`、`full-access`）已拒绝，请分别指定配方与权限。省略权限或选择 `default` 均跟随部署默认值。见[权限与预设](../guide/security.zh-CN.md#permissions-and-presets)。

Print 输出用 `--mode text|json|stream-json` 选择；等待审批是配置项（`limits."approval.park"`），不是命令行参数。退出码见[CLI 指南](../guide/cli.zh-CN.md)。当前无 `--session` 或命令行明文 API key 开关。

## 控制面

| 语法 | 用途 |
| --- | --- |
| `agh config` | 模型/账号配置交互 |
| `agh daemon start\|status\|stop` | 显式后台生命周期 |
| `agh serve [--home DIR] [--profile NAME] [--cwd DIR] [--port N]` | 本地 Web |
| `agh profile list` / `inspect NAME --resolved` / `trust DEPLOY_DIR` | 配置检查与部署信任 |
| `agh doctor [platform\|network\|provider\|storage\|credentials\|profile\|extensions\|daemon\|binary\|code-runtime] --json` | 诊断 |
| `agh doctor credentials --json` | 只读检查目标、权限模式与安全状态；不读取凭据内容、不修改权限 |
| `agh doctor provider --probe` | 明确发起最小推理，可能计费 |
| `agh doctor subagents [--repair] --json` | 子 agent 检查；repair 会修改状态 |
| `agh consent DISABLED\|LOCAL\|ANON\|FULL` | 保存遥测同意档位；不等于已验证所有外部采集 |
| `agh completion bash\|zsh\|fish` | 把 shell 补全脚本打印到 stdout（见 [CLI 指南](../guide/cli.zh-CN.md#shell-补全)）；隐藏命令 `agh __complete sessions [前缀]` 是它的辅助，从不启动 daemon |
| `agh stats deviation --json` | 偏差统计 |
| `agh conformance gateway --json` | 网关一致性检查入口 |

`daemon/mcp/resources/skills/serve` 将剩余参数交给各自解析器，不可任意混用普通运行参数。`--data-dir` 在普通 parser 中只对 `computer-use rescue` 开放，不作为一般 daemon 选择捷径。

## 包、资源与 Computer Use

包：`package status|list|catalog|inspect|add|trust|enable|disable|rollback|remove|operation|cancel|source-policy`（最后一个显示允许的包来源）；`install SOURCE` 是 add 别名；`packages pins inspect|release` 管理保留引用。更新走 Web、TUI `/package update ID SOURCE INTEGRITY` 或 SDK；TUI update 直接提交所指定摘要，先 inspect，不声称它有额外 preview/confirm 向导。

资源：`resources list|get|operation|cancel|enable|disable`；`skills refresh|trust`；`mcp list|get|add|update|remove|test|trust|enable|disable|status|reconnect|tools`。变更操作通常要求 expected revision 与交互确认，详见[Skills](../guide/skills.zh-CN.md)、[MCP](../guide/mcp.zh-CN.md)。

当前源码包含的 Skills 永久删除/优先级动作使用 Web 或 Node SDK；shell/TUI 的 Skills 语法仍是 refresh/trust 等既有命令，不能执行猜测的 `skills remove` 或 `skills priority`。见[Skills 指南](../guide/skills.zh-CN.md)。

Computer Use：`status`、`install [--upgrade]`、`restart`、`operation [ID]`、`cancel ID`、`permissions status|grant`、`rescue status|install|repair`。诊断用 `doctor computer-use [--include CHECK] [--skip CHECK] --json`。有写入/安装/权限副作用的命令不能当作普通只读 doctor 自动运行。

权威语法：[args/usage](../../packages/cli/src/args.ts)、[package](../../packages/cli/src/commands/package.ts)、[resources](../../packages/resource-control-cli/src/resources.ts)、[TUI package](../../packages/cli-tui/src/package-controller.ts)。

## 诊断

`agh diagnostics export [--session SESSION_ID] --out diagnostics.json` 通过本地 owner 连接写出脱敏支持包。内容与限制见[可观测性](../guide/observability.zh-CN.md)。

## 插件开发与共享 App Server

| 语法 | 用途 |
| --- | --- |
| `agh --new -p PROMPT` | 使用当前插件的新会话；普通打印模式可能复用工作区会话 |
| `agh tools [--session KEY] [--json]` | 查看准入工具及能力来源 |
| `agh plugins add SOURCE [--yes]` / `pack FOLDER [OUTPUT]` | 审阅后获取；不执行代码地打包分发 |
| `agh dev FOLDER` / `plugins reload [ID]` | 授权本地开发 / 向新会话发布修改后的本地代码 |
| `agh plugins candidates list\|show\|approve\|reject` | 读取与审阅 Agent 候选；批准/拒绝绑定候选与审阅摘要 |
| `agh plugins config get ID [--json]` | 显示插件配置行：当前值、schema 摘要和是否有效。secret 与凭据字段显示为 `[redacted]`，`--json` 也一样 |
| `agh plugins config validate ID [ROW] --file VALUE.json\|-` / `set ID [ROW] --file VALUE.json\|-` | 只校验一行的值/校验后保存；校验失败时逐条列出且不保存（退出码 1）。插件只有一行时可省略 ROW |
| `agh plugins tree [list]` / `tree show` / `plugins generations [--json]` | 读取插件树（`show --json` 含 artifact）/运行代（generation） |
| `agh plugins tree apply --file ARTIFACT.json\|- [--yes]` / `tree rollback [--yes]` | 应用一个插件树 artifact/回滚到上一个；不带 `--yes` 只打印将要做什么，不发请求 |
| `agh plugins provenance ID [--json]` | 读取安装来源及信任证据 |
| `agh plugins publication-status [--json]` | 查看每个容器的发布收敛结果 |
| `agh sessions migrate KEY [--json]` | 显式迁移已关闭且兼容的会话，拒绝打开中的会话 |
| `agh app show [--json]` / `app preview 插件#应用` | 显示当前应用与候选/采纳前的同意预览 |
| `agh app adopt 插件#应用 [--yes]` | 采纳应用；不带 `--yes` 只打印预览，不发请求 |
| `agh app clear [--profile NAME] [--json]` | 在插件启动前清除当前应用及全部界面角色选择，复用配置 CAS |
| `agh app-server --stdio` / `schema --out DIR` | 桥接共享 daemon / 不启动服务地导出生成合同 |
| `agh doctor --json` / `doctor --probe --json` | 本地检查 / 显式账号测试，可能产生费用 |

完整参数与权限边界见[候选审阅](../extend/agent-built-plugins.zh-CN.md)、[热重载](../extend/hot-reload.zh-CN.md)、[App Server](app-server.zh-CN.md)和[首次运行](../guide/getting-started.zh-CN.md)。

## 按智能体创建会话

`node agnes.mjs --agent '@acme/kit#review' -p '检查这个工作区'` 通过后端解析该 Bundle 自己声明的 `launch`，选择精确的 Loop、会话 Bundle 和必填 preset。`--agent` 不能与 `--loop`、`--preset`、`--permission` 或恢复选项组合。只有 Loop 的插件仍可使用 `--loop id@version`。

目标必须已信任、已启用且可启动；引用、依赖或严格模型/权限准入失败会拒绝创建，不会退回普通会话。草稿提示词不会自动发送。
