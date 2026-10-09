# Intelligent UI 合同

[English](intelligent-ui.md) | 简体中文

[架构](architecture.zh-CN.md) · [插件](plugins.zh-CN.md) · [前端](frontend.zh-CN.md) · [会话与恢复](../guide/sessions.zh-CN.md) · [Web 渲染器](intelligent-ui-web.zh-CN.md)

本文定义预设与已审阅自定义组件的 surface 合同。官方后端插件、已认证 App Server 方法与通用 deferred 执行桥已实现该合同；下文描述客户端渲染与财务试点。可用性仍需仓库统一验证。

## 归属与范围

官方插件 `agnes/intelligent-ui` 位于 `packages/base/extensions/intelligent-ui`，负责 `ui_render`、`ui_update`、`ui_close`、扩展事实和可重放投影。Protocol 负责声明；Host 与 daemon 适配器绑定已认证的会话、actor、任务/通道以及会话锁定的插件 generation。Core 保持不变。客户端展示后台事实并提交请求；可点击的按钮或模型文字都不构成权限。

每个 surface 同时出现在对话卡片和工作台面板中。展开卡片打开同一个 `(sessionId, surfaceId, revision)` 的面板。两处共享动作回执和草稿；展开只改变展示状态，不产生第二个 surface 或第二次执行。`placement.preferred` 只是布局提示，不能隐藏其中一个位置。

第一阶段支持表单、表格、仅包含数据的图表、按钮组、纯文本和状态。没有生成 HTML、JavaScript、表达式求值器、远程组件加载器或任意 CSS。外部 UI 依赖留在 `packages/web-ui`，客户端保持其主题、无障碍、CSP 和皮肤钩子。业务插件提供的标签属于内容；渲染器控件与拒绝提示提供英文及简体中文目录、键盘操作、状态朗读和稳定 test id。

## Schema 与绑定

声明源为 [intelligent-ui.json](../../packages/protocol/schema/intelligent-ui.json)；[生成类型](../../packages/protocol/gen/ts/intelligent-ui.ts) 从 `@agnes/protocol/gen/intelligent-ui` 或根类型导出使用。修改声明时仅运行现有 protocol 生成器，不手改生成类型。该 Schema 与描述已部署应用产物的 `surface.json` 独立。

`UiSurface` 是禁止未知字段的对象，必填 `id`、`revision`、`title`、`placement`、`components[]`、`data{}`、`actions[]`。Surface id 在会话内唯一，关闭后不能复用，初始 revision 为 1。组件和动作 id 分别在各自列表内唯一。数据键与组件引用只在当前 surface 中解析。后台同时验证 JSON Schema 形状和这些关联。

| 组件 `kind` | 除 `id`、`kind` 外的必填字段 | 行为 |
| --- | --- | --- |
| `form` | `dataKey`、`schema` | 初始值来自 `data[dataKey]`；草稿通过 `input[component.id]` 提交。可选 `actionIds` 指定提交按钮。 |
| `table` | `dataKey`、`rowKey`、`columns`、`selection` | 行为对象。`rowKey` 对应唯一非空字符串，最长 128 字符。选择模式为 `none`、`single`、`multiple`；可选 `rowActionIds` 引用声明的动作。 |
| `chart` | `dataKey`、`chartType`、`categoryKey`、`series` | `bar`、`line`、`pie`；数据为对象数组，分类为字符串，序列为有限数值。饼图仅有一个序列且值非负。无可执行配置。 |
| `button-group` | `actionIds` | 按钮引用 surface 的动作列表。 |
| `text` | `dataKey` | 纯字符串，按文本渲染。 |
| `status` | `dataKey` | 纯字符串；处理/审批状态来自回执，不能由该业务标签决定。 |

所有组件均可带 `title`。列包含 `key`、`label` 和可选 `format`（`text`、`number`、`currency`、`date`、`status`）；格式只影响展示，不改变值、不推断货币单位。图表序列包含 `key`、`label`。绑定的数据必须存在并符合组件形状。非法行、缺失字段、重复行 id、未声明的组件类型拒绝整个 render/update，不静默省略。

