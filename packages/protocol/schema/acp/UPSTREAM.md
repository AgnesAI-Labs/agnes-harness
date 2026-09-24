# ACP upstream pin

- repo: https://github.com/agentclientprotocol/agent-client-protocol
- tag: v1.7.0
- commit: 272bf799f35a258c6a4107a0410ed361e83683d3
  （`v1.7.0` 是 annotated tag——`git rev-parse v1.7.0` 给出的是 tag 对象自身的 hash
  `d46e61d959c356e86468ee7bf87544cfa0933b3a`，不是提交；真正的提交要多解一层，
  `git rev-parse v1.7.0^{commit}`，与 `git checkout v1.7.0` 后 `git rev-parse HEAD` 一致，
  即上面这行。）
- date: 2026-08-20
- license: Apache License, Version 2.0（仓库根 `LICENSE`；无单独 SPDX 头，仓库层面即
  Apache-2.0，见 README 「Contribution Policy」一节复述同一许可证）
- file: `schema/v1/schema.json`
  （上游仓库根 `schema/` 下有 `v1/` 与 `v2/` 两个并列目录，不是 brief 预告的单一
  `schema/schema.json`——以 `ls schema/` 实测结果为准。`v1`/`v2` 是「JSON Schema **产物**
  的排布版本」，不是 wire 协议版本；README 明文写「The current stable ACP protocol version
  is `1`」，且 Integrations 一节唯一给出的 Schema 链接就是 `schema/v1/schema.json`——
  `schema/v2/meta.json`（`"version":2`）对应的是尚未列为 stable 的下一代 wire 协议（比如
  v2 的 `clientMethods` 直接砍掉了 `fs/*`/`terminal/*`，属于破坏性变更），本仓库据此选取
  `v1` 而非目录名数字更大的 `v2`。）
- sha256: caf62ff962ada396878372ced11efb2c6764e59d90919a38583c319948931a42
- definitions used by this repo: InitializeRequest, InitializeResponse, NewSessionRequest, NewSessionResponse, PromptRequest, PromptResponse, CancelNotification, SessionNotification, RequestPermissionRequest, RequestPermissionResponse, AuthenticateRequest, AuthenticateResponse, LoadSessionRequest, LoadSessionResponse, SetSessionModeRequest, SetSessionModeResponse
  （已用 `jq '.definitions // .$defs | keys' schema.json` 核对：这 16 个名字在上游 `$defs`
  里逐一存在，与 brief 猜测的名字完全一致，无需改名对照表。后六个是 Task 6b 把 `authenticate` /
  `session/load` / `session/set_mode` 从 I3 提前到 I1 时用上的——vendored `schema.json` 本身没动，
  只是这一行从 10 个名字变成 16 个。schema 顶层键是 `$defs`
  （2020-12 dialect，`$schema` = `https://json-schema.org/draft/2020-12/schema`），不是
  `definitions`。）
- upgrade rule: 先复核 DEVIATIONS.md 再换本文件（protocol 稿 §5.4）。升级时同时重新核对
  「definitions used by this repo」这行——上游改名/删除任一 definition 会直接影响
  Task 6 的方法表，必须先更新本文件与 `methods.ts` 再切版本号。

## 生成器未支持节点（UNSUPPORTED_NODES，本仓库范围内的限制，非上游缺陷）

以下 4 个 `$def` 内部都用了 `not`（`tools/gen-core.ts` 的 `emit()` 未实现这个 JSON Schema 关键
字），但**只有 `CreateElicitationRequest` 同时还用了 `unevaluatedProperties`**——修复轮 1 评审
用 `jq` 逐个核实后指出：`CreateElicitationResponse` / `ElicitationPropertySchema` /
`MultiSelectItems` 用的是 `not` + `additionalProperties:true`，不是 `unevaluatedProperties`；
`additionalProperties:true` 本身 `emit()` 早就能正确处理（不是障碍），真正让这三个无法生成的
只有 `not`。已用 `$ref` 可达性分析确认本仓库引用的上述 16 个 definition 均不直接或间接 `$ref`
到这 4 个节点。生成器对这 4 个节点整体退化为 `Type.Unknown()`（不再校验其内部结构），其余节点
一律按已支持的组合子合并规则正常生成，不做静默降级：

| 节点（文件 + JSON 指针） | 为什么不支持 | 影响哪些方法的校验强度 |
|---|---|---|
| `packages/protocol/schema/acp/schema.json#/$defs/CreateElicitationRequest` | 第三个 `anyOf` 分支用 `not:{anyOf:[...]}` **+ `unevaluatedProperties:true`** 排除 form/url 两种已知 mode，表达"自定义/未来 mode"；两个关键字 `emit()` 都未实现 | 无——`elicitation/create` 不在本包 v0.1 收录的 ACP 方法表内（Task 6 / 6b 使用上表 16 个 definition），此 def 本身在生成物里就是不带结构校验的 `Type.Unknown()` |
| `packages/protocol/schema/acp/schema.json#/$defs/CreateElicitationResponse` | `anyOf` 分支之一用 `not` 排除已知 outcome 变体（旁边的 `additionalProperties:true` 不是障碍，`emit()` 能处理）；未实现的只是 `not` | 同上 |
| `packages/protocol/schema/acp/schema.json#/$defs/ElicitationPropertySchema` | `anyOf` 分支之一用 `not` 排除其余属性 schema 类型（旁边的 `additionalProperties:true` 不是障碍）；未实现的只是 `not` | 同上 |
| `packages/protocol/schema/acp/schema.json#/$defs/MultiSelectItems` | `anyOf` 分支之一用 `not` 排除另一分支（旁边的 `additionalProperties:true` 不是障碍）；未实现的只是 `not` | 同上 |

`DEVIATIONS.md` 的 U3 条目登记同一批节点（那边是"我方消费者视角"的登记，这里是"生成器实现
边界"视角的登记，两处都要看，见文首「规则：表里没登记的差异 = bug」）。
