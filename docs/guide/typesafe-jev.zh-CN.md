# 使用 TypeSafe Jev 做旁路模型调用

[English](typesafe-jev.md) | 简体中文

[文档](../README.zh-CN.md) · [通用凭据](credentials.zh-CN.md) · [使用本地模型](local-model.zh-CN.md) · [网络部署](deployment.zh-CN.md) · [编写插件](../develop/plugins.zh-CN.md)

`@agnes/ai` 内置了 TypeSafe Jev 的模型适配器，注册为 `typesafe-systemone`。它一次回答一个结构化请求：一份 JSON `state` 和一组 `questions`，厂商为每个问题返回一个答案。循环插件用它做不必经过对话模型的快速决策。

Jev **不是对话模型**。适配器只接收载荷（payload），不接收 messages、system prompt 和 tools，也不做流式输出。它声明的能力是 `payload: true` 和 `payloadOnly: true`，所以由它服务的模型不会出现在任何模型选择器里，不能被选作会话、默认、fast、verifier 或子代理模型，客户端直接按名字请求也会被拒绝。循环插件通过旁路模型调用使用它。

## 设置页面配置

在 设置 → 模型与账户 页面，展开「高级：旁路模型与任务模型」，在其中的「旁路模型」分组里添加条目。同一页面还提供**语音**适配器，用于对话框里的听写和朗读，见[和智能体说话](voice.zh-CN.md)。添加 Jev 条目时：

1. 适配器固定为 `typesafe-systemone`。
2. 端点默认 `https://openrouter.ai/api/v1`，可改为直连 `https://api.typesafe.ai/v1`。端点规则与适配器一致：不允许模板、账号信息、query 和 fragment，明文 `http` 只接受环回地址。
3. 凭据从[通用凭据](credentials.zh-CN.md)里选择，或就地新建一个；条目保存的是 `secret://generic/<UUID>` 引用，不是密钥本身。
4. 模型列表每条只需填 `id`、`name`、`contextWindow`、`maxTokens` 和可选的 `cost`；其余字段按适配器模板固定（`reasoning: false`、`input: [text]`、`toolCallFormats: []`、`thinkingReplay: drop`、`contract_id: null`）。
5. 测试按钮向端点发一个固定的最小载荷 `{state: {}, questions: {ping: 'ping'}}`：成功或限流都视为可达，凭据被拒会单独标出。探测发送的内容暂定，可以跳过测试直接保存。
6. 保存对新会话生效；条目可启用、禁用或删除。旁路模型不能成为默认账户，也不出现在 fast、verifier 槽位里。

页面创建的路由名为 `account-<id>`，条目的摘要行显示这个名字；循环插件按这个名字指定路由。声明在用户 profile 里的路由（下一节）只在设置页面没有管理任何账户时生效：一旦保存了页面条目或其他任何账户，设置服务就会提供整个 `provider` 块，profile 里的路由不再使用。从 profile 路由迁移到页面时，先保存页面条目，把循环指向它的路由名，再删掉 profile 里的路由。工作区文件 `.agh/profile.local.yaml` 不能声明路由：本版本中它只接受 `extensionIsolation`，写了其他键时运行时以 `E_DEP_MISSING` 拒绝启动。

## 配置档路由

在用户 profile `AGH_HOME/profiles/<profile>/profile.yaml` 的 provider 配置里加一条路由。这适用于设置页面没有管理任何账户的 home，例如无界面或脚本化的部署；否则请用设置页面。适配器随 `@agnes/ai` 提供，不需要安装或信任任何包。如果配置档在 `providers.model-adapter` 下显式列出了模型适配器，请把 `typesafe-systemone`（或 `@agnes/ai`）加进这个列表。

