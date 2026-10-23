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

名字打错时，会提示最接近的已知名字，不会替你执行。未知的 flag 退出码为 2，长 flag 有接近的候选时追加 `did you mean --json?`。TUI 里不存在的斜杠命令会提示 `unknown command /modl; did you mean /model?`（内置命令和自定义命令都是候选）。第一个词单独出现、且与某个子命令只差一个笔误（比如 `agh sesions`）时，仍按提示词发给模型，因为单个词的提示词是允许的，但 stderr 会先写一行 `note: sesions is sent as a prompt; did you mean the command sessions?`；加 `-p` 则不再提示。

普通自动连接会在核对规范化的 home/profile/数据路径、进程身份、私有 socket 权限、协议与 CLI 版本，并完成认证就绪检查后复用现有 daemon；连接前不再准备本地插件快照或重复校验安装包。RPC 授权及执行前的代码校验仍由 daemon 负责。没有就绪 daemon 或其状态异常时，仍执行完整启动准备；版本不一致时需停止 daemon，再用当前 CLI 重启。Doctor、恢复、嵌入式执行与 Web 启动入口保留各自的准备路径。

`AGH_TIMING=1 node agnes.mjs -p "hello"` 会向 stderr 写入 `agh-timing PHASE MILLISECONDS` 启动阶段标记。数值从启动器／进程的时间原点累计，不是各阶段耗时。stdout 保持选定的文本／JSON 格式；未设置 `AGH_TIMING=1` 时不输出标记。

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
| 剪贴板图片 | Ctrl-V 或 `/paste` 把系统剪贴板里的图片作为附件（终端只会转发粘贴的文字，不会转发图片）。macOS 用 `osascript`，Linux 用 `wl-paste` 或 `xclip`，Windows 用 PowerShell；超时 5 秒、上限 20 MB；图片先写入 `<AGH_HOME>/tmp/` 下仅本人可读的文件，按 `/attach` 的方式上传（`--connect` 下同样如此），随后删除。草稿里出现 `[图片 #N]` 标记，只有发送时标记还在文字里，图片才随下一条消息发出；Backspace 整体删除标记。没有图片、缺少工具或超时时，状态栏说明原因，不附加任何东西。目前只读取 PNG 格式的剪贴板图片；macOS 上在 Finder 里复制的图片文件则直接附加该文件（png、jpeg、gif 或 webp） |
| 拖入图片文件 | 把图片文件拖进终端（或粘贴其路径）即可附加。当一次粘贴只含已存在的 png、jpeg、gif 或 webp 文件的路径（绝对路径、`~/` 路径或 `file://` URL，可带引号或用反斜杠转义空格，以空格或换行分隔）时，每个文件都按 `/attach` 的方式上传并显示 `[图片 #N]` 标记。其他粘贴（文字夹着路径、文件不存在、不是图片）按文字插入，`--connect` 下的所有粘贴也一样。上传失败时状态栏说明原因，路径留在草稿里。以路径开头的消息，如 `/srv/pics/a.png 描述一下`，是普通消息；只有 `/` 加命令名才是命令 |
| 定时提示 | `/loop 30m 检查构建` 每 30 分钟向当前会话发一次这条提示（间隔写作 `90s`、`30m`、`2h`、`1d`，范围 60 秒到 366 天，与 `agh schedules add --every` 一致）。`/schedule every 间隔 提示` 等价，`/schedule daily HH:MM 提示` 按本机时区每天一次，`/schedule` 列出本会话的定时任务，`/schedule delete 序号|ID` 归档一条。创建前先显示一张卡片，写明间隔、提示和目标会话，用 `/schedule confirm`（或 `/loop confirm`）确认后才创建；`/schedule cancel` 放弃。这些任务与 `agh schedules` 和 Web 自动化页看到的是同一批，经同一个 `schedules.upsert` 调用创建，目标是当前会话。daemon 的拒绝连同代码一起显示 |
| 导出 | `/export [agnes\|html\|sharegpt\|claude-code] [路径]` 用 `agh export` 背后的同一套代码把本会话写成文件（始终脱敏；`--raw` 只存在于 shell 命令），完成后显示路径。不给路径时文件写在当前目录，名为 `agh-会话-时间戳.扩展名`（`agnes` 和 `claude-code` 为 `.jsonl`，`sharegpt` 为 `.json`，`html` 为 `.html`）；相对路径从当前目录算起，给目录则在其中使用这个默认名。文件仅本人可读（0600）。与 shell 命令一样，它在到 daemon 的第二条连接上读取账本，因此只在共享的本机 daemon 连接下可用：`--connect`、`--standalone`、`--ephemeral` 下命令会直接说明（`agh export` 本身也拒绝 `--connect`） |
| 给回复打分 | `/rate up\|down [理由]` 给本会话最近一条已完成的回复打分，也就是 Web 上显示拇指的那一条（最后一个未在运行、不是从 fork 父会话继承、且有最终回答的回合）。它调用与 Web 拇指相同的 `admin.feedback` 方法，所以打分和理由会出现在 Web 里；再次给同一条回复打分会替换之前的评价。理由可选，最长 4000 个字符。没有已完成的回复时会直接说明，不支持打分的旧 daemon 会提示不支持 |
| 记忆 | `/memory` 列出此工作区的记忆文件、模式和已用空间；`/memory show 文件名` 显示一个文件；`/memory add 文字` 先显示一张写明这条单行笔记的卡片，运行 `/memory confirm` 后才追加到 `MEMORY.md`（`/memory cancel` 放弃）；`/memory edit 文件名` 像 Ctrl-G 一样用 `$VISUAL` 或 `$EDITOR` 编辑已有文件，保存时带上读取时的版本号，所以输给更新保存的编辑会被拒绝，不会覆盖。这一切都经 Web 记忆设置用的 `admin.memory` 方法完成，TUI 自己不碰记忆目录。该方法没有删除操作，所以这里不提供（要清空文件请用 `edit`）；`edit` 只改已有文件，记忆模式（`off`、`ask`、`auto`）仍在 Web 设置或 `agh settings` 里修改。不提供该方法的 daemon 会直接说明 |
| 后台会话 | `/bg 提示` 在此工作区新开一个会话并发出这条提示，当前会话保持打开、不切换。它的创建方式与 `/new` 相同（同一个 `session.new` 调用，沿用同样记住的模型和权限选择），并且权限绝不超过当前会话：记住的选择是完全访问、而当前会话不是时，后台会话也不是。它没有自己的审批对话框，所以需要审批的工具会让回合停下等待，直到你打开该会话回答；不会替你批准任何东西。结束时（完成、出错、停止或等待审批）状态栏会提示，窗口在后台时同一事件也会按 `/notify` 的设置响铃或发系统通知。单独运行 `/bg` 列出本次运行开启的后台会话和状态，并打开会话选择器；同时最多运行五个，列表不会跨运行保存。退出不会停止它们：退出摘要会列出仍在运行或在等待的，`agh --resume ID` 可以打开其中一个 |
| Shift+Enter 设置 | `/terminal-setup` 说明如何让 Shift+Enter 在 TUI 所在的终端里插入换行，终端由 `TERM_PROGRAM`、`TERM` 和各终端导出的变量识别（与提醒用的方式相同）。终端通过 kitty 键盘协议上报该键时（TUI 在 tmux 和 screen 之外会为 kitty 和 Ghostty 开启该协议）会说明无需设置。否则显示确切的配置和它所在的文件：VS Code 和 Cursor 的 `keybindings.json` 条目，WezTerm（只有 `enable_kitty_keyboard = true` 时才用该协议）、Ghostty、kitty 和 Alacritty 的按键绑定，iTerm2 和 Terminal.app 的按键映射步骤，以及 Windows Terminal 的 `actions` 条目。它们都让这个键发送 ESC 加回车，TUI 把它当作 Alt+Enter；Alt+Enter 和行尾 `\` 加回车在任何地方都无需设置。它不写任何文件，只有 VS Code 和 Cursor 例外：`/terminal-setup apply` 先显示一张写明文件和备份名的卡片，运行 `/terminal-setup confirm` 才会写入：先把当前的 `keybindings.json` 复制为 `keybindings.json.agh-backup-时间戳`（绝不覆盖已有文件），再在最后一项之后追加一条，文件其余内容（包括注释）逐字节保持原样，通过临时文件改名落盘（符号链接的文件仍是链接）。文件不是它能读懂的数组、已经把 shift+enter 绑定到别的终端序列、或自卡片显示后已被改动时，它会拒绝并让你手动修改；`/terminal-setup cancel` 放弃这张卡片 |
| 旁路提醒 | `/heads-up on` 让旁路模型盯着 agent 的工作，并递给它一条仅供参考的提醒（默认关闭；`/heads-up off` 立即停止并丢弃尚未送出的提醒，单独的 `/heads-up` 显示当前状态）。开启后，在有副作用的工具结果（执行命令、写文件、编辑、删除）之后和每轮结束时，审查模型会收到到目前为止的对话、最近一条用户请求和本轮工具调用的截断摘要（工具名、参数的前 200 个字符、成功或失败）：与 `/btw` 发送的对话视图相同，发给验证模型，没有验证模型时发给快速模型；两者都没配置时不发送任何内容。每次审查按 `side-call` 费用行计费，受单次请求预算和本轮预算覆盖约束。同一时间最多运行一个审查，回合中的审查至少间隔 20 秒，期间到来的触发合并为一次，已给过的提醒不会重复，每个会话每小时最多产生 6 条。提醒（最多 300 个字符，已去除控制字符）随主 agent 的下一次模型请求送出一次，并标明仅供参考、不是用户指令；它不会拦截工具、不会改变权限，也不会替用户审批。回合结束后提醒还会显示在状态栏，形如 `⚑ 旁路提醒: ...`。该设置属于正在运行的会话，会话重新打开后恢复为关闭 |
| 工作区改动 | `/diff` 列出本会话改动的文件（`+新增 -删除 路径`）并显示前三个文件的 diff；`/diff turn` 只看最近一个回合，`/diff [turn] PATH` 完整显示一个文件。列表被截断、文件没有 diff（二进制、过大）、会话记录没有覆盖全部改动时，都会写明 |
| 内联图片 | 在 kitty、Ghostty、iTerm2 和 WezTerm 里，你消息里的图片附件和 agent 产出的图片文件会画在消息下面：最高 12 行、不超过时间线宽度、单张不超过 5 MB。kitty 和 Ghostty 支持 PNG；iTerm2 和 WezTerm 还支持 JPEG 和 GIF（iTerm2 可能让 GIF 动起来）。图片字节走 daemon 按会话授权的 artifact 读取，读不到时仍显示 `[image: ...]` 文本。tmux、screen、未识别的终端和 `/raw` 一律显示文本。图片滚出视口就会被清除。`/images on\|off` 开关，并记住选择；默认开 |
| 会话回顾 | `/recap` 用本地已有的数据拼一张会话进展卡片，不调用模型：会话名、回合数、你最后一条请求的前 200 字、计划进度和正在做的那一步、本会话改过的文件数、运行中的后台会话、定时任务和上下文占用。读不到或为零的项直接省略 |
| 审查 | `/review [范围]` 让 agent 审查未提交的改动，或只审查你指定的路径、范围。按严重程度列出问题，给出文件和行号，不修改文件 |
| 旁问 | `/btw <问题>` 基于当前对话回答一个问题，答案显示在输入框上方的面板里，当前回合照常运行。它只读：问题和答案不进对话、transcript 或 `/copy`，模型不能调用工具。按旁路调用计费（一条 `side-call` 费用行），受单次请求和树预算约束。回合进行中只看到该回合之前已完成的部分；同一会话同时只能有一个旁问，60 秒超时。Esc 或 Enter 关闭面板并丢弃未返回的答案，但费用照计。旧 daemon 会提示不支持 `/btw` |
| 项目初始化 | `/init` 让 agent 写出 `AGENTS.md`，已有时则检查并补全。它只发送一条消息，自己不写文件；写入照常经过审批 |
| 自定义命令 | 一个 `.md` 文件就是一条斜杠命令，文件名即命令名（`[a-z0-9][a-z0-9-]{0,31}`）：`<工作区>/.agh/commands/NAME.md`（项目级）和 `<AGH_HOME>/commands/NAME.md`（个人级）。可选的 frontmatter 设置 `description` 和 `argument-hint`；正文里 `$1`..`$9` 是参数，`$@` 是全部参数。展开后的正文作为普通用户消息发送。内置命令永远优先，其次项目级，最后个人级；每个目录按文件名排序扫描前 200 个 `.md`；扫描范围内被跳过的文件（重名、命令名不合规、超过 32 KiB、不是普通文件）列在 `/help` 底部。项目级命令来自仓库，可能出自他人之手：它们标注路径，每条第一次执行时先显示路径和将发送内容的前 200 个字符，再按一次 Enter 才发送。项目命令正文含隐藏字符（包括零宽、双向控制、私用或未分配字符、盲文空白、连续四个组合标记）时，即使确认也拒绝执行；普通 emoji 显示选择符允许。200 字预览被截断时，应先查看完整文件再确认，因为会发送全部展开内容。个人命令直接运行。`--connect` 时只读个人级。每次打开补全菜单或执行命令时重新读取文件 |
| 会话整理 | `/pin`、`/unpin`、`/rename TITLE`、`/archive` |
| 审批授权 | `/grants` 列出本会话中无需询问即可运行工具的授权（「本会话」与「总是」）；`/grants revoke N\|ID` 撤销一条（需管理员连接） |
| 交付物 | `/deliverables` 列出本会话交付的文件；`/deliverables save N\|ID [PATH]` 校验大小与 sha256 后下载 |
| 压缩 | `/compact [instructions]`，结果可能是执行、跳过或失败，按回执判断 |
| 分叉 | `/rewind` 打开已完成轮次的选择器；`/rewind SEQ` 按序号分叉。都会创建新会话，并把那一轮的提示放回输入框，改完可再发送；不是文件系统回滚 |
| 就地分叉 | `/fork` 从最近一个已完成回合的末尾分叉并切换到新会话；`/fork N` 从第 N 回合分叉。回合进行中，或第 N 回合不是已完成回合时拒绝。提示里会给出原会话 id，用 `/resume ID` 可回去。走的是和 `/rewind` 相同的 daemon 分叉，不改动输入框 |
| 分叉树 | `/tree` 把当前工作区的会话（最多 2000 个，每页 500）按分叉关系显示成树：分叉放在父会话下面并标出分叉点，父会话是当前打开的会话时显示“分叉自第 N 回合”，否则显示 `分叉 @SEQ`（账本序号）；父会话已归档或不在本工作区时当作根。选中一行后像 `/resume` 一样恢复它。daemon 不报告分叉关系时退化为平铺列表 |
| 撤销文件改动 | `/undo` 预览最近一次写过文件的轮次：每个文件会被恢复，本轮新建的文件会被删除，无法撤销的文件连同原因一并列出。`/undo N` 预览第 N 轮，`/undo confirm` 执行预览，`/undo cancel` 放弃。只有会话属主能撤销，轮次运行中和只读会话都不行。只要有文件在该轮之后又被改动，整轮被拒绝且不改动任何文件（没有 force）。要先撤销更晚的轮次，一次只撤一轮。shell 命令造成的改动只做提示，不会恢复。撤销功能出现之前记录的轮次，或快照已被清理的轮次，无法撤销。快照按工作区保留：每个会话最近 20 个改过文件的轮次一定保留；每个工作区最多保留 500 MB 的快照，超出时先清理不受保护的旧快照，再清理最久没活动的会话的快照（从旧的轮次删起）。已知限制：清理只删除快照引用，不删除底层 git 对象，磁盘占用不会因此缩小。旧 daemon 会提示「这个 daemon 不支持撤销」 |
| 插件 | `/packages`、`/install SOURCE`、`/package ...` |
| 资源 | `/skills`、`/skill refresh ...`、`/mcp ...` |
| 显示/退出 | `/theme [auto\|light\|dark\|mono\|custom:<name>]`、`/notify [on\|bell\|off]`（见下文关于提醒的一段）、`/keys`、`/mouse`、`/thinking`、`/help`、`/quit`（或 `/exit`）。`/keys` 按作用域列出当前生效的键位，改过的会标出来。`/thinking` 仅在本次运行内切换模型思考的显示：默认在回答开始后收起（思考期间回复上方显示最后三行，之后变成一行“已思考（N 字）”），也可以始终展开。`/mouse` 在本次运行内关闭或打开鼠标上报（默认开启；环境变量 `AGH_MOUSE=0`、`off`、`false` 或 `no` 会让它一开始就是关闭的，之后可用 `/mouse` 打开）：关闭后由终端自己选择和复制文字，但滚轮会发送方向键来翻看输入历史。复制会提示已复制、已发送到剪贴板（只请求了终端，例如经 SSH）或复制失败。状态栏在知道 preset 后一直显示它（命令行指定或用 `/preset` 设置的），`/yolo` 打开期间改为醒目的粗体 `⚠ 完全访问`。状态栏不显示后台任务或子 agent 的数量：TUI 没有拿到这个数据，查看请用 `/jobs`。Shift+Tab 把模型切到下一个思考档位（`off`、`low`、`medium`、`high`，或模型自己列出的档位），到头回到第一档，走的是和 `/model` 相同的调用；底部显示新档位，提示里写明从哪个 seq 起生效。模型没有思考档位时会提示，不做任何改动。这个键位是 `/keys` 全局作用域里的 `thinking-cycle`，可以在 `keybindings.json` 中改键 |

启动时选择新会话能做什么，例如 `node agnes.mjs --permission read-only`；`--preset NAME` 独立选择配方（见[权限与预设](security.zh-CN.md#permissions-and-presets)）。`/preset NAME` 切换当前会话的预设并保留其权限；更换权限需新建会话。

发送过的消息（包括斜杠命令）保存在 `<AGH_HOME>/tui-history.jsonl`（仅本人可读，保留最近 500 条，相邻重复不记），重启后按 ↑ 仍能找到。Ctrl-R 进入反向搜索：输入以缩小范围，再按 Ctrl-R 找更早的匹配，Enter 把匹配项放进输入框但不发送，Esc 退出搜索并恢复草稿。文件无法读写时，历史只在本次运行内有效。

编辑键与 readline 一致。Ctrl-A、Ctrl-E 跳到行首、行尾，Ctrl-B、Ctrl-F 左右移一个字符，Alt-B、Alt-F 或 Ctrl-←、Ctrl-→ 按词移动（中文按词切分）。Ctrl-K 删到行尾，Ctrl-U 删到行首，Ctrl-W 或 Alt-Backspace 删光标前一个词，Alt-D 删后一个词；Ctrl-Y 粘回最近一次删掉的文本。运行中的 TUI 保留最近 16 次删除组成的 kill ring：连续的删除合并成一条（向后删的接在前面，向前删的接在后面），按其他键就中断连续；紧接着 Ctrl-Y 或 Alt-Y 再按 Alt-Y，把刚粘贴的内容换成上一条，循环切换。粘贴和每次切换各算一步撤销。kill ring 只存在内存里，不碰系统剪贴板。

Ctrl-Z 撤销输入框里的上一次编辑，Ctrl-Shift-Z 重做（重做要求终端能报告 Shift，例如 kitty）。连续输入算一步，每次删除和每次粘贴各算一步。最多保留最近 100 步，发送消息或切换会话后清空。

草稿有多行时，↑ 和 ↓ 先在行间移动光标并尽量保持原来的列；只有在第一行按 ↑、最后一行按 ↓ 时才翻历史。

Ctrl-G 用你自己的编辑器编辑草稿：优先 `$VISUAL`，否则 `$EDITOR`（命令可以带参数，如 `code -w`；直接启动，不经过 shell）。Windows 请指定原生 `.exe`，例如 `"C:\Program Files\Microsoft VS Code\Code.exe" -w`，含空格的路径用双引号包住；反斜杠按原样保留，不支持把 `.cmd`/`.bat` 包装脚本作为编辑器。macOS/Linux 保留 POSIX 引号规则。草稿会写入 `<AGH_HOME>/tmp/` 下仅本人可读的临时文件，TUI 把终端交给编辑器；编辑器以 0 退出时，文件内容替换草稿，非 0 退出则保留原草稿并提示“已取消”。临时文件用完即删。两个变量都没设置时，Ctrl-G 只提示如何设置，不会猜一个编辑器。远程 `--connect` 下同样可用，因为编辑器在本机运行，只改本地草稿。

主题默认是 `auto`，跟随终端背景：CLI 用 OSC 11 向终端询问背景色（最多等 100 毫秒），问不到就看 `COLORFGBG` 的最后一段（7 或 15 表示浅色背景），都没有则用深色。输出不是终端、使用 `-p` 或设置了 `NO_COLOR` 时不会发出查询。`/theme auto` 保存的是 `auto` 而不是识别结果；已保存的 `dark`、`light`、`mono` 保持不变。

自定义主题：在偏好文件所在目录的 `tui-themes/` 下，每个主题放一个 JSON 文件（`<AGH_HOME>/tui-themes/<name>.json`；名字是 1 到 32 个 `a-z`、`0-9` 或 `-`）。`/theme` 在内置主题之后列出它们，选择结果以 `"theme": "custom:<name>"` 存进偏好文件，不影响文件里的其他键。文件的内容是在某个内置配色上替换若干色调：

```json
{ "extends": "dark", "tones": { "accent": "#00aaff", "success": "#3ddc97" } }
```

`extends` 取 `dark`（默认）或 `light`；`tones` 只能使用下列键，值都是 `#rrggbb`：`bg`, `fg`, `surface`, `surfaceFg`, `selection`, `border`, `borderStrong`, `muted`, `faint`, `accent`, `accentSoft`, `onAccent`, `success`, `warning`, `danger`, `info`, `code`, `codeBg`, `link`, `thinking`。出现其他键、不是 `#rrggbb` 的值、JSON 不合法或超过 8 KB 的文件会被整份拒绝，不会部分生效，`/theme` 会给出原因。不跟随符号链接。启动时已保存的自定义主题丢失或无效，TUI 改用 `auto` 并提示一次，偏好文件保持原样。`mono` 和 `NO_COLOR` 下无论选了哪个主题都不上色。

