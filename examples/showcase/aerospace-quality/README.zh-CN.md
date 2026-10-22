# 穹序航天研制质量台

[English](README.md) | 简体中文

一个可安装、显式采纳的 AGH 应用，面向**虚构**的 QV-X27 航天推进阀驱动分系统研制项目。
穹序 / Qiongxu、供应单元、器件、测量、历史审批全部为合成数据。已检索组合项目名称是否存在明显航天品牌冲突；不代表真实公司、客户项目或已获认证的质量体系。

`@agnes-showcase/aerospace-quality`（showcase 家族）提供五个角色智能体、六个业务页面、亮暗皮肤、原创 PNG 品牌、严格工具输入、档案持久数据、证据卡、报告和显式部署的每周自动化。`aero_briefing` 在会话与工作台发布真实结构化 Intelligent UI 图表；工具证据卡另行呈现已记录结果。仅使用公开作者 API，不依赖官方包特权。安装不会自动采纳应用或授予执行权限。

数据包含 39 条树形需求、32 个验证用例、6 个试验活动（4 个有数据，共 484 个采样点 / 1,452 个通道测量；2 个待执行，不虚构实测）、18 个 NCR、12 个 ECR、4 个基线、24 个器件和双五条十项证据。业务快照固定在 2026-10-20，账龄按快照计算，执行审计采用真实时间。

## 安装与采纳

在匹配源码根目录先执行 `mise trust`、`mise install`，将以下 `pnpm` 替换为 `mise exec -- node tools/toolchain/run.mjs`。构建、tsc、Vitest 经开发机 heavy-lock。直接安装源码目录前先构建本包；本地运行时打包器也会为所有示例家族编译声明的源码入口，并复制声明的 Markdown。

```sh
pnpm install --frozen-lockfile
pnpm --filter @agnes-showcase/aerospace-quality build
pnpm --filter @agnes/cli build:local
export AGH_SOURCE="$PWD"
export AGH_HOME="$(mktemp -d /tmp/agh-aero.XXXXXX)"
export AGNES_PROFILE=local-dev
node agnes.mjs plugins add "$AGH_SOURCE/examples/showcase/aerospace-quality" --yes
node agnes.mjs daemon stop
node agnes.mjs serve --port 4296
```

每个终端使用同一 home/profile；`--yes` 仅用于已授权的无人值守合成试用，真实安装须核对能力与来源。进入**设置 → 应用**预览并显式采纳穹序：品牌、皮肤、主页、六个业务入口、五个智能体随之生效，智能体、自动化、宿主管理与恢复仍可达。也可执行 SDK 预览 / 采纳：

```sh
pnpm --filter @agnes-showcase/aerospace-quality exec node --import tsx adopt.mjs
pnpm --filter @agnes-showcase/aerospace-quality exec node --import tsx adopt.mjs --adopt
node agnes.mjs --new --agent '@agnes-showcase/aerospace-quality#investigator' -p '先读 aero_playbook，调查 AN-027 并引用证据，不宣称已确认原因。'
```

Demo 模型可用显式调用：`call aero_investigate {"anomalyId":"AN-027"}`；机理推理使用已配置的真实模型。[DEMO.md](DEMO.md) 提供自然业务问题与真人签署流程。

## 页面与可信执行

需求追溯提供需求—设计—验证矩阵和缺口、孤立需求筛选；试验页展示冷平台电流、限值、66–70 分钟异常窗口、温度/真空度、日志及关联证据。MRB 看板覆盖五种处置和账龄；先保存依据，再请求宿主人工批准。包括原样使用在内的正式处置都须审批。`dispositioned` 只表示批准实施，不能宣称返工完成、关闭或飞行放行；器件与基线保持隔离。

技术状态页提供基线、更改影响图、优选器件、停产与假冒风险。批准更改后受影响验证失效，目标基线待复验，受审规则会增加待执行的热真空筛选用例。归零页逐项显示双五条证据；有任何一项不完整，即使获批也拒绝关闭，报告保留草案状态。

技能成长先通过 `aero_rule_propose` 产生未启用领域候选，再用 `aero_skill_candidate` prepare/commit 提交真实宿主 Skill 安装提议；commit 需要原生人工批准，下一轮生效。另由人通过 `aero_decide(kind=rule)` 批准项目内筛选策略，下一次更改分析会显示 v1 及追加筛选要求。不会自动发布代码。

页面只通过声明的 profile services 读写，业务数据归属 owner/profile store。操作 ID 与原回执持久保存，按档案、激活和客户端修订隔离；重开只查询原操作，不以新 ID 重试不确定操作。数据修订变化拒绝旧审批，浏览器存储失败阻止发送。角色预设选择包内公开 `aero-human-review` 工具策略，保留普通工具权限。业务签名独立请求人工、仅本次，绑定对象与项目修订；会话/永久工具授权不能替代业务裁决；完全访问下由 Host 代表主会话真人自动确认符合合同的业务签署，其他权限由人确认。工具核验宿主证明，事务再次比较当前修订。UI 标签不能授权；受信 JS 不等于沙箱。

