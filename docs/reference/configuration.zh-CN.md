# 配置参考

[English](configuration.md) | 简体中文

[文档导航](../README.zh-CN.md) · [首次配置](../guide/quickstart.zh-CN.md)

用本页查找配置存在哪里、在哪一层生效，以及哪些字段由管理服务维护。首次配置模型可直接走[快速开始](../guide/quickstart.zh-CN.md)，无需先读完整配置表。

配置文件与模型凭据分离。优先使用 CLI `config` 或 Web 设置修改 Provider；不要手写含密钥的 YAML 或自行编辑配置服务的 revision。

## 位置与层级

| 位置/变量 | 含义 |
| --- | --- |
| `AGH_HOME` | 绝对 home 根，缺省 `~/.agh`；相对路径拒绝 |
| `AGNES_HOME` | 旧兼容变量，有弃用警告；AGH_HOME 优先，无自动迁移 |
| `AGNES_PROFILE` / `--profile` | Profile 选择，通常为 `local-dev` |
| `AGH_HOME/profiles/NAME/profile.yaml` | 用户 profile 层 |
| `AGH_HOME/profiles/NAME/configuration.json` | Host 配置服务管理的账号、默认模型与引用，不能当成手工配置模板 |
| `PROJECT/.agh/profile.local.yaml` | 工作区覆盖，按信任/权限规则使用 |
| `PROJECT/.agh/skills` / `PROJECT/.agh/hooks.json` | 工作区 Skill 与命令 hook 资源 |
| `AGH_HOME/data`、`cache`、`secrets`、`auth` | 数据、缓存、凭据与身份状态 |
| `AGNES_WEB_ORIGIN` | 精确 Web Origin，如 `http://127.0.0.1:4180`，与 serve 端口配对 |

builtin 模板是基础，用户 profile 与 Host configuration overlay 合并，再按工作区信任处理 local 层；部署与锁文件也影响最终解析。配置服务负责的键在用户层具有自己的覆盖规则，不是任意 YAML 深合并。只改变 cwd 不选择另一个 daemon。

## Profile 可配置面

| 字段 | 内容与约束 |
| --- | --- |
| `name`、`schemaVersion`、`extends` | 配置身份/版本/继承；现有模板 schemaVersion 为 1 |
| `packages` | 包来源、启用与配置；实际安装/信任仍由 PackageManager 管理 |
| `seams` | 必要接缝实现归属；不是普通插件自由注册的接口 |
| `provider` | package/adapters/routes/catalog/contract；route 名 `default` 是保留 sentinel |
| `adapters` | storage/fs/exec/platform/secrets 选择 |
| `transports` | stdio/unix/ws-tls，远程配置另需证书与认证 |
| `dataDir`、`cacheDir` | 数据/缓存位置；改变它们可能改变共享实例身份 |
| `presets` | default 与 allowed；默认必须在允许集合中 |
| `approvals.mode` | manual/smart/off |
| `reconcile` | immediate/turn/step；maxWaitMs 仅适用 turn/step |
| `policy.capabilityCeiling` | 能力上限；默认不含 services |
| `policy.workspacePackages` | deny 或 require-project-trust |
| `computerUse` | 启用、应用访问范围、捕获与保留限制 |
| `extensionIsolation` | 隔离请求与不可用处置，不能凭声明证明真实保护 |
| `limits` | daemon/worker/jobs/shutdown 等受支持的点分键 |

完整字段以[Profile Schema](../../packages/protocol/schema/profile.json)、[实际类型](../../packages/host/src/profile/types.ts)、[local-dev 模板](../../packages/host/templates/local-dev.yaml)及[enterprise 模板](../../packages/host/templates/enterprise.yaml)核对。Schema 合法只是第一步，策略与装配可能进一步拒绝。

## 模型与密钥

现行配置服务支持账号列表、每账号 route 和默认账号，账号路由可能为 `account-...`。选择界面返回的 route/model，不假设所有 DeepSeek 账号共享同一路由。Provider/模型能力来自目录和合同，保存时还校验所选项；修改默认值不追溯改写旧会话。