键位可以在 `<AGH_HOME>/keybindings.json` 中修改，CLI 启动时读取一次：`{ "cut-to-end": ["ctrl-o"] }` 表示给这个动作换上新的键，旧键作废。动作 id 和所属作用域（全局、输入框、历史搜索）用 `/keys` 查看，那里也列出可以写的键名（`ctrl-k`、`alt-enter`、`pgup`、`f2` 等，不能绑定普通字母）。文件损坏、动作或键名不存在，或者同一作用域里的键已被别的动作占用，对应条目会被跳过，状态栏给出提示，并列在 `/keys` 末尾；文件里其余条目照常生效，启动不会被拦住。Ctrl-C 和 Ctrl-D（中断与退出）、审批弹窗、选择器、报告面板和密钥输入的按键是固定的。屏幕上的提示（比如回到对话底部）仍然写默认键。

链接：在 iTerm2、WezTerm、kitty、Ghostty、VS Code 终端和 Windows Terminal 上（按它们设置的环境变量识别，各自的文档都写明支持 OSC 8 超链接），全屏 TUI 会把 `http(s)` 网址、本机上确实存在的绝对路径和 `path:line` 变成可点击的链接；路径以 `file://` 地址打开，不带行号。其他终端以及 tmux、screen 里不加任何东西，文字和宽度两种情况下都一样。目标只用 `http`、`https`、`file` 三种。被折成两行的网址不加链接。`--no-alt-screen` 的底栏模式不加链接。

