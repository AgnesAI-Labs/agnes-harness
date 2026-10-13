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

`doctor platform` 会在每个低于 `full` 的能力下方输出 `<能力>.reason=…`。`sandbox.l1=unavailable` 且原因为 `awaiting sandbox backend full-boundary probe`，表示沙箱后端尚未探测（doctor 不会启动后端），并非平台不支持命令沙箱；`no runnable OS sandbox backend passed its full-boundary probe` 才是探测失败。`doctor storage` 会建立并清理临时探测数据库；它不修复现有数据。`doctor provider --probe` 则会调用模型，排错时不要无意添加。

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
| Windows 上 `SECRET_UNRESOLVED` 且 `reason` 为 `private-file` | 密钥存储被拒绝，不是缺失；使用该存储的所有路由都会受影响，无论消息里点名的是哪个 ref。`part` 指出被拒的是 `store`、其 `namespace` 目录还是 `file`，`check` 指出目录没通过哪项检查：`not-private` 表示属主、访问列表或继承设置不满足私有要求。在私有目录里新建的子目录会继承其访问列表，但在关闭继承之前并不是私有的：执行 `icacls <目录> /inheritance:r`，再授予当前用户和 `SYSTEM` |
| 缺 Provider / 非法 route/model | 运行 config 或 Web 设置，测试保存后从当前目录选模型；新默认不修改旧会话 |
| `TOOL_ARGS_INVALID` | 按错误中的参数路径补齐符合工具定义的参数再重试。`write` 必须同时传入 `path` 和 `content`；被拒绝的调用不会写文件 |
| 输出以 `max_tokens` / `OUTPUT_LIMIT` 结束 | 模型回复达到输出额度，保留已生成文字、丢弃未完成的工具调用并停止本轮，不自动重试。可要求分步继续，或在 Provider 支持范围内配置 preset 的 `model.max_tokens`；这与输入上下文超限不同 |
| `RATE_LIMIT` / HTTP 429 | 模型服务返回限流错误，稍后重试；若持续出现，检查账号的服务限制或联系 Provider。该错误不能证明输入上下文或输出 token 超限 |
| 模型服务返回 `TRANSPORT` / `TIMEOUT` | 消息会写明出错的环节、所处阶段和错误码，例如 `the connection to the model provider was reset while waiting for the first byte (ECONNRESET)`（等待首字节时连接被重置），或 `the connection to the model provider timed out while connecting (connect timeout, UND_ERR_CONNECT_TIMEOUT)`（建立连接超时）；本地时限会写明是哪个计时器，如 `(first-token timeout, 120s)`。连接重置、连接被拒、DNS 失败、流式中途断开和超时会在本轮失败前自动重试，`after N attempts` 表示所报告的错误背后共发出几次请求，此前每次被重试的失败都会在会话日志中留下一条 `x/core/inference-retry` 记录。请检查网络、代理或 VPN。`CERT_HAS_EXPIRED` 等证书或 TLS 错误不会重试，通常说明有代理在拦截 TLS。Provider 返回的错误原文不会显示；只有 `status=?` 而没有错误码时，表示无法识别失败原因 |
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
| 打开旧会话一直停在"正在准备会话" / `LOAD_STALLED` | 很大的会话可能要几分钟才能打开；状态栏会显示进度，10 秒后会只读显示存储中的历史（见[打开很大的旧会话](sessions.zh-CN.md#打开很大的旧会话)）。`LOAD_STALLED` 表示后台 30 秒没有任何消息；后台仍会继续打开会话，重试会接上正在进行的打开。先查看 `daemon status`，再看 `audit/runtime.jsonl` 里的 `session.open` 与 `session.load` 记录。只读历史未经校验；不要为了绕过慢打开去复制或编辑数据库 |
| `E_LEDGER_INTEGRITY` / 会话历史核对失败 | 存储中的历史与它的哈希链不再相符：有记录被改动，或序号中断。后台拒绝针对该会话的所有请求（包括导出），也不会自行重新打开它（见[历史完整性校验](sessions.zh-CN.md#历史完整性校验)）。先保留证据：停止后台并复制 dataDir。然后再打开一次该会话。这次打开会从第一条记录核对全部历史，所以历史本身完好（只是"核对到哪里"的记录有误）的会话能重新打开，确实被改动的历史会再次被拒绝。这种情况下，用实例停止期间做的备份恢复 `sessions.db`。编辑数据库修复不了哈希链 |
| 浏览器断线/停止后仍运行 | 关闭客户端与取消/停止后台不同；根据后台历史确认最终状态 |
| 导入失败 | 保留输入和错误，用脱敏最小夹具复现；不要直接改数据库 |

意外 daemon 错误可能附 `diagnosticId`；用它匹配所选 dataDir 下 `audit/daemon.jsonl` 的记录。审计写入失败时可能返回 `diagnosticUnavailable`，不能因此声称不存在错误。记录应只含安全的 method/code/时间等，分享前仍检查私有上下文。

`audit/daemon.jsonl` 是请求审计，记录失败的请求，以及每个发起的[批次](batch.zh-CN.md)各一行；文件里没有失败请求的行表示没有请求失败，不表示 daemon 没有日志。工作进程退出（退出码或信号、它承载的会话、它最后写到 stderr 的几行）、工作进程启动失败、会话中断及原因、工作进程日志、每个会话的打开耗时（`session.open` 记录账本各阶段，`session.load` 记录整次加载；只有大小和耗时，不含名称和内容），以及 daemon 的启动、停止、崩溃和错误，记在同一 dataDir 下的 `audit/runtime.jsonl`。该日志与审计一样脱敏，超过 2 MiB 前轮转为 `audit/runtime.jsonl.1`，不保留更早的一代。一次 daemon 启动之前若没有停止记录，说明上一个 daemon 未经关闭流程就结束了。Web 诊断包分别以 `logs/daemon-runtime.jsonl` 和 `logs/daemon-request-audit.jsonl` 收录两者。运行日志出现之前的旧 daemon 无法提供它，诊断包会提示 `runtime.jsonl` 不可用。

## 读懂运行日志里的会话打开记录

在 worker 中运行会话的后台，会把三类与打开会话有关的记录写进 `audit/runtime.jsonl`；进程内后台不写。每行是一个 JSON 对象，含 `kind`、`detail` 和时间 `at`。`detail.session` 不是会话 ID，而是其 SHA-256 的前 16 位十六进制数字；要找某个会话的记录，用同样方法对 ID 求哈希：

```sh
node -e "console.log(require('node:crypto').createHash('sha256').update(process.argv[1]).digest('hex').slice(0, 16))" SESSION_ID
```

时间单位是毫秒，大小单位是字节。记录中不含名称、路径或内容。

- `session.open` 由 worker 在每次打开会话历史时写入：加载、恢复，或唤醒一个它先前休眠的会话。
  - `lastSeq` 是最后一条记录的序号。`storedBytes` 和 `maxRowBytes` 是历史的存储大小和其中最大一条记录的大小；存储报告不了时两者都省略。
  - `checkpoint.used: true` 表示这次打开信任了"上次核对到哪里"的记录（到 `checkpoint.throughSeq` 为止），这部分不重新核对就先显示，再在后台核对（见 `session.verify_full`）。`checkpoint.used: false` 时，会话打开之前已核对了全部历史，`checkpoint.reason` 说明原因：`absent`（没有这条记录，如首次打开或核对失败之后）、`unsupported`（存储不保存这类记录），或 `algorithm`、`self-check`、`beyond-head`、`row-mismatch`（有记录但不能用）。`beyond-head` 表示历史现在结束在上次核对到的位置之前，末尾可能有记录被删除；worker 还会为此写一行警告。
  - `ms.total` 是打开历史的耗时，其组成为 `ms.read`（从存储读取记录）、`ms.verify`（核对哈希链）、`ms.fold`（用记录重建会话）和 `ms.registers`（读取会话当前状态）。`wallMs` 是 worker 看到的整次打开，包括启动会话。
  - 打开失败的记录只有 `wallMs`、`outcome: "failed"` 和错误 `code`，例如 `E_LEDGER_INTEGRITY` 或 `E_FORMAT`。
- `session.load` 由后台在客户端的加载需要打开会话时写入；会话已经打开时不写。`ms.open` 是 worker 中的打开，`ms.authorityReplay` 是后台从 worker 读回历史，`ms.acpReplay` 是把历史发给客户端，`ms.total` 是三者之和。`transferBytes` 是从 worker 传到后台的字节数，`resumes` 是一页历史超出单条消息、需要在下一条消息中续传的次数。加载失败的记录有 `outcome: "failed"`、`ms.open` 与 `ms.total` 中的失败前耗时，以及错误 `code`。
- `session.verify_full` 在后台核对结束后写入，跟在 `checkpoint.used: true` 的 `session.open` 之后。`ms` 是耗时，`rows` 是核对的记录数，`bytes` 是历史的存储大小。`outcome: "failed"` 表示该会话从此被拒绝；若有 `seq`，它是核对失败的那条记录。

要找出慢打开的时间花在哪里，先比较 `session.load` 的 `ms.open`、`ms.authorityReplay` 与 `ms.acpReplay`，再看对应 `session.open` 的各项 `ms`。`checkpoint.used: false` 时 `ms.verify` 很大，是在完整核对很长的历史；正常关闭的会话下次打开可以改用检查点。

没有自动修复所有 home 迁移的命令。不要删除 owner、锁、SQLite 或回滚快照来让错误消失。要做版本切换，先结束任务、停止对应后台并备份自有数据，再按[安装指南](install.zh-CN.md)启动完整新分发。
