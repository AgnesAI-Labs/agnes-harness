# AGH Windows 云端测试文档

更新日期：2026-11-18。项目仓库：[Ysweater/agnes-harness](https://github.com/Ysweater/agnes-harness)，测试分支 `codex/sa-windows-qa-20261118`；插件仓库：[Ysweater/agh-cloud-plugin](https://github.com/Ysweater/agh-cloud-plugin)。两个仓库均为个人私有仓库，源码访问需要负责人授权。测试包可由负责人直接转交，不要求测试同事取得 GitHub 权限。

## 本轮范围

整合李卓呈的侧栏本地／云端 Tab、已有的按 Key 自动发现连接、本浏览器云端凭据引用展示、上下文容量修复，以及 Core 和 cloud 插件计费旁路兼容。上游云端分支核对提交 `13172696857611bae773567d5fa0184af1c9effd`；原本地测试基线 `33db835e91677726ad77079cfaa5b735f0b0d6c8`。实际测试包的完整源码提交与文件校验值记录在包内 `qa-build.json`。

本包启动的是测试同事电脑上的 A 端，不会替换已部署的 B 端沙箱、修改现有安装或自动迁移其他版本的数据。新计费兼容涉及 B 的 Core 与插件，B 是否已更新必须另行核对，不能仅凭本机界面更新判定云端新计费已验收。

配套插件为 `0.7.1-sideband.20261118.1`，包含最终的事件声明、同 lane 结果校验与端点能力筛选。LLMSG 镜像入口的既有目录权限修复以 [`integrations/llmsg/entrypoint-permissions.patch`](../../integrations/llmsg/entrypoint-permissions.patch) 交付，适用 LLMSG 基线 `bf11b45b653a5bab96ff632cd1a3bb5013065a78`；该补丁只收紧已核实的运行数据根目录权限，不递归改 CFS 或用户文件。它属于 LLMSG 构建入口，不会由本机启动脚本自动应用，也未部署到现有 B。

## 从源码启动（同事测试用）

接受仓库邀请后，让本机小助手拉取 `Ysweater/agnes-harness` 的 `codex/sa-windows-qa-20261118` 最新提交。按照仓库 `AGENTS.md` 与[安装文档](install.zh-CN.md)准备 Node 24.20.0、pnpm 10.34.5、Node 配套头文件与 Windows C++ 构建环境，然后在仓库根目录执行：

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
- B 升级兼容计费版本后，再检查新旧记录、失败重试和重启补报。必须先换兼容新旧记录的插件，再换 Core，或在同一新镜像内同时交付。缺少可信派发证据不根据错误文案猜次数。

`cache_read_tokens` 展示由 LLMSG 另一项修改处理，不包含在本机启动包范围内。模型能力元数据、失效上游渠道和已部署 B 的权限状态，以实际配置和版本为准。

## 本次验证与限制

整合基线 `0ce7651` 的 Core、账本及相关界面回归为 3969 项通过、1 项既有性能基准跳过；类型检查、lint、生成检查通过，guards 为 601 项通过、1 项既有跳过。Windows PowerShell 5.1 的启动包保护检查 7 项通过。该基线的完整 Windows 构建及隔离页面启动已验证返回 HTTP 200；测试 Key 的自动发现、鉴权和 WebSocket 连接实测通过。

后续源码移除了手动地址入口，继续复用原有按 Key 自动发现接口；连接界面、会话打开、草稿输入及页面路由相关的 47 项回归、类型检查与改动文件 lint 通过。此前的 ZIP 仍是上述整合基线，不包含这次界面调整；源码测试请拉取约定分支的最新提交。

额外整仓检查因范围过大已主动中止，不能据此声称整仓全部通过。检查期间 `host/test/replay.test.ts` 的 `0102-declared-credit-rate` 失败已在未修改基线复现；另外观察到 daemon 启动验证、工作区根冲突与 CLI 工作区显示用例失败，尚未归因，不列为本次功能验收通过，也未修改或放宽其断言。当前交付供隔离联调，不代表生产验收通过。

## 从源码构建

按[源码安装文档](install.zh-CN.md)准备仓库固定的 Node 24.20.0、pnpm 10.34.5、对应 Node 头文件和 Windows C++ 构建工具。依赖安装与构建都使用标准 `tools/toolchain/run.mjs`，不更换用户全局运行时。工作区必须干净，输出目录必须是新目录。

```powershell
.\tools\build-windows-qa.ps1 `
  -NodeExe 'C:\Program Files\nodejs\node.exe' `
  -NodeLicense 'C:\Program Files\nodejs\LICENSE' `
  -OutputDirectory 'D:\AghQA\new-build'
```

上述路径是可替换示例，不依赖作者电脑。完成后把整个输出目录压缩交给测试，Key 另行发送。源码提交、完整构建、本机启动、真实云端入账和生产验收分别核实；本仓库同步不等于部署。