表单复用[现有 Schema 渲染器](../../packages/web-ui/src/plugin-schema-fields.tsx)与[模型](../../packages/web-ui/src/plugin-schema-model.ts)：`UiJsonSchema` 为布尔值或 JSON Schema 对象；本地 `$ref`、对象/数组/变体/枚举/标量控件、无损 JSON 回退保持既有语义。展示递归阈值仍为 6，与后台载荷限制独立。无法展示的断言回退到 JSON 编辑器，不展示会误导人的部分表单。后台编译完整 Schema，校验提交值，不做类型转换、不丢弃未知属性。不进行网络 `$ref` 解析。秘密字段不提供权限：surface 不得携带原始凭据；业务凭据字段只能使用现有凭据引用合同。

`UiAction` 必填 `id`、`label`、`tool`、`argsTemplate`、`paramsSchema`；可选 `confirm` 是业务确认提示，`style` 为 `primary`、`secondary`、`danger`。目标工具必须已声明并在会话锁定的组合中可见。标签和模板不能选择其他工具、工作区、会话、actor、通道或权限。改变动作目标必须生成新 surface revision。

`argsTemplate` 将工具顶层参数名映射到以下二者之一：

- `{ "literal": <JSON 值> }`：固定数据；
- `{ "from": "data" | "input" | "row" | "selection", "key": "...", "pointer": "..." }`：值绑定。`pointer` 默认空 JSON Pointer。

`data` 的键标识已提交的 surface 数据；`input` 的键标识表单组件 id；`row` 的键标识提交行上下文中的表格组件；`selection` 的键标识表格，解析结果是后台按展示顺序解析的行对象数组。客户端只发送行 id，不发送具有权威性的行对象。后台从接纳的 revision 解析行，检查成员、选择 id 唯一性与选择模式；在不匹配的表格动作上下文中使用 row/selection 绑定会被拒绝。表格动作可以使用 selection；行内动作还可以使用 row。表单草稿按其表单 Schema 校验；展开后的参数必须同时符合 `paramsSchema` 与注册工具的参数 Schema。缺失键、Pointer 或非法 Pointer 转义均为错误。Pointer 只访问自身属性，禁止 `__proto__`、`prototype`、`constructor` 路径段，不执行代码、不做字符串插值。

### 大小限制

Schema 声明结构限制并导出 `X_AGNES_UI_LIMITS`；后台与渲染器还执行语义/字节限制。字节数以持久化前 UTF-8 编码的 JSON 计算。

| 项目 | 上限 |
| --- | --- |
| 单个 surface / 单个动作请求或展开后的参数对象 | 32,768 / 16,384 字节 |
| 单个扩展事实 / 整体投影状态及视图 | 65,536 / 262,144 字节；保持既有归属模块更严格的限制 |
| 组件 / 动作 / 数据键 | 每 surface 32 / 32 / 64 |
| Id/数据键 / 标题/标签 / 确认提示 | 64 / 256 / 1,024 字符；工具名 128 |
| 列 / 图表序列 | 32 / 8 |
| 表格行 / 图表数据点 | 每组件 1,000 / 1,000 |
| JSON / Schema 嵌套深度 | 16 / 16；拒绝不受控外部引用 |
| 未关闭 surface / 待处理命令 | 每会话 16 / 8；每 surface 最多一个待处理命令 |
| 恢复分页 | 16 个 surface、64 个回执；响应合计不超过 262,144 字节 |
| 接纳 | 每已认证 actor/会话在滚动一分钟内最多 30 个新 command id |

写入前校验整体投影容量，不能只校验单个 surface。render/update 超出容量时拒绝操作并保留前一个 revision。读取分页可以减少条目以满足字节限制。即使移出有界投影缓存，命令身份与关闭 surface 的墓碑仍保留在 ledger 中。重启后从回执事实重建近期接纳窗口；并发接纳串行化。同一命令的重试不消耗新的命令额度。过载返回现有 `OVERLOADED` RPC 拒绝和重试提示，不创建业务执行。

### 财务 surface 示例

以下是完整 surface 值。金额保持精确的整数美元分，展示标签说明单位。

