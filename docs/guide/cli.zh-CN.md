# CLI 与 TUI

[English](cli.md) | 简体中文

[文档导航](../README.zh-CN.md) · [完整命令参考](../reference/cli.zh-CN.md)

CLI 适合把 AGH 接到日常终端和脚本中；TUI 适合持续对话、检查上下文和处理审批。先用一次性任务获得结果，再按需使用交互式会话。

以下以仓库根为工作目录；从其他目录使用构建入口的绝对路径。命令首个位置应是子命令，之后才是该子命令支持的选项。

## 一次性输出

```sh
node agnes.mjs -p "解释当前项目"
printf '%s\n' '请总结这段文本' | node agnes.mjs -p
node agnes.mjs --mode json --chunks --meta "解释当前项目"
```

`--mode json` 自动选择 print 模式；JSON 输出适合程序消费，stderr 仍可能含运行时警告。检查进程退出码，不能把收到部分文本当成功。`--park` 支持让一次性调用在等待审批时停驻；不带可用审批交互的脚本不能自行批准危险操作。

默认连接或启动本地共享 daemon。`--connect TARGET` 是显式连接，失败不回退；`--standalone` 为嵌入式，`--ephemeral` 为显式临时执行。ACP 入口为 `acp` 或 `--mode acp`，不能推定其生命周期与普通共享 daemon 模式一致。

普通自动连接会在核对规范化的 home/profile/数据路径、进程身份、私有 socket 权限、协议与 CLI 版本，并完成认证就绪检查后复用现有 daemon；连接前不再准备本地插件快照或重复校验安装包。RPC 授权及执行前的代码校验仍由 daemon 负责。没有就绪 daemon 或其状态异常时，仍执行完整启动准备；版本不一致时需停止 daemon，再用当前 CLI 重启。Doctor、恢复、嵌入式执行与 Web 启动入口保留各自的准备路径。

## 交互式终端

```sh
node agnes.mjs
```

输入 `/` 可查看当前菜单。常用操作：

| 操作 | 用法 |
| --- | --- |
| 新任务/选择历史 | `/new`、`/sessions`、`/resume [id]` |
| 模型/预设 | `/model`、`/model main ROUTE/MODEL`、`/preset NAME` |
| 上下文/用量 | `/context`、`/usage`、`/cost` |
| 压缩 | `/compact [instructions]`，结果可能是执行、跳过或失败，按回执判断 |
| 分叉 | `/rewind SEQ`，创建新会话，不是文件系统回滚 |
| 插件 | `/packages`、`/install SOURCE`、`/package ...` |
| 资源 | `/skills`、`/skill refresh ...`、`/mcp ...` |
| 显示/退出 | `/theme [light\|dark\|mono]`、`/help`、`/quit` |

TUI `/package` 与 shell `package` 的子命令集合不完全相同，例如更新可以从 TUI/Web 发起，shell `package update` 当前没有实现。以[生命周期指南](packages.zh-CN.md)为准。

审批卡显示后检查工具、参数和授权范围，再选当前提供的 allow/deny/abort 等选项。`/yolo` 为当前会话启用完全权限：跳过工具审批，允许读写工作区内外的文件。策略中的明确禁令、操作系统权限和已配置的命令沙箱限制仍然有效。新会话会沿用已保存的权限选择。TUI 当前没有关闭完全权限的命令。

TUI 与 Web 中的 `/plan`、`/plan on`、`/plan off` 和 `/plan <说明>` 都调用所选的后端计划服务。`/plan status` 查看模式，`/plan pending` 查看上次提交的计划。后端被禁用或不可用时，界面显示计划模式关闭。现有 `.agh/plan-mode.json` 文件可直接读取，无需迁移。计划模式即使在完全访问权限下也会阻止写入和执行工具；`exit_plan_mode` 仍须获得绑定当前计划版本的人工批准。用户显式输入 `/plan off` 仍可直接关闭。

## 退出码

| 码 | 意义 |
| --- | --- |
| 0 | 完成 |
| 1 | 执行失败或未知错误 |
| 2 | 参数或启动错误 |
| 3 | 已停驻等待 |
| 4 | 预算/阻断 |
| 5 | 到达最大步数 |
| 130 / 143 / 129 | SIGINT / SIGTERM / SIGHUP |

实现依据：[参数与 usage](../../packages/cli/src/args.ts)、[退出码](../../packages/cli/src/errors.ts)、[TUI 命令](../../packages/cli-tui/src/commands.ts)。


在 TUI 中使用 `/attach <path>` 分块上传原件，并将回执作为 prompt 提交。路径可含空格。失败保留后端附件原因；回执属于当前会话，上传完成前切换会话会拒绝提交。
