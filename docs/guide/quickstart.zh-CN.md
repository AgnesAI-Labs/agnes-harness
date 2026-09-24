# 快速开始：跑通你的第一个任务

[English](quickstart.md) | 简体中文

[文档导航](../README.zh-CN.md) · 前提：[已完成构建](install.zh-CN.md)

完成这一页后，你将配置一个模型、运行一个小任务，并从 CLI 找到 Web 中创建的会话。前提是已完成[源码构建](install.zh-CN.md)，建议首次试用采用其中的独立 home。没有模型账号时，可以先体验[本地模拟模型演示](demo.zh-CN.md#不配置模型账号先跑通本地链路)。

## 第一次打开 Web

```sh
node packages/cli/dist/local/agnes.mjs serve
```

默认地址为 `http://127.0.0.1:4177`，以终端实际输出为准。当前本地模式直接打开普通 URL，不需要从地址栏复制连接 token，也不需要把 daemon 凭据粘贴进页面。

没有可用模型时会进入 Provider 设置。选择账号/Provider，核对 Base URL，在密码输入框输入 API key，执行“测试连接”，选择返回目录中的模型，再保存。页面只显示已配置状态，不会读回已保存的明文密钥。测试连接和后续对话可能访问提供方并产生费用；无模型账号时请用[本地演示](demo.zh-CN.md)。

你可以使用 Agnes AI，也可以选择 Kimi、Kimi Coding Plan、GLM、Qwen、DeepSeek、OpenAI、Anthropic、Google、OpenRouter、MiniMax 或 xAI。Web 将 Agnes AI 优先展示；实际模型、路由及能力来自当前目录与账号配置，不能用品牌名称推定工具、视觉或思考能力。自定义端点也应走配置服务的测试和模型选择流程，不用把不兼容端点伪装成某个已知模型。

保存后关注生效提示：`new-sessions` 表示新会话可用，已有会话保留自己的选择；若提示重启，先结束需要保留的任务，使用同一 home/profile 执行 `daemon stop`，再重新 `serve`。连接失败时核对当前 home/profile，确保仍在操作同一个实例。

点击“新建任务”，确认工作目录，然后发送：

> 请只读取当前项目，说明主要目录及用途；不要修改文件或运行安装命令。

这是一条用户意图，执行边界由审批与策略决定。读取[安全说明](security.zh-CN.md)后再授予执行权限。

**如何确认跑通：** 页面出现本轮回答；若模型使用了工具，展开记录检查名称、参数和结果；确认任务进入完成或明确的等待状态。随后回到会话列表，再打开这条任务，核对历史仍可读取。遇到错误时保留错误码，按[排错](troubleshooting.zh-CN.md)继续。

## 第一次运行 CLI

`serve` 会占用当前终端。在新终端运行 CLI 时，进入同一个源码目录；若前面设置了 `AGH_HOME` / `AGNES_PROFILE`，这里也要设置为完全相同的值。不要重新执行 `mktemp` 创建另一个 home，否则 Web 与 CLI 会连接不同实例。未自定义时，两端都使用默认 home/profile。

交互式配置：

```sh
node packages/cli/dist/local/agnes.mjs config
```

配置好后，先在源码仓库根执行下面命令。`AGH_ENTRY` 保存入口绝对路径；以后切换到自己的项目目录，也可以继续用它运行：

```sh
AGH_ENTRY="$PWD/packages/cli/dist/local/agnes.mjs"
node "$AGH_ENTRY" -p "只读概括当前项目"
node "$AGH_ENTRY" sessions --json
node "$AGH_ENTRY"
```

最后一个命令在真实 TTY 启动 TUI；重定向 stdin 或 stdout 时会走 print 模式。`config` 与 Web 使用相同的 Host 配置服务，不要照旧实验脚本把密钥写入另一个产品的 home。

CLI 使用特定模型时，先从 Web 或 TUI `/model` 获取当前 route/model：

```sh
node "$AGH_ENTRY" -p --model main=ROUTE/MODEL "你好"
```

`ROUTE` 是实际路由 ID，可能代表一个账号；不是必然等于 Provider 品牌。不存在的路由或模型会被拒绝。不要添加不存在的 `--api-key` 或旧 `--session` 参数。

## 确认共享与退出

```sh
node "$AGH_ENTRY" daemon status
node "$AGH_ENTRY" sessions --json
```

同 home/profile/dataDir 下，Web 创建的会话应出现在 CLI 列表。关闭 TUI 或浏览器不会结束共享 daemon；停用实验实例时先退出 Web 终端，再执行：

```sh
node "$AGH_ENTRY" daemon stop
```

保留实验 home 可以稍后恢复会话；它可能包含会话正文和用户输入，不应提交仓库。

## 接下来做什么

想让 Agent 采用团队的方法，添加一个[Skill](skills.zh-CN.md)；想接入业务系统，从[插件开发](../develop/plugins.zh-CN.md)开始；想继续已有任务，阅读[会话与恢复](sessions.zh-CN.md)。

实现依据：[配置控制器](../../packages/host/src/configuration.ts)、[Provider 入口](../../packages/cli/src/onboarding/provider-registry.ts)、[Web 模型配置](../../packages/web/src/settings.ts)、[CLI 参数](../../packages/cli/src/args.ts)。
