# UI 数据源 — 设计提案

状态：待主审。实现以本文为准。字面量 `data[dataKey]` 保持不变。不做流式渲染、公式或新组件。不改 deferred 队列。

业务插件用新的服务 kind 注册只读查询。Surface 只保存绑定。Host 在授权之后解析，渲染器拿到结果。模型不再抄录账本数字。

## 1. Provider kind

新叶子包 `@agnes/ui-data-source-contract`（只依赖 `@agnes/extension-api` 与 `@agnes/protocol`）。Host 不导入 `@agnes/base`，`extension-api` 不增加本功能类型。令牌：

| 项 | 值 |
| --- | --- |
| `kind` | `ui-data-source` |
| `cardinality` | `multi` |
| `instanceScope` | `request`（每次查询单独 `open` / `dispose`） |
| `scope` | `generation`（实现钉在会话 generation，不要求重启） |
| `ports` | 空。数据源不能写 ledger、不能给模型投递 |

一个数据源一次 `providers.register`。`id` 全局唯一，形如 `finance/differences`（`^[a-z0-9-]+/[a-z0-9-]+$`）。`version` 为 semver。同 id 拒绝。`sourcePackage` 由加载器核对，作者不能改称别人的包。

Provider 还声明：`paramsSchema`（封闭 JSON Schema，`additionalProperties: false`）、`result`（`rows` | `object` | `text` | `steps` | `progress` | `image`）、`permission`（短字符串）、`capabilities`（本轮只有 `refresh`）。`open(ports).query(params, signal)` 返回 JSON。Actor、session、generation 只来自 Host 注入的 `capabilities`，不来自 `params`。

现有 `ServiceBindings.choose` 在同一包有多个 provider 时会失败关闭。多源要按 id 绑定：`ServiceCall` 增加可选 `providerId`（只在 `host-common`）。`cardinality === 'multi'` 时必填，且必须命中目录里的那一个 id；`single` 时禁止，原选择不变。

## 2. 绑定语法

绑定写在原 `data[dataKey]`，不新增 `sources` 图。持久 surface 只存绑定，不存行。

```json
"differences": { "$source": "finance/differences", "params": {} }
```

对象恰好两个自有键：`$source`、`params`。`params` 最多 16 个键、4096 字节、深度 8。其它形状仍是字面量，沿用现有组件校验。共享校验器只做结构判断，不在浏览器路径编译数据源 Schema。

组件与 `result` 必须一致：`table` / `chart` → `rows`；`detail-card` / 自定义组件 / `form` 初值 → `object`；`text` / `status` → `text`；`steps`、`progress`、`image` 同名。`button-group` 与 `tabs` 不能绑定。同一 `dataKey` 只查询一次。每个 surface 最多 8 个绑定。

禁止出现在 `params` 的键（即使 Schema 写了也拒绝）：`actor`、`session`、`sessionId`、`workspace`、`workspaceRoot`、`permission`、`grant`、`role`、`generation`、`generationId`、`packageId`、`owner`、`userId`、`asUser`，以及 `__proto__`、`prototype`、`constructor`。

## 3. 解析

解析在 Host 会话桥（`packages/host/src/runtime/sessions/`），经 Intelligent UI 已有的 capabilities 注入。官方插件只调用该函数并写审计事实。

| 时机 | 行为 |
| --- | --- |
| `ui_render` / `ui_update` | 先解析。拒绝则整次写入失败，不落空表。空数组是合法结果。 |
| `ui.read` | 返回已替换为结果的视图，另附 `sources[dataKey]`。 |
| 显式刷新 | 新会话操作 `ui.refresh`，走与 `ui.read` 相同的已认证转发。 |
| 冷恢复 | 从事实还原绑定，再按同一授权重查。 |

快照，不推送。`surface.revision` 仍是作者的比较并交换。绑定数据的版本是 `resultHash`（规范 JSON 的哈希），放在视图和审计里，不进模型写的 surface。刷新结果哈希不变则不使在途动作失效。哈希变了，依赖该表的动作按现有 `UI_STALE` 要求重确认。动作进行中（`received` / `pending-approval` / `executing`）刷新返回 `UI_BUSY`。

行选择和 `from: "data"` 使用该哈希对应的快照。客户端仍只提交 row id。执行前重查，哈希不一致则 `UI_STALE`，不拿新行执行旧确认。

进程内缓存键为 generation、surface、revision、source id、params 哈希。最多盖住 16 个打开的 surface。命中前仍检查启用与信任。关闭、禁用、撤销、generation 变化即丢弃。

界限：单次 2000ms，到点 abort；单键结果 65536 字节，并继续用表格 1000 行、图表 1000 点等现有形状上限。超时、超限、形状不符都是错误，不截断。

