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
| `persistence` | `{ provider: id }`。默认 `sqlite`，默认值不写入解析后的 profile。仅用户 profile 可设置。更改后需要重启。协议 schema 尚未列出该字段；Host 类型和用户 YAML 接受它。 |
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
| `sandbox.provider` | 启动时的沙箱提供者 id，默认 `local`。更改需要重启进程。见[沙箱提供者](../guide/sandbox-providers.zh-CN.md) |

完整字段以[Profile Schema](../../packages/protocol/schema/profile.json)、[实际类型](../../packages/host-common/src/profile/types.ts)、[local-dev 模板](../../packages/host-common/templates/local-dev.yaml)及[enterprise 模板](../../packages/host-common/templates/enterprise.yaml)核对。Schema 合法只是第一步，策略与装配可能进一步拒绝。

## 模型与密钥

现行配置服务支持账号列表、每账号 route 和默认账号，账号路由可能为 `account-...`。选择界面返回的 route/model，不假设所有 DeepSeek 账号共享同一路由。Provider/模型能力来自目录和合同，保存时还校验所选项；修改默认值不追溯改写旧会话。

Web 账户设置可为所选模型保存 `defaultSettings`：`thinking` 只能选择已安装 adapter 声明的档位，`contextWindow` 表示本会话的上下文预算，单位为 Token，不能超过模型目录容量。新保存的预算必须是至少 2,048 Token 的安全整数；模型容量不足 2,048 时，允许使用其完整容量。新会话保存这些默认值的快照，会话中的后续修改单独持久化，重开与分叉后仍保留；修改账户默认值不会覆盖它们。会话预算控制 Harness 的用量统计和压缩，与 `model.max_tokens` 分开，不能扩大 Provider 的实际容量。较小预算下，预留量最多占会话预算的四分之一，预留量与近期记录都不再按会话预算与模型容量的比例缩小；整理时保留的近期记录，最多占阈值之下扣除估算的固定指令和工具定义后剩余空间的一半，使整理后的第一个请求落在阈值之下；自动模式在能容纳预设策略时保留原策略。摘要请求使用压缩模型自身的容量和输出上限，不继承主模型会话较小的预算。发起请求或摘要前，会检查较小预算能否容纳估算的固定指令、工具定义和预留量；容纳不下则停止并提示调大预算或恢复自动。旧会话的已保存预算仍可读取和修改。

整理阈值为会话预算减去预留量，因此上下文尚未超过完整预算也可能触发整理。找不到可安全压缩的较早消息时，预算审批会说明实际整理阈值，并提示调大预算或恢复自动。若摘要请求本身无法工作（凭据无效、额度用尽、压缩模型配置有误），自动整理会按递增的回合数（最多 8 个回合）间隔重试；上下文距预算不足预留量一半时，本回合以 `COMPACTION_UNAVAILABLE` 和原因停止，而不是继续增长。

API 客户端可通过 `_agnes/v1/session.setModel` 传入可选的 `thinking`、`contextWindow`。同一模型下省略字段会保留会话当前值；`thinking: null` 恢复 Provider 自动思考，`contextWindow: null` 恢复目录容量。`_agnes/v1/config.save` 和 OAuth `commit` 接收 `defaultSettings`，省略时保留已保存默认值，传 `{}` 清除。配置与模型列表接口返回能力和默认值，会话用量投影返回当前生效配置。

凭据形式为 `secret://namespace/name`；文件/env/vault adapter 是不同部署面。不要将演示配置里的假 token 复制到真实服务，也不要在 browser `publicConfig`、工具输出或环境 dump 中暴露真实值。

包导出的 [preset 定义](../../packages/protocol/schema/preset.json) 可用正安全整数配置 `model.max_tokens`，例如 `model: { max_tokens: 32768 }`。它设置主模型单次请求的输出额度，与模型目录容量分开；省略时沿用 Provider 默认值。请求 hook 可覆盖它，任务树预算仍可压低额度，应使用所选 Provider 支持的值。该字段属于 preset 定义，不属于 profile 的 `presets` 选择字段或 profile 顶层 `model` 字段。现有会话保留创建时解析的 preset。

预设的 `tools.output_max_bytes`（整数，4096 到 1048576，默认 32768）决定模型最多能看到一条工具结果的多少，超过就由输出守卫截断：保留预算的前一半和最后八分之一，完整内容另存，被截断的结果会给出 `read` 与 `grep` 都认的 `artifact://…` 路径，用来读回其余部分；`read` 的分页也按同一上限。值越大，模型每条结果看到的越多，上下文和会话账本里留到压缩前的内容也越多，调大要慎重；调小最低到 4096。已经打开的会话沿用开始时解析的值。

