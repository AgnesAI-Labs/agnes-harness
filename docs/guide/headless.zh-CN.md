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

可选参数为 `--profile`、`--preset`、`--loop ID@VERSION`、`--model primary=ROUTE/MODEL`、`--cwd`，均放在 `run` 后。输入为 UTF-8 文本，最大 4 MiB；bundle JSON 最大 1 MiB。`--batch` 按文件名顺序处理目录第一层普通文件，每个文件一个会话，不递归、不跟随符号链接。每条记录带输入路径，可按 input 和 runId 分组。无人值守运行拒绝权限请求；运行前应配置适当的后端策略。

退出码：completed 为 0，错误或事件未完整排空为 1，用法/启动失败为 2，parked 为 3，blocked/budget 为 4，max steps 为 5，SIGINT/SIGTERM/SIGHUP 分别为 130/143/129。batch 在单项失败后继续，返回首个非零状态。信号取消当前 prompt 并停止后续输入，关闭宽限期为五秒。

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

`write` 按流顺序等待；应返回一个在 sink 接受记录后才完成的 Promise。写入失败会取消 turn 并使 run reject。`preset`、`loop`、`model`、`runId` 可选。`drainMs` 默认 1000；prompt RPC 完成后，终止 ledger 通知若在该时间内未抵达，result 会标明 `eventsComplete: false`。

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