```json
{
  "id": "finance-review", "revision": 1, "title": "Reconciliation review (USD cents)",
  "placement": { "inline": true, "workbench": true, "preferred": "workbench" },
  "components": [
    { "id": "differences", "kind": "table", "dataKey": "differences", "rowKey": "id", "columns": [{ "key": "id", "label": "Transaction" }, { "key": "amountCents", "label": "Difference (USD cents)", "format": "number" }, { "key": "status", "label": "Status", "format": "status" }], "selection": "multiple" },
    { "id": "amounts", "kind": "chart", "dataKey": "differences", "chartType": "bar", "categoryKey": "id", "series": [{ "key": "amountCents", "label": "Difference (USD cents)" }] },
    { "id": "adjustment", "kind": "form", "dataKey": "draft", "schema": { "type": "object", "additionalProperties": false, "required": ["proposals"], "properties": { "proposals": { "type": "array", "maxItems": 1000, "items": { "type": "object", "additionalProperties": false, "required": ["id", "amountCents", "reason"], "properties": { "id": { "type": "string" }, "amountCents": { "type": "integer" }, "reason": { "type": "string" } } } } } }, "actionIds": ["confirm"] },
    { "id": "buttons", "kind": "button-group", "actionIds": ["confirm"] }
  ],
  "data": {
    "differences": [{ "id": "txn-1", "amountCents": 250, "status": "needs-review", "reason": "amount-mismatch" }],
    "draft": { "proposals": [{ "id": "txn-1", "amountCents": 250, "reason": "amount-mismatch" }] }
  },
  "actions": [
    { "id": "confirm", "label": "确认调整", "tool": "fde_finance_approve", "argsTemplate": { "proposals": { "from": "input", "key": "adjustment", "pointer": "/proposals" } }, "paramsSchema": { "type": "object", "required": ["proposals"], "additionalProperties": false, "properties": { "proposals": { "type": "array" } } }, "confirm": "Confirm these simulated adjustments? Nothing is posted.", "style": "primary" }
  ]
}
```

行内动作隐含只选择该行。后台根据展示表格解析行 id。消费选择行的业务工具必须声明行的实际形状，或显式映射为提案；不能剥掉展示字段来绕过工具校验。示例将表单的提案数组绑定到现有工具。

## 公开操作与执行桥接

| 入口 | 合同 |
| --- | --- |
| `ui_render(UiRenderParams)` | 创建 revision 1；后台绑定归属插件/generation、任务和通道。同一普通工具 invocation 重入时使用已有回执，不重复 render。 |
| `ui_update(UiUpdateParams)` | 整体替换，不采用 JSON Patch。`surfaceId` 必须等于 `surface.id`；expected revision 必须是当前版本，下一版本严格为当前 + 1。归属/任务不可改变。 |
| `ui_close(UiCloseParams)` | 按 expected revision 关闭，保留最终 surface 和墓碑。revision 不变；再次关闭相同 revision 为无操作。不能重新打开或复用 id。 |
| `_agnes/v1/ui.action(UiActionParams)` | 已认证提交；返回持久 `UiActionReceipt`，可以是 `received` 或待审批而非终态。不接受调用方指定工具或授权。 |
| `_agnes/v1/ui.read(UiReadParams)` | 已认证恢复读取；可选 surface/command 筛选、不透明 cursor 和 limit。返回 `UiReadResult`，包含 ledger 水位和有界 surface/回执分页。 |

以上方法名为待评审声明，尚未注册为 App Server 方法。所有读取/写入前检查会话归属。未认证或跨会话调用使用既有认证/能力 RPC 错误，不泄露 surface 或历史命令结果。格式错误的请求使用 `INVALID_PARAMS`；只有形状正确且绑定会话的命令才能进入动作状态机。归属插件由工具贡献确定，不取自模型提供的 surface 数据。Surface 归属该会话持续中的任务；单纯开启新 turn 不使其失效。后台任务完成/退役时通过本合同关闭其 surface。

