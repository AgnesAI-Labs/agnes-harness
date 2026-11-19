# Superagent 部署

[English](superagent.md) | 简体中文

[文档](../README.zh-CN.md) · [插件](packages.zh-CN.md) · [安全](security.zh-CN.md) · [网络部署](deployment.zh-CN.md)

Superagent 是随 AGH 默认安装并启用的官方插件。它关注一个 GitHub 仓库（也可以通过已配置的机器人 lark-cli 包装程序关注飞书群），把允许名单里的人提出的请求变成工单，
每个工单交给它自己的会话：该会话在工单目录里工作，推送自己的分支并开 PR；对人说话的是主会话。侧栏入口可直接打开现有面板。
未配置时保持等待设置，不监听外部来源、不接单、不启动会话、不调用模型。默认安装不授权任何外部账号或请求者。

升级会给从未安装或卸载过它的旧 home 补入默认包，保留已安装配置、数据以及明确的禁用或卸载选择，并遵守 profile 的能力上限。
升级需要补入新默认包时，若包卸载历史损坏、截断或不可读，会拒绝自动补入；没有新默认候选的 profile 不读取这份历史。

本页讲把它作为长期服务运行：账号与单独的 AGH home、launchd 或 systemd 单元或 Windows 计划任务、启用、停用、清除数据，以及它的会话能碰到什么、碰不到什么。
由编码智能体陪你逐步完成的设置（包括各项设置与面板）见插件自带的[设置指南](../../packages/superagent/docs/setup.md)（英文）。

## 开始之前

- **macOS、Linux 或 Windows。** Windows 上工单会话和准备命令在 Windows PowerShell 里运行，引用变量写 `$env:名字`；Superagent 的垫片是 `.cmd` 文件；
  需要 Git for Windows，因为 git 用它自带的 shell 运行智能体的凭据助手。下面的路径是 POSIX 的写法，Windows 上用任意绝对路径，例如 `C:\Superagent\agh`。