改动的行：审批卡和 `/diff` 里，被删除的行与替换它的新增行会逐词比较，改动过的词在该行原有颜色之上用粗体加下划线标出。超过 500 个字符的行、共同内容不足 40% 的一对行，以及没有对应删除行的新增行，仍整行显示为改动。

模型：Alt+P 切到 `/model` 列表里的下一个模型，Alt+Shift+P 切到上一个，到头回绕，走的是和 `/model` 相同的调用；状态栏写出新模型和从哪个 seq 起生效。列表就是 profile 里的列表，每个 route/model 只出现一次；当前模型已不在列表里时从第一个（反向则最后一个）开始。新模型提供当前的思考档位时保持不变。只有一个模型时状态栏提示没有其他模型。这两个键是 `/keys` 全局作用域里的 `model-next` 和 `model-prev`。把 Option+P 当字符发送的终端（macOS 终端和 iTerm2 的默认设置）需要把 Option 设成发送 Esc+。

草稿暂存：Ctrl-S 把输入框里的文字（粘贴块展开后）压入最多 10 条的暂存栈并清空输入框；输入框为空时取回最近的一条，作为一步可撤销的操作，栈空时会提示。压入第 11 条时丢弃最旧的一条。暂存栈只存在于本进程内存里，不写磁盘。Ctrl-S 能送到程序：raw 模式下终端的 XOFF 流控（IXON）是关闭的，已在伪终端里验证，所以没有改用 Alt-S。键位是 `/keys` 全局作用域里的 `draft-stash`；Ctrl-R 搜索打开时它不做任何事。

