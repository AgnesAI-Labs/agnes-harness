# CLI 命令参考

[English](cli.md) | 简体中文

[文档导航](../README.zh-CN.md) · [使用指南](../guide/cli.zh-CN.md)

按“会话运行 → 管理 → 扩展”查找命令。想看连续操作示例，先读[CLI / TUI 指南](../guide/cli.zh-CN.md)。

下表的 `agh` 是阅读简写；源码分发实际执行为 `node packages/cli/dist/local/agnes.mjs`。以下均按源码分发方式使用。

## 会话与运行

| 语法 | 用途/注意 |
| --- | --- |
| `agh [prompt]` | TTY 为 TUI；非 TTY 为 print |
| `agh -p [prompt]` | 一次性任务，读取管道输入 |
| `agh --mode text\|json` | 自动 print；ACP 为单独模式 |
| `agh --model main=ROUTE/MODEL` | 显式槽位与运行目录中的路由/模型 |
| `agh --profile NAME --preset NAME --cwd DIR` | 普通运行选项，不是所有转发子命令均支持 |
| `agh --continue` / `agh --resume ID` | 互斥；恢复最近/指定会话 |
| `agh resume ID [-p prompt]` | 恢复入口 |
| `agh sessions [list --cwd DIR] --json` / `agh sessions show ID` | 列表/详情 |
| `agh export ID --format agnes\|sharegpt\|claude-code [-o FILE]` | 导出；另有 `--html`、`--raw` |
| `agh import FILE --from claude-code\|codex\|pi\|auto [--key KEY]` | 转换导入 |
| `agh --connect TARGET` | 只连接目标，失败不回退 |
| `agh --standalone` / `agh --ephemeral` | 嵌入/临时执行 |
| `agh acp` / `agh --mode acp` | ACP 协议入口 |

Print 的 `--park`、`--chunks`、`--meta` 控制等待和输出；退出码见[CLI 指南](../guide/cli.zh-CN.md)。当前无 `--session` 或命令行明文 API key 开关。

## 控制面

| 语法 | 用途 |
| --- | --- |
| `agh config` | 模型/账号配置交互 |
| `agh daemon start\|status\|stop` | 显式后台生命周期 |
| `agh serve [--home DIR] [--profile NAME] [--cwd DIR] [--port N]` | 本地 Web |
| `agh profile list` / `inspect NAME --resolved` / `trust DEPLOY_DIR` | 配置检查与部署信任 |
| `agh doctor [platform\|provider\|storage\|profile\|extensions\|daemon\|binary\|code-runtime] --json` | 诊断 |
| `agh doctor provider --probe` | 明确发起最小推理，可能计费 |
| `agh doctor subagents [--repair] --json` | 子 agent 检查；repair 会修改状态 |
| `agh consent DISABLED\|LOCAL\|ANON\|FULL` | 保存遥测同意档位；不等于已验证所有外部采集 |
| `agh stats deviation --json` | 偏差统计 |
| `agh conformance gateway --json` | 网关一致性检查入口 |

`daemon/ext/mcp/resources/skills/serve` 将剩余参数交给各自解析器，不可任意混用普通运行参数。`--data-dir` 在普通 parser 中只对 `computer-use rescue` 开放，不作为一般 daemon 选择捷径。

## 包、资源与 Computer Use

包：`package status|list|catalog|inspect|add|trust|enable|disable|rollback|remove|operation|cancel`；`install SOURCE` 是 add 别名；`packages pins inspect|release` 管理保留引用。更新走 Web、TUI `/package update ID SOURCE INTEGRITY` 或 SDK；TUI update 直接提交所指定摘要，先 inspect，不声称它有额外 preview/confirm 向导。

资源：`resources list|get|operation|cancel|enable|disable`；`skills refresh|trust`；`mcp list|get|add|update|remove|test|trust|enable|disable|status|reconnect|tools`。变更操作通常要求 expected revision 与交互确认，详见[Skills](../guide/skills.zh-CN.md)、[MCP](../guide/mcp.zh-CN.md)。

当前源码包含的 Skills 永久删除/优先级动作使用 Web 或 Node SDK；shell/TUI 的 Skills 语法仍是 refresh/trust 等既有命令，不能执行猜测的 `skills remove` 或 `skills priority`。见[Skills 指南](../guide/skills.zh-CN.md)。

Computer Use：`status`、`install [--upgrade]`、`restart`、`operation [ID]`、`cancel ID`、`permissions status|grant`、`rescue status|install|repair`。诊断用 `doctor computer-use [--include CHECK] [--skip CHECK] --json`。有写入/安装/权限副作用的命令不能当作普通只读 doctor 自动运行。

低层 `ext`、`mcp serve` 与 `serve model-api` 是专用接入面，不能替代前述本地工作台命令或被当作已验证公网服务。

权威语法：[args/usage](../../packages/cli/src/args.ts)、[package](../../packages/cli/src/commands/package.ts)、[resources](../../packages/resource-control-cli/src/resources.ts)、[TUI package](../../packages/cli-tui/src/package-controller.ts)。