`aero_report` 在授权工作区 `aero-output/` 创建唯一 Markdown / 可打印 HTML 文件，再调用 `present` 转为持久交付物。HTML 转义内容，不使用 artifact URL 作为 present 输入。执行记录 / 来源视图显示工具输入、审批、effects、包完整性与会话 pin。升级后在途会话保留后端绑定，档案页面跟随当前激活；应用采纳不会改变执行身份。

## 每周摘要与验证

```sh
export AERO_WORKSPACE=/absolute/path/to/isolated/workspace
pnpm --filter @agnes-showcase/aerospace-quality exec node --import tsx automation.mjs
pnpm --filter @agnes-showcase/aerospace-quality typecheck
pnpm exec vitest run examples/showcase/aerospace-quality/test --project fast --maxWorkers=1
pnpm exec vitest run tools/guards/src --project fast --maxWorkers=1
pnpm gen:check
```

自动化显式创建周一 09:00（Asia/Shanghai）任务，冻结质量智能体启动选择，拒绝无人值守审批。进入**自动化 → 立即运行**可演示摘要报告。包加载不创建任务；试用完成后停用该日程。

Host 测试覆盖持久数据、重启、拒绝、取消、修订漂移、审批事实与 pin；公开面板测试覆盖双语页面、筛选和原操作恢复。显式 `test/acceptance.e2e.mjs` 验收脚本覆盖隔离 home 的安装/检查/采纳、截图、真实模型和自动化；不进入快速测试。付费模式请遵循脚本头说明，禁止输出或保存密钥。[领域说明](DOMAIN-NOTES.md) 记录标准参考和建模边界。`/?admin` 或 `agh app clear` 可恢复宿主呈现；只停止本次试用的 daemon。

领域策略允许 `aero_report` 进行有界证据导出：输入仅限报告类型/语言白名单，在 `aero-output/` 创建新文件并通过 `present` 交付。这使带来源污点的调度提示能够生成报告；MRB、技术状态、规则启用与归零关闭仍逐次要求精确业务裁决，符合合同的完全访问请求由 Host 自动确认。

## 业务签名

MRB 处置、技术状态更改、规则启用与归零关闭属于业务签署。工具以 `business.confirm` 绑定精确参数、对象、版本、证据及签名含义。完全访问下，宿主代表选择该权限的会话真人提交声明的批准值，不出现待审卡片；回执、审计及放行证书／关闭记录明确标注 **完全访问下自动确认**，不能冒充人工点击或模型签名。其他权限保留人工签署、拒绝、取消和过期语义。宿主单次消费原决策，私有凭证在存储事务内复核当前 epoch、取消及有效期，提交前收窄权限会阻止写入。批准合同缺失或歧义时仍请求人工。页面 effect 保留宿主人工确认与修订校验。

可选真实模型验收：仓根通过工具链入口执行 `exec node --import tsx examples/showcase/scripts/presentation.mjs aerospace-quality --real`，外层使用 heavy-lock 和 web-gate-lock，仅为该命令安全提供 `AGH_DEMO_API_KEY`。截图与费用默认保存在隔离运行目录；`AGH_SHOWCASE_SHOTS` 可指定外部报告目录，`AGH_SHOWCASE_PRIOR_USD` 将此前付费尝试计入每应用 $3 总额。原验收脚本的 `--real` 也转交此自然对话流程。

签署卡按当前界面语言展示业务对象、审阅版本、精确签名含义及证据链接；宿主答复必须返回该展示版本绑定的原文。回执和审计保存所见含义；仅返回旧式空答复不能完成新签署。

## 一个业务工作台

采用后主导航为“项目总览”和“待办与签署”，总览保留原有全部模块入口。对 AN-027 点击“调查”，
对 NCR 点击“起草处置”，对 ECR 点击“发起评审”，对归零项点击“生成报告”。宿主审阅既有智能体启动，
随后打开可编辑请求并聚焦“当前对象”。输入区快捷操作按业务工作路由到现有角色；这是启动时路由，没有新增委派运行时。
会话显示已审阅启动的角色归属。可选的浏览器会话记忆恢复展示上下文；提交的 JSON 请求和业务记录仍由后端负责。

“当前对象”在会话投影失效通知后通过 profile 服务更新；“待签署”与会话卡使用同一组宿主决定动作；标准和工作区写入权限由人确认，完全访问下由宿主自动确认并记录方式，不显示待签卡；
“证据与报告”展示本会话回执，支持查看来源、审批和报告文件。批准处置仍只批准实施，硬件保持隔离等待复验，不能宣称试验通过。

仓库根目录运行 `pnpm exec node --import tsx examples/showcase/scripts/workbench.mjs`，外层使用项目工具链和浏览器锁。
脚本创建独立的全新 home，不调用付费模型。

1.1.0 更新会话工作台；已有 1.0.0 安装可在插件页审阅捆绑更新。安装与应用采用仍分开进行。

1.1.1 将报告工具声明为历史证明操作：报告生成等待会话后台历史校验，期间普通工作可以继续。详见[会话完整性](../../../docs/guide/sessions.zh-CN.md)。