Service 不提供任意工具调度入口。公开[延后工具调用合同](deferred-invocations.zh-CN.md)是唯一的通用执行桥接，可供 UI、webhook、schedule 使用。Host 将持久队列绑定到会话锁定的 session/lane，通过公开 Loop context 的可选端口接入，Core 不变。默认 Loop 与财务 Loop 在安全步骤边界，通过 `LoopContext.tools.execute`、`tools.resume`、`effects.status` 通用排空；不包含 UI 专用 helper 或组件逻辑。Intelligent UI 是一个生产方：校验动作、持久化绑定、将已声明工具 invocation 入队。队列事实与生产方通知仍基于 ledger。未安装生产插件时队列端口为空，默认 Loop 调度不变。缺少通用排空能力的自定义 Loop 在工具派发前拒绝提交。禁止直接调用 `ToolDef.execute`、导入 Core 私有模块、依赖模型文字指令执行或消费无关 SC1 输入。

不可变的已接纳命令绑定 surface revision、归属 generation、任务/通道、已认证 actor、动作、完整校验的参数以及稳定 invocation id。命令事实构成工作队列，从 ledger 重建；不增加数据库或 Agent 输入通道。执行时 helper 再检查绑定任务、surface 与工具目录，再沿普通 tool policy、approval、auto review、sandbox、deny-list 控制执行原工具。业务 `confirmed: true` 仅满足 `action.confirm`，不授予工具权限。存在 `received`、`pending-approval`、`executing` 动作时，update/close 返回 `UI_BUSY`，避免审批票据下的审阅数据改变。未解决的 `outcomeUnknown` 失败也保持该 surface 锁定，直到既有效果对账解决它。相同 surface 以不同 command id 并发提交也返回瞬时 `OVERLOADED`，不创建第二个 invocation。

回执字段依状态约束：`rejected` 必须有 `refusal`，`failed` 必须有 `failure`，`pending-approval` 必须关联 invocation/票据，`succeeded` 必须关联持久工具结果。不适用的 failure/refusal 字段缺省。后台在结构 Schema 之外验证这些关系。`outcomeUnknown: true` 始终意味着 `retryable: false`。

终态结果/拒绝只通过现有 SC1 queued-input 到达 Agent：活跃 turn 支持 steering 时使用 `next-step`，否则使用 `next-turn` 与既有空闲唤醒。结果持久化恰逢 turn 结束时仍须留在队列，供下一轮领取。队列内容包括 surface id/revision、action/command id、状态、安全摘要和 ledger/tool-result 引用。工具输出仍是不可信证据。Agent 随后可调用 `ui_update` 或 `ui_close`；执行成功本身不生成业务数据，也不增加 surface revision。

## Ledger 事实与生命周期状态表

下列插件事件使用 `x/agnes/intelligent-ui/` 命名空间，表中简写为 `ui/`。每个 surface 事实包含后台绑定的归属/任务/通道和完整验证的 surface；`surface.closed` 保留最终 revision 与原因。每个动作事实包含命令身份、actor、revision、前一事实引用和安全结果链接。接纳在会话串行边界内计算校验。`action.received` 在调度前持久化不可变原请求；绑定合法时还记录解析参数与 invocation id；绑定非法时记录拒绝，不虚构工具 invocation。若拒绝记录被中断，恢复先根据原请求补齐拒绝，不能先调度。完整工具输出保留在既有工具/效果事实中，不复制到另一份无界载荷。扩展事实解释 UI 状态；执行仍以普通 Core 授权/效果事实为权威。事实链损坏或引用结果缺失表现为恢复缺口，不能算成功。

