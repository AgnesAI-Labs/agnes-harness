# Superagent 部署

[English](superagent.md) | 简体中文

[文档](../README.zh-CN.md) · [插件](packages.zh-CN.md) · [安全](security.zh-CN.md) · [网络部署](deployment.zh-CN.md)

Superagent 是随 AGH 发布的可选插件。它关注一个 GitHub 仓库（也可以通过一个 AGH 飞书渠道实例关注飞书群），把允许名单里的人提出的请求变成工单，
每个工单交给它自己的会话：该会话在工单目录里工作，推送自己的分支并开 PR；对人说话的是主会话。Superagent 默认不安装、不启用；不启用就没有任何变化。

本页讲把它作为长期服务运行：账号与单独的 AGH home、launchd 或 systemd 单元、启用、停用、清除数据，以及它的会话能碰到什么、碰不到什么。
由编码智能体陪你逐步完成的设置（包括各项设置与面板）见插件自带的[设置指南](../../packages/superagent/docs/setup.md)（英文）。

## 开始之前

- **macOS 或 Linux。** Superagent 只支持 macOS 与 Linux：它的工单会话和命令依赖 POSIX 工具（`sh`、可执行的 shim、进程组），与原版一致。
  在 Windows 上它报告设置问题“Superagent 支持 macOS 与 Linux”，不做别的事。
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
| `/srv/superagent/state/home` | 智能体的 `HOME`：它的 `.gitconfig`，Superagent 每次启动时重写 |
| `/srv/superagent/state/home/.config/gh` | 智能体的 GitHub CLI 登录 |
| `/srv/superagent/state/worker-bin` | 垫片：`gh` 运行智能体的 GitHub CLI，被禁用的命令直接失败 |

不设 `stateDir` 时，Superagent 使用 AGH 数据目录下的 `bundled-apps/<哈希>`，面板的 **Deployment** 页会写出它。
在服务启动前显式设置，下面的单元文件就可以写死。

## 安装与启用

1. 以服务用户、`AGH_HOME=/srv/superagent/agh` 先启动一次 daemon（`agh serve`），按[安装](install.zh-CN.md)配好模型。
2. 打开 **插件 → 市场**，安装 **Superagent**，审阅它申请的权限（模型与会话访问、在本机运行命令），然后启用（见[插件](packages.zh-CN.md)）。
3. 在插件设置页把 `stateDir` 设为 `/srv/superagent/state`。此时 Superagent 会报告一个设置问题，因为智能体的环境还没就绪，这是正常的。
4. 用智能体自己的配置目录登录智能体账号，绝不要用你自己的：

   ```sh
   GH_CONFIG_DIR=/srv/superagent/state/home/.config/gh gh auth login
   GH_CONFIG_DIR=/srv/superagent/state/home/.config/gh gh api user --jq .login
   ```

   第二条命令必须打印智能体的登录名。
5. 停掉这个 daemon，按下文以智能体身份作为服务运行。

## 作为服务运行

daemon 启动时必须把 `HOME` 设为智能体 home，并把垫片目录放在 `PATH` 最前面；它运行的会话会继承这两项，所以即使操作者在同一台机器上已登录，
会话的提交、推送和 `gh` 调用也都以智能体账号进行。Superagent 启动时会检查这一点，不满足就报告 `agentHomeMismatch` 或 `agentGhNotShim`。
三个变量都要写全：服务管理器不展开 `~`，也不读你的 shell 配置，而且 `PATH` 仍须能找到 `node`、`git` 和真正的 `gh`。

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
    <key>HOME</key><string>/srv/superagent/state/home</string>
    <key>PATH</key><string>/srv/superagent/state/worker-bin:/opt/homebrew/bin:/usr/bin:/bin</string>
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
Environment=HOME=/srv/superagent/state/home
Environment=PATH=/srv/superagent/state/worker-bin:/usr/local/bin:/usr/bin:/bin
Environment=AGH_HOME=/srv/superagent/agh
ExecStart=/usr/local/bin/agh serve
Restart=on-failure
KillMode=mixed
TimeoutStopSec=60

