# 无界面运行与模型回放

[English](headless.md) | 简体中文

[文档](../README.zh-CN.md) · [CLI 参考](../reference/cli.zh-CN.md) · [使用本地模型](local-model.zh-CN.md)

每次创建新会话，不启动 TUI、浏览器、Web listener 或共享 daemon：

```sh
agh run --bundle PACKAGE_ID#BUNDLE_ID --input prompt.txt --json > events.jsonl
cat prompt.txt | agh run --bundle ./bundle.json --input - --json
agh run --bundle ./bundle.json --input ./prompts --batch --json > batch.jsonl
```

`agh` 指源码构建出的 CLI，见[安装](install.zh-CN.md)。所选 profile 必须已经包含 bundle 需要的已安装、可信插件和模型路由。bundle ID 来自 Host 的已安装目录；文件路径指 JSON **BundleDocument**，与包内 `agnes.bundles` 条目的 `extends`、`profile`、`presets` 格式相同。例如只读补丁：

```json
{ "profile": { "toolPolicy": { "readOnly": true } } }
```

CLI 将临时 profile inputs 交给 Host composition 和常规验证，不保存 admin bundle selection。未知 ID、缺失依赖在会话开始前失败，不自动安装插件。不支持 bundle composition 的 Host 会拒绝 `--bundle`。