| 实体 / 转换 | 持久事实 | UI | Agent / 幂等 |
| --- | --- | --- | --- |
| 不存在 → open | `ui/surface.opened`（revision 1）、普通 render 工具回执 | 卡片与面板可见 | 普通 `ui_render` 结果；已有 invocation 回执复用。 |
| Open n → updated n+1 | `ui/surface.updated`，含完整新 surface 与旧 revision | 两处替换已提交数据；旧脏草稿须重新审阅 | 普通 `ui_update` 结果；expected-revision 比较并写入。 |
| Open n → closed | `ui/surface.closed` | 保留最终视图，禁用输入/动作 | 普通 `ui_close` 结果；重复关闭不新增事实。 |
| 新命令 → received | `ui/action.received` | 显示已接纳/排队，冻结该 surface 提交 | 尚无业务结果；确认接纳使用该命令回执。 |
| Received → rejected: invalid | `ui/action.rejected`（`UI_INVALID`） | 字段/动作错误，不执行 | 安全的类型化拒绝入队一次；含输入/参数/Schema 错误。 |
| Received → rejected: stale | `ui/action.rejected`（`UI_STALE`、当前 revision） | “数据已变化，请重新确认”；读取当前数据，再次确认 | 拒绝入队一次；revision 不符绝不执行。 |
| Received → rejected: closed | `ui/action.rejected`（`UI_CLOSED`） | 同样的重新确认提示；关闭视图保持只读 | 拒绝入队一次；closed 属于陈旧动作类，具有具体原因。 |
| 重复传输提交 → 首个命令状态 | 相同请求不新增执行/事实；返回原命令最新持久回执，`duplicate: true` | 重新关联首个结果，包括待处理状态 | 不新增 queued input。这是重复提交处置，不是新业务动作被拒绝。 |
| 相同 commandId、请求改变 → rejected: duplicate | 首个回执保持不变；既有命令 journal 记录冲突，不新增动作链 | `UI_COMMAND_CONFLICT`；不覆盖首个结果 | 无执行/输入；调用方应读取首个命令。 |
| Received → rejected: unauthorized | `ui/action.rejected`（`UI_UNAUTHORIZED`）；适用时含既有 policy 拒绝 | 解释工具不可用/动作被拒 | 拒绝入队一次；无业务效果。 |
| Received → pending-approval | 既有 `tool/call`、`approval/asked`；`ui/action.pending-approval` 关联 invocation 与票据 | 既有审批 UI，加两处等待状态 | 无成功输入；业务确认与权限分离。 |
| Pending-approval → rejected: unauthorized | 既有 `approval/decided` 与工具拒绝；`ui/action.rejected` | 审批拒绝/取消 | 拒绝入队一次；恢复原 invocation 返回原拒绝。 |
| Received 或 pending-approval → executing | `ui/action.executing`；既有获授权工具/效果 intent | 处理中，锁定动作 | 尚无终态输入；插件事实本身不证明授权或派发。 |
| Executing → succeeded | 既有 `tool/result`、`effect/settled`；`ui/action.succeeded` 关联持久回执 | 成功与安全摘要；解锁 surface | 结果入队一次，Agent 继续并更新 surface。 |
| Executing → failed | 既有工具/效果错误或恢复证据；`ui/action.failed` 含 `retryable`、`outcomeUnknown` | 错误；只允许符合条件的重试；未知结果须对账 | 失败入队一次；不乐观修改业务数据。 |
| Failed → retried → received（新命令） | `ui/action.retried` 关联 `retryOf` 与新命令；新的 `ui/action.received` | 保留旧失败，新尝试显示排队 | 重新校验/授权；旧命令始终保留失败结果。 |
| 终态 → 待投递 → 已投递 | 既有 SC1 enqueue/claim 事实；`ui/action.delivered` 关联队列项 | 终态显示不依赖 Agent 进度 | 稳定投递键由会话 + command id 派生；重放补投递而不重复输入。 |

`retried` 是两次尝试间的边，不是原地重置或额外 `UiActionStatus`。只有普通工具路径要求审批时才进入 `pending-approval`。审批/执行拒绝与业务工具错误区分。派发前失败/取消在效果证据证明未执行时可重试；派发后的工具错误不会自动变成安全重试。

### 幂等与顺序

持久键为 `(sessionId, commandId)`，包括拒绝的提交；认证后、stale/closed 校验、限流与工具派发前查询。比较规范化的完整请求（不含传输 request id）；相同请求始终返回首次尝试当前回执，即使 surface 后来变化或关闭。同键不同请求属于重复冲突，不能改变首个结果。`UI_COMMAND_CONFLICT` 是类型化 `SEMANTIC_REJECTED` RPC 拒绝，不是改写首个动作回执。`UiActionReceipt.seq` 指向最新动作事实；`duplicate` 是响应元数据，不是持久业务状态。客户端重连保留 command id，仅在新的用户决定或显式安全重试时生成新 id。