[Install]
WantedBy=multi-user.target
```

通过服务管理器停止服务（`launchctl bootout`、`systemctl stop`），daemon 会干净地结束各会话的回合。任何时候重启都是安全的，见[重启与恢复](#重启与恢复)。

## 设置与首次使用

打开 AGH 首页上的 **Superagent** 入口，依次保存：来源（仓库与智能体的 GitHub CLI；用飞书时选飞书渠道实例）、策略（谁可以提请求）、
执行设置（工单目录根与 prepare 命令，例如 `git clone "https://github.com/<owner>/<name>.git" repo`）以及团队提示段。
各字段的含义见[设置指南](../../packages/superagent/docs/setup.md)。然后用允许名单里的账号在某个 Issue 下评论 `@<智能体登录名> <请求>`，
大约一分钟内总览里就会出现工单。

## 停用

在 **插件** 里停用插件；如果只想停止接新活而让它继续运行，用面板里的 **暂停处理**。停用会停止轮询和发件，取消 Superagent 所有会话正在跑的回合，
在几秒内停掉它们的后台作业，并把正在跑的派工记为暂停。会话、工单目录和状态目录都保留。再次启用时按每个会话的真实状态对账：
仍在跑的不动，被打断的派工带恢复说明重新派一次，在会话队列里等着的消息运行一次。

在 Superagent 这套 AGH 里安装、更新、启用或停用任何其他插件，也会让 Superagent 以同样方式重启：先按上文停下，再立即启动。
见[重启与恢复](#重启与恢复)。

## 清除数据

清除数据只能由主人显式操作，停用从不清除。要全部删掉：

1. 停用插件，再在 **插件** 里卸载它。
2. 删除状态目录（`/srv/superagent/state`，或面板写出的 `bundled-apps/<哈希>` 目录）。这会删掉数据库、每个工单目录（包括尚未推送的分支）
   以及智能体的 GitHub 登录。
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

- 会话能用绝对路径读取操作者的家目录，包括操作者日常 AGH home 里的密钥与 socket。单独的 `HOME` 改变的是身份，不是会话能碰到的范围；
  受保护的 `~/.ssh` 是智能体 home 下的那个，操作者真正的 `~/.ssh` 不在保护列表里。
- 在 Superagent 这套 AGH 里，完全访问会解除对数据目录的软禁止：`tables`、`audit` 与 `sessions.db` 可读可写；只有数据目录下的 `secrets`
  和私有状态根仍然禁止。Superagent 自己的 SQLite 数据库也能被它的会话读写。
- 在同一个系统用户下，会话很可能能自行连上 daemon 的本地 socket，以主人的权限行事：本地认证只看 socket 归谁所有。
  所以“不把主人级客户端交给会话”不是安全边界。

以上各点只有用专用系统用户运行这套 AGH 才能解决；强烈推荐这样做，但不强制。

## 重启与恢复

- **daemon 重启。** 正在跑的回合以中止结束，其作业随 daemon 停止。启动时 Superagent 先写入并检查智能体环境，再按每个会话的真实状态对账：
  仍在跑的回合不动；被打断的派工带恢复说明重新派一次；会话队列里最早的一条等待消息被启动，因为重启后不会有别的东西让它续跑。
- **这套 AGH 里的插件变更。** 在 Superagent 的 AGH home 里安装、更新、启用或停用任何插件（不只是 Superagent 自己），都会让 Superagent
  重启。所有正在跑的工单都会被打断：回合被取消、作业被停，正在进行的 `git push` 或测试运行会中断。Superagent 恢复后，被打断的工单像
  daemon 重启后一样继续：每个被打断的派工带恢复说明重新派一次。请在概览显示没有工单在跑时再改这套 home 里的插件。
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
| `The daemon runs with HOME …, not the agent home …` | 以 `HOME` 为 `<stateDir>/home` 启动 daemon（单元里的 `HOME`） |
| `Sessions run gh from …, not the shim in …` | 把 `<stateDir>/worker-bin` 放在单元 `PATH` 的最前面 |
| `git would ask other credential helpers than the agent's for github.com` | 从系统 git 配置里去掉列出的凭据助手，或换一个没有它们的用户运行 |
| `gh acts as @…, not the agent account @…` | 用智能体的 `GH_CONFIG_DIR` 重新登录，见第 4 步 |
| `The agent GitHub CLI was not found.` | 让单元 `PATH` 能找到 `gh`，或在 GitHub 来源里写绝对路径 |
| 某个文件 `… was not written by Superagent` | 把它移出 `<stateDir>/worker-bin` 或 `<stateDir>/home`，或换一个状态目录 |
| `A session superagent:… exists that Superagent did not open` | 归档或删除这个不属于 Superagent 的会话，再点 **Check again** |
| 工单失败并带有 prepare 命令的输出 | 在执行设置里修好命令，再重试工单 |
| `deliveries` 健康项点名某个工单 | 重新派工时一直无法确认会话是否收到某条消息；确认 daemon 有应答，再重试工单 |
| @ 之后没有反应 | 检查发起人在允许名单里、来源已开启、处理没有暂停 |
