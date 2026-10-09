# 排错：找到下一步可以检查的事

[English](troubleshooting.md) | 简体中文

[文档导航](../README.zh-CN.md) · [已知限制](../reference/limitations.zh-CN.md)

先分辨问题发生在构建、连接、模型配置还是插件运行，再选对应的检查。表格中的步骤尽量保留现场，方便定位原因。

先记下当前 commit、Node 版本、命令、错误码与所用 home/profile；不输出整个环境或凭据。下面的诊断默认仍使用你选定的隔离 AGH_HOME。

```sh
node packages/cli/dist/local/agnes.mjs --version
node packages/cli/dist/local/agnes.mjs daemon status
node packages/cli/dist/local/agnes.mjs doctor platform --json
node packages/cli/dist/local/agnes.mjs doctor storage --json
node packages/cli/dist/local/agnes.mjs doctor provider --json
```

`doctor storage` 会建立并清理临时探测数据库；它不修复现有数据。`doctor provider --probe` 则会调用模型，排错时不要无意添加。

| 现象 | 核对与处理 |
| --- | --- |
| Node 太旧/SQLite 模块错误 | 确认 Node >=24.10；默认 shell 与构建使用的 Node 可能不同 |
| 缺少 `dist/local/agnes.mjs` | 在仓库根运行完整 `build:local`；不是 daemon stop 能修复的问题 |
| native helper 缺失/不兼容 | 保留完整分发，按当前 OS/架构/Node 重建；不复制其他平台的单文件 |
| `listen EPERM` | 执行环境禁止 socket/回环监听；测试需允许相应权限，不通过修改产品安全策略绕过 |
| daemon 启动后马上退出 / `E_DAEMON_SOCKET_PATH` | 核对 helper、版本及 home/profile。可用短 `/tmp/agh-*` 实验 home 排除路径因素；当前源码对过长默认 socket 路径有短目录回退，但过长显式路径、目录身份或权限不合格仍会拒绝 |
| 端口占用 | 先确认哪个实验 Web listener 持有它，再结束自己启动的服务或换端口 |
| Origin/Host 不匹配 | 地址与 `AGNES_WEB_ORIGIN` 严格一致，不混用 localhost/127.0.0.1；旧后台不同配置时显式停止对应实例 |
| 页面问 token/文档要求复制 token | 检查是否混用旧 build/旧说明；当前本地 Web 打印普通 URL |
| 缺 Provider / 非法 route/model | 运行 config 或 Web 设置，测试保存后从当前目录选模型；新默认不修改旧会话 |
| `TOOL_ARGS_INVALID` | 按错误中的参数路径补齐符合工具定义的参数再重试。`write` 必须同时传入 `path` 和 `content`；被拒绝的调用不会写文件 |
| 输出以 `max_tokens` / `OUTPUT_LIMIT` 结束 | 模型回复达到输出额度，保留已生成文字、丢弃未完成的工具调用并停止本轮，不自动重试。可要求分步继续，或在 Provider 支持范围内配置 preset 的 `model.max_tokens`；这与输入上下文超限不同 |
| `RATE_LIMIT` / HTTP 429 | 模型服务返回限流错误，稍后重试；若持续出现，检查账号的服务限制或联系 Provider。该错误不能证明输入上下文或输出 token 超限 |
| `CONFIG_CREDENTIAL_REJECTED` / 推理 HTTP 401 或 403 | 已保存的凭据被拒绝。已保存 API Key 的鉴权失败属于永久错误，不会自动重试或退避。点击**修复模型账户**进入对应账户，更正凭据或重新授权，测试并保存后，在同一会话发起新一轮即可，无需重启 daemon |
| 读取文件后显示通用后台错误 | 保留诊断编号并匹配 daemon 审计记录。仅凭通用提示不能判定是 token 超限 |
| `SANDBOX_UNAVAILABLE` | Linux 检查 bwrap 的真实执行及 user namespace，macOS 检查系统沙箱可用性；不可用时保留拒绝 |
| 插件安装成功却没有工具 | 看 trusted、desired、actual、行错误、依赖和 manifest；单独旧 `agnes.extensions` 不是现行普通后端插件入口 |
| 前端 v2、后端仍旧或 unavailable | 核对同包 anchor、web row、services ceiling/allow-list、当前会话与 runtime revision |
| package/resource 操作超时 | 用返回的 operation ID 查询；超时不代表已取消 |
| Skill 找不到或被 shadow | 看来源根、会话工作区、修订、trust/desired/actual、winner/stale；刷新相应根 |
| 找不到 Skills 删除或优先级操作 | 使用 Web 管理页或 Node SDK；shell/TUI 没有对应命令。若管理页也缺少入口，核对前端与后台是否来自同一份完整构建 |
| Skill 优先级已保存却不可用 | 检查 winner 的自身 trust/desired；数值改变不授予权限，保存冲突需刷新 revision 与 expectedPriority |
| Skill 删除失败/不能重新启用 | 检查 operation 与 SKILL_REMOVAL_PENDING；可能已有部分文件删除，排除占用后显式重试，不能靠重启/刷新当作撤销 |
| MCP 目录为空或不能调用 | 检查定义 revision、信任、期望启用、连接状态、tool allow-list 与可执行程序策略；当前逐服务器会话路径跳过 OAuth 绑定，管理面测试成功不能证明会话可调用 |
| 工具报 E_LEASE_EXPIRED | 检查当前行是否已卸载、撤权或被新版本替换，并核对运行产物版本；旧版本曾有默认 24 小时到期问题，详见[支持范围](../reference/limitations.zh-CN.md)。保留会话与错误，按实际状态重新加载 |
| 浏览器断线/停止后仍运行 | 关闭客户端与取消/停止后台不同；根据后台历史确认最终状态 |
| 导入失败 | 保留输入和错误，用脱敏最小夹具复现；不要直接改数据库 |

