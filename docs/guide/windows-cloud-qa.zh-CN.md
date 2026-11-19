# AGH Windows 云端测试文档

更新日期：2026-11-19。项目仓库：[AgnesAI-Labs/agnes-harness](https://github.com/AgnesAI-Labs/agnes-harness)，测试分支 `feat/agh-cloud`。主项目为公共仓库；B 的独立插件由部署方提供，须使用配套 0.9.0。此前完整 ZIP 不包含本次底座同步，同事测试以本分支最新源码为准。

## 本轮范围

本轮以远端云端分支 `654f325` 为基础，合入最新底座 `develop` 的 `9fbd0ba7f`，保留侧栏本地／云端 Tab、按 Key 自动发现连接、本浏览器云端凭据引用展示、上下文容量修复，以及 Core 派发证据和恢复修复。此前完整测试包的版本另见包内 `qa-build.json`，不能代替当前源码版本。

源码启动的是测试同事电脑上的 A 端，不会替换已部署的 B 端沙箱、修改现有安装或自动迁移其他版本的数据。新计费规则涉及 B 的 Core 与插件，B 是否已更新必须另行核对，不能仅凭本机界面更新判定云端新计费已验收。

当前配套插件为 `0.9.0`，整合李卓呈 `main` 的 `1dc5e21`，保留本测试项目的 Core 恢复修复、自动地址、凭据使用方和模型容量展示。按 2026-11-19 确认，插件只统计可信新旁路或可信异步确认，不再使用旧 `tool/result.dispatchPhase`；投影版本为 4，历史成功回执仍保留幂等身份。Core 与插件须配套验证，不以旧账本无新旁路记录推断漏计。

本次不部署现有 B、不开放 Key 重置，也不启用真实 `cloud-key` 文件下发；Core 私有路径清单尚未覆盖该文件，启用文件下发前需另行补齐隔离保护。LLMSG 镜像入口的既有目录权限修复仍以 [`integrations/llmsg/entrypoint-permissions.patch`](../../integrations/llmsg/entrypoint-permissions.patch) 交付，适用 LLMSG 基线 `bf11b45b653a5bab96ff632cd1a3bb5013065a78`；该补丁只收紧已核实的运行数据根目录权限，不递归改 CFS 或用户文件。它属于 LLMSG 构建入口，不会由本机启动脚本自动应用，也未部署到现有 B。

## 从源码启动（同事测试用）

让本机小助手拉取 `AgnesAI-Labs/agnes-harness` 的 `feat/agh-cloud` 最新提交。按照仓库 `AGENTS.md` 与[安装文档](install.zh-CN.md)准备 Node 24.20.0、pnpm 10.34.5、Node 配套头文件与 Windows C++ 构建环境，然后在仓库根目录执行：

```powershell
$qaCommit = (git rev-parse --short=12 HEAD).Trim()
if ($LASTEXITCODE -ne 0) { throw '请先进入仓库根目录。' }
$env:AGH_HOME = Join-Path $env:LOCALAPPDATA ('AgnesHarnessQA\source-' + $qaCommit)
$env:AGNES_HOME = $null
$env:AGH_LLMSG_API_BASE_URL = 'https://api-llmsg-dev.agnes-dev.com'
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\start-local-windows.ps1
```

该脚本复用本地源码的构建与启动流程，完成后打开它打印的完整地址，默认端口 `4180`。同一源码提交使用独立的测试 home；换提交不自动迁移已有数据。此脚本不负责拉取 Git，也不需要此前的 ZIP。缺少环境时由小助手按安装文档准备，不要直接运行仅供完整测试包使用的 `start-windows-qa.ps1`。

## 已有完整测试包的启动方式

1. 将负责人提供的 Windows x64 测试 ZIP 完整解压到一个新目录。不要在 ZIP 内直接运行，也不要覆盖已有版本。
2. 双击包内 `start-windows-qa.cmd`；或在该目录的 PowerShell 执行下面的命令。无需安装 Node、pnpm 或 C++ 编译工具，包内已带匹配的 Node 运行时。

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\start-windows-qa.ps1
```

3. 看到服务就绪后，打开 [本机测试页面](http://127.0.0.1:4188/)。保持终端运行。端口被占用时脚本会拒绝结束其他进程；可先确认自己的旧测试窗口，或使用 `-Port 4198` 启动到新端口。
4. 同一包再次启动沿用该版本的独立数据；不同提交使用新的 `%LOCALAPPDATA%\AgnesHarnessQA\<提交前12位>`，不复用其他版本的 home。脚本不会自动结束已有 daemon。

只检查包完整性、不启动应用：

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\start-windows-qa.ps1 -CheckOnly
```

日志在该版本独立数据目录的 `logs` 下。报告问题时提供包内提交号、发生时间、模型、操作与错误；Key 和临时通行证不要贴入公共问题单或提交到仓库。

## 连接开发沙箱

环境为本机 A → `https://api-llmsg-dev.agnes-dev.com` → 测试沙箱 B。测试 Key 由负责人单独提供，脚本与仓库不内置 Key；本期 Key 重置仍不开放。

1. 在“设置 → 权限 → 凭据”新建通用 API Key 凭据，名称可填 `agh-qa`，值填负责人提供的完整 `agh_sk_...`。
2. 在“设置 → 高级 → 云端连接”刷新凭据列表，选择 `agh-qa`，点击“保存并连接”。地址和业务 Token 由后端自动获取，页面不展示沙箱地址或手动填写入口。连接成功后只需查看连接状态。
3. 侧栏切到“云端”，新建云端会话，选择测试环境确认可用的模型。当前联调优先使用 `agnes-2-5-flash`；`agnes-1.5-flash` 曾被上游拒绝，渠道配置修正前不将它作为通过标准。
4. Key 属于既有开发手测账号，会看到该账号已有的云端测试会话。不要删除他人测试记录，也不要用这个账号保存个人或客户数据。云端实例仍按现有规则计时扣费，停止 A 不代表关闭 B。

## 验收操作

- 在本地和云端 Tab 间切换，检查会话列表、搜索、新建会话与草稿分别归属正确的环境。
- 首次连接就绪后，新建云端会话并输入草稿，检查不需要再次新建或刷新页面。若输入框持续灰色，记录时间、连接状态和恢复操作；目前正常连接与首次新建的实际检查可输入，尚未复现用户报告的持续灰色情况，不将其列为已修复。
- 保存云端连接后，凭据列表应显示“此浏览器的云端连接”使用方；断开连接后回读展示。这个标记描述浏览器配置引用，不代表立即吊销已签发的临时通行证。
- 检查云端会话的上下文窗口设置可用。当前云端适配器没有思考强度能力时应显示不支持，不强行选择 `high`。
- 发送“只回复 OK”，再对自己新建的测试文件发起一次明确的 `read`。记录真实模型请求 ID，核对云端工具记录、LLMSG 明细与汇总；不要凭助手声称成功判定入账。
- B 升级配套 Core 与 0.9.0 插件后，再检查可信新旁路计数、旧结果字段不参与计数、失败重试和重启补报。保持既有插件 ID、队列及成功回执，不换 ID 绕过去重。缺少可信派发证据不根据错误文案猜次数。

`cache_read_tokens` 展示由 LLMSG 另一项修改处理，不包含在本机启动包范围内。模型能力元数据、失效上游渠道和已部署 B 的权限状态，以实际配置和版本为准。

## 本次验证与限制

2026-11-19，本轮候选源码在 Windows、Node `v24.20.0`、pnpm `10.34.5` 下完成以下验证：

- 类型检查、lint、生成检查通过；lint 仍有仓库既有警告。guards 为 601 项通过、1 项既有跳过。
- 云端入口、输入区、模型选择、协议、派发恢复、Worker 和底座迁移等相关回归为 8604 项通过、2 项失败、1 项跳过。配套 0.9.0 插件的 21 项检查全部通过。
- 完整 Windows 本地构建通过，构建产物的 `--help` 入口退出码为 0。本轮未启动用户桌面应用，未在共享 B 部署或执行真实入账验收。

两项相关回归失败均在未修改基线 `33db835` 上复现：`worker-runtime/test/oauth-bootstrap.test.ts` 的凭据目录写入报 `CREDENTIAL_STORE_UNSAFE: io`；`worker-runtime/test/hosted-sessions-outward.e2e.test.ts` 的普通会话 push 用例实际返回成功，但断言预期失败。保持原断言，没有跳过或放宽这些检查。

整仓 fast 长测观察到 `host/test/replay.test.ts` 的 `0102-declared-credit-rate` 失败：实际 18000 与严格小于 18000 的断言冲突，此前也在未修改基线复现。按本轮提测约定中止整仓长测，完成上述相关验证后交付；不能据此声称整仓全部通过。

额外文档校验的 62 个源码锚点与本地链接检查未发现问题；仍有本 Windows 中文指南缺少英文对应页和语言切换的两项既有规则错误。本次保持中文交接，不新增英译，也不修改校验规则。

首次云端新会话输入框持续灰色的问题尚未复现，不能列为已修复。此前完整 ZIP 的验证结果只适用于包内 `qa-build.json` 指定的历史版本，不能代替本轮源码结果。

## 从源码构建

按[源码安装文档](install.zh-CN.md)准备仓库固定的 Node 24.20.0、pnpm 10.34.5、对应 Node 头文件和 Windows C++ 构建工具。依赖安装与构建都使用标准 `tools/toolchain/run.mjs`，不更换用户全局运行时。工作区必须干净，输出目录必须是新目录。

```powershell
.\tools\build-windows-qa.ps1 `
  -NodeExe 'C:\Program Files\nodejs\node.exe' `
  -NodeLicense 'C:\Program Files\nodejs\LICENSE' `
  -OutputDirectory 'D:\AghQA\new-build'
```

上述路径是可替换示例，不依赖作者电脑。完成后把整个输出目录压缩交给测试，Key 另行发送。源码提交、完整构建、本机启动、真实云端入账和生产验收分别核实；本仓库同步不等于部署。