重绘：Ctrl-L 清屏并把整个画面重新画一遍，用于别的程序把屏幕写乱之后；草稿、滚动位置和会话都不变。`--no-alt-screen` 模式下只重画底栏，终端滚动区里已有的对话保持不动。键位是 `/keys` 全局作用域里的 `redraw`。

挂起：输入框为空时按 Ctrl-Z，TUI 像退出时一样把终端还给 shell，然后停住，回到 shell；`fg` 恢复，屏幕、鼠标和粘贴模式原样重新打开并重绘。挂起期间会话在 daemon 里照常运行。输入框有内容时 Ctrl-Z 仍是撤销。Windows 没有挂起，Ctrl-Z 一直是撤销。键位是 `/keys` 全局作用域里的 `suspend`。

会话、模型和主题选择器可以直接输入文字过滤，不区分大小写，匹配每行的标题、id 和时间。顶部显示 `过滤：xx（3/20）`，即匹配数与总数。退格删一个字，Esc 先清空过滤词，过滤词为空时再按 Esc 才关闭选择器；数字键只在过滤词为空时直接选行，否则数字属于过滤词。

用 PageUp 或滚轮往上翻之后，一旦有新内容出现，功能键行上方会显示 `↓ 有新内容 · End 回到底部`。按 End（或 Ctrl-End）回到最新的行并继续跟随新输出。输入框里有草稿时，End 仍是把光标移到行尾，这时只有 Ctrl-End 回到底部，提示行也会写成 Ctrl-End。