可选参数为 `--profile`、`--preset`、`--permission LEVEL`（`read-only`、`workspace-write`、`full-access` 或 `default`，见[权限与预设](security.zh-CN.md#permissions-and-presets)）、`--loop ID@VERSION`、`--model primary=ROUTE/MODEL`、`--cwd`，均放在 `run` 后。输入为 UTF-8 文本，最大 4 MiB；bundle JSON 最大 1 MiB。`--batch` 按文件名顺序处理目录第一层普通文件，每个文件一个会话，不递归、不跟随符号链接。每条记录带输入路径，可按 input 和 runId 分组。完全访问权限请求会自动允许；其他权限级别在没有审批处理器时继续按无人值守策略拒绝。

退出码：completed 为 0，错误或事件未完整排空为 1，用法/启动失败为 2，parked 为 3，blocked/budget 为 4，max steps 为 5，SIGINT/SIGTERM/SIGHUP 分别为 130/143/129。batch 在单项失败后继续，返回首个非零状态。信号取消当前 prompt 并停止后续输入，关闭宽限期为五秒。

定时任务与 Webhook 会话沿用有效权限级别。完全访问的权限请求自动允许并记录证据，不转交人工审批；其他权限级别继续遵循无人值守的交接或拒绝设置。明确选择的计划／只读模式保持原有行为。

## 无人值守的轮次

`agh run`、`runHeadless` 和 `agh -p`（任何 `--mode`）把提示作为无人值守提示发送（SDK 中为 `session.prompt(input, { unattended: true })`）：运行结束前没有人能回答问题。由该提示开启的轮次不向模型提供需要有人在场、会等待或面向在场用户的工具（`ToolMeta.requiresUser`）：`ask_user_question` 以及界面工具 `ui_render`、`ui_update`、`ui_close`、`ui_guide` 不出现在该轮的工具 schema 和发现结果中，对它们的调用按未知工具拒绝。模型还会收到一条上下文说明：本次运行无人值守，应凭自己的判断完成任务，并在最终回复中写明所作的假设。系统提示不变。该标记只属于这一条提示：同一会话的下一轮（例如在 TUI 或 Web 中 `agh --resume ID` 之后）恢复为有人值守，工具全部恢复，上下文说明会注明先前那条已不再适用。审批是另一回事：完全访问不会询问审批；其他权限级别下，没有审批处理器的一次性运行按上文拒绝或挂起，不会静默等待。早于该标记的 daemon 会忽略它。

这类轮次委派出去的工作同样如此：从无人值守轮次开启的子智能体或子会话（无论通过子智能体工具、工作流还是角色委派）也是无人值守的，同样不能向人提问。从有人值守轮次开启的子会话仍保留全部工具，与以前一致。

无人值守策略为 **直接拒绝**（`--unattended refuse`）的计划任务或 Webhook 触发器表示不会有人回答，因此它们的轮次同样按无人值守处理。默认的 **转人工并通知** 下，owner 可以稍后在 Web 或已绑定频道中回答，这些轮次保持有人值守，保留 `ask_user_question` 和界面工具。

## 回合上限

提示词自带上限时，模型会通过一条上下文说明得知这一回合的上限，以便安排在上限内完成。提示词可带的上限包括：墙钟时间上限（`agh -p --timeout`、`session.prompt(input, { timeLimitMs })`）、步数上限（`--max-turns`、`maxSteps`）和额度上限（`--max-budget`、`creditLimit`）；只要设了其中一项，说明里就列出生效的步数上限，其中包括 preset 的 `budget.max_steps`。回合的第一次请求列出所有已设置的上限，截止时间以 UTC 时间给出。最接近用尽的那项上限用掉约 50%、75%、90% 时，这条说明各更新一次，写明该上限还剩多少，并依次要求先把核心需求做出来并验证、然后收尾、最后用简短总结结束。有时间上限时，每次请求还附一条简短说明，给出组装该请求时实测的时间：上限已用多少、还剩多少（精确到 10 秒），并说明这个数字是权威的，模型不应凭自己的估算断定时间已到。这条说明和其他上下文说明一样写入对话，因此缓存的前缀保持不变；数字与上一条相同的请求不再追加，恢复的回合在下一次请求时重新测量即可。之后没有时间上限的回合会注明最后那个数字已不再有效。这类回合中的前台 `shell` 命令以及 `job_output` 的等待也会在截止前结束（见[默认工具](../reference/default-tools.zh-CN.md)）。触发条件只看时间、步数和额度。上限说明是实时上下文说明：系统提示及其缓存不变；恢复的回合从账本（`x/core/turn-time-limit`、`x/core/turn-step-cap`）重建上限，不会重复已经发过的说明。提示词没有设置任何上述上限的回合（例如普通的交互回合）不会收到说明（仅有 preset 的步数上限不会触发说明），之后这样的回合会注明先前那条已不再适用。Core 不会在时间上限到达时结束回合：由设置它的客户端在截止时取消回合，`agh -p` 就是这样做的。

## SDK

使用公开的 `@agnes/sdk` helper，连接到经 Host 组装的 profile/bundle。调用方负责启动 client、workspace admission 和 `client.close()`；helper 负责新会话、订阅、权限拒绝和 detach。

```ts
import { runHeadless } from '@agnes/sdk'

await client.workspace.add(cwd)
try {
  const result = await runHeadless(client, {
    cwd,
    input: '解释结果。',
    signal: controller.signal,
    write: async (record) => output.write(JSON.stringify(record) + '\n'),
  })
  if (result.reason !== 'completed' || !result.eventsComplete) throw new Error('run failed')
} finally {
  await client.close()
}
```

`write` 按流顺序等待；应返回一个在 sink 接受记录后才完成的 Promise。写入失败会取消 turn 并使 run reject。`preset`、`permission`、`loop`、`model`、`runId` 可选。`drainMs` 默认 1000；prompt RPC 完成后，终止 ledger 通知若在该时间内未抵达，result 会标明 `eventsComplete: false`。

## JSONL schema v1

公开 TypeScript 合同为 [`HeadlessRecord`](../../packages/sdk/src/headless.ts)。会话记录都有 `schemaVersion: 1`、`runId`、`sessionId`，以及下列 type：

| Type | Payload |
| --- | --- |
| `start` | 新会话身份 |
| `event` | `event` 为原始持久化 `LedgerEvent`，含 seq、ts、type、data、可选 lane 与 SDK `_meta`；payload 遵循现有 session-v1 协议 |
| `turn-metrics` | `metrics` 含 turn、lane（string 或 null）、reason、durationMs（number 或 null）、toolCalls、tokens（object 或 null）、usageRecords |
| `result` | reason、lastSeq、eventsComplete、可选 error；reason 为协议的 turn-end reason 或 failed |

CLI 额外添加 `input`。SDK 尚未生成会话 result 时的单项失败会输出 `error` 行，含 schemaVersion、runId、input、error，不伪造 sessionId。命令级启动/用法错误输出到 stderr，并以非零码退出。

指标覆盖各 lane 已观察到的 `turn/start` 至 `turn/end`。耗时为 ledger 时间戳之差，最小为零，不代表 adapter 原始回放耗时。toolCalls 计数 `tool/call` 行。tokens 累加同一 lane/turn 中非 adjustment 的 `cost/ledger`，包括 inference、compaction；字段为 input、output、cacheRead、cacheWrite、reasoning。usageRecords 表示纳入统计的行数；没有 usage 时 tokens 为 null。turn 结束后的延迟/后台行仍在 event stream 中，不回填指标。子会话成本见原始 `subagent/cost` 行，不自动汇总。文本 preview 非持久化事件，不包含在此流中。

## 录制、回放与教学

可选 [`@agnes/model-adapters`](../../packages/model-adapters/README.zh-CN.md) 插件用 `defineModelAdapter` 注册 local-openai、replay、scripted。录制位于模型 adapter 边界，保留 text/thinking delta、工具调用、媒体、usage 和终止事件，不从 UI preview 重建回复。

包装已有 adapter 实例：

```ts
import { recordModelResponses } from '@agnes/model-adapters'
const recording = await recordModelResponses(instance, '/absolute/responses.jsonl')
// 用 recording 替代 instance；结束时 await recording.dispose()。
```

本地兼容路由也可配置 `compat.recordFile`，见[本地模型](local-model.zh-CN.md)。文件以独占方式创建，权限为 0600，不覆盖已有文件。JSONL 行含 schemaVersion: 1、sessionKey、调用 index、request、原始 adapter events、complete。提示词和模型内容可能敏感；不录制 adapter 凭证或鉴权 header。中断调用记录 complete: false，回放会拒绝。读取上限 64 MiB。

模型路由选择 `api: replay`，配置 `compat: { file: /absolute/responses.jsonl }`，保留模型容量和工具声明。默认 `match: strict` 比较 kind、slot、system、messages、tools、sampling，忽略 route/model ID、session ID、派生 hash。显式 `match: sequence` 将相同回复用于修改后的 loop/compaction 提示词；这是固定回复条件下的策略比较，不表示真实模型会对新上下文给出相同回复。耗尽、不匹配、并发调用返回不可重试模型错误，不回退到真实模型，不模拟原始延迟。回放复现模型回复；工具和其他 effect 仍按正常后端策略执行。比较完整会话时，需要受控 workspace 和这些 effect 的 fixture。

一份 transcript 只含一个模型路由。每个新会话从第零条回复开始；文件含多个会话时设置 compat.recordedSession。同一路由的辅助调用也占用调用顺序；其他路由需要独立录制。

教学时使用 `api: scripted`，compat.file 指向：

```json
{
  "schemaVersion": 1,
  "replies": [[
    { "type": "text_delta", "delta": "Hello, class." },
    { "type": "usage", "tokens": { "input": 1, "output": 3, "cacheRead": 0, "cacheWrite": 0 }, "creditSource": "estimated" },
    { "type": "done", "reason": "stop" }
  ]]
}
```

课程作者显式填写 usage，并标为 estimated。成功回复需要一个 usage 和一个终止 done；错误可以用 error 结束。该 adapter 属于 runtime 包，不导入 testkit。
