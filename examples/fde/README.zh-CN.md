# FDE bundles：使用 AGH 交付业务流程

[English](README.md) | 简体中文 · [为什么选择 AGH](../../docs/guide/why-agh.zh-CN.md)

FDE 工程师将流程、连接器、审核策略与手册一起交付。下面每个目录都是独立可安装的 **bundle**，只使用公开契约与作者工具包。合成数据和本地模拟器让团队无需凭据即可体验完整交付流程。

| Bundle | 业务成果 | 控制点 |
| --- | --- | --- |
| [客服分诊](support-triage/README.zh-CN.md) | 读取工单 → 分类 → 草稿 → 人工审批 → 模拟发送回执。 | 动作前人工确认 |
| [合同评审](contract-review/README.zh-CN.md) | 拆分条款 → 并行评审节点 → 汇总 Markdown 报告 → 模型解读。 | 只读策略 |
| [数据报告](data-report/README.zh-CN.md) | 读取 CSV → 计算合计与利润率 → 含 SVG 图表的 Markdown/HTML → 模型解读。 | 只读策略 |
| [运维手册](ops-runbook/README.zh-CN.md) | 读取手册 → 官方后台诊断作业 → 问题卡 → 授权模拟重启 → 核对回执。 | 业务选择与工具权限 |
| [CRM 助手](crm-assistant/README.zh-CN.md) | 本地 MCP 查询 → Skills 续约手册 → 草拟备注 → 审批 → 幂等模拟备注。 | 动作前人工确认 |
| [设备巡检](device-inspection/README.zh-CN.md) | 读取状态 → 检测异常 → 人工确认 → 受约束动作 → 回执与状态验证。 | 动作前人工确认 |
| [知识问答](knowledge-qa/README.zh-CN.md) | 本地文档 → 来源摘录 → 带引用回答或拒答 → 模型解读。 | 无来源则拒答；只读检索 |
| [会议行动项](meeting-actions/README.zh-CN.md) | 转录 → 摘要、决定、负责人和日期 → Markdown 与面板 → 模拟发送。 | 发送前人工审批 |
| [代码评审](code-review/README.zh-CN.md) | Git diff 夹具 → 并行轻量/风险检查 → 汇总评审报告。 | 只读 DAG |
| [财务对账](finance-reconcile/README.zh-CN.md) | 银行/账簿 CSV → 整数分差异 → 调整分录草稿。 | 人工审批；未解决依据保持开放 |
| [招聘初筛](recruiting-screen/README.zh-CN.md) | 最小化简历 → 岗位依据与未知项 → 人工后续评审。 | 人工决定；仅使用岗位技能依据 |
| [合规证据审计](compliance-audit/README.zh-CN.md) | 清单 → 依据检查 → 含严重程度和引用的发现。 | 只读；缺失依据保留为缺口 |

## 开始交付

按[安装指南](../../docs/guide/install.zh-CN.md)构建 `agh`。打开对应 README，在目录中执行 `agh plugins add .`，通过 `agh run --bundle PACKAGE#NAME` 或 Web **Admin → Plugins → Bundles** 面板选择已安装 bundle。每份 README 提供预设、提示、模型目标与预期结果。Web bundle 变更需要重启 Host 并新建会话。

全新 local-dev 配置提供无密钥 Demo 路由。工具依据和客服/CRM 草稿来自夹具，Demo 不进行真实推理。已有部署须保留该路由或配置真实模型。所有示例使用 Core 准备的请求和会话主模型，`real-model.bundle.json` 配置预设 primary 路由。

发送、CRM 备注、运维重启、设备动作、调整分录与招聘后续评审先交付草稿，再调用官方 `ask_user_question`。持久保存的 Proceed/Cancel 问题暂停流程，经校验的用户答案恢复执行。工具授权仍独立控制，不可用的权限会拒绝动作；业务选择可在 Web/TUI 完成。依据流程可无交互完成，仅允许生成输出，拒绝源数据修改。Demo 成果仍为确定性结果，真实模型解读保留为审核草稿。

十二个 bundle 均使用官方 `write`、`present` 生成受限路径报告和标准制品打开/下载卡。会议面板只渲染行动依据，不再自建下载路径。知识问答可按显式公开查询使用 `web_search`，私有问题与文档保持本地。运维使用官方 `shell` 后台作业与 `job_output`，操作者可用 `job_list`、`job_kill` 检查或停止所属作业。部署能力与限制见[官方默认工具](../../docs/reference/default-tools.zh-CN.md)，已有配置须允许问题/交付工具的投影能力。

Loop 3.0.0/checkpoint codec 3 保存待答问题和单个原生审批的续跑信息，升级后新建会话；旧 checkpoint 会被拒绝。

在 Web/TUI 中先输入 `/plan on`，再提交**新任务**，启用官方计划模式。Loop 从公开提示区识别计划模式，以 `exit_plan_mode` 提交固定业务步骤；官方审批卡片获准后才运行连接器、报告或命令。拒绝计划会停止流程，未启用时跳过此关卡。示例策略保留默认策略的计划模式拒绝结果。计划获准不替代后续业务问题或工具权限；单个原生工具票据通过公开续跑端口和原调用回执恢复，未知回执会阻止重放。

## 从示例到客户

保留可复用 loop，替换夹具连接器、业务规则与 `SKILL.md`。明确客户可暴露的数据、需要人工审核的动作和证明成功的回执。运维场景启动前选择已注册沙箱提供方。设备的单位、动作边界与物理安全留在已验证的控制器/适配器中；设备示例受 MHS 启发，不宣称 MHS 兼容。

每个 tarball 包含轻量 loop 辅助文件，因此没有相邻示例导入。普通后台插件运行在受信进程内；能力声明用于安装审核和策略，不隔离任意代码。checkpoint 拒绝自动重放 pending 副作用；模拟器回执不是生产设备/CRM 的持久账本。

## 验证

使用仓库固定的 Node/pnpm 版本。外部验证器构建作者 tarball，将指定示例复制到仓库外，安装真实依赖，检查公开导入并运行各自快速测试：

```sh
pnpm release:external-examples --author-only \
  --example examples/fde/knowledge-qa \
  --example examples/fde/meeting-actions \
  --example examples/fde/code-review \
  --example examples/fde/finance-reconcile \
  --example examples/fde/recruiting-screen \
  --example examples/fde/compliance-audit
```

重复 `--example` 可加入十二个示例中的任意一个。`--author-only` 跳过完整 CLI 打包，验证作者契约与示例流程，不代表浏览器或完整分发验收。快速测试使用官方工具端口、模型和制品回执的脚本夹具，覆盖等待、无效或取消答案，以及保留的工具权限拒绝。CRM/设备测试启动短小的真实 stdio MCP 进程，使用 `.e2e.test.mjs`。运维作业端口与重启执行器均为夹具，不证明操作系统隔离或真实后台清理。安装匹配作者 tarball 后可独立执行各目录的 `npm run build`、`npm test`。公开 conformance testkit 所需 Vitest 仅为测试依赖。

夹具验证不代表真实模型质量、客户 API、物理设备或跨平台验收。