```yaml
provider:
  package: "@agnes/ai"
  routes:
    - route: jev
      api: typesafe-systemone
      baseUrl: https://openrouter.ai/api/v1
      credentialRef: secret://openrouter/jev
      models:
        - id: typesafe/jev-1.13-20260917
          name: Jev 1.13 (2026-09-17)
          api: typesafe-systemone
          route: jev
          baseUrl: https://openrouter.ai/api/v1
          reasoning: false
          input: [text]
          cost: { input: 0.042, output: 0, cacheRead: 0, cacheWrite: 0 }
          contextWindow: 65536
          maxTokens: 32768
          toolCallFormats: []
          thinkingReplay: drop
          contract_id: null
```

- `api` 选择适配器，路由下每个模型都要重复它。`contract_id` 必须为 `null`：Jev 没有 system prompt 可以承载契约。
- 适配器向 `<baseUrl>/systemone` 发 POST，密钥作为 bearer token。明文 `http` 只接受环回地址，密钥不会未加密地发往其他机器。
- `credentialRef` 写的是密钥的引用，不是密钥本身。把密钥保存为[通用凭据](credentials.zh-CN.md)，使用它返回的 `secret://generic/<UUID>` 引用，或者把密钥放进配置档的密钥存储。引用在装配运行时时解析；解析不了，这条路由不会启动。不要把密钥写进配置档。
- 模型 id 原样发送。请固定带日期的版本，例如 `typesafe/jev-1.13-20260917`；`~typesafe/jev-latest` 这类别名可能在你不做任何改动时换成另一个版本。响应会报告实际作答的模型，旁路调用记录也会保存它。
- `cost` 的单位是每百万 token 的美元数。厂商回报单次调用的价格时，AGH 记录该价格，否则按 `cost` 估算。复制上面的数字前，请先核对厂商当前的价格。
- 不要在 preset 的槽位里指定 Jev 模型，槽位是对话模型。preset 留作 `default` 的槽位会取第一条没有被仅载荷适配器服务的已声明路由，所以 `default` 不会选中 Jev 路由，这条路由可以声明在最前面。如果配置档只声明了仅载荷路由，`default` 仍落在其中第一条，所有对话都会在适配器处失败。

如果不经 OpenRouter 而直接调用 TypeSafe，把路由和模型的 `baseUrl` 改为 `https://api.typesafe.ai/v1`，`credentialRef` 指向直连密钥，并使用厂商的模型 id，例如 `jev-1.13.0`。直连端点按厂商文档编写，尚未用真实密钥验证。

## 不是对话模型

- Web 模型选择器、CLI 的 `/model` 列表和 `apis.list` 返回的列表都不含 Jev 模型，新会话不会默认使用它。
- 新会话的管理默认值以及 fast、verifier 槽位都不提供它，定时任务也不能指向它。
- 子代理不能选择它：`list_subagent_models` 不列出这些模型，在其上启动子代理会被当作未知模型拒绝（`E_MODEL_UNKNOWN`）。旁路模型调用不受影响，循环插件仍可指向这条路由。
- 客户端直接发送同样的选择时，服务端同样拒绝：把会话切换到 Jev 模型会得到 `PRESET_SWITCH_REJECTED`，把它保存为默认值或槽位会得到 `CONFIG_MODEL_UNAVAILABLE`。
- 如果带 messages、tools 或 system prompt 的请求仍然到了适配器，它会在联网前以 `CONTRACT_MISMATCH` 拒绝。
- Web 设置里仍会列出这个适配器，标注为 **仅载荷请求，不用于对话**；技术详情里显示 `payload` 和 `payloadOnly` 两项能力。

既收 messages 又收载荷的社区适配器只需声明 `payload: true`，它的模型仍可选。模型适配器插件模板说明了 `payload` 和 `payloadOnly` 这两个能力字段。

## 在循环插件里调用

循环拿到 `ctx.sideCall` 后，先 prepare，需要时检查估算，再 invoke。目标是已装配目录里的 route 和 model，不接受槽位名。