macOS daemon identity 使用内核 boot-session UUID、PID 和进程保存的启动时间；calendar clock 校时不会改变该 identity。旧 owner/discovery 记录仍可读取。旧 identity 精确匹配时，系统写入私有、绑定 boot 的迁移证明，不改写仍在运行的旧 daemon 的记录。完成验证后，status 和 stop 可跨校时继续工作。若旧记录在首次验证前已经漂移，则无法确认所属 boot：status 保守报告 running，discovery/stop 拒绝 unknown identity。不使用 PID-only 匹配、时间容差或锁绕过。

子进程能写入私有启动诊断时，本地 launcher 会在 early-exit 错误中附上真实拒绝原因，例如 `daemon or package mutation lock is held`。启动成功或失败后均清理诊断文件。

`E_SEAM_INIT` 会话初始化失败返回 `INTERNAL_ERROR`，其 `data.code` 为稳定的 `E_SEAM_INIT`；若 Provider 注册或初始化失败，则保留具体的 `E_PROVIDER_*` 原因码。daemon 审计记录该码，不记录异常消息或请求参数。缺少 loop 时，检查其精确 id/version 是否已安装、启用，并被会话 bundle 选中。

意外 daemon 错误可能附 `diagnosticId`；用它匹配所选 dataDir 下 `audit/daemon.jsonl` 的记录。审计写入失败时可能返回 `diagnosticUnavailable`，不能因此声称不存在错误。记录应只含安全的 method/code/时间等，分享前仍检查私有上下文。

布局不受支持时，请通过 AGH_HOME 选择新的私有空目录。已有文件不会被修改。

<a id="linux-diagnostics"></a>

## Linux 诊断

`doctor` 区分 bubblewrap 是否安装与 L1 完整边界是否验证，并报告 Landlock ABI（零表示不可用或已禁用，`unknown` 表示无法确认）。Landlock 可用本身不赋予隔离能力。应检查实际 sandbox 拒绝原因，不能仅凭 `bwrap --version` 判断可用。受限制的容器若不能建立完整边界，拒绝命令是预期行为；明确选择 full-access 时仍无操作系统隔离。

Linux daemon 身份绑定 `/proc/sys/kernel/random/boot_id`、PID 与 `/proc/<pid>/stat` 启动 tick，日历时钟调整不影响身份，PID 复用或重启会改变身份。不可读或格式异常的记录保持 unknown。僵尸或死亡任务保留 PID，但不能运行 daemon，因此报告为 dead。不得仅匹配 PID 或删除锁来修复 unknown 身份。

缺少原生 helper 时，使用匹配 Node 的头文件与 C 工具链重建。浏览器启动失败时，在 gate 之前运行 `playwright install --with-deps chromium` 准备依赖，不要在测试中下载浏览器。当前 Computer Use 会拒绝 Linux 平台准入；仅安装桌面不能建立驱动证据，不应注入虚假的桌面能力。

## 首次运行检查

详见[首次运行指南](getting-started.zh-CN.md)：`agh home info` 只读检查唯一支持的布局；`agh doctor --json` 不连接模型，`--probe` 才主动测试。