Web 账户设置可为所选模型保存 `defaultSettings`：`thinking` 只能选择已安装 adapter 声明的档位，`contextWindow` 表示本会话的上下文预算，单位为 Token，不能超过模型目录容量。新保存的预算必须是至少 2,048 Token 的安全整数；模型容量不足 2,048 时，允许使用其完整容量。新会话保存这些默认值的快照，会话中的后续修改单独持久化，重开与分叉后仍保留；修改账户默认值不会覆盖它们。会话预算控制 Harness 的用量统计和压缩，与 `model.max_tokens` 分开，不能扩大 Provider 的实际容量。较小预算下，预留量最多占会话预算的四分之一，近期记录最多占剩余预算的一半，不再按会话预算与模型容量的比例缩小；自动模式在能容纳预设策略时保留原策略。摘要请求使用压缩模型自身的容量和输出上限，不继承主模型会话较小的预算。发起请求或摘要前，会检查较小预算能否容纳估算的固定指令、工具定义和预留量；容纳不下则停止并提示调大预算或恢复自动。旧会话的已保存预算仍可读取和修改。

整理阈值为会话预算减去预留量，因此上下文尚未超过完整预算也可能触发整理。找不到可安全压缩的较早消息时，预算审批会说明实际整理阈值，并提示调大预算或恢复自动。

API 客户端可通过 `_agnes/v1/session.setModel` 传入可选的 `thinking`、`contextWindow`。同一模型下省略字段会保留会话当前值；`thinking: null` 恢复 Provider 自动思考，`contextWindow: null` 恢复目录容量。`_agnes/v1/config.save` 和 OAuth `commit` 接收 `defaultSettings`，省略时保留已保存默认值，传 `{}` 清除。配置与模型列表接口返回能力和默认值，会话用量投影返回当前生效配置。

### JevLoop 分环节模型槽位

Preset 可以用 `model.jev_language_slots` 把 JevLoop 的每个语言环节绑定到独立模型槽位（`parameters` 补参、`arbitration` 仲裁、`answer` 回答；取值为协议槽位名，未写的环节保持 `primary`）：

```yaml
model:
  route: { primary: gw, fast: gw, escalation: gw }
  id: { primary: answer-model, fast: param-model, escalation: arb-model }
  thinking: { escalation: high }
  jev_language_slots: { parameters: fast, arbitration: escalation, answer: primary }
```