Render/update/close、提交接纳和执行状态转换沿会话 ledger 既有单写者顺序串行化。Received 命令在完整验证与普通工具授权通过前不具有权限。回执与调度之间失败可从 `action.received` 恢复。稳定 invocation 身份绑定接纳参数；审批恢复同一个 invocation。不能新建工具调用来消费已有票据。不承诺外部效果恰好一次；未知回执遵循既有效果恢复规则，在对账完成前不可重试。

不同 command id 仍可能重复同一业务意图。同一 surface 仅有一个处理中动作；成功终态后 Agent 必须 update/close 以反映已处理行，业务工具必须拒绝已处理交易。传输幂等不能替代业务验证。

## 恢复与降级

| 情况 | 必须采取的恢复行为 |
| --- | --- |
| 浏览器刷新/重连 | 在一致 ledger 水位读取 surface/回执分页，然后接续该序号之后的既有会话事件；发现缺口则重新读取。两处使用同一投影。挂载卡片不能触发执行。 |
| 未保存草稿 | 可选的会话级浏览器本地草稿，按 surface/component/revision 关联，卡片与面板共享。它不是后台处理状态。Revision 变化时丢弃或显式重新基于新数据编辑，不静默提交旧草稿。即使草稿未保存，刷新仍恢复后台已提交数据。 |
| 待审批时刷新 | 从既有审批记录恢复原 invocation/票据，不能只读 UI 状态；展示既有审批控件。不自动批准、不新建票据。 |
| 派发前 daemon 重启 | 重放 surface/action 事实，重建待处理工作；验证不可变绑定，通过普通 Loop helper 执行一次。 |
| 执行中重启 | 查询既有 invocation/effect 状态。已知成功/失败补齐缺失终态 UI 事实，不重跑工具。待审批恢复原调用。缺失/不确定效果回执成为 `failed`，含 `outcomeUnknown: true`、`retryable: false` 与证据链接；既有对账机制解决后才能开始新尝试。 |
| 结果写入与 Agent 入队之间崩溃 | 扫描尚未投递的终态事实，使用同一 SC1 去重键入队。若入队先于投递标记成功，恢复已有队列项并补标记，不产生第二次结果输入。 |
| 工具失败与重试 | 保留旧失败；要求新 command id、`retryOf`、当前 revision/确认、已证实的重试资格与重新普通授权，串联两次尝试。 |
| 锁定插件/Loop 缺失或投影损坏 | 遵循既有 generation/恢复的默认拒绝行为。可行时从 ledger 重建合法投影，否则展示不可用/证据缺口并禁用动作。 |
| 不支持预设渲染的 TUI/channel | 纯文本标题、revision、状态、行/金额摘要、动作标签，附指向既有 Web 会话 surface 面板的已认证链接。不能创建公开 bearer 链接，不能因展示文字标签就调用工具。文字“确认”本身不是 UI 提交或审批。 |

分页 cursor 绑定快照水位与筛选。快照期间实时事件先缓冲，再顺序应用；重连使用标准 session attach/catch-up 机制。Cursor 过期则重新读取。重建投影不新增业务事实。展示分页或缓存淘汰不能遗忘持久命令。

## Trace、试点与后续迁移

Fact-chain 与 trace 展示 surface id/revision 和归属、received 命令/actor、解析后的工具 invocation、审批、效果与结果、终态 UI 事实、Agent 队列输入及 Agent 下一次 surface 更新。按 ledger 序号与稳定 id 关联，不能靠相近时间猜测。缺失回执/投递/revision 链接明确展示为缺口。UI 不能将插件编写的标签/事实提升为授权决定证据。

[财务对账试点](../../examples/fde/finance-reconcile/index.mjs) 保持合成源账本和精确整数分。对账后渲染差异、柱状图和调整表单。“确认调整”映射到现有模拟调整工具 `fde_finance_approve`，保留其需要审批的元数据与 policy。业务工具根据已提交对账事实与选择校验提案，包括交易成员、整数分、原因、无重复 id、是否已处理。表单编辑不能悄悄覆盖已提交差异。获得权限与模拟回执后，queued result 恢复 Agent；Agent 将已处理行更新为 `simulated-approved`，保留未解决交易，明确 `posted: false`。审批拒绝/失败不能标记行已处理。通用 deferred-invocation drain 替换试点既有业务提问阶段，不再要求第二次自由文本 “Proceed”。

