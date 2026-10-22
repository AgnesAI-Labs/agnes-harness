# CLI 与 TUI

[English](cli.md) | 简体中文

[文档导航](../README.zh-CN.md) · [完整命令参考](../reference/cli.zh-CN.md)

CLI 适合把 AGH 接到日常终端和脚本中；TUI 适合持续对话、检查上下文和处理审批。先用一次性任务获得结果，再按需使用交互式会话。

以下以仓库根为工作目录；从其他目录使用构建入口的绝对路径。命令首个位置应是子命令，之后才是该子命令支持的选项。

## 一次性输出

```sh
node agnes.mjs -p "解释当前项目"
printf '%s\n' '请总结这段文本' | node agnes.mjs -p
node agnes.mjs --mode json "解释当前项目"
node agnes.mjs --mode stream-json "解释当前项目"
```

`--mode json` 和 `--mode stream-json` 自动选择 print 模式。`--mode stream-json` 每收到一个会话事件就输出一行 `{"schema":"agnes-cli-event/v1","event":{…}}`（event 是会话事件信封），最后一行永远是 `--mode json` 同样的 `agnes-cli-result/v1` 结果行；退出码和 stderr 不变。两种格式都是 `v1`：可能新增字段，已有字段的含义不变。JSON 输出适合程序消费，stderr 仍可能含运行时警告。检查进程退出码，不能把收到部分文本当成功。一次性调用只有在配置里设置了 `limits."approval.park"` 时才会为等待审批而挂起；挂起后输出 `parked ticket=… session=…`，退出码为 3。命令行参数 `--park` 会被拒绝。不带可用审批交互的脚本不能自行批准危险操作。