```ts
const sideCall = ctx.sideCall
if (!sideCall) return fallback() // 这个端口是可选的

const prepared = await sideCall.prepare({
  label: 'sample.decide',
  target: { route: 'jev', model: 'typesafe/jev-1.13-20260917' },
  payload: { state, questions }, // 恰好这两个键
  output: 'json', // 解析后的答案
  deadlineMs: 10_000,
})
const result = await sideCall.invoke(prepared, signal)
if (result.status === 'ok') return result.json // 每个问题 id 一组答案
if (result.status === 'failed' && result.retryable) {
  // 适配器不重试。要再试就作为一次新调用，使用新的 invocationId。
}
return fallback()
```

`payload` 上限 1 MiB，`deadlineMs` 范围 100–120000 毫秒（默认 10000），时限覆盖整次调用。完整契约见[循环的旁路模型调用](../develop/plugins.zh-CN.md#循环的旁路模型调用)，包括 `status` 以及 `unknown`、`refused` 两种结果。

[Jev Agent Loop](jev-loop.zh-CN.md) 是随发行版附带的可选包形式的循环插件，每一步都发起这样的调用；它的指南说明如何从市场安装它并指向你的路由。

## 限制

- **上下文。** 厂商接受整个请求约 64k token，其中状态加最长的问题约 32.8k token。超出时返回 `OVERFLOW`。
- **题数。** 厂商不限制一个请求有多少个问题，限制只按 token 计。适配器只检查载荷的外形（`state` 和 `questions`），不检查题数、题目 id 和状态大小。让请求保持在 token 限制内是循环插件的责任。
- **速率。** 厂商文档给出的限制是每个密钥每秒 100K token。这是速率上限，不是花费上限。
- **响应。** 适配器最多读取 1 MiB 响应，更大的会被拒绝。
- **适配器内不重试。** 每次调用恰好发一次 HTTP 请求。限流或服务端错误以可重试错误返回，厂商发送了 `retry-after` 时一并带上等待时间，是否再试由循环决定。

## 错误

消息是固定短语，例如 `typesafe-systemone RATE_LIMIT (HTTP 429)`，从不引用响应正文、密钥或厂商的账户字段。

| 错误码 | 情形 | 可重试 |
| --- | --- | --- |
| `CONTRACT_MISMATCH` | 请求不是 `{state, questions}` 载荷，带有 messages、tools 或 system prompt，或厂商以其他 4xx 状态拒绝 | 否 |
| `AUTH` | 没有绑定凭据，或厂商返回 401、403 | 否 |
| `OVERFLOW` | 厂商报告 `max_tokens_exceeded` | 否 |
| `NO_MODEL` | 厂商不认识这个模型 id | 否 |
| `QUOTA` | 厂商返回 402 | 否 |
| `RATE_LIMIT` | 厂商返回 429 或 529 | 是 |
| `TRANSPORT` | 服务端错误、被拒绝的重定向或连接失败 | 是 |
| `TIMEOUT` | 本次调用自己的时限已到 | 是 |
| `FORMAT` | 响应不是合格的信封、超过 1 MiB 或不是 UTF-8 | 否 |
| `NO_ADAPTER` | 路由已不存在或适配器已关闭 | 否 |
| `ABORTED` | 调用方取消 | 否 |

厂商以 4xx 状态拒绝请求时，请求没有被处理也不收费，所以适配器会在错误之前先报告零用量。

## 网络与隐私

适配器与其他官方适配器一样遵守 `HTTP_PROXY`、`HTTPS_PROXY` 和 `NO_PROXY`，每条路由持有一个连接池，运行时重新配置或停止时关闭。重定向会被拒绝，密钥不会被发往别处。要收紧连接限制，可在路由上设置 `networkTimeouts`；单次调用的时限是旁路调用的 `deadlineMs`。

每次调用的 `state` 和 `questions` 都会发给厂商，使用 OpenRouter 时也会发给 OpenRouter。本地请求轨迹会像记录所有模型请求一样记录这份请求体。除非你与厂商的协议允许，请不要在载荷里放个人数据和密钥。