### 已审阅的自定义组件

业务插件可在 `contributes.client.intelligentComponents`，或普通插件的 `agnes.client.json` 描述符的 `client` 对象中声明命名空间 kind：`<plugin-id>/<name>@<major>`。扩展 manifest 的 namespace 是扩展 id；普通插件描述符使用包名。major 必须为正整数；不兼容的 props 合同变化需要新的 major。

```json
{
  "client": {
    "id": "reconciliation-diff",
    "entry": "./reconciliation-diff.mjs",
    "intelligentComponents": [{
      "kind": "@agnes-fde/finance-reconcile/reconciliation-diff@1",
      "propsSchema": { "type": "object", "required": ["rows"], "properties": { "rows": { "type": "array", "maxItems": 1000 } }, "additionalProperties": false },
      "maxPropsBytes": 16384,
      "fallback": "请审阅下方预设差异表。",
      "accessibility": { "label": "对账差异", "keyboard": true }
    }]
  }
}
```

模块导出 `renderers` 对象，键为声明的完整 kind。函数接收 `(mount, props, api)`，可返回清理函数或其 Promise。`@agnes/web-client` 导出 `IntelligentUiRenderer` 与 `IntelligentUiRendererApi` 类型。API 仅有 `emitAction(id)`、`readTheme()`（`light`/`dark`）和 `readLocale()`（`en`/`zh-CN`）。action id 必须同时在组件 `actionIds` 与 surface `actions` 中；宿主调用现有 surface 的确认、工具及审批路径。组件不能提交 input、row、工具名，也没有会话或服务访问接口。

自定义模块沿用现有安装审阅、能力摘要、信任、不可变资源和会话 generation 名册。入口必须是自包含 ESM（不超过 262,144 字节），不允许运行时 import、slots、services 或外部样式。代码在独立 opaque-origin iframe 中运行，`sandbox="allow-scripts"` 与该文档的 CSP 禁止 fetch/网络资源、表单和嵌套 frame。宿主不将其 import 到自己的页面。渲染器只拥有自身 frame 的 mount；使用 `textContent` 展示文字，提供语义标签、键盘可操作控件、可见焦点，并在卸载时清理资源。manifest 的 keyboard 要求是作者与审阅者的责任，不等于自动无障碍认证。

模型只输出数据组件：`id`、命名空间 `kind`、`dataKey`、`fallback`、`actionIds`（可选 `title`）；props 位于 `surface.data[dataKey]`。后台 `validIntelligentSurface(surface, declarations)` 从持久会话 generation 取得声明，在持久化前按本地同步 JSON Schema 校验 props，核对声明的原文 fallback，并拒绝未知或不唯一的 kind。不能替换为当前安装版本。限制：每模块最多 16 项声明；Schema 最多 16,384 字节、深度 16；props 不超过声明的上限（1–16,384 字节）；fallback 为 1–4,096 字符；继续遵守现有 surface 字节、深度与组件数量上限。Schema 不得加载远程引用或异步执行。

找不到已审阅、ready、锁定版本的模块，或加载/渲染失败、加载超过 15 秒时，该组件显示声明的文本回退与本地化提示，其他组件继续工作。TUI 与 channels 从 `ui_render`/`ui_update` 工具文本得到 fallback。[财务示例](../../examples/fde/finance-reconcile/client/agnes.client.json) 使用小型对账差异组件，并保留旁边的预设差异表作为可用回退。


预设 question/table 迁移与经认证的文本客户端提交见下方“问答、表格与交付物 surface”。自定义 renderer 使用相同 surface 事实和动作路径，文本客户端展示声明的 fallback。业务答案仍不代表权限授予。

## 实现验收

扩展最近的有意义测试，覆盖状态表每项转换、规范化命令重复/冲突、非法 Schema/绑定、revision 改变、关闭 surface、归属/任务及工具缺失/不支持 Loop 拒绝、policy/approval/auto-review 拒绝、sandbox 失败、容量/限流接纳、并发命令、工具错误和安全/不安全重试、回执/投递崩溃缺口、待审批/未知效果下的重启恢复。包含 scripted-model 财务流程和共享 inline/panel 状态、刷新、重新确认的 Web spec。真实 daemon/worker 测试放在 `*.e2e.test.ts`；大 ledger/真实定时器测试放在 `*.slow.test.ts`。测试可观察的回执、事实、工具结果和 queued input，不固定内部调用次数。后台与渲染实现审阅完成后，才能声明此能力可用。