`agh -p --output-schema FILE` 要求最终回复是一个符合 `FILE` 里 JSON Schema（2020-12，最大 64 KiB）的 JSON 值：CLI 在提示词后面追加一段固定说明并附上 schema，回合结束后检查最终助手文本。回复可以被一个 ```json 代码块包住，不做其他解包，也不重试。符合时，text 模式只打印紧凑的一行 JSON，`--mode json` 与 `--mode stream-json` 在结果行里加 `structured` 字段，退出码为 0。不符合（不是 JSON，或违反 schema）时，stdout 照原样保留回复，stderr 给出前五条问题，退出码为 6。回合没有正常完成时保持原有退出码，不做校验。文件不存在、超过大小、不是 JSON，或 schema 无法编译（包括指向其他文档的 `$ref`，它不会被下载）时，在启动会话前以退出码 2 结束。不校验 `format`。该选项只用于 `-p`，TUI 会拒绝它。

默认连接或启动本地共享 daemon。`--connect TARGET` 是显式连接，失败不回退；`--standalone` 为嵌入式，`--ephemeral` 为显式临时执行。ACP 入口为 `acp` 或 `--mode acp`，不能推定其生命周期与普通共享 daemon 模式一致。

`agh --continue` 恢复当前目录下最近一个未归档的会话。终端能标识所在窗格时（`ZELLIJ_PANE_ID`、`TMUX_PANE`、`KITTY_WINDOW_ID`、`WEZTERM_PANE`、`ITERM_SESSION_ID`、`TERM_SESSION_ID`、`WT_SESSION`，取第一个存在的），改为恢复这个窗格上次用过的会话，前提是目录相同、会话仍存在且未归档；否则回到该目录最近的会话。所以同一目录下的两个 tmux 窗格各自接回自己的会话。记录是 `<AGH_HOME>/terminal-sessions/` 下每个窗格一个私有小文件，TUI 打开或切换会话时、`-p` 用到会话时写入，写入失败会被忽略。没有窗格标识、使用 `--connect` 或 `--ephemeral` 时不读不写，行为不变。

`--safe-mode` 和 `--ignore-rules` 用于排障：少加载一些东西来启动会话。它们只在本命令自己启动的私有 host 上生效，所以必须加 `--ephemeral` 或 `--standalone`；连接共享 daemon 时（默认的 attach，或任何 `--connect`，即使同时写了 `--standalone`）一律拒绝，退出码 2，因为那个 daemon 上的其他会话共用同一份配置。`--ignore-rules` 跳过个人和项目的自定义斜杠命令。`--safe-mode` 包含它，并关闭所有非内置插件；内置的 `@agnes/base` 和你的凭据照常可用。TUI 状态栏会一直显示 `安全模式` 标记。暂不支持：跳过指令文件（`AGENTS.md`、`CLAUDE.md`、`<AGH_HOME>/AGENTS.md`）、hooks 和 MCP server。Host 没有对应的启动参数，指令文件现有的唯一开关是安装级的 `context.json`，一次运行不改进程环境变量就无法覆盖它。命令每次都会在 stderr 说明这一点，避免这个开关被当成它并未提供的保证。

普通自动连接会在核对规范化的 home/profile/数据路径、进程身份、私有 socket 权限、协议与 CLI 版本，并完成认证就绪检查后复用现有 daemon；连接前不再准备本地插件快照或重复校验安装包。RPC 授权及执行前的代码校验仍由 daemon 负责。没有就绪 daemon 或其状态异常时，仍执行完整启动准备；版本不一致时需停止 daemon，再用当前 CLI 重启。Doctor、恢复、嵌入式执行与 Web 启动入口保留各自的准备路径。

## 交互式终端

```sh
node agnes.mjs
```

输入框顶边显示模型、所在目录及其 Git worktree 与分支，以及上下文用量；`┊` 标出自动压缩的起点。

输入 `/` 可查看当前菜单。常用操作：

| 操作 | 用法 |
| --- | --- |
| 新任务/选择历史 | `/new [DIR]`、`/sessions`、`/resume [id\|all]`（`all` 列出所有工作区；选择器里 Tab 在本工作区与全部之间切换并保留已输入的过滤词，PgUp/PgDn 翻页，按最近活动的本地时间排序）、`/search QUERY`（需管理员连接）、`/import [文件 [--from claude-code\|codex\|pi\|auto]]` |
| 子智能体 | `/agents` 列出本会话可控的子智能体；`/agents stop N\|ID` 中断一个，`/agents resume N\|ID 消息` 让它继续。能否执行由 daemon 决定，拒绝会原样显示 |
| 后台任务 | `/jobs` 列出本会话的后台任务；`/jobs stop N\|ID` 终止一个（agent 拥有的任务会被 daemon 拒绝） |
| 排队消息 | 回合进行中按 Enter，消息进入 daemon 队列，回合结束后自动发送；按 Alt+Enter 则插入正在运行的回合（该回合不接受插入时改为排队）。TUI 不保存任何队列，退出后队列仍在，会话的所有客户端都看得到。`/queue` 列出排队的消息，并按序号管理：`/queue edit N` 放回输入框修改（附件随下一条消息发送），`/queue drop N` 丢弃，`/queue now N` 停止当前回合并先发送这一条，`/queue steer N` 把它变成对当前回合的插入。输入框为空时按 Alt+↑ 取回最新的一条排队消息。对已发送或已删除的消息操作会提示这一点 |
| 模型/预设 | `/model`、`/model main ROUTE/MODEL`、`/preset NAME` |
| 上下文/用量 | `/context`、`/usage`、`/cost` |
| 状态 | `/status` 一屏显示会话、预设、模型、工作区、`AGH_HOME`、连接方式（本机 daemon 或 `--connect`）、上下文用量、花费、排队输入和 YOLO；读不到的值显示 `-` |
| 复制 | `/copy` 把最近一条回复复制到剪贴板，`/copy N` 复制倒数第 N 条，`/copy code` 复制最近一条回复里的最后一个代码块 |
| 工作区改动 | `/diff` 列出本会话改动的文件（`+新增 -删除 路径`）并显示前三个文件的 diff；`/diff turn` 只看最近一个回合，`/diff [turn] PATH` 完整显示一个文件。列表被截断、文件没有 diff（二进制、过大）、会话记录没有覆盖全部改动时，都会写明 |
| 审查 | `/review [范围]` 让 agent 审查未提交的改动，或只审查你指定的路径、范围。按严重程度列出问题，给出文件和行号，不修改文件 |
| 项目初始化 | `/init` 让 agent 写出 `AGENTS.md`，已有时则检查并补全。它只发送一条消息，自己不写文件；写入照常经过审批 |
| 自定义命令 | 一个 `.md` 文件就是一条斜杠命令，文件名即命令名（`[a-z0-9][a-z0-9-]{0,31}`）：`<工作区>/.agh/commands/NAME.md`（项目级）和 `<AGH_HOME>/commands/NAME.md`（个人级）。可选的 frontmatter 设置 `description` 和 `argument-hint`；正文里 `$1`..`$9` 是参数，`$@` 是全部参数。展开后的正文作为普通用户消息发送。内置命令永远优先，其次项目级，最后个人级；被跳过的文件（重名、命令名不合规、超过 32 KiB、不是普通文件、超出前 200 个）列在 `/help` 底部。项目级命令来自仓库，可能出自他人之手：它们标注路径，每条第一次执行时先显示路径和将发送内容的前 200 个字符，再按一次 Enter 才发送。个人级命令直接执行。`--connect` 时只读个人级。每次打开补全菜单或执行命令时重新读取文件 |
| 会话整理 | `/pin`、`/unpin`、`/rename TITLE`、`/archive` |
| 审批授权 | `/grants` 列出本会话中无需询问即可运行工具的授权（「本会话」与「总是」）；`/grants revoke N\|ID` 撤销一条（需管理员连接） |
| 交付物 | `/deliverables` 列出本会话交付的文件；`/deliverables save N\|ID [PATH]` 校验大小与 sha256 后下载 |
| 压缩 | `/compact [instructions]`，结果可能是执行、跳过或失败，按回执判断 |
| 分叉 | `/rewind` 打开已完成轮次的选择器；`/rewind SEQ` 按序号分叉。都会创建新会话，并把那一轮的提示放回输入框，改完可再发送；不是文件系统回滚 |
| 撤销文件改动 | `/undo` 预览最近一次写过文件的轮次：每个文件会被恢复，本轮新建的文件会被删除，无法撤销的文件连同原因一并列出。`/undo N` 预览第 N 轮，`/undo confirm` 执行预览，`/undo cancel` 放弃。只有会话属主能撤销，轮次运行中和只读会话都不行。只要有文件在该轮之后又被改动，整轮被拒绝且不改动任何文件（没有 force）。要先撤销更晚的轮次，一次只撤一轮。shell 命令造成的改动只做提示，不会恢复。撤销功能出现之前记录的轮次，或快照已被清理的轮次，无法撤销。旧 daemon 会提示「这个 daemon 不支持撤销」 |
| 插件 | `/packages`、`/install SOURCE`、`/package ...` |
| 资源 | `/skills`、`/skill refresh ...`、`/mcp ...` |
| 显示/退出 | `/theme [auto\|light\|dark\|mono]`、`/keys`、`/mouse`、`/thinking`、`/help`、`/quit`。`/keys` 按作用域列出当前生效的键位，改过的会标出来。`/thinking` 仅在本次运行内切换模型思考的显示：默认在回答开始后收起（思考期间回复上方显示最后三行，之后变成一行“已思考（N 字）”），也可以始终展开。`/mouse` 在本次运行内关闭或打开鼠标上报：关闭后由终端自己选择和复制文字，但滚轮会发送方向键来翻看输入历史。复制会提示已复制、已发送到剪贴板（只请求了终端，例如经 SSH）或复制失败 |

启动时选择新会话能做什么，例如 `node agnes.mjs --permission read-only`；`--preset NAME` 独立选择配方（见[权限与预设](security.zh-CN.md#permissions-and-presets)）。`/preset NAME` 切换当前会话的预设并保留其权限；更换权限需新建会话。

发送过的消息（包括斜杠命令）保存在 `<AGH_HOME>/tui-history.jsonl`（仅本人可读，保留最近 500 条，相邻重复不记），重启后按 ↑ 仍能找到。Ctrl-R 进入反向搜索：输入以缩小范围，再按 Ctrl-R 找更早的匹配，Enter 把匹配项放进输入框但不发送，Esc 退出搜索并恢复草稿。文件无法读写时，历史只在本次运行内有效。

编辑键与 readline 一致。Ctrl-A、Ctrl-E 跳到行首、行尾，Ctrl-B、Ctrl-F 左右移一个字符，Alt-B、Alt-F 或 Ctrl-←、Ctrl-→ 按词移动（中文按词切分）。Ctrl-K 删到行尾，Ctrl-U 删到行首，Ctrl-W 或 Alt-Backspace 删光标前一个词，Alt-D 删后一个词；Ctrl-Y 粘回最近一次删掉的文本。运行中的 TUI 保留最近 16 次删除组成的 kill ring：连续的删除合并成一条（向后删的接在前面，向前删的接在后面），按其他键就中断连续；紧接着 Ctrl-Y 或 Alt-Y 再按 Alt-Y，把刚粘贴的内容换成上一条，循环切换。粘贴和每次切换各算一步撤销。kill ring 只存在内存里，不碰系统剪贴板。

Ctrl-Z 撤销输入框里的上一次编辑，Ctrl-Shift-Z 重做（重做要求终端能报告 Shift，例如 kitty）。连续输入算一步，每次删除和每次粘贴各算一步。最多保留最近 100 步，发送消息或切换会话后清空。

草稿有多行时，↑ 和 ↓ 先在行间移动光标并尽量保持原来的列；只有在第一行按 ↑、最后一行按 ↓ 时才翻历史。

Ctrl-G 用你自己的编辑器编辑草稿：优先 `$VISUAL`，否则 `$EDITOR`（命令可以带参数，如 `code -w`；直接启动，不经过 shell）。草稿会写入 `<AGH_HOME>/tmp/` 下仅本人可读的临时文件，TUI 把终端交给编辑器；编辑器以 0 退出时，文件内容替换草稿，非 0 退出则保留原草稿并提示“已取消”。临时文件用完即删。两个变量都没设置时，Ctrl-G 只提示如何设置，不会猜一个编辑器。远程 `--connect` 下同样可用，因为编辑器在本机运行，只改本地草稿。

主题默认是 `auto`，跟随终端背景：CLI 用 OSC 11 向终端询问背景色（最多等 100 毫秒），问不到就看 `COLORFGBG` 的最后一段（7 或 15 表示浅色背景），都没有则用深色。输出不是终端、使用 `-p` 或设置了 `NO_COLOR` 时不会发出查询。`/theme auto` 保存的是 `auto` 而不是识别结果；已保存的 `dark`、`light`、`mono` 保持不变。

键位可以在 `<AGH_HOME>/keybindings.json` 中修改，CLI 启动时读取一次：`{ "cut-to-end": ["ctrl-o"] }` 表示给这个动作换上新的键，旧键作废。动作 id 和所属作用域（全局、输入框、历史搜索）用 `/keys` 查看，那里也列出可以写的键名（`ctrl-k`、`alt-enter`、`pgup`、`f2` 等，不能绑定普通字母）。文件损坏、动作或键名不存在，或者同一作用域里的键已被别的动作占用，对应条目会被跳过，状态栏给出提示，并列在 `/keys` 末尾；文件里其余条目照常生效，启动不会被拦住。Ctrl-C 和 Ctrl-D（中断与退出）、审批弹窗、选择器、报告面板和密钥输入的按键是固定的。屏幕上的提示（比如回到对话底部）仍然写默认键。

会话、模型和主题选择器可以直接输入文字过滤，不区分大小写，匹配每行的标题、id 和时间。顶部显示 `过滤：xx（3/20）`，即匹配数与总数。退格删一个字，Esc 先清空过滤词，过滤词为空时再按 Esc 才关闭选择器；数字键只在过滤词为空时直接选行，否则数字属于过滤词。

用 PageUp 或滚轮往上翻之后，一旦有新内容出现，功能键行上方会显示 `↓ 有新内容 · End 回到底部`。按 End（或 Ctrl-End）回到最新的行并继续跟随新输出。输入框里有草稿时，End 仍是把光标移到行尾，这时只有 Ctrl-End 回到底部，提示行也会写成 Ctrl-End。

TUI `/package` 与 shell `package` 的子命令集合不完全相同，例如更新可以从 TUI/Web 发起，shell `package update` 当前没有实现。以[生命周期指南](packages.zh-CN.md)为准。

退出 TUI 时终端原样恢复到进入前的样子，不会重新打印对话。如果本次运行在当前会话里至少发过一条消息，且输出是终端，会留下一行 `agh --resume ID`，用来回到该会话。

Ctrl-O 展开最近一张工具卡，并向 daemon 读取完整的调用与结果；读取期间或读取失败时，卡片保留预览并说明原因。连续的 `read`、`grep`、`find`、`ls` 调用合并为一张卡，标题如“已读取 4 个文件 · 搜索 2 次”；展开后逐条列出每次调用的标题行，遇到其他调用即断开。鼠标上报开启时，点击卡片标题行可展开或收起那一张；Ctrl-O 仍然切换最新一张。折叠的卡片最多预览结果的三个屏幕行，其余显示为“… 还有 N 行”；`edit` 和 `write` 在名称后显示 `+a -b`，展开后显示这次修改的逐行 diff。计划、子智能体、后台任务和工作流的工具调用有各自的卡片：计划每步一行并标出状态，其余显示名称、状态、时间线里有的耗时和一行摘要。

粘贴与常见终端编辑器一致。TUI 向终端请求括号粘贴，所以一整块粘贴内容会连同换行一起整体到达：`\r` 和 `\r\n` 变成换行，制表符变成两个空格，其余控制字符被丢弃。超过 10 行或 1000 个字符的粘贴在输入框里显示为一个占位块，例如 `[粘贴 #1 · 42 行]`；退格一次删掉整块，Enter 发送完整原文。占位块只存在于正在运行的 TUI 中。

审批卡显示后检查工具、参数和授权范围，再选当前提供的 allow/deny/abort 等选项。弹窗和审批卡显示同一份正文：工具、风险标签，以及 `edit`、`write` 的逐行 diff；弹窗在其下保留原始输入（PgUp/PgDn 翻页）。选项文案写明作用范围，例如“本会话内总是允许”。shell 命令的审批卡还可能多一个“本会话内以 `git push` 开头的命令不再询问”，前缀由 daemon 给出，`/grants` 把该授权显示为 `prefix: git push`（见[安全](security.zh-CN.md#命令前缀审批)）。`agh approvals suggest` 根据过去会话里你反复批准的命令提出前缀建议，只读；采用前缀要在审批卡上选择。可能造成不可恢复损害的命令在请求审批之前就会被拒绝，`/yolo` 下也一样（见[安全](security.zh-CN.md#硬封锁命令)）。回车默认仍落在拒绝上。`/yolo` 为当前会话启用完全权限：跳过工具审批，允许读写工作区内外的文件。策略中的明确禁令、操作系统权限和已配置的命令沙箱限制仍然有效。新会话会沿用已保存的权限选择。`/yolo off` 恢复常规审批询问。

终端上报焦点时，TUI 仅在窗口处于后台的情况下，于回合结束时响一次铃，每有一个审批开始等待也响一次。窗口标题为 `agh · 目录名`，回合进行中前面加 `… `，等待审批时加 `! `，退出时恢复原来的标题。不上报焦点的终端不会收到铃声。

TUI 与 Web 中的 `/plan`、`/plan on`、`/plan off` 和 `/plan <说明>` 都调用所选的后端计划服务。`/plan status` 查看模式，`/plan pending` 查看上次提交的计划。后端被禁用或不可用时，界面显示计划模式关闭。现有 `.agh/plan-mode.json` 文件可直接读取，无需迁移。计划模式即使在完全访问权限下也会阻止写入和执行工具；`exit_plan_mode` 仍须获得绑定当前计划版本的人工批准。用户显式输入 `/plan off` 仍可直接关闭。

回合进行中按 Esc 只中断回合，保留正在写的消息。没有回合运行时 Esc 清空草稿，输入框为空时半秒内连按两次 Esc 打开 `/rewind` 选择器，选中某一轮后把它的提示放回输入框；`@` 文件菜单打开时只关闭菜单。Ctrl-C 仍然中断回合，一秒内连按两次退出。这两个键会中断会话正在运行的任何回合，包括别的客户端发起的：daemon 允许会话属主停止它，拒绝其他人。

`agh --no-alt-screen` 保留终端自己的滚动区。TUI 此时运行在普通屏幕而不是备用屏幕上，只重画底部几行（正在流式输出的回复、输入框和状态行）；每个已定稿的回合只写入终端滚动区一次，所以终端自带的搜索、选择、复制和滚动条（以及 tmux 的 copy 模式）都能用在对话上，退出后对话也留在屏幕上。鼠标交还给终端：滚轮和文字选择由终端处理，`/mouse` 没有可切换的内容，全屏视图里的 PgUp/PgDn、End 和“下方有新内容”提示在此模式下不存在。长回复按块写入（一个段落、列表或代码块在下一个块出现后写入），最后一块仍在底部流式显示。写进去的内容不会被改写，滚动区也不会被清空：Ctrl-O 只影响仍在底部的卡片，已写入条目之后的变化（比如事后附上的审查结果）不会显示，窗口大小变化只重画底部，所以旧文字保持写入时的宽度，由终端像处理其他输出一样重新折行。`/new` 和 `/resume` 会写入一条带新会话 id 的分隔线；重连后只补写尚未写入的条目，若更早的输出无法重放，会写一行提示。默认仍是全屏视图。请在底部区域出现后再输入：全屏模式在连接 daemon 期间先画出的输入框，此模式下没有。

`--no-alt-screen` 已知的终端限制：

- 底部区域通过向终端询问光标位置（`ESC [ 6 n`，等待四分之一秒）来确定在 shell 提示符下方起步；没有回应时从屏幕底部起步，窗口大小变化后则假定底部区域仍在最后几行。
- 已定稿文字通过滚动边距（DECSTBM）滚入，每一帧用同步输出（模式 2026）包起来；不支持 2026 的终端可能闪烁。在 Zellij 下（设置了 `ZELLIJ`）不用边距，而是滚动整个屏幕；也可以用 `AGH_SPLIT_FOOTER_SCROLL=region` 或 `=full` 自行选择。
- 窗口变窄后，tmux 和 xterm.js 会把旧的底部行重新折行，Zellij 则直接截断，清除范围按此计算；尚未验证的终端按 tmux 处理。行为不同的终端可能在重画的底部区域上方留下几行旧的底部残影，只是外观问题，会随滚动消失，对话不会被清除。
- 底部区域固定在最后几行。它变矮时（回复结束、菜单关闭），空出的行会在对话与底部区域之间保持空白，直到新输出填满。
- 已用无头 xterm.js、tmux 3.8 和 Zellij 0.45.1 验证。macOS Terminal、iTerm2、Windows Terminal 和 IDE 终端使用同样的转义序列，但尚未验证。

## 定时任务与触发器

`agh schedules` 和 `agh triggers` 管理与 Web 自动化页相同的定时任务和 webhook 规则，需要管理员连接。每分钟运行一次的任务：`agh schedules add --prompt "汇总新增问题" --every 1m --cwd .`；`agh schedules run ID` 立即运行一次，`pause`、`resume` 暂停和恢复，`archive` 归档，`show ID` 列出最近的运行记录。Webhook 规则以 JSON 编写（`agh triggers add --file rule.json`），发送前先按协议 schema 校验；`agh triggers test RULE` 用模拟投递试跑。拒绝时打印 code 并以 1 退出；`--json` 原样输出 daemon 的返回。

## 插件配置、插件树与应用

这些命令对应 Web 管理页，需要管理员连接。`agh plugins config get ID` 列出插件的配置行及当前值、schema 摘要和是否有效；schema 标为 `x-secret`、`writeOnly` 或 `credential-reference` 的字段，以及名字像凭据的键，文本和 `--json` 都显示为 `[redacted]`。配置值只从 JSON 文件读取，不走命令行：`agh plugins config validate ID [ROW] --file value.json` 只校验，`set` 先校验，值无效时不保存并以 1 退出。`agh plugins tree` 和 `generations` 显示插件树与运行代（generation）；`tree apply --file artifact.json` 与 `tree rollback` 会改变运行态，不带 `--yes` 只打印将要做什么。`agh app show` 和 `preview 插件#应用` 读取应用状态与同意预览，`app adopt` 同样需要 `--yes`。`agh package source-policy` 显示允许的包来源。后台的拒绝原样显示并以 1 退出。

## 设置与凭据

`agh settings` 修改与 Web 设置页相同的设置，需要管理员连接。不带 section 时列出全部：`model-slots`、`child-engines`、`auto-review`、`system-prompt`、`memory`、`observability`、`search`、`session-defaults`。`agh settings SECTION`（或 `get`）每个值输出一行，`--json` 输出 daemon 的原始返回。`agh settings SECTION set --file settings.json` 保存 JSON（`-` 读标准输入），保存前先按协议 schema 校验；多数 section 可以把 `get --json` 的结果改一改直接作为输入。`agh settings system-prompt set --text "..."` 替换整个系统提示词（需要 `--yes`；文本为空则移除替换）。`memory` 作用于 `--cwd` 指定的目录。`agh settings search test --text "查询" [PROVIDER]` 跑一次搜索。它与 `agh config` 不同：后者用于登录账号和输出生效的运行配置。

`agh credentials` 列出通用 API 密钥凭据（id、名称、创建时间、被谁使用），`rename ID 名称...` 改名，`delete ID --yes` 删除；不带 `--yes` 只显示将删除的对象，仍被使用的凭据还需要 `--force`。密钥值从不显示。新增或替换密钥请用 `agh config`，命令行不接收密钥。

## 会话总览

`agh agents` 列出 daemon 里的会话及其状态和队列：key、标题、loop（或 preset）、状态、排队条数和最近活动。默认显示最近活动的 50 个未归档会话，`--all` 不设上限，`--json` 输出供脚本使用的稳定字段。状态来自逐个会话的只读 `session.controls` 调用（并发上限 8）：`paused`（暂停）、`queued`（输入排在当前 turn 之后）、`open`（daemon 中在线、没有排队；daemon 不向客户端提供忙碌标志，所以 turn 仍可能在运行）、`closed`（daemon 中未在线）、`unknown`（该会话读取失败，不影响其他行）。`agh sessions list` 是归档和分组视图，`agh agents` 是运行和队列视图。

`agh sessions list` 默认只打印一页 50 个会话，还有更多时在 stderr 提示。`--limit N`（1 到 500）设置页大小；`--all` 翻完所有页，与 `--limit` 同用时 `--limit` 是总条数上限；`--last` 只打印最近活动（最后一条消息，没有则取创建时间）的一个会话，例如 `agh --resume "$(agh sessions list --last --json | jq -r '.items[0].sessionId')"`。文本行依次是 id、最后序号、preset、`pinned` 或 `-`、最近活动、cwd、标题；cwd 列插在标题前面，脚本请读 `--json`，其结构不变（`--all` 或 `--last` 时 `items` 是合并结果，省略 `next`）。

`agh queue KEY [--steer] [--json] 文本...|-` 从另一个 shell 往已有会话注入一条消息。默认是 follow-up：等当前 turn 结束后再执行；`--steer` 则在当前 turn 中引导。`-` 从 stdin 读取消息，消息以连字符开头时在前面加 `--`。它和 TUI、Web 走同一条命令路径（commandId 和 pending journal），成功时打印 `queued followUp (seq N)`。daemon 拒绝（不是你的会话、会话已关闭、不支持）时打印 `refused: CODE: message` 并以 1 退出。如果 daemon 无法确认结果，命令会提示 `unconfirmed`、以 1 退出，并且不会重发；重试前先用 `agh sessions show KEY` 核对。

`agh api METHOD [--params JSON|-] [--json]` 用 CLI 已有的连接调用一个协议方法，不新增任何权限。`METHOD` 是协议方法表里的名字，可带或不带 `_agnes/v1/` 前缀；`agh api --help` 列出所有可调用方法及其层级（`client` 或 `admin`），由协议方法表生成。`--params` 是 JSON 参数对象（`-` 从 stdin 读，默认 `{}`），发送前先在本地按协议 schema 校验：有问题的字段会被指出，并且不会发送。方法名不存在时拒绝并给出最接近的名字。结果以 JSON 打印到 stdout（`--json` 为单行）；daemon 的拒绝（包括没有 admin 连接时调用 admin 方法）以 `error: CODE: message` 打印到 stderr 并以 1 退出。流式和 attach 方法（`session.attach`、`participant.join` 等）以及命令类方法（`submit`、`session.control`、`session.fork` 等）会被拒绝，因为它们需要 commandId 和 pending journal：请用 `agh queue` 或对应子命令。ACP 会话调用（`session/prompt` 等）同样不提供。

`/import 文件 [--from claude-code|codex|pi|auto]` 把一个 Claude Code、codex 或 pi 的会话文件导入 agh，转换和写入与 `agh import 文件` 完全相同，并打印新会话的 key，用 `/resume KEY` 继续。不带文件时，`/import` 打开选择器，按修改时间倒序列出当前工作区最近的 50 个外部会话：`~/.claude/projects/<编码后的 cwd>/*.jsonl` 里的 Claude Code 文件，以及 `~/.codex/sessions/**/rollout-*.jsonl` 里文件头指向当前目录的 codex 文件。只读文件元数据和前几行，不上传、不缓存内容；读不了的文件会被跳过并计数。它需要共享的本机 daemon 连接：使用 `--connect`、`--standalone` 或 `--ephemeral` 时只提示不可用，不做任何事，也不会把文件上传到远端 daemon。

## Shell 补全

`agh completion bash|zsh|fish` 把补全脚本打印到 stdout，不做其他任何事，由你自己加载。命令、子命令词、全局 flag 和枚举型 flag 的取值（`--mode`、`--permission` 等）来自固定的表。会话 key（`--resume`、`agh resume`、`agh sessions show|pin|archive|...` 之后）通过隐藏命令 `agh __complete sessions [前缀]` 向正在运行的本机 daemon 查询，输出 `KEY<TAB>标题` 行。这个命令从不启动 daemon，300 毫秒内没结果就放弃，没有 daemon 或出错时什么都不输出，标题里的控制字符会被过滤。暂不支持 PowerShell。

```sh
# bash（写进 ~/.bashrc）；用 eval，因为 macOS 自带的 bash 3.2 不支持 source <(...)
eval "$(agh completion bash)"
# zsh（写进 ~/.zshrc，放在 compinit 之后）
eval "$(agh completion zsh)"
# fish（保存一次）
agh completion fish > ~/.config/fish/completions/agh.fish
```

## 退出码

| 码 | 意义 |
| --- | --- |
| 0 | 完成 |
| 1 | 执行失败或未知错误 |
| 2 | 参数或启动错误 |
| 3 | 已停驻等待 |
| 4 | 预算/阻断 |
| 5 | 到达最大步数 |
| 6 | `--output-schema`：回合已完成，但最终回复不符合 schema |
| 130 / 143 / 129 | SIGINT / SIGTERM / SIGHUP |

`agh -p` 暂不支持按单次运行限制步数。它需要在协议里新增 session 或 submit 字段，或修改共享 daemon 的配置，而一次性运行两者都不应做。要限制步数，请选用或导出在定义里把 `budget.max_steps` 设为正整数的 preset，并用 `--preset` 指定；达到上限后该回合以 `max_steps` 结束，退出码为 5（见[配置参考](../reference/configuration.zh-CN.md)）。

实现依据：[参数与 usage](../../packages/cli/src/args.ts)、[退出码](../../packages/cli/src/errors.ts)、[TUI 命令](../../packages/cli-tui/src/commands.ts)。

在 TUI 中使用 `/attach <path>` 分块上传原件，并将回执作为 prompt 提交。路径可含空格。常见的图片、文档、压缩包和音视频扩展名按各自的 MIME 类型上传，其余扩展名按 `application/octet-stream` 上传；daemon 的白名单拒绝原样显示。失败保留后端附件原因；回执属于当前会话，上传完成前切换会话会拒绝提交。
