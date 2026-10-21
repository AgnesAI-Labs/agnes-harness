# 沙叶 GMP 质量中枢

[English](README.md) · [演示 / Demo](DEMO.md) · [领域说明 / Domain notes](DOMAIN-NOTES.md)

一个可安装、可显式采纳的药厂质量应用，包名 `@agnes-showcase/pharma-gmp`。沙叶 / Sableleaf OSD、人员、产品、签名和证据均为虚构合成；名称经公开检索未发现明显同名药厂，并不构成商标审查。本应用是非无菌片剂/胶囊质量系统的教学示例，未经计算机化系统验证，不可用于真实放行或申报。

36 个批次、240 条环境记录、9 台设备、12 个偏差，场景时点为 **2024-10-20**。工作台整合质量总览、待办与签署、实时对象档案，以及批记录、偏差/CAPA、EM、QA 放行和审计模块。质量助手是统一入口，委派偏差调查、批记录复核、环境监测和放行前检查四个角色，委派卡片与完成通知保留角色归属。

从源码仓根运行（先按仓库安装指南构建本地 CLI）：

```sh
mise exec -- node tools/toolchain/run.mjs --filter @agnes-showcase/pharma-gmp build
export AGH_HOME="$(mktemp -d /tmp/agh-pharma.XXXXXX)"
export AGNES_PROFILE=local-dev
node agnes.mjs plugins inspect "file:$PWD/examples/showcase/pharma-gmp"
node agnes.mjs plugins install "file:$PWD/examples/showcase/pharma-gmp"
node agnes.mjs serve --port 4319
```

在插件页审阅准确的能力和完整性后信任、启用；在 **设置 → 应用** 预览并采纳沙叶应用。安装本身不采纳应用。选择 Demo 模型可通过 `call pharma_inspect {"batch":"B-2410-017"}` 等精确工具提示复现。推理步骤使用真实模型并参考 DEMO。`/?admin` 与 `agh app clear` 保留恢复能力。请勿将 home 指向真实 AGH 数据。

所有页面通过声明的 `pharma.snapshot`、`pharma.change`、`pharma.release` 档案服务访问数据，无需活动会话。后端状态在宿主绑定的 owner/profile 存储中持久化；无浏览器数据库和私有文件路径。变更采用事务、单调版本和审计记录；原始 OOS 不覆盖。页面保留 operationId，待审批/未知回执先查询；不得盲目重新提交。QA 放行同时检查清单、精确版本、固定签名含义及宿主批准凭证，签名人来自批准凭证。

`pharma_report` 生成 Markdown 与可打印 HTML，并调用 `present`。夜间任务通过环境监测智能体的标准 `schedule_create` 创建。智能体成长通过宿主插件候选工具创建、测试、提交审阅，并由人工发布精确哈希。会话继续使用宿主的代码 pin；升级不改写旧记录。

本地验证（仓根，遵循宿主工具链及 heavy-lock 规则）：

```sh
mise exec -- node tools/toolchain/run.mjs exec vitest run examples/showcase/pharma-gmp/test --project fast --maxWorkers=1
mise exec -- node tools/toolchain/run.mjs --filter @agnes-showcase/pharma-gmp typecheck
```

完整演示和浏览器证据脚本位于 `scripts/`；使用独立 home、独立端口和显式费用上限。包不内置账号或密钥。使用 EU GMP Annex 1、Annex 11、21 CFR Part 11、ICH Q9/Q10 与 ALCOA+ 的术语参考，不代表合规认证。

角色 preset 通过公开 tool-policy SPI 选择包内策略，保留默认工具权限行为。质量写入与放行另行请求“人工、单次、绑定精确参数及版本”的业务签名，包括 full-access 会话；缺少人工凭证的领域写入仍拒绝。

仅精确的夜间 EM 导出（kind=em 加支持的语言）允许无人值守：只读取质量状态，并在 pharma-output/ 内创建新的报告文件。其他报告形状保留默认决策；质量记录与放行始终需要人工批准。

放行档案工具同时返回原始历史发现、当前阻断和偏差结案、复验、EM、设备追溯证据。证书绑定签署前被审阅的档案版本；签署使状态版本加一。

## 业务签名

质量记录与批次放行属于业务签署。工具以 `business.confirm` 绑定精确参数、对象、版本、证据及签名含义。完全访问下，宿主代表选择该权限的会话真人提交声明的批准值，不出现待审卡片；回执、审计及放行证书／关闭记录明确标注 **完全访问下自动确认**，不能冒充人工点击或模型签名。其他权限保留人工签署、拒绝、取消和过期语义。宿主单次消费原决策，私有凭证在存储事务内复核当前 epoch、取消及有效期，提交前收窄权限会阻止写入。批准合同缺失或歧义时仍请求人工。页面 effect 保留宿主人工确认与修订校验。

真实模型投资者演示：仓根通过工具链入口执行 `exec node --import tsx examples/showcase/scripts/presentation.mjs pharma-gmp --real`，外层使用 heavy-lock 和 web-gate-lock，按任务要求从 keychain 命令级注入密钥。截图与费用默认保存在隔离运行目录；`AGH_SHOWCASE_SHOTS` 可指定外部报告目录，`AGH_SHOWCASE_PRIOR_USD` 将此前付费尝试计入每应用 $3 总额。原验收脚本的 `--real` 也转交此自然对话流程。

设置 `AGH_SHOWCASE_REQUIRE_REVIEW=1` 可显式审查测试候选：脚本在隔离运行目录写入 `candidate-review.json`，等待操作者核对源码与测试后写入包含相同 `candidateHash`、`reviewHash` 的 `review-approved.json`。该测试夹具不提供生产自动批准能力。

签署卡按当前界面语言展示业务对象、审阅版本、精确签名含义及证据链接；宿主答复必须返回该展示版本绑定的原文。回执和审计保存所见含义；仅返回旧式空答复不能完成新签署。

1.2.0 新增角色子代理与质量助手统一入口；已有安装可在插件页审阅捆绑更新。安装与应用采用仍分开进行。

工作台提供当前对象、待签署、证据与报告。通过对象按钮或输入区快捷操作开展偏差、CAPA、EM、批记录复核与 QA 放行；四个专家子代理在委派卡片和完成通知中显示归属。主导航只保留总览和待办与签署，其他模块从更多或总览链接进入。

1.2.0 以“质量助手”为统一入口：快捷操作和对象操作均进入主会话，由它委派偏差调查、批记录复核、EM 分析和放行前检查四个角色。角色使用配方中的持久人格启动全新会话，权限是启动时角色与父会话工具、文件、网络、沙箱及只读权限的交集。委派卡片和完成通知记录角色归属，刷新后仍可查看。子代理不能取得审批或业务签署，即使父会话使用完全访问也会自动拒绝；质量助手先汇总结果，再在主会话执行用户要求的签署登记、推进或放行。