预设的 `tools.timeout_ms`（整数，至少 1000，默认 120000）是一次工具调用在被内核强制截止之前最多能跑多久，`tools.timeouts`（工具名到毫秒数的映射，每项至少 1000）为指名的工具覆盖这个值。随包的 `base` 预设设有 `timeouts.shell: 600000`。`shell` 工具在模型不传 `timeoutMs` 时按 `tools.timeout_ms` 运行；模型可以申请更长，直到 `shell` 的上限，超出的部分按上限截断，所以前台命令最长 600000，而 `tools.timeout_ms` 仍是默认值。内核会在自己的强制截止之前一小段宽限（2000 毫秒与上限十分之一中的较小者）就把上限告知工具，因此超时的命令由执行器杀死，模型拿到的是已捕获的输出和一行 `[timed out after Nms: ...]`，而不是"结果未知"。当前构建没有可用的 shell 后台作业，所以调大上限是让一条命令获得更多时间的唯一办法。更长的上限会让这一轮及其写者租约占用同样长的时间，调大要慎重。已经打开的会话沿用开始时解析的值。

使用 Agnes 中国官方网关时，若请求未覆盖额度，adapter 会明确将内置模型的目录额度 65536 作为 `max_tokens` 发送。[3.0 Flash](https://agnes-ai.com/zh-Hans/docs/agnes-30-flash)、[2.5 Pro](https://agnes-ai.com/zh-Hans/docs/agnes-25-pro)和 [Pro Alpha](https://agnes-ai.com/zh-Hans/docs/agnes-25-pro-alpha) 的官方规格为 65536；[Pro Beta](https://agnes-ai.com/en/docs/agnes-25-pro-beta) 按 Pro 同系额度配置为 65536，尚未单独验证网关容量；[2.5 Flash](https://agnes-ai.com/zh-Hans/docs/agnes-25-flash) 和 [2.0 Flash](https://agnes-ai.com/zh-Hans/docs/agnes-20-flash) 的官方说明使用约数 65.5K，此处按 65536 配置。已废弃模型保留注册以兼容现有配置，其可用性取决于网关。请求中明确设置的额度仍优先。仅修改目录元数据不会设置底层 OpenAI 兼容流请求的额度。大文件仍应通过多次小型 write/edit 调用分段构建；默认额度不能保证任意大的单次调用都能完成。

## 任务步数限制

普通任务默认不设累计执行步数上限。Core 默认值及内置 `base`、`standard`、`claw` preset 均使用 `budget.max_steps: null`，不会再因为达到 50、80 或 200 步而截停。一“步”是主模型的一轮执行，可包含多个工具调用。任务完成、用户取消、模型请求失败、单次请求超时、费用预算和循环检查仍然生效。冻结的 `minimal-rl` 评测 preset 保留其明确配置的 100 步上限。

包导出的 preset 定义可用 `budget: { max_steps: null }` 关闭上限，包括覆盖继承来的上限；只有明确设置正整数，例如 `budget: { max_steps: 80 }`，才启用每轮任务的步数限制，耗尽后仍以 `max_steps` 结束。零、负数、小数和字符串均不合法。省略该字段会继承父 preset 的设置；没有继承值时默认不设上限。它属于 preset 定义，不是 profile 的 `limits` 键。

已打开的会话继续使用内存中解析好的 preset；重启服务后重新打开会话，或新建会话，会按更新后的默认值重新解析。自定义 preset 若明确配置数字上限，仍保留该限制。替换 Budget 段的扩展需要将 `maxSteps: null` 视为没有步数上限。内部执行循环仅限制程序计数器连续没有提交变化的状态转移，不按整个任务的累计步数计算，因此正常推进的长任务不会消耗这项保护额度。

## Skills 同名优先级覆盖

默认来源优先级为 workspace 500、runtime 450、AGH user 400、agents 300、claude 200、codex 100、package 50。用户可对非 runtime 候选设置 50–500 的整数覆盖，或传 `null` 恢复来源默认；该数据按 profile/resourceId 保存在资源控制 journal，并随 worker control 快照应用。它不是新 profile YAML 字段，不应手改 journal。

保存同时比较内容 `expectedRevision` 与当前 `expectedPriority`，不会自动修改 trust/desired。同名 winner 先按优先级解析，再按自身授权判定可用；没有“高位禁用就自动启用低位”的保证。操作见[Skills](../guide/skills.zh-CN.md#调整同名候选优先级)，合同见[资源 Schema](../../packages/protocol/schema/resource-control.json)。

## 插件配置不是 profile 顶层任意键

普通插件默认配置来自 `agnes.plugins[].config`，由导出的 `Config` 校验。部署/用户/工作区普通行覆盖由装配接口处理；不要猜一个未被当前解析器接受的顶层 `plugins:` 就会生效。包入口、配置与 inject/provide 的精确形状见[插件教程](../develop/plugins.zh-CN.md)。

源码依据：[输入合并](../../packages/host/src/profile/inputs.ts)、[解析](../../packages/host-common/src/profile/resolve.ts)、[配置存储](../../packages/host/src/configuration.ts)、[后台身份](../../packages/daemon/src/supervisor/scope.ts)、[daemon limits](../../packages/daemon/src/config.ts)。