TUI `/package` 与 shell `package` 的子命令集合不完全相同，例如更新可以从 TUI/Web 发起，shell `package update` 当前没有实现。以[生命周期指南](packages.zh-CN.md)为准。

退出 TUI 时终端原样恢复到进入前的样子，不会重新打印对话。如果本次运行在当前会话里至少发过一条消息，且输出是终端，会留下几行：本次运行的时长，以及（完整历史已加载时）会话里的消息数（`本次运行了 12m 3s · 消息数：14`）；只有仍有等待中的事项时才多一行，即还没回答的审批和排在回合后面的排队消息（恢复会话前它们不会运行）；最后是 `agh --resume ID`，用来回到该会话。取不到的数字不显示。

Ctrl-O 展开最近一张工具卡，并向 daemon 读取完整的调用与结果；读取期间或读取失败时，卡片保留预览并说明原因。连续的 `read`、`grep`、`find`、`ls` 调用合并为一张卡，标题如“已读取 4 个文件 · 搜索 2 次”；展开后逐条列出每次调用的标题行，遇到其他调用即断开。鼠标上报开启时，点击卡片标题行可展开或收起那一张；Ctrl-O 仍然切换最新一张。折叠的卡片最多预览结果的三个屏幕行，其余显示为“… 还有 N 行”；`edit` 和 `write` 在名称后显示 `+a -b`，展开后显示这次修改的逐行 diff。计划、子智能体、后台任务和工作流的工具调用有各自的卡片：计划每步一行并标出状态，其余显示名称、状态、时间线里有的耗时和一行摘要。

