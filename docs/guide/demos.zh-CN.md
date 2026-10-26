# 产品演示与开发者机制示例

[English](demos.md) | 简体中文

智能体画廊展示三个已随源码提供的旗舰应用：[DevBoard 3.7.2](../../examples/showcase/devboard/README.zh-CN.md)、[制药 GMP](../../examples/showcase/pharma-gmp/README.zh-CN.md)和[航空质量](../../examples/showcase/aerospace-quality/README.zh-CN.md)。DevBoard 是轨道门系统研发与质量工作台，包含项目评审门、追溯、试验、服务质量闭环和研发协调员。三个应用均使用虚构数据。画廊只推广这些旗舰，缺包时不显示占位或教学示例替补；[五个教学示例](../../examples/fde/README.zh-CN.md)仍可主动安装。下面三个脚本演示平台机制。

亲手验证业务 Agent 即插件、热升级保留进行中的工作，以及 Agent 构建可复用能力。每个脚本都在新的临时 `AGH_HOME` 中运行真实 daemon 和 worker，只使用合成数据，无需模型账号或浏览器。

## 从源码运行

需要 Node.js 24.10+、pnpm 10.34.5 和平台对应的原生构建工具（见[安装](install.zh-CN.md)）。在仓库根目录运行：

```sh
mise exec -- node tools/toolchain/run.mjs install --frozen-lockfile
mise exec -- node tools/toolchain/run.mjs --filter @agnes/cli build:local
node examples/demos/business-agent/run.mjs
node examples/demos/hot-upgrade/run.mjs
node examples/demos/growing-skills/run.mjs
```

阅读打印的源码、能力审查和业务草稿，输入 `yes` 批准合成示例中的操作；拒绝会以非零状态结束演示。脚本逐步讲解，检查持久化的后端结果，只有声明成立时才打印 `PASS`。结束时停止自己的 daemon 并删除临时 home 和工作目录。

| 演示 | 可观察证据 |
| --- | --- |
| [业务 Agent 即插件](../../examples/demos/business-agent/README.zh-CN.md) | 安装现有 support-triage bundle；业务会话选择自己的 Loop 和工具，并行的默认 Agent 看不到这些工具。禁用后新会话失去 bundle，旧会话仍使用固定代码完成任务。 |
| [热升级不打断业务](../../examples/demos/hot-upgrade/README.zh-CN.md) | 多步骤工作流停在持久化的审查问题；发布已审查的新包版本，新会话输出 v2 收据。中途重启 daemon 后，旧会话保留 v1、先前工具结果和待回答问题；读取、分类和模拟发送各记录一次。 |
| [Agent 自己长技能](../../examples/demos/growing-skills/README.zh-CN.md) | 默认 Agent 用 `plugin-helper` 写文本统计插件。用户审查源码和通过的测试、发布审阅过的精确候选哈希后，新会话调用真实工具，provenance 显示 `installer=agent`。 |

默认 demo model 做确定性的教学选择，不执行推理。客服操作是**模拟发送**，不会对外发消息。重启演示验证持久化审查边界和已提交工具结果的恢复；它不承诺任意外部副作用在执行中崩溃后恰好发生一次，未知效果仍会阻塞并要求核查。参见[会话](sessions.zh-CN.md)、[包管理](packages.zh-CN.md)、[安全](security.zh-CN.md)与[固定代码、实时资源](../develop/architecture-plugins.zh-CN.md#固定代码动态资源)。

## 可选真实模型

通过 `AGH_DEMO_MODEL` 指定 provider id 与模型，例如 `deepseek/deepseek-flash`，用 shell 的秘密处理方式提供 `AGH_DEMO_API_KEY`。`AGH_DEMO_BASE_URL` 可指定该 provider 支持的端点。脚本通过公开配置 API 把账号保存到临时 home，并为会话显式选择模型，不读取常用 AGH home，不打印凭据。模型推理可能收费，工具选择与生成源码可能变化；不支持或错误的结果仍会触发断言失败。

不要把凭据放进命令参数、提交文件或共享实录。真实模型验收与离线 CI 检查分开。

## 智能体目录浏览器验收

构建本地 CLI 并准备 Playwright Chromium 后，运行重型浏览器验收：

```sh
mise exec -- node tools/toolchain/run.mjs exec vitest run tools/e2e-web/agent-sweep.e2e.test.ts --maxWorkers=1
```

测试枚举所有带 `launch` 的示例 Bundle，通过 Web UI 安装、信任、启用，检查模型、权限、来源包和草稿审阅，确认草稿入框且未发送，再显式提交每个示例提示词。默认使用离线 Demo 模型。测试检查持久化工具结果、完成状态和报告卡片，并通过正常控件回答模拟业务问题及工具授权。

真实推理须显式设置 `AGH_REAL_AGENT_SWEEP=1`，并通过安全的 shell 凭据处理提供 `AGH_DEMO_API_KEY`。测试通过公开配置 API 保存 DeepSeek 账号（`deepseek-flash`）。真实 home 保留在 `~/agh-real-eval/sweep-*`，端口在本机回环随机分配。每个智能体运行限时六分钟；AGH 记录的费用超过 $5 后取消并停止巡检。可用 `AGH_AGENT_FILTER` 按逗号分隔的智能体引用子串做聚焦重跑，用 `AGH_WEB_TEST_OUTPUT` 分开保留每轮报告。JSON 证据和截图属于测试产物，不是源码文件，应按运行证据保护。脚本模型通过不代表真实模型回答质量通过。

## 无界面 smoke

`--check` 明确自动批准本合成演示中的操作和生成模板，替代终端确认。后端和断言相同，无测试重试，不使用 Playwright：

```sh
node examples/demos/business-agent/run.mjs --check
node examples/demos/hot-upgrade/run.mjs --check
node examples/demos/growing-skills/run.mjs --check
mise exec -- node tools/toolchain/run.mjs exec vitest run examples/demos/test/demos.e2e.test.ts --maxWorkers=1
```

测试启动真实进程，文件属于 heavy tier，`pnpm test:heavy` 会包含它。运行测试前须构建本地 CLI。