- **专用系统用户（强烈推荐）。** 每个工单会话都以运行 daemon 的用户身份完全访问本机。只有一个单独的、不含你自己文件、密钥和已登录工具的用户，
  才能限制出错或被操纵的会话能碰到的范围。见[安全边界](#安全边界)。
- **智能体专用的 GitHub 账号**，只对这一个仓库有写权限；默认分支开启**分支保护**：合并需 PR 且有人批准，禁止强推和删除。
  除非你在它的提示里开启自动合并，智能体从不合并。
- **Superagent 专用的 AGH home**，与你日常工作的 home 分开，并配好模型。Superagent 随自己的 daemon 重启，不会关掉你的会话。
- 本机装有 git 2.32 及以上、GitHub CLI 2.48 及以上。

## 路径

下面的例子使用这些路径，换成任何绝对路径都可以。服务账号最好不要用个人家目录下的路径。

| 路径 | 存放 |
| --- | --- |
| `/srv/superagent/agh` | `AGH_HOME`：daemon 的 home、模型配置、会话，以及它列出的 Superagent 技能 |
| `/srv/superagent/state` | Superagent 的状态目录（插件设置 `stateDir`）：`superagent.sqlite`、`work/` 下的工单目录 |
| `/srv/superagent/state/Superagent` | 新建主会话的工作区目录；侧栏直接显示它的真实目录名 `Superagent` |
| `/srv/superagent/state/worker-bin` | 垫片，Superagent 每次启动时重写：`gh` 运行智能体的 GitHub CLI，被禁用的命令直接失败 |
| `/srv/superagent/state/worker-gitconfig` | 智能体的 git 配置，Superagent 每次启动时重写 |
| `/srv/superagent/bin/gh-agent` | 智能体的 GitHub CLI：一个用自己配置目录的 `gh` 包装 |
| `/srv/superagent/gh-agent` | 这个配置目录：智能体的 GitHub CLI 登录 |

不设 `stateDir` 时，Superagent 使用 AGH 数据目录下的 `bundled-apps/<哈希>`，面板的 **Deployment** 页会写出它。
在服务启动前显式设置，下面的单元文件就可以写死。
新建主会话使用 `<stateDir>/Superagent`，显式配置 `stateDir` 时也一样。数据库、智能体环境和工单目录仍使用原来的
`stateDir` 下的路径；显式设置的工单执行目录也不变。这个默认值不会迁移已有会话的工作区。

## 安装与启用

1. 以服务用户、`AGH_HOME=/srv/superagent/agh` 先启动一次 daemon（`agh serve`），按[安装](install.zh-CN.md)配好模型。
   全新的 home 在首次启动之前不要在 `AGH_HOME` 下创建任何文件：那里有文件（比如把 daemon 输出重定向到其中的日志）时，启动器会以
   `E_HOME_VERSION` 拒绝这个 home。日志请写到 home 之外，例如 `/srv/superagent/agh.log`。
2. 打开侧栏 **Superagent**；它已安装、启用并等待配置。如果以前禁用过，在 **插件** 页手动启用；如果以前卸载过，
   从 **插件 → 市场** 重新安装，并审阅模型与会话访问、在本机执行命令等能力（见[插件](packages.zh-CN.md)）。
   终端的等价操作是用同一个 `AGH_HOME` 运行 `agh plugins add file:./bundled-plugins/superagent`；这个保留引用标识官方随包载荷。
   包名本身不是来源，文件夹副本也不获随包应用授权（见[排错](#排错)）。
3. 在插件设置页把 `stateDir` 设为 `/srv/superagent/state`（Windows 上不要设，见 [Windows](#windows任务计划程序)）。此时 Superagent 会报告一个设置问题，因为智能体的环境还没就绪，这是正常的。
4. 给智能体一个只用它自己登录、绝不用你的登录的 GitHub CLI：一个带自己配置目录的 `gh-agent` 包装。然后用它登录：

   ```sh
   mkdir -p /srv/superagent/bin
   cat > /srv/superagent/bin/gh-agent <<'EOF'
   #!/bin/sh
   GH_CONFIG_DIR=/srv/superagent/gh-agent exec gh "$@"
   EOF
   chmod +x /srv/superagent/bin/gh-agent
   /srv/superagent/bin/gh-agent auth login
   /srv/superagent/bin/gh-agent api user --jq .login
   ```

   在 macOS 上用 `gh-agent auth login --insecure-storage` 登录（经典令牌用 `--with-token --insecure-storage`），让令牌留在包装自己的配置目录里。工单会话在 macOS 沙箱中运行，读不到 `gh` 默认存放令牌的钥匙串，智能体的 `gh` 在会话里会表现为未登录。设置检查发现令牌在钥匙串中时会报告。

   Windows 上包装是 `gh-agent.cmd`，它用完整路径运行 `gh.exe`（`where.exe gh` 会打印出来），从不经过 Superagent 的 `gh` 垫片；
   它自己的路径只能含 ASCII 字符：垫片里写着这个路径，而 `cmd.exe` 读批处理文件时会读错其他字符。写进包装的 `gh.exe` 路径也一样：
   装在你的配置文件目录下的（winget 或 scoop 按用户安装）改写成 `%LOCALAPPDATA%` 或 `%USERPROFILE%` 开头，由 `cmd.exe` 运行时展开；
   其他含非 ASCII 字符的路径会让下面的命令停下，这时需要把 `gh.exe` 移到别处。在 PowerShell 里：

   ```powershell
   New-Item -ItemType Directory -Force C:\Superagent\bin | Out-Null
   $gh = (Get-Command gh.exe).Source.Replace($env:LOCALAPPDATA, '%LOCALAPPDATA%').Replace($env:USERPROFILE, '%USERPROFILE%')
   if ($gh -match '[^\x20-\x7e]') { throw "Move gh.exe to a path of ASCII characters: $gh" }
   Set-Content -Encoding ascii C:\Superagent\bin\gh-agent.cmd "@set `"GH_CONFIG_DIR=C:\Superagent\gh-agent`"`r`n@`"$gh`" %*"
   C:\Superagent\bin\gh-agent.cmd auth login
   C:\Superagent\bin\gh-agent.cmd api user --jq .login
   ```

   批处理文件不能把参数里的换行传下去。Superagent 经标准输入把评论正文交给它，并告诉 Windows 上的会话把多行文本放进文件交给 `gh`（`--body-file`）。

   最后一条命令打印智能体以哪个账号行事；Superagent 也这样读取。请以智能体自己的 GitHub 账号在浏览器里登录：这是一个专用账号，
   作为协作者只对这一个仓库有写权限、别的都没有，这样它无论用什么方式登录都只能碰到这个仓库。试用时也可以登录你自己的账号，
   这时智能体以你的身份行事。Superagent 通过这个账号的通知接收请求，而 GitHub 的通知 API 只接受浏览器登录或经典令牌：

   - **不支持细粒度个人访问令牌**：通知 API 拒绝它们。这时 Superagent 的设置检查会报告“智能体的 GitHub 令牌读不到通知”。
   - **经典个人访问令牌**（用 `gh auth login --with-token` 给出）带上 `repo` 和 `notifications` 两个范围即可使用。它能碰到这个账号能碰到的
     所有仓库，这也是只让该账号访问这一个仓库的又一个理由。

   阻止智能体直接推送默认分支、或不经人批准就合并的，是默认分支上的分支保护，而不是令牌。Superagent 从不读取分支保护；
   读取它需要仓库的管理员权限，而智能体账号不应有这个权限，请用你自己的账号核对。
5. 在面板的 **来源** 页，GitHub 卡片上填仓库（`owner/name`）和 CLI `/srv/superagent/bin/gh-agent`，保存。设置检查会核对账号和它的推送权限。
6. 停掉这个 daemon，按下文作为服务运行。

## 作为服务运行

daemon 照常启动，不需要智能体的 `HOME` 或 `PATH`。Superagent 给它开的每个会话设置智能体的环境：垫片目录放在 `PATH` 最前面，
用它自己的 git 配置代替用户的全局与系统配置（`GIT_CONFIG_GLOBAL`、`GIT_CONFIG_NOSYSTEM`），git 不弹提示，也没有 `GH_TOKEN` 或 `GITHUB_TOKEN`。
所以即使操作者在同一台机器上已登录，这些会话的提交、推送和 `gh` 调用也都以智能体账号进行。Superagent 自己运行的 git、`gh` 和 prepare 命令也一样。
每次启动时它在这个环境下检查：git 访问 github.com 时只向智能体的 GitHub CLI 要凭据，而这个 CLI 以智能体账号行事。
这个环境随会话保存，重启之后不论谁打开会话都仍然生效。只有 Superagent 能给会话设置这个环境，而且只能给它自己的会话：平台拒绝其他任何客户端或插件这样做。

会话沿用 daemon 的 `HOME`，而 git 在询问任何凭据助手之前会先读 `~/.netrc`：其中的 `machine github.com` 或 `default` 项会让智能体以你的身份推送。
只要有这样一项，Superagent 就不启动（`agentNetrc`）；删掉这一项，或换一个没有它的用户运行服务。

服务管理器不读你的 shell 配置：把 `PATH` 写全，让它能找到 `node`、`git` 和包装所运行的 `gh`。

### macOS（launchd）

`/Library/LaunchDaemons/dev.agnes.superagent.plist`，用 `sudo launchctl bootstrap system <文件>` 加载：

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>dev.agnes.superagent</string>
  <key>UserName</key><string>superagent</string>
  <key>ProgramArguments</key>
  <array><string>/opt/homebrew/bin/agh</string><string>serve</string></array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>/opt/homebrew/bin:/usr/bin:/bin</string>
    <key>AGH_HOME</key><string>/srv/superagent/agh</string>
  </dict>
  <key>WorkingDirectory</key><string>/srv/superagent</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>
  <key>ExitTimeOut</key><integer>60</integer>
  <key>StandardErrorPath</key><string>/srv/superagent/agh.log</string>
</dict>
</plist>
```

### Windows（任务计划程序）

Windows 上 `agh serve` 没有服务单元：注册一个在服务用户登录时启动它的计划任务，下面在管理员 PowerShell 里执行。任务在该用户的会话里、
用该用户的配置文件运行 daemon：

```powershell
$action = New-ScheduledTaskAction -Execute 'C:\Program Files\nodejs\agh.cmd' -Argument 'serve' -WorkingDirectory 'C:\Superagent'
$trigger = New-ScheduledTaskTrigger -AtLogOn -User 'superagent'
$settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1)
Register-ScheduledTask -TaskName 'AGH Superagent' -Action $action -Trigger $trigger -Settings $settings -User 'superagent'
[Environment]::SetEnvironmentVariable('AGH_HOME', 'C:\Superagent\agh', 'User')   # 以服务用户执行
```

`-Execute` 写你的安装提供的 `agh`。`AGH_HOME` 设为服务用户的用户变量（以该用户登录后执行最后一行），这样任务和该用户的每个终端都用同一个 home；
该用户的 `Path` 要能找到 `node`、`git` 和 `gh`。在 Windows 上不要设 `stateDir`：Superagent 把状态放在平台给的目录里，只有当前用户能打开，
它拒绝这个目录之外的 `stateDir`。以该用户运行 `agh daemon stop` 停止 daemon：结束任务（`Stop-ScheduledTask`）会直接杀掉进程，会话来不及结束回合。

### Linux（systemd）

`/etc/systemd/system/superagent.service`，用 `systemctl enable --now superagent` 启动：

```ini
[Unit]
Description=AGH with Superagent
After=network-online.target
Wants=network-online.target

[Service]
User=superagent
WorkingDirectory=/srv/superagent
Environment=PATH=/usr/local/bin:/usr/bin:/bin
Environment=AGH_HOME=/srv/superagent/agh
ExecStart=/usr/local/bin/agh serve
Restart=on-failure
KillMode=mixed
TimeoutStopSec=60

[Install]
WantedBy=multi-user.target
```

通过服务管理器停止服务（`launchctl bootout`、`systemctl stop`），Windows 上用 `agh daemon stop`，daemon 会干净地结束各会话的回合。任何时候重启都是安全的，见[重启与恢复](#重启与恢复)。

**按早先方式配置的安装。** 单元以 `HOME=<stateDir>/home` 启动 daemon、把 `<stateDir>/worker-bin` 放在 `PATH` 最前面、GitHub 卡片填的是 `gh`
的安装照常可用：那个 `gh` 仍读取 `<stateDir>/home/.config/gh` 里的登录。要改成上面的方式，用 `GH_CONFIG_DIR=<stateDir>/home/.config/gh`
建 `gh-agent` 包装（沿用那份登录），把它作为 CLI 保存到 GitHub 卡片，再从单元里去掉 `HOME` 和垫片目录并重启。
Superagent 下次打开已有会话时会给它们设置智能体的环境。

## 设置与首次使用

打开 AGH 首页上的 **Superagent** 入口，依次保存：来源（仓库与智能体的 GitHub CLI `/srv/superagent/bin/gh-agent`；用飞书时填写机器人 CLI 包装程序路径）、策略（谁可以提请求）、
执行设置（工单目录根与 prepare 命令，例如 `git clone "https://github.com/<owner>/<name>.git" repo`）以及团队提示段。
各字段的含义见[设置指南](../../packages/superagent/docs/setup.md)。全新安装时总览会报告 GitHub 来源没有设置仓库：
**来源** 设置从首次启动起就列出 GitHub，保存仓库与 CLI 后设置会自行继续，无需重启。然后用允许名单里的账号在某个 Issue 下评论 `@<智能体登录名> <请求>`，
大约一分钟内总览里就会出现工单。

使用飞书时，在 **来源 → 飞书 → 机器人 CLI 路径** 填写已配置认证的 lark-cli 包装程序绝对路径，
strict-mode 必须为 `bot`。保存时会验证并显示应用与机器人身份，再配置群列表、@ 策略、私聊和 **策略** 中的请求人允许名单，启用来源。
不需要 AGH 飞书插件、渠道实例或认领。后端负责 CLI 事件、上下文读取、图片下载与回复；执行器通过
`orchestrator_feishu_read` 读取属于自己工单的机器人、群和话题范围内的内容。

旧实例设置保留群策略和允许名单，但需要补填 CLI 路径。已有工单与消息去重记录保留；未验证机器人身份的旧工作，
以及属于另一个机器人的工作，不能通过新机器人读取或回复，请发起新请求。重启恢复游标按机器人身份隔离。
超时或崩溃导致回复结果不明时，回执保持待处理，需操作人员核对外部消息后处理，不会静默重发；当前面板没有覆盖此状态的操作。
真实机器人验证与消费者切换需单独协调，模拟 CLI 测试不代表已完成真实飞书验收。

在 Web 侧栏里，每个工单会话的标题是 `Worker · <工单标题>`，归在工单目录对应的项目下；主会话保留原名，工单链接仍打开对应会话。
Superagent 投递到自己会话里的内容（例如派工、转达的汇报、飞书消息）显示为一行折叠的「应用自动投递的消息」，而不是有人输入的文字；
展开即可查看投递的原文。只改显示：模型读到的内容和它在会话队列里的排队方式都与以前完全相同。限制：只有本版本起由 Superagent 新建的会话才这样标记，
之前建的主会话即使删除后重建，也仍按普通消息显示投递；有人输入或粘贴同样的文字始终是普通消息。

## 停用

在 **插件** 里停用插件；如果只想停止接新活而让它继续运行，用面板里的 **暂停处理**。停用会停止轮询和发件，取消 Superagent 所有会话正在跑的回合，
在几秒内停掉它们的后台作业，并把正在跑的派工记为暂停。会话、工单目录和状态目录都保留。再次启用时按每个会话的真实状态对账：
仍在跑的不动，被打断的派工带恢复说明重新派一次，在会话队列里等着的消息运行一次。

在 Superagent 这套 AGH 里安装、更新、启用或停用任何其他插件，也会让 Superagent 以同样方式重启：先按上文停下，再立即启动。
见[重启与恢复](#重启与恢复)。

## 清除数据

清除数据只能由主人显式操作，停用从不清除。要全部删掉：

1. 停用插件，再在 **插件** 里卸载它。
2. 删除状态目录（`/srv/superagent/state`，或面板写出的 `bundled-apps/<哈希>` 目录）。这会删掉数据库和每个工单目录（包括尚未推送的分支）。
   智能体的 GitHub 登录留在包装的配置目录（`/srv/superagent/gh-agent`）里；把它和包装一起删掉，或用 `gh-agent auth logout` 让智能体退出登录。
3. 删除不再需要的会话：主会话 `superagent:orchestrator` 与工单会话 `superagent:worker:<工单 id>`。
4. 删除 Superagent 写进 AGH home 的技能：`<AGH_HOME>/skills` 下的 `dsh-superagent-*` 目录。

已推送的分支和 PR 留在 GitHub 上，需要到那里删除。

## 安全边界

Superagent 保留它原有的边界：允许名单与每个工单的授权书（策略版本、范围、强度）、专用的 GitHub 账号与飞书机器人、合并需人批准的分支保护，
以及它自己的 AGH home。提示词不是边界；来自 GitHub 或飞书的正文只是材料，不能改变工单的目录、Bundle 或权限。

**主会话可以改设置。** 与原版一致，主会话有一个工具 `orchestrator_settings_save`，在有人于对话中明确要求时保存一个设置块：
策略（允许名单与规则）、Eval 设置、执行设置（含准备命令）、某个 Source，或暂停。这个要求是否真实，由模型判断，代码不做校验。
因此，被 Issue 或群聊里的文字误导的主会话，或者应允许名单里某人的要求，可能把某人加进允许名单，或改掉准备命令，而 Superagent
会为之后的每个新工单运行这条命令。允许名单挡得住名单外的人，挡不住名单内的人，也挡不住主会话读到的文字。限制这一风险的是：

- 每次保存都留一个版本。面板 Eval、执行与 Source 页的历史把主会话做的每次保存标为 **主 Session 工具**；请复查这些保存，
  需要时在面板里改正。
- 允许名单保持精简，并以专用系统用户运行 Superagent（见下文），让改动过的准备命令只能碰到智能体自己的账号。

工单会话以完全访问运行。这意味着：

- 会话能用绝对路径读取操作者的家目录，包括操作者日常 AGH home 里的密钥与 socket，以及包装配置目录里智能体自己的登录。
  智能体的环境改变的是 git 与 `gh` 用哪个身份，不是会话能碰到的范围。
- 在 Superagent 这套 AGH 里，完全访问会解除对数据目录的软禁止：`tables`、`audit` 与 `sessions.db` 可读可写；只有数据目录下的 `secrets`
  和私有状态根仍然禁止。Superagent 自己的 SQLite 数据库也能被它的会话读写。
- 在同一个系统用户下，会话很可能能自行连上 daemon 的本地 socket，以主人的权限行事：本地认证只看 socket 归谁所有。
  所以“不把主人级客户端交给会话”不是安全边界。

以上各点只有用专用系统用户运行这套 AGH 才能解决；强烈推荐这样做，但不强制。

**Windows 上 `gh` 是批处理文件。** 会话的 shell 是 PowerShell，`gh` 经 Superagent 的 `gh.cmd` 垫片到达智能体的 CLI。运行批处理文件的
`cmd.exe` 会再读一遍参数：在换行处截断参数，并把引号加 `&` 或 `|` 之后的内容当作命令执行，不管 PowerShell 怎么加引号。执行会话若把
Issue 标题或评论放进 `gh` 的命令行，就可能执行写那段文字的人写的命令。Windows 上的会话被告知把来自人的文本经文件或标准输入交给 `gh`
（`--body-file`、`-F title=@<文件>`），Superagent 自己的命令也这样做：它为 `cmd.exe` 转义每个参数（包括引号），并拒绝传给批处理文件的参数里有换行。提示词不是安全边界。
被禁用的命令也只拦 PATH 上找到的程序：在 Windows PowerShell 5.1 里 `curl` 和 `wget` 是 `Invoke-WebRequest` 的别名，不会被拦。

## 重启与恢复

- **daemon 重启。** 正在跑的回合以中止结束，其作业随 daemon 停止。启动时 Superagent 先写入并检查智能体环境，再按每个会话的真实状态对账：
  仍在跑的回合不动；被打断的派工带恢复说明重新派一次；会话队列里最早的一条等待消息被启动，因为重启后不会有别的东西让它续跑。
- **这套 AGH 里的插件变更。** 在 Superagent 的 AGH home 里安装、更新、启用或停用任何插件（不只是 Superagent 自己），都会让 Superagent
  重启。所有正在跑的工单都会被打断：回合被取消、作业被停，正在进行的 `git push` 或测试运行会中断。Superagent 恢复后，被打断的工单像
  daemon 重启后一样继续：每个被打断的派工带恢复说明重新派一次。请在概览显示没有工单在跑时再改这套 home 里的插件。
- **Superagent 代码升级。** 新服务接单前，会将真实登记的主会话和可续做工单会话迁到它实际发布的代码，即使版本号没有变化，
  也包括人类续问能恢复的已完成工单。人类终止或已被保留策略退休的工单保留原绑定。
  只关闭、迁移代码不同的会话；普通重启保留当前绑定，其他会话保留原 pin。会话忙碌或效果尚未核清时，启动保持暂停并重试；
  原因解决后可用 **Check again** 再试。这需要与本次 Superagent 更新一同发布的 daemon。
- **工具结果未知。** 升级不会清除历史或重放结果不明的调用。只有对该次调用的正式人工答复已被 Core 消费，且留有匹配的检查点，
  迁移才会认可这项人工核对；系统或代理身份的答复不符合条件，
  人工答复也不代表系统已观察到效果。尚未答复或不相关的未知结果仍阻止迁移。
- **先记后做。** 每个对外动作（回复、派工、投递）都先入库再执行，成功后才删除，失败按退避重试。暂停处理期间来源照常记录。
- **结果不明的投递**按命令 id 查询核实；核实不了就记为未送达，交人处理，绝不重投，也不换 id。
- **主人归档了工单会话**：派工以失败结束，交人决定，不会背着你另开会话。**主人删除了工单会话**：用同一个 key 重开并重新发送完整派工；
  重开失败则派工以失败结束并写明原因。
- **模型与 GitHub 故障。** 因限流或服务端错误失败的回合，分别在 15、30、60 秒后续跑；连续第四次失败则派工失败、交人处理。
  超时或失败的 GitHub 读取在下一轮轮询时重读。prepare 命令失败则工单失败，不再重跑。

## 排错

面板总览会列出设置问题并链接到修复它的设置；在面板之外修好之后，用 **Check again** 重新检查。

| 问题 | 处理 |
| --- | --- |
| `The GitHub Source names no repository.` | 打开 **设置 → 来源**，在 GitHub 卡片上填写仓库（`owner/name`）和智能体的 GitHub CLI 并保存；设置随即继续，无需重启 |
| 面板说连不上 Superagent，调用返回 `CAPABILITY_DENIED` | 请从市场安装；本地路径安装没有特权授权。用文件夹路径安装得到的是 `local-source` 包，它永远拿不到 Superagent 运行所需的随包应用授权，这是有意的。先卸载它，再从 **插件 → 市场** 或用 `agh plugins add file:./bundled-plugins/superagent` 安装 |
| `agh package add @agnes/superagent` 被拒绝 | 包名不是来源。从市场安装，或用 `agh plugins add file:./bundled-plugins/superagent` |
| 首次 `agh serve` 以 `E_HOME_VERSION` 拒绝 home | 全新的 `AGH_HOME` 在首次启动前被建了东西，比如日志文件。删掉它再启动，并把日志写到 home 之外 |
| `git would sign in to github.com with …/.netrc, not with the agent's GitHub CLI` | 删掉该文件里 `machine github.com` 或 `default` 那一项，或换一个没有它的用户运行服务，再点 **Check again** |
| `The agent GitHub CLI … is in …/worker-bin, which Superagent writes` | GitHub 卡片填的是 Superagent 自己写的垫片，而不是它要运行的 CLI。改填 `gh-agent` 包装 |
| `git would ask other credential helpers than the agent's for github.com` | 有凭据助手被加进了 `<stateDir>/worker-gitconfig`，Superagent 下次启动时会重写它：点 **Check again**。否则就是智能体用的 git 早于 2.32 |
| `The agent's GitHub token cannot read notifications; …` | 智能体用细粒度令牌登录，GitHub 的通知 API 拒绝它。用 `gh-agent auth login` 在浏览器里重新登录，或改用带 `repo` 与 `notifications` 范围的经典令牌，见第 4 步 |
| `gh acts as @…, not the agent account @…` | 用 `gh-agent auth login` 重新登录，见第 4 步 |
| `The agent's GitHub token for @… is in the macOS keychain, …`，或者 macOS 上智能体的 `gh` 在工单会话里表现为未登录，而 `gh-agent auth status` 显示 `(keyring)` | 会话在 macOS 沙箱中运行，读不到钥匙串。用 `gh-agent auth login --insecure-storage` 重新登录（经典令牌用 `--with-token --insecure-storage`），见第 4 步 |
| `The agent GitHub CLI was not found.` | 在 GitHub 来源里写 `gh-agent` 包装的绝对路径，并让单元 `PATH` 能找到它运行的 `gh` |
| `The agent GitHub CLI cannot read its account.` | 包装还没登录：运行 `gh-agent auth login`，见第 4 步 |
| 某个文件 `… was not written by Superagent` | 把它移出 `<stateDir>/worker-bin`，或把 `<stateDir>/worker-gitconfig` 挪走，或换一个状态目录 |
| `A session superagent:… exists that Superagent did not open` | 归档或删除这个不属于 Superagent 的会话，再点 **Check again** |
| 工单失败并带有 prepare 命令的输出 | 在执行设置里修好命令，再重试工单 |
| `deliveries` 健康项点名某个工单 | 重新派工时一直无法确认会话是否收到某条消息；确认 daemon 有应答，再重试工单 |
| `relay` 健康项点名某个工单或触发 | 转达给主会话的某条消息一直失败（通常是无法确认会话是否已收到），后面的转达都排在它之后。它按退避重试，daemon 确认后即送达。如果一直卡住，重启服务（见[作为服务运行](#作为服务运行)）：之后这条转达会被确认，或以它自己的 id 发送一次。面板里工单的 **停止** 与 **重试** 不会放行它：停止结束该工单的派工并收回授权，之后线程里的消息不再恢复它；重试（在执行会话失败、受阻或有输入未送达时提供）结束当前派工，并在同一授权下重新派工 |
| @ 之后没有反应 | 检查发起人在允许名单里、来源已开启、处理没有暂停 |