Ctrl-T 在独占的全屏里打开整段对话，停在最新输出处；再按 Ctrl-T 或 Esc 关闭，回到原来的位置，下面的对话不会被移动。↑↓、PgUp/PgDn、Home/End 和鼠标滚轮可以滚动。里面按条目显示对话当前呈现的内容，是打开那一刻的样子。再次到达顶部时，才向 daemon 读取下一页更早的历史，所以长会话不会一次全部载入。审批卡出现时翻阅层先让开，答完后原样回来。它需要全屏视图；`--no-alt-screen` 下终端自己的滚动区承担这个作用，Ctrl-T 不起作用。这些键在 `/keys` 的翻阅层作用域里能看到，只有打开键可以改。 在翻阅层里按 `/` 输入关键词：回车跳到第一个匹配，`n` 和 `N` 跳到下一个和上一个（到头后绕回），匹配处高亮，状态行显示当前位置，例如 `3/17`。搜索不区分大小写，按纯文本匹配（关键词不会被当作正则），范围是显示出来的行（去掉颜色码），只覆盖已载入的历史；要找更早的内容，先滚到顶部读取更早的页，再搜一次。一个匹配不会跨越两个屏幕行。`c` 复制当前匹配所在的整条消息，走和 `/copy` 相同的剪贴板路径。

计划面板：智能体写下的最新一份计划（对话里的 `update_plan` 或 `todo` 工具调用）固定显示在输入框上方，不用滚动就能看到进度。面板最多占 6 行，每一步用和计划卡相同的标记（`[x]` 已完成、`[>]` 进行中、`[ ]` 待办、`[!]` 受阻）。计划更长时显示以进行中那一步为中心的五步，最后一行写还有多少步没显示；屏幕窄于 40 列时只显示一行 `计划 3/7`。计划里还有未完成的步骤时面板出现；全部完成后留下一行 `计划 7/7 ✓`，直到下一轮开始再消失；刚恢复的会话里已经完成的计划不显示。新会话或切换会话时面板清空。计划取自卡片的参数预览，而投影把它截在 2048 个字符：太长而无法完整解析的计划不显示面板，也不报错。`/todos` 在自动（默认）、始终显示、隐藏三者间切到下一个，`/todos auto|show|hide` 直接指定；选择只在本次运行有效。

卡片焦点：Ctrl-O 保持原样（展开或折叠最近一张卡）。Ctrl-X 更进一步：把焦点放在最新的一张工具卡上，卡片左侧用一条竖线标出，之后的按键用来在卡片之间移动，而不是输入文字。↑ 和 ↓ 移到上一张和下一张卡（到第一张和最后一张就停住），焦点卡不在视野内时会滚动对话；回车或空格展开或折叠焦点卡；`a` 展开所有卡，`z` 折叠所有卡；Esc 或 Ctrl-X 退出，对话回到按下 Ctrl-X 之前的位置。模式开着时没有按键会进入输入框，草稿保持原样（Ctrl-C 会先退出模式，再像平时一样中断当前轮）。期间有新卡到达，焦点不会跳。一串只读调用合并成的一个分组算一个停靠点。`/expand all` 和 `/expand none` 的效果与 `a`、`z` 相同，但不进入模式；只读分组里的卡不受影响，因为分组只显示它们的标题行。卡片焦点需要全屏视图；`--no-alt-screen` 下 Ctrl-X 不做任何事，`/expand` 仍对底栏里的卡片有效。键位列在 `/keys` 的「工具卡焦点」作用域下，只有开启键（`cards-focus`）可以改。

状态栏：`/statusline` 打开状态栏字段的列表，每项带一个复选框：模型、预设、用量（输入框上边缘的上下文进度条和状态栏下面的 token 行）、工作目录、git 分支与工作树、连接状态，以及扩展的 `status.line` 插槽。↑↓ 移动，空格或回车关闭或打开光标所在的字段并立即保存，Esc 关闭。关掉的字段马上从屏幕上消失。有三项没有复选框，因为它们不能隐藏：预算告警、暂存的审批票、错误通知。`/statusline reset` 让所有字段重新显示。选择保存在主题所用的同一个偏好文件（`<AGH_HOME>/tui-theme.json`）的 `statusLine` 键下；保存时不会丢掉文件里的其他键，文件读不出来时所有字段都显示。文件无法写入时，选择在本次运行中仍然有效，列表会提示没有保存。

窗口标题：`/title off|session|cwd|session-cwd` 选择 TUI 往终端窗口标题（OSC 2）里写什么：什么都不写（`off`）、会话名（`session`）、目录名（`cwd`，默认值，和 `/title` 出现之前一样）、或两者都写（`session-cwd`）；单独输入 `/title` 会说明当前用的是哪个。标题文本是 `agh · 名称`，回合进行中前面加 `● `，等待审批时加 `! `。名称里的控制字符会被去掉，整条标题截到 80 个字符。`off` 不输出任何转义序列，连保存原标题的那一条也不发。会话名在会话打开时和每个回合结束时从 daemon 的会话列表里读取，所以 `/rename` 之后从下一个回合起生效；还没有名字的会话显示目录名。其他模式会在写出第一个标题之前保存终端原来的标题，退出时放回去，前提是终端支持（不支持的终端上会留着最后一个标题）。在 tmux 里照常输出，由 tmux 决定是否透传给外层终端。选择保存在主题所用的偏好文件的 `title` 键下。

vim 键位：`/vim`（或 `/vim on|off`）在普通编辑和 vim 键位之间切换输入框；默认关，选择保存在同一个偏好文件的 `vim` 键下。开启后，在插入模式（也就是输入框原来的样子）按 Esc 进入普通模式，光标落在最后输入的字符上；再按一次 Esc 才执行没开 vim 时 Esc 的作用（中断正在运行的回合、清空草稿）；`@` 菜单打开时第一下 Esc 仍先关菜单，Ctrl-C 不变。普通模式支持：移动用 `h j k l`、`w b e`、`0 ^ $`、`gg G`；回到输入用 `i a I A o O`；删除和修改用 `x`、`dd`、`dw`、`D`、`cw`、`C`；粘贴用 `p P`；`u` 和 Ctrl-R 撤销与重做。删除的内容进入与 Ctrl-K、Ctrl-W 相同的 kill ring（所以 Ctrl-Y 能粘出 `dd` 删掉的行，`p` 能粘出 Ctrl-K 剪掉的文字），撤销用与 Ctrl-Z 相同的撤销栈。移动命令前可以加数字重复（`3w`；`2G`、`3gg` 表示跳到某一行）；数字加在其他命令前则取消该命令，而不是只执行一次。没有可视模式、`:` 命令行、宏和寄存器名；普通模式下其他字母不起作用，方向键、退格和 Ctrl 组合键保持原来的含义。Enter 在两种模式下都发送草稿，下一条输入从插入模式开始。模式显示在输入框下边缘的左侧（`█ 普通` 加粗，`▏插入` 淡色，mono 主题下也分得出），普通模式下提示符箭头会掉头（`❮`）。这些键列在 `/keys` 的 `vim` 作用域里，不能改键。