此后每个环节经其绑定的槽位解析 route、模型、thinking 与上下文窗口：对该槽位的授权 `session.setModel` 只影响绑定它的环节，各槽位的 thinking 强度独立生效。映射本身只是部署默认：`_agnes/v1/session.setJevStages` 可把某环节为当前会话直绑到 route/model（可带 thinking），传 `null` 恢复预设槽位解析；直绑有审计、重开保留、下一请求生效，无需改 preset。只读 RPC `_agnes/v1/session.modelSlots` 返回逐槽位实时解析状态、含默认值的生效环节映射与直绑状态，不打开也不恢复会话。`_agnes/v1/comparison.create` 在 JevLoop 一侧的 lane（`left`/`right`）上接受同形的 `jevStages`，其他运行时拒绝。成本提示：分档后各环节不再共享同一前缀缓存命名空间，每个冷环节各自支付全前缀读取——仲裁是少数路径时分档才划算，反之会倒挂。参见[运行循环](../guide/runtime-loops.zh-CN.md#jevloop)。

凭据形式为 `secret://namespace/name`；文件/env/vault adapter 是不同部署面。不要将演示配置里的假 token 复制到真实服务，也不要在 browser `publicConfig`、工具输出或环境 dump 中暴露真实值。

包导出的 [preset 定义](../../packages/protocol/schema/preset.json) 可用正安全整数配置 `model.max_tokens`，例如 `model: { max_tokens: 32768 }`。它设置主模型单次请求的输出额度，与模型目录容量分开；省略时沿用 Provider 默认值。请求 hook 可覆盖它，任务树预算仍可压低额度，应使用所选 Provider 支持的值。该字段属于 preset 定义，不属于 profile 的 `presets` 选择字段或 profile 顶层 `model` 字段。现有会话保留创建时解析的 preset。

预设的 `tools.output_max_bytes`（整数，4096 到 1048576，默认 32768）决定模型最多能看到一条工具结果的多少，超过就由输出守卫截断：保留预算的前一半和最后八分之一，完整内容另存，被截断的结果会给出 `read` 与 `grep` 都认的 `artifact://…` 路径，用来读回其余部分；`read` 的分页也按同一上限。值越大，模型每条结果看到的越多，上下文和会话账本里留到压缩前的内容也越多，调大要慎重；调小最低到 4096。已经打开的会话沿用开始时解析的值。

使用 Agnes 中国官方网关时，若请求未覆盖额度，adapter 会明确将内置模型的目录额度 65536 作为 `max_tokens` 发送。[3.0 Flash](https://agnes-ai.com/zh-Hans/docs/agnes-30-flash)、[2.5 Pro](https://agnes-ai.com/zh-Hans/docs/agnes-25-pro)和 [Pro Alpha](https://agnes-ai.com/zh-Hans/docs/agnes-25-pro-alpha) 的官方规格为 65536；[Pro Beta](https://agnes-ai.com/en/docs/agnes-25-pro-beta) 按 Pro 同系额度配置为 65536，尚未单独验证网关容量；[2.5 Flash](https://agnes-ai.com/zh-Hans/docs/agnes-25-flash) 和 [2.0 Flash](https://agnes-ai.com/zh-Hans/docs/agnes-20-flash) 的官方说明使用约数 65.5K，此处按 65536 配置。已废弃模型保留注册以兼容现有配置，其可用性取决于网关。请求中明确设置的额度仍优先。仅修改目录元数据不会设置底层 OpenAI 兼容流请求的额度。大文件仍应通过多次小型 write/edit 调用分段构建；默认额度不能保证任意大的单次调用都能完成。

Preset 的 `subagent.tree_budget_credits` 区分三种策略：省略或填写 `default`，保留新委派任务树
默认 20 credits 的既有行为；数值设置有限额度；显式 `unlimited` 不添加新的任务树额度。
原始配置中的 `null` 非法，内部旧的 nullable view 仍保留默认行为。继承时省略字段会保留上级值，
`default` 和 `unlimited` 则显式覆盖上级 preset 的值，但都不会改变祖先 scope 已持久化的有限额度
或正整数 `subagent_spawn.budget` 子任务额度。零不是无限，不能准入任务树额度预留。Credits 是
计量单位，不能展示为美元。常规 `standard` 将两项都设为 `null` / `unlimited`，普通任务无需价格
估算；`standard-no-credit-cap` 保留为同一策略的兼容名称。自定义 preset 写入正数上限后，才会
重新启用费用检查。

## 自定义 OpenAI 兼容账户

在 Web **设置 → 模型与账户 → 添加账户**中选择 **自定义 OpenAI 兼容服务**（`custom-openai`），填写 Base URL、API key 和手工模型 ID，选择 Chat Completions 或 Responses。明确声明上下文容量、最大输出、图片输入、推理及原生 OpenAI 工具调用；输出不得超过容量。模型列表不能证明这些能力。连接测试通过实际运行时适配器，对所选 ID 做有界流式推理，无 `/models` 的服务也可使用；测试不证明工具调用或图片能力。未配置价格保持未知，不当作免费估价。 已验证的自定义账户保存时，还会尝试有界认证 GET `<Base URL>/model/info`，按精确模型 ID 匹配 HTTPS 元数据来源的 LiteLLM 格式 USD/token 价格，换算为每百万 token 的估算。同一 ID 的全部部署必须价格一致；条件／阶梯价格或无法识别的其他收费保持未知。缺失单价保持未知，明确零单价保留为零。元数据请求被拒绝、不支持、损坏或超时不阻碍保存。只持久化按账户与模型区分的单价、来源和读取日期，运行时加载不查询价格。重新保存会刷新快照，元数据不可用时清空估算，不静默保留旧单价。每次调用在接纳时冻结自己的报价，新价格不改写历史报价或网关账单。 已有自定义 API-key 账户可通过 `config.account({accountId, action: "refresh-prices", expectedRevision})`，使用保存的端点与凭据仅刷新价格快照。该操作保留模型声明、默认设置、凭据及其他账户，不进行推理或能力验证；普通保存仍执行完整连接检查。

点击 **获取模型列表** 读取服务的有界认证 `/models` 目录，选择默认 ID，再点击 **一键导入模型 ID** 将返回的 ID 加入当前账户。所有导入模型共用你在本页明确设置的能力和容量声明；目录不提供能力或价格证据。保存验证所选默认模型的推理，不逐个调用全部导入 ID。没有 `/models` 的服务仍支持手工 ID。SDK `config.discover` 返回目录证据和 `verified: false`，底层使用带 `catalogueOnly: true` 的 `config.test`，不写入配置。

Chat Completions 的测试分别展示普通推理和 `system → user → assistant → system → user` 请求是否被接受。结果绑定测试时的端点、协议和模型；修改连接或模型声明后，页面结果失效。未声明该能力时，中途 system 检查失败不妨碍保存普通账户。

JevLoop 的语言调用要求明确声明服务 **保留中途 system 消息的顺序**，新自定义账户默认不勾选。推理成功只证明请求可被接受，不证明网关内部没有合并、删除或重排消息；测试不会自动开启该声明。请依据服务契约或实现证据确认保序。保存会按当前配置重新测试；声明该能力时，中途 system 检查也必须通过。Responses 跳过此项，不支持当前 Jev 历史路径。`config.test` 可选返回 `customVerification`，失败理由为固定枚举，`ordering` 始终为 `unverified`；不会返回上游原始错误或密钥。Cloudflare Jev 按操作方策略复用 System One 的配置估算（输入 0.042 USD、输出 0，按每百万 token 且按总输入计），这是配置估算，不是 Cloudflare 账单。费用上限须显式配置，因此常规任务不依赖价格资料即可执行。

非秘密声明随账户保存在 `configuration.json`；密钥仍由当前 home 的凭据存储管理，配置读取不返回密钥。修改目标或协议须明确输入密钥，修改声明使页面旧测试结果失效。新账户默认值不改变既有会话。

## Jev 决策服务

使用 Web **设置 → Jev 决策服务**，或 Jev 插件的 **配置 Jev** 快捷入口。公共设置不依赖插件安装。决策后端可选 **Jev** 或 **本地 Laya（实验性）**，测试后保存。Jev 支持原生 HTTP 和 Cloudflare Workers AI。Cloudflare 要求 32 位小写十六进制 Account ID、Bearer token 和固定地址 `https://api.cloudflare.com/client/v4/accounts/{id}/ai/run`，默认模型 `typesafe/jev`。供应商测试账户勿用于生产。原生 HTTP 允许显式 Bearer 或无认证。

本地 Laya 仅支持原生 HTTP。先另行启动服务，再配置 `http://127.0.0.1:8791/v1/systemone`、模型 `multilingual`；匿名服务须显式选择无认证。受保护的 Laya 服务使用自己的 Bearer 密钥，切换后端不能隐式复用已保存的 Jev 密钥。语言模型账户不变，运行方式仍为 JevLoop。Laya 不继承 `TYPESAFE_API_KEY`，失败也不会回退到云端决策服务。启动与限制见[本地 Laya](../guide/runtime-loops.zh-CN.md#local-laya)。

两套目标可以同时保存：保存一侧后端不会覆盖另一侧的目标或凭据引用。重启后，运行方式目录会公布实际启动的决策后端、默认值和各自不可用原因；配置的默认后端无法启动时，只在启动时一次性解析到另一个已装配目标。每一轮都可以覆盖默认值：输入框旁的“本轮决策”选择器（JevLoop 会话与双线对比的 JevLoop 侧）随输入提交选择，持久队列把选择绑定到该输入；同一 command id 的重试必须沿用相同选择。运行中的轮次不会中途切换——steer 不能改变当前轮的后端。选择不可用后端会在输入被消费前拒绝，不会回退到另一个后端。决策流程图与请求查看器按账本记录标注每个请求的真实后端（Jev、Laya 或语言模型），不读取当前界面状态。

Profile 下的 `jev-configuration.json` 只保存带 revision 的设置和凭据引用；读取永不返回 token。可选每次请求 credits 须为正数，与实际 token 用量分开，仅用于准入。测试只发一次合成评分请求，不保存、不启动 Agent。Revision 冲突需重新读取再保存。

保存后的反馈显示在固定操作栏，不会随表单滚动隐藏。保存成功会重新读取运行方式列表；尚未激活的 Jev 显示“配置已保存，需重启后台后生效”，不会误标为可用。若环境变量覆盖仍生效，提示先检查环境配置再重启。

**保存 Jev 后须手动重启 daemon。** 运行中的 daemon 为所有 worker 代冻结配置，旧凭据引用保留供其运行中的 worker 使用；保存不重启进程、不改变当前会话。嵌入式 Host 在创建时冻结。启动优先级为显式 Host options、显式 Jev 环境配置、持久 profile 配置；部分环境配置会令 Jev 不可用，不与已保存 token 混用。仅 HTTP/2 开关不算目标覆盖。配置异常只禁用 Jev，不阻止 Native。

## 任务步数限制

普通任务默认不设累计执行步数上限。Core 默认值及内置 `base`、`standard`、`claw` preset 均使用 `budget.max_steps: null`，不会再因为达到 50、80 或 200 步而截停。一“步”是主模型的一轮执行，可包含多个工具调用。任务完成、用户取消、模型请求失败、单次请求超时、循环检查，以及显式配置的费用上限仍然生效。冻结的 `minimal-rl` 评测 preset 保留其明确配置的 100 步上限。

包导出的 preset 定义可用 `budget: { max_steps: null }` 关闭上限，包括覆盖继承来的上限；只有明确设置正整数，例如 `budget: { max_steps: 80 }`，才启用每轮任务的步数限制，耗尽后仍以 `max_steps` 结束。零、负数、小数和字符串均不合法。省略该字段会继承父 preset 的设置；没有继承值时默认不设上限。它属于 preset 定义，不是 profile 的 `limits` 键。

已打开的会话继续使用内存中解析好的 preset；重启服务后重新打开会话，或新建会话，会按更新后的默认值重新解析。自定义 preset 若明确配置数字上限，仍保留该限制。替换 Budget 段的扩展需要将 `maxSteps: null` 视为没有步数上限。内部执行循环仅限制程序计数器连续没有提交变化的状态转移，不按整个任务的累计步数计算，因此正常推进的长任务不会消耗这项保护额度。

## Skills 同名优先级覆盖

默认来源优先级为 workspace 500、runtime 450、AGH user 400、agents 300、claude 200、codex 100、package 50。用户可对非 runtime 候选设置 50–500 的整数覆盖，或传 `null` 恢复来源默认；该数据按 profile/resourceId 保存在资源控制 journal，并随 worker control 快照应用。它不是新 profile YAML 字段，不应手改 journal。

保存同时比较内容 `expectedRevision` 与当前 `expectedPriority`，不会自动修改 trust/desired。同名 winner 先按优先级解析，再按自身授权判定可用；没有“高位禁用就自动启用低位”的保证。操作见[Skills](../guide/skills.zh-CN.md#调整同名候选优先级)，合同见[资源 Schema](../../packages/protocol/schema/resource-control.json)。

## 插件配置不是 profile 顶层任意键

普通插件默认配置来自 `agnes.plugins[].config`，由导出的 `Config` 校验。部署/用户/工作区普通行覆盖由装配接口处理；不要猜一个未被当前解析器接受的顶层 `plugins:` 就会生效。包入口、配置与 inject/provide 的精确形状见[插件教程](../develop/plugins.zh-CN.md)。

源码依据：[输入合并](../../packages/host/src/profile/inputs.ts)、[解析](../../packages/host/src/profile/resolve.ts)、[配置存储](../../packages/host/src/configuration.ts)、[后台身份](../../packages/daemon/src/supervisor/scope.ts)、[daemon limits](../../packages/daemon/src/config.ts)。
