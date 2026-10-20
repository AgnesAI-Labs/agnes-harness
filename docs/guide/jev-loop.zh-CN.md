# 使用 Jev Agent Loop

[English](jev-loop.md) | 简体中文

[文档](../README.zh-CN.md) · [TypeSafe Jev 旁路模型调用](typesafe-jev.zh-CN.md) · [通用凭据](credentials.zh-CN.md) · [组合包与配置](../extend/bundles-and-profiles.zh-CN.md) · [编写插件](../develop/plugins.zh-CN.md)

Jev Agent Loop（`agnes.jev@0.1.0`）是可选的 Agent Loop。它作为随发行版附带的可选包 `@agnes/jev-loop` 提供，默认没有安装；默认循环仍是 `agnes.default`。需要时从市场安装。

## 它做什么

每一步，循环都通过[旁路模型调用](typesafe-jev.zh-CN.md)询问 TypeSafe Jev 下一步做什么：任务处在哪个阶段、用哪个工具、参数怎么填，或者是否作答。Jev 有把握时，循环直接执行工具，不发对话模型请求。只有三件事会调用对话模型：

- **补参数**：Jev 选了工具，但参数需要撰写，例如文件内容。
- **复核**：Jev 没有把握，或上一步的结果需要判断，由对话模型决定下一次调用。
- **作答**：由对话模型撰写给用户的回复。

Jev 在默认循环于同一会话中会提供的工具之间选择，但不包括 `compact` 和 `run_code`（只有默认循环能用），也不包括 `tool_search` 和 `tool_describe`（它们留给对话模型）。回合中加载的工具，从加载起也加入选择。对七个内置的文件和 shell 工具（`ls`、`read`、`grep`、`find`、`write`、`edit`、`shell`），Jev 在能做到时也自己选参数：先前 `ls` 的结果列出过的目录或文件、先前 `find` 或 `grep` 的结果列出过的文件，或先前 `read`、`write`、`edit` 调用以之为路径的文件，可以直接列出或读取，一步最多可读四个文件。其他所有工具（包括 MCP 工具和插件工具）的参数都由对话模型给出。审批、预算和停止检查与默认循环相同。