复制友好视图：`/raw` 在本次运行内切换到便于从终端复制的视图。鼠标捕获关闭，所以终端自带的选择可用（此时滚轮会发出方向键，和 `/mouse` 关闭时一样）；你自己的消息和引用块去掉左侧竖条和背后的填充；展开的工具卡和审批卡去掉左侧竖线和收尾行；代码块去掉缩进和底色，变成单独一行语言名加原样的代码，按终端宽度折行，不丢字符。状态栏在此期间显示加粗的 `RAW`。再次输入 `/raw` 恢复装饰和原来的鼠标设置（本来就关着鼠标的运行仍然保持关闭）。不会保存。

ASCII 边框：`/borders unicode|ascii` 选择框线和图标的画法；单独输入 `/borders` 会说明当前用的是哪个。`ascii` 下，TUI 画出的每一条线、每个角、竖条和图标都换成宽度相同的纯 ASCII 字符（`+ - | = # * > < v ^ x`，回合转圈换成 `| / - \`），所以切换时版面不会移动；对话本身的文字、其他文字和 emoji 保持原样。这些字符都出自同一张映射表，之后新增的图标只需在一处加映射。选择保存在主题所用的偏好文件的 `borders` 键下。没有保存的选择时，Linux 控制台（`TERM=linux`）默认用 `ascii`，其他终端默认用 `unicode`。分屏页脚模式写进滚动区的行和退出后留下的文字也遵循同一个设置。

粘贴与常见终端编辑器一致。TUI 向终端请求括号粘贴，所以一整块粘贴内容会连同换行一起整体到达：`\r` 和 `\r\n` 变成换行，制表符变成两个空格，其余控制字符被丢弃。超过 10 行或 1000 个字符的粘贴在输入框里显示为一个占位块，例如 `[粘贴 #1 · 42 行]`；退格一次删掉整块，Enter 发送完整原文。占位块只存在于正在运行的 TUI 中。

不支持括号粘贴的终端：在终端发来第一次括号粘贴之前，一次读到、或相邻两次读到的间隔不足 10 毫秒、合计超过 16 个字符的文字算一次粘贴，其中的 Enter（以及它之后 30 毫秒内的 Enter）插入换行而不是发送消息；输入安静 30 毫秒后 Enter 恢复发送。这只是按时间做的猜测：极快的打字，或一次提交整句的输入法，可能被当成粘贴；经慢速连接分散到达的粘贴，也可能被当成打字。两种情况下稍等片刻再按一次 Enter 即可。

审批卡显示后检查工具、参数和授权范围，再选当前提供的 allow/deny/abort 等选项。弹窗和审批卡显示同一份正文：工具、风险标签，以及 `edit`、`write` 的逐行 diff；弹窗在其下保留原始输入（PgUp/PgDn 翻页）。选项文案写明作用范围，例如“本会话内总是允许”。shell 命令的审批卡还可能多一个“本会话内以 `git push` 开头的命令不再询问”，前缀由 daemon 给出，`/grants` 把该授权显示为 `prefix: git push`（见[安全](security.zh-CN.md#命令前缀审批)）。若前缀能运行项目代码，卡片也会说明授权涵盖项目脚本、git hooks 和构建代码。`agh approvals suggest` 根据过去会话里你反复批准的命令提出前缀建议，只读；采用前缀要在审批卡上选择。可能造成不可恢复损害的命令在请求审批之前就会被拒绝，AGH 配置和指令文件的逐次审批只适用于声明写入路径的工具；shell 不声明目标，全权限下的 `echo ... > AGENTS.md` 不受此规则约束，强隔离由沙箱负责。`/yolo` 下也一样（见[安全](security.zh-CN.md#硬封锁命令)）。回车默认仍落在拒绝上。单键是同一批决定的快捷方式：`y` 允许一次，`a` 在对话里的审批卡上表示本会话内允许（卡片没有这一项时什么都不做；对整个配置生效的授权一律要按数字键；审批弹窗里「始终允许」的范围由发起请求的 agent 决定，`a` 在弹窗里不起作用），`n` 拒绝。单键只在输入框为空时生效，否则它们就是你正在输入的文字；数字键不受影响。它们在 `/keys` 的审批作用域里能看到，不能改键。卡片要静置 600 毫秒后单键才生效：卡片出现或换成另一张时开始计时，你按下的每个键都会让它从头算起，所以已经在进行的打字不会落到审批上。准备期内 `y`、`a`、`n`、数字、`r` 和回车都不做决定，输入的文字进入输入框草稿，卡片上的按键提示是暗色，Esc 仍然立即拒绝。按 `r` 可带理由拒绝：输入一行（最多 500 字符），回车拒绝，模型会把它当作用户原话读到，Esc 回到选项，理由为空则等同普通拒绝。卡片标题下会说明请求来自谁（拥有该工具的包、被委派会话的智能体角色、工具所属的 MCP 服务）；提供“对此配置始终允许”时，还会列出该选项将存入的 scope。这些内容都由 daemon 给出，有长度上限，并按纯文本显示。当调用写入 agh 的配置或指示文件时（见[安全](security.zh-CN.md#审批)），卡片只提供“允许一次”和拒绝，并附一行说明。`/yolo` 为当前会话启用完全权限：跳过工具审批，允许读写工作区内外的文件。策略中的明确禁令、操作系统权限和已配置的命令沙箱限制仍然有效。新会话会沿用已保存的权限选择。`/yolo off` 恢复常规审批询问。

终端上报焦点时，TUI 仅在窗口处于后台的情况下，于回合结束时响一次铃，每有一个审批开始等待也响一次。窗口标题见上面的 `/title`：默认是 `agh · 目录名`，回合进行中前面加 `● `，等待审批时加 `! `，退出时恢复原来的标题。不上报焦点的终端不会收到铃声。出错和被委派的子 agent 完成时同样如此；同一事件三秒内重复出现只算一次。在 iTerm2、Ghostty、WezTerm、kitty 和 Warp 上（按 `TERM_PROGRAM`、`TERM` 或它们导出的变量识别，tmux 里也适用，此时通知用 passthrough 包装，需要 `allow-passthrough on`），这些提醒会通过 OSC 9 变成系统通知；其他终端仍然是响铃。Windows Terminal 和 ConEmu 把 OSC 9 当作进度命令，所以只会响铃。通知文本是 `agh · 事件 · 目录名`，不会带上你的提示词、命令或工具参数。`/notify on|bell|off` 在系统通知（`on`，默认）、只响铃和静音之间选择；选择像主题一样保存在 `<AGH_HOME>/tui-notify.json`，环境变量 `AGH_NOTIFY=on|bell|off` 会覆盖它。

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

`agh api METHOD [--params JSON|-] [--json]` 用 CLI 已有的连接调用一个协议方法，不新增任何权限。`METHOD` 是协议方法表里的名字，可带或不带 `_agnes/v1/` 前缀；`agh api --help` 列出所有可调用方法及其层级（`client` 或 `admin`），由协议方法表生成。`--params` 是 JSON 参数对象（`-` 从 stdin 读，默认 `{}`），发送前先在本地按协议 schema 校验：参数无效时输出 schema 诊断，并且不会发送。方法名不存在时拒绝并给出最接近的名字。结果以 JSON 打印到 stdout（`--json` 为单行）；daemon 的拒绝（包括没有 admin 连接时调用 admin 方法）以 `error: CODE: message` 打印到 stderr 并以 1 退出。流式和 attach 方法（`session.attach`、`participant.join` 等）以及命令类方法（`submit`、`session.control`、`session.fork` 等）会被拒绝，因为它们需要 commandId 和 pending journal：请用 `agh queue` 或对应子命令。ACP 会话调用（`session/prompt` 等）同样不提供。

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
| 124 | `--timeout`：超过期限，回合已被取消 |
| 130 / 143 / 129 | SIGINT / SIGTERM / SIGHUP |

`agh -p --max-budget CREDITS` 限制一次运行最多花费的额度。`CREDITS` 是大于 0 的数字，单位与 preset 的单次请求额度上限相同。它随这一次提示词作为单回合硬上限发送，只能调低 preset 自身的上限，不能调高。额度用尽时该回合以 `budget` 结束，退出码为 4。与 `--continue` 或 `--resume` 一起使用时，只对这一次提示词生效。值不是正数、没有 `-p`，或 daemon 没有声明支持硬性回合预算时，在发出提示词之前以退出码 2 结束。

`agh -p --max-turns N` 限制一次运行的模型步数。`N` 是 1 到 1000 的整数。它随这一次提示词作为单回合步数上限发送，只能调低 preset 自身的 `budget.max_steps`，不能调高。运行达到上限时该回合以 `max_steps` 结束，退出码为 5（preset 的上限见[配置参考](../reference/configuration.zh-CN.md)）。与 `--continue` 或 `--resume` 一起使用时，只对这一次提示词生效。值超出范围、没有 `-p`，或 daemon 没有声明 `turnMaxSteps` 时，在发出提示词之前以退出码 2 结束，不会被静默忽略。

`agh -p --timeout 秒数` 让运行过久的任务停下来。`秒数` 是大于 0 且不超过 86400 的数字（可以带小数）。期限从发出提示词时开始计时。到期后，CLI 用与 Ctrl-C 相同的方式取消当前回合，向 stderr 写 `agh: timeout after 秒数s; turn cancelled (exit 124)`，并以 124 退出，这与 `timeout(1)` 的退出码一致。回合在取消生效之前已经结束时，保持它自己的退出码；收到信号时仍以信号的退出码为准。值超出范围或没有 `-p` 时，在发出提示词之前以退出码 2 结束。

`agh -p --output-file 文件` 在 stdout 输出之外，再把最终文本写入 `文件`（相对 `--cwd`，已存在则覆盖）；stdout 的内容不变。与 `--output-schema` 一起使用时，文件里是紧凑的 JSON 值。无论回合怎样结束都会写文件，回合没有文本时文件为空，这样脚本不会读到上一次的旧答案。文件无法写入时退出码为 1。没有 `-o` 简写：`-o` 已经是 `export`、`computer-use` 和 `diagnostics export` 的 `--out`。没有 `-p` 时退出码为 2。

实现依据：[参数与 usage](../../packages/cli/src/args.ts)、[退出码](../../packages/cli/src/errors.ts)、[TUI 命令](../../packages/cli-tui/src/commands.ts)。

在 TUI 中使用 `/attach <path>` 分块上传原件，并将回执作为 prompt 提交。路径可含空格。常见的图片、文档、压缩包和音视频扩展名按各自的 MIME 类型上传，其余扩展名按 `application/octet-stream` 上传；daemon 的白名单拒绝原样显示。失败保留后端附件原因；回执属于当前会话，上传完成前切换会话会拒绝提交。