失败码只这些：`UI_SOURCE_DENIED`、`UI_SOURCE_UNKNOWN`、`UI_SOURCE_INVALID`、`UI_SOURCE_TIMEOUT`、`UI_SOURCE_TOO_LARGE`、`UI_SOURCE_SHAPE`、`UI_SOURCE_UNAVAILABLE`。写入时任一绑定失败则拒绝整次 render/update。已打开的 surface 在读取时单组件降级，兄弟组件照常渲染。降级组件上的动作拒绝，不用旧行冒充当前值。

文本回退：已解析则沿用 `surfaceText`，表格最多 20 行再加总数。仍是绑定或失败时只写标题和失败码，不打印绑定对象。

## 4. 授权与审计

Surface 事实的 owner 仍是 `agnes/intelligent-ui`。它没有替业务包绑定的特权。允许绑定当且仅当：

1. `provider id` 在该会话钉住的 generation 目录中；
2. 目录记录的 `sourcePackage` 当前仍 enabled，且信任决定仍覆盖该快照。禁用或撤销后停止解析，即使 pin 里还有代码。不前滚到新版本；
3. provider 声明的 `permission` 原样成立。Surface 和 params 里没有授权字段。

模型不能借 params 扩大访问。身份只从已接纳的 `ServiceCall.actor` 注入。数据源必须按这个 actor 裁剪，不能信任 params 里的租户或角色。试点源的 Schema 是空对象，查询只读本包夹具账本。

解析结果对模型不可信。本轮不把行送回模型（见第 5 节）。审计写在 Intelligent UI 自己的 ledger 上，相对名 `source.resolved`、`source.refused`、`source.refreshed`。字段只有 source id、params 哈希、result 哈希、字节数、行数、耗时、generation、actor id、失败码。没有参数原文、没有行、没有数据源内部错误文本。这些事实不进入 `surfaces` 投影。诊断导出沿用同一裁剪。

## 5. 模型可见性

默认不可见。`ui_render` / `ui_update` 的工具结果保持标题、组件数和链接；`details.surface` 只留绑定，剥掉解析行。SC1 仍是现有的安全摘要。不为数据源增加模型可读接口。

理由：数字应以系统记录为准，模型要计算时走已经授权并审计的业务工具。把表注入提示会重新引入费用、幻觉和过期。令牌影响是减少：surface 不再携带整表。用户要看的行只走已认证的 `ui.read`。

## 6. 试点

`examples/fde/finance-reconcile` 在现有 bundle 上注册 provider：`id` 为 `finance/differences`，`sourcePackage` 为 `@agnes-fde/finance-reconcile`，`result` 为 `rows`，`permission` 为 `finance.differences.read`，`capabilities` 为 `refresh`，`params` 为空对象。`query` 读取现有 CSV 夹具，行形状与今天的差异表相同（整数美分）。

`surface.mjs` 里 `differences` 改为上述绑定。表格和金额图共用这个 key。摘要、步骤、表单、状态和自定义差异视图仍是字面量。未启用该包的会话写这个 `$source` 被拒绝。

## 7. 文件、测试与估计

实现大约六笔提交：Schema 与共享校验、文本回退；叶子合同与按 id 绑定；Host 解析、授权、审计、`ui.refresh` 转发；渲染器加载/错误/刷新（web-ui 组件与 token，en 与 zh-CN）；双语合同文档；财务试点。

会碰协议 Schema（变基热点，只加定义）、`host-common` 的 `service-binding.ts`、Host 会话桥、官方 IU 插件的一小段能力调用（行数上限 1009，逻辑放在 Host）、daemon/worker/SDK 上与 `ui.read` 平行的刷新入口、`web-ui` 与 `web` 的 Intelligent UI、财务示例、依赖允许表与新包的 ratchet 登记。不改 `extension-api` 的 `KindMap`，不改 deferred 内部。

测试只写不跑：校验器接受绑定并仍拒绝坏字面量；外来源、已撤销或已禁用包、params 扩权；超限与超时；刷新与 `UI_BUSY` / `UI_STALE`；冷恢复重查失败时降级；渲染器 loading、error、刷新。扩展现有 IU 与财务测试，不新开套件，除非没有落点。

开发阶段不跑 tsc、vitest、Playwright 或构建。改 Schema 时只跑现有协议生成器，不手改 `gen`。

估计：主审通过后约一天，六笔可审查提交。风险在协议生成文件和 `service-binding` 的变基。

## 请主审确认

1. 允许条件采用「钉住的 generation 里该包仍启用且信任有效」，而不是「只有 surface owner 能绑自己的源」。后者会把业务源挡在 `agnes/intelligent-ui` 外面。本轮不做 `audience: owner`，因为工具调用没有调用方包。若必须限制到发起插件，需要另加调用方包，本设计不包含。
2. 新叶子包，而不是把类型放进 `@agnes/intelligent-ui-contract`。
3. 账本只存绑定和哈希；冷恢复重查，失败则降级，不回放上一份行。
4. 模型完全看不到解析行。
