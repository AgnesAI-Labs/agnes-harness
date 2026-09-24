# CLI 与 TUI

[文档导航](../README.md) · [完整命令参考](../reference/cli.md)

CLI 适合把 AGH 接到日常终端和脚本中；TUI 适合持续对话、检查上下文和处理审批。先用一次性任务获得结果，再按需使用交互式会话。

以下以仓库根为工作目录；从其他目录使用构建入口的绝对路径。命令首个位置应是子命令，之后才是该子命令支持的选项。

## 一次性输出

```sh
node packages/cli/dist/local/agnes.mjs -p "解释当前项目"
printf '%s\n' '请总结这段文本' | node packages/cli/dist/local/agnes.mjs -p
node packages/cli/dist/local/agnes.mjs --mode json --chunks --meta "解释当前项目"
```

`--mode json` 自动选择 print 模式；JSON 输出适合程序消费，stderr 仍可能含运行时警告。检查进程退出码，不能把收到部分文本当成功。`--park` 支持让一次性调用在等待审批时停驻；不带可用审批交互的脚本不能自行批准危险操作。

默认连接或启动本地共享 daemon。`--connect TARGET` 是显式连接，失败不回退；`--standalone` 为嵌入式，`--ephemeral` 为显式临时执行。ACP 入口为 `acp` 或 `--mode acp`，不能推定其生命周期与普通共享 daemon 模式一致。

## 交互式终端

```sh
node packages/cli/dist/local/agnes.mjs
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

TUI `/package` 与 shell `package` 的子命令集合不完全相同，例如更新可以从 TUI/Web 发起，shell `package update` 当前没有实现。以[生命周期指南](packages.md)为准。

审批卡显示后检查工具、参数和授权范围，再选当前提供的 allow/deny/abort 等选项。`/yolo` 会让当前会话剩余部分跳过审批，开启后不能在该会话撤销；不作为新手默认路径，且它不等于解除沙箱和其他权限约束。

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
