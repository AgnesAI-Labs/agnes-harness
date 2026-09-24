# ACP deviations (protocol 稿 §5.4)

| id | kind | method / field | 内容 | 理由 | since |
|---|---|---|---|---|---|
| E1 | extension | `initialize.params._meta["ai.agnes.harness"].auth` | 四形状鉴权凭据（jwt / source-auth / portal-identity / local） | ACP 只允许经 `_meta` 扩展；凭据不在 params 顶层 | 0.1 |
| E2 | extension | 每条 `session/update` 与响应的 `_meta["ai.agnes.harness"]` | promptTurnId / eventSequence / generation / lane / phase / credits / turnEnd | quiescence 与游标续读 | 0.1 |
| E3 | extension | `session/new._meta["ai.agnes.harness"].preset` | 会话级配方名（须在 `presets.allowed`，否则 -32008） | preset 是会话属性 | 0.1 |
| E4 | extension | `session/new._meta["ai.agnes.harness"].sessionKey` | 客户端指定 §13 文法键（渠道 / jobs） | 渠道按 chat 算键 | 0.1 |
| R1 | restriction | `session/new.mcpServers` | 只接受空数组 | MCP 由 Profile / preset 管，客户端不得注入执行面 | 0.1 |
| R2 | restriction | `session/request_permission.options[].kind` | 只提供 allow_once / allow_always / reject_once | reject_always 走 preset 命令策略表 | 0.1 |
| U1 | unsupported | `fs/*`、`terminal/*` | 不宣告、不实现 | 文件与进程只经 sandbox 插座 | 0.1 |
| U2 | unsupported | `session/prompt` 内容块 audio / embedded_resource | 拒 -32602 | v0.1 只收 text / image / resource_link | 0.1 |
| U3 | unsupported (生成器) | `CreateElicitationRequest` / `CreateElicitationResponse` / `ElicitationPropertySchema` / `MultiSelectItems`（`$defs` 节点，非某个方法字段） | `CreateElicitationRequest` 用 `not` + `unevaluatedProperties`；其余三个只用 `not`（旁边都带 `additionalProperties:true`，但那个关键字 `emit()` 本来就能正确处理，不是障碍）。`tools/gen-core.ts` 的 `emit()` 未实现 `not`（`unevaluatedProperties` 只在 `CreateElicitationRequest` 出现，同样未实现），登记进 `UNSUPPORTED_NODES`，生成物对这 4 个节点整体是 `Type.Unknown()`（无内部结构校验） | 已用 `$ref` 可达性分析确认本包引用的 16 个 ACP definition（见 `UPSTREAM.md`）均不直接或间接引用这 4 个节点；本包 v0.1 也不宣告 `elicitation/*` 能力（同 U1 的"没有能力就不实现"原则）。若未来 Task 引入 elicitation，需先给 `emit()` 实现 `not`（`CreateElicitationRequest` 还需要 `unevaluatedProperties`），从 `UNSUPPORTED_NODES` 里移除对应条目 | 0.1 |

规则：表里没登记的差异 = bug。