公开的可选 `ExtensionAPI.intelligentUi` 适配器在插件已有的 events 与 `surfaces` projection 权限下注册 `IntelligentUiFactory`。`session(ref)` 只能在有效且 owner 匹配的工具／hook 回调内使用。Host 提供 `IntelligentUiPorts`：规范会话／任务身份、本命名空间的账本读写、只读已声明工具 schema、通用 deferred 队列，以及幂等 SC1 投递。Daemon 先验证已认证会话归属，再调用同一会话服务。该适配器没有执行或审批权限。SDK 会话新增 `uiAction()`／`uiRead()`。Projection 保留完整 surface、活跃 receipt，以及字节预算内最近最多 64 条终态 receipt；更早命令仍可通过 `ui.read({ commandId })` 与账本重放恢复。总 projection 预算内为 receipt 预留 64 KiB。

财务 Loop 使用 version 4／codec 4，通用排空 deferred 队列，并在完成 step 的边界领取 SC1。业务校验基于已经提交的 reconciliation checkpoint；成功后先把已处理交易 ID 记录到该 checkpoint，再报告队列完成。原 invocation 可以恢复缓存回执，另一个 command 不能重复模拟相同交易。opaque invocation ID 为 surfaceId、revision、commandId 的 SHA-256 绑定，符合现有 128 字符工具 ID 上限；Surface schema 形状完全未改。Fact-chain 新增有界 `plugin-fact` 元数据节点，展示修订、deferred 状态、action 结果和 SC1 投递，只按明确 seq/id 引用连接。Trace 在 Core 之外追加有界元数据 span，标签不包含表单数据或参数。

公开 Host author testkit 为本试点提供 `AuthorSession.uiAction()`／`uiRead()`；`AuthorTestOptions.packageDirs`、`presets`、`preset` 显式指定隔离夹具的官方 manifest 和业务策略预设，不读取开发者 home 或凭证。

后台与渲染器复用 `@agnes/protocol/intelligent-ui` 的 surface 验证，包含表格列和图表展示语义。默认读取开放视图；按 `surfaceId` 读取仍可获得关闭后的账本证据。关闭视图不占投影容量，也不允许复用 ID。

读取 cursor 经过签名，60 秒过期，并绑定水位、筛选与页大小。后续页按该水位重放，不重复首页面的有界回执。后台结果 follow-up 在 cancel 后保留为 next-turn 输入；delivery 确认持久入队，队列 claim 才消费输入。

后台结果的 inbox 项使用 `origin: system` 与 `trust: untrusted`，与提交动作的人类 actor 分开记录。

## 问答、表格与交付物 surface

`ask_user_question` 保持模型侧参数。官方交互生产方通过普通工具调用 `ui_render`：问答使用预设 form 和声明的 `ui_submit` 收集工具，表格使用 table，交付物使用纯文本及既有 artifact 引用。收集工具核对 Host 记录的 deferred invocation 和不可变的认证 action，拒绝模型直接调用。成功收集关闭 surface，经 SC1 投递完整答案，保留认证 actor 与 untrusted 内容。回答不授予工具权限。持久化超时只限制可选等待，不关闭表单或使晚答失效；deferred 执行在下一个安全 Loop 边界进行。

文本客户端通过 `ui.read` 恢复 surface。TUI 展示编号选项，以 `ui.action` 提交表单草稿；保留展示版本，传输重试复用同一 command。复杂表单／动作使用认证 Web 链接。渠道展示相同 surface 数据与编号选项；现有回调协议不能认证 surface action，因此通过 Web 链接提交。渠道 runner 的 `outbound.webUrl` 配置为可达的 HTTP(S) Web 基础地址，不含凭据、查询或片段。链接仅含 session/surface 标识，仍需正常 Web 认证与归属校验，不携带 token 或权限授予。