循环既需要 Jev 路由，也需要一个普通的对话模型。每次 Jev 调用的 `state` 和 `questions` 含有任务文字和工具结果摘录，会发送给厂商；见[网络与隐私](typesafe-jev.zh-CN.md#网络与隐私)。

## 配置 Jev 路由

**在设置页面配置（推荐）。** 在 设置 → 模型与账户 → **高级：旁路模型与任务模型** 的「**旁路模型**」分组里添加 Jev 端点，步骤见[设置页面配置](typesafe-jev.zh-CN.md#设置页面配置)。页面创建的路由名为 `account-<id>`，条目的摘要行在适配器名之后显示完整路由名。把这个名字填进插件的 `jev.route` 配置（见下一节）。插件的 `jev.route` 默认是 `jev`，与页面条目对不上。同时确认 `jev.model` 是条目里保存的某个模型 id；默认值是 `typesafe/jev-1.13-20260917`。

**在用户 profile 里声明（无界面或脚本使用）。** 在 `AGH_HOME/profiles/<profile>/profile.yaml` 的 `provider.routes` 下声明路由，写法见[配置档路由](typesafe-jev.zh-CN.md#配置档路由)。路由名用 `jev` 时，插件默认的 `jev.route` 就能对上。这只适用于设置页面没有管理任何账户的 home：一旦在设置里保存了账户，设置服务就会提供整个 `provider` 块，`profile.yaml` 里的路由不再生效，插件找不到它的路由。这种情况请用设置页面。

`credentialRef` 只写密钥的引用，不写密钥本身：使用[通用凭据](credentials.zh-CN.md)的 `secret://generic/<UUID>` 引用，或 profile 自己的密钥存储里的一项。

以下位置不可用：

- 工作区文件 `.agh/profile.local.yaml` 不能声明路由。本版本中它只接受 `extensionIsolation`，写了其他键时运行时以 `E_DEP_MISSING` 拒绝启动。
- 组合包的 `profile` 补丁不能带 `provider` 块。
- 不要把 Jev 模型写进 preset 槽位：槽位是对话模型。

## 安装并配置插件

Jev 是发行版附带的可选包，安装之前并不存在。设置里没有单独的开关。

1. 打开 **插件 → 市场**，搜索 **Jev 运行方式**（卡片上标有「**运行方式**」），点击 **安装**。
2. AGH 检查这个包并打开审阅页。选择 **安装并启用**：安装、信任并启用你审阅过的这个确切版本。**只安装**只安装、不启用。审阅页若只提供 **安装**，说明当前账户没有信任或启用插件的权限。
3. 之后这个包出现在 **插件** 页。打开 **Jev 运行方式**，在它的 **设置** 页填写 `jev.route` 和 `jev.model`（见下表），再点击 **保存配置**。改动对新会话生效。

安装并启用之后，这个循环才会出现在[选用循环](#选用循环)所述的各个循环列表里。

**不用网页界面。** 可以用 CLI 安装同一个包，来源是市场卡片安装时使用的保留来源，在任何目录下都可以执行：

```sh
agh plugins add file:./bundled-plugins/jev-loop
```

命令会显示来源、能力范围和阻断项，确认后安装、信任并启用审阅过的版本；已明确授权的脚本可加 `--yes`。命令说明见[安装、启用、更新与移除插件](packages.zh-CN.md)。`jev.route` 等键在 profile 里设置，见下文；不用界面时，改 profile 就相当于在「设置」页配置。

**在 profile 或组合包里。** 装好 `@agnes/jev-loop` 之后，它的插件行是 `ext:agnes.jev/loop`，默认启用。可以在 profile 里配置，代替「设置」页：

```yaml
# AGH_HOME/profiles/<profile>/profile.yaml
composition:
  plugins:
    "ext:agnes.jev/loop":
      config:
        jev: { route: account-<id> }   # 路由声明在本 profile 里时写 jev
```

在组合包里，同样的 `plugins` 映射写在组合包的 `profile` 补丁里。一行的 `config` 整体替换已保存的配置。在这一行上写 `enabled: false` 可以关掉这个循环而不卸载包。改动对新会话生效。

没有安装 `@agnes/jev-loop` 的 home 里没有 `ext:agnes.jev/loop` 这一行：profile 或组合包写了它就会被拒绝，报 `composition selects unknown ordinary plugin row: ext:agnes.jev/loop`。请先安装这个包。

插件的配置项：

| 键 | 范围 | 默认 | 含义 |
| --- | --- | --- | --- |
| `jev.route` | 文本 | `jev` | 提供 Jev 模型的旁路调用路由 |
| `jev.model` | 文本 | `typesafe/jev-1.13-20260917` | 该路由上的模型 id；请固定带日期的版本 |
| `jev.deadlineMs` | 1000–120000 | 15000 | 单次 Jev 调用的时限，单位毫秒 |
| `jev.maxRetries` | 0–3 | 2 | 一步之内的重试次数，只对 `RATE_LIMIT` 重试 |
| `llmMaxAttempts` | 1–5 | 2 | 对话模型请求遇到可重试错误时的最多尝试次数 |
| `thresholds.escalate` | 0–1 | 0.5 | Jev 的选择不经复核直接执行所需的置信度；低于它时由对话模型复核，只有参数没把握时由对话模型撰写参数 |
| `thresholds.externalWriteMin` | 0–1 | 0.6 | 外部写入类工具的更高阈值：即非只读、且工具元数据标为开放世界的工具，例如许多 MCP 工具；内置工具都不属于这一类 |
| `thresholds.ambiguityGate` | 0–1 或 `null` | 0.4 | 在查看和验证阶段，Jev 报告的歧义度不超过此值时，低于 `escalate` 的只读选择仍直接执行；`null` 关闭 |
| `thresholds.answerProgressFloor` | 0–3 或 `null` | `null` | 本回合还没执行过任何工具、Jev 就作答且报告的进度低于此值时，由对话模型复核；`null` 关闭 |
| `stepCap` | 1–200 | 30 | 每回合的步数上限，达到后回合以 `max_steps` 结束 |
| `stateTokenBudget` | 4000–30000 | 24000 | Jev 状态加最长问题的估算 token 数 |
| `requestTokenBudget` | 8000–60000 | 48000 | 整个 Jev 请求的估算 token 数 |

未写的键取上表默认值。超出范围的值会被拒绝：设置页面不保存它；写在 profile 或组合包里时，循环不会以它启动。

循环需要压缩引擎。除非用 `providers.compaction: null` 关闭压缩，否则会选用默认引擎；这样组合的会话不能使用本循环。

## 选用循环

安装并启用这个包之后，用以下任一方式为新会话选择循环：

- profile：`providers.loop: { provider: agnes.jev, version: 0.1.0 }`；
- 管理端「**新会话默认**」面板；
- SDK：`client.createSession({ cwd, loop: { id: 'agnes.jev', version: '0.1.0' } })`；
- CLI：`agh -p "prompt" --loop agnes.jev@0.1.0`。

显式选择优先于管理端默认，管理端默认优先于 profile，profile 优先于 `agnes.default`。会话保持启动时的循环；改默认值只影响新会话。选择规则见[编写插件](../develop/plugins.zh-CN.md)。

## 能看到什么

- 管理端的循环列表和新会话的循环选择器里，`agnes.jev@0.1.0` 出现在默认循环旁边。有两个及以上循环可用时才显示选择器。
- **插件** 页列出已安装的包，它的 **设置** 页就是配置页。提供方面板把 `typesafe-systemone` 标为「**仅载荷请求，不用于对话**」。
- 对话看起来与默认循环一样，有两点不同：循环附加到对话模型请求上的附注显示为运行时上下文；Jev 直接选定的工具调用前面是一条没有文字的助手消息。对话模型在调用之前写的文字，记录里最多保留 8 KiB。
- 成本明细里每次 Jev 调用一行「**旁路模型调用**」。没有报告用量的调用标为估算。
- 循环自己的遥测事件（`jev.decide`、`jev.step`、`jev.metrics`）保存在会话历史和导出里，对话界面不显示。

## Jev 不可用时

Jev 调用失败时（路由没配、凭据被拒、请求过大、连接中断），循环把这一步记为失败，下一步再问。它不会退回到只用对话模型跑完回合。同一回合里同一种失败出现三次，或连续三步没有新的观察，回合以错误 `NO_PROGRESS_LIMIT` 结束。结束信息以 `No progress:` 开头，写出最后一次失败及其原因码；路由没配时其中含 `E_MODEL_UNKNOWN`。请对照你配置的路由检查 `jev.route` 和 `jev.model`。Core 因预算拒绝 Jev 调用时（回合的额度用完，或无法证明这次调用不超过回合的上限，例如 Jev 路由没有价格），回合改以 `budget`（`BUDGET_EXCEEDED`）结束。

限流会在本步内重试，最多 `jev.maxRetries` 次，按厂商要求的时间等待；要等超过 10 秒时不重试。

## 限制

本版本还不：

- 支持暂停或中断（回合运行中插话引导 steer 已支持）；
- 从循环里运行后台任务或子 Agent；
- 保留对话模型随调用一起写出的文字和思考中超过 8 KiB 的部分：记录里截到 8 KiB。

在一个回合内，Jev 会被告知哪些文件读过、读过之后哪些又变了。读取之后被写入或编辑的文件会标为需要重新读取；运行过 shell 命令之后，或某次可能改动过文件的调用结果丢失之后，本回合此前的读取都不再算作最新；`ls`、`read`、`grep`、`find` 的结果丢失不影响这一点。相同工具、相同参数的调用，在最近两次运行得到相同结果、且其间没有其他调用改动过文件（或可能改动过文件）时，不会运行第三次：该步以 `DUPLICATE_NO_PROGRESS` 被拒绝，改由对话模型复核下一步。

当会话里对话模型能用 `run_code` 时（**ptc** 预设，见[程序化工具调用与工作流](code-workflows.zh-CN.md)，以及任何提供代码模式且已加载代码运行时的自定义预设），本循环不能使用；预设只提供代码模式时，即使没有代码运行时也不能使用。这样的会话，每个回合都会立即以错误 `JEV_UNSUPPORTED_DISCLOSURE` 结束，不调用 Jev，也不调用对话模型。请改用默认循环，或选用不提供 `run_code` 的预设，例如 **standard**。

会话在回合中途重启时，从循环最后一次检查点继续。可能已经发出的对话模型请求不会重发；下一步改为请对话模型复核。
