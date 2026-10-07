# FDE bundles：使用 AGH 交付业务流程

[English](README.md) | 简体中文 · [为什么选择 AGH](../../docs/guide/why-agh.zh-CN.md)

FDE 工程师将流程、连接器、审核策略与手册一起交付。下面每个目录都是独立可安装的 **bundle**，只使用公开契约与作者工具包。合成数据和本地模拟器让团队无需凭据即可体验完整交付流程。

| Bundle | 业务成果 | 控制点 |
| --- | --- | --- |
| [客服分诊](support-triage/README.zh-CN.md) | 读取工单 → 分类 → 草稿 → 人工审批 → 模拟发送回执。 | 动作前人工确认 |
| [合同评审](contract-review/README.zh-CN.md) | 拆分条款 → 并行评审节点 → 汇总 Markdown 报告 → 模型解读。 | 只读策略 |
| [数据报告](data-report/README.zh-CN.md) | 读取 CSV → 计算合计与利润率 → 含 SVG 图表的 Markdown/HTML → 模型解读。 | 只读策略 |
| [运维手册](ops-runbook/README.zh-CN.md) | 读取手册 → 诊断 argv → 批准模拟重启 → 核对回执。 | 动作前人工确认 |
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

全新 local-dev 配置提供无密钥 Demo 路由。工具依据和客服/CRM 草稿来自夹具，Demo 不进行真实推理。已有部署须保留该路由或配置真实模型。每个示例的 `real-model.bundle.json` 展示模型配置。知识、会议、代码、财务、招聘与审计 loop 使用 Core 准备的请求和会话主模型。

无交互运行会拒绝审批请求。发送、CRM 备注、运维重启、设备动作、调整分录与招聘后续评审在 CLI 中到达审批边界，在 Web 完成确认。示例测试覆盖批准与拒绝，不产生真实客户副作用。只读 bundle 可无交互完成。完整夹具成果均为确定性结果，真实模型解读保留为审核草稿。

第二组覆盖本地知识、会议、工程评审、财务、招聘与政策依据。本源码版本尚未提供交互/展示工具，轻量本地导出与决定工具标记了采用官方 `present`、`ask_user_question` 的 TODO。固定 DAG 与本地依据检索无需交互计划或互联网搜索。

## 从示例到客户

保留可复用 loop，替换夹具连接器、业务规则与 `SKILL.md`。明确客户可暴露的数据、需要人工审核的动作和证明成功的回执。运维场景启动前选择已注册沙箱提供方。设备的单位、动作边界与物理安全留在已验证的控制器/适配器中；设备示例受 MHS 启发，不宣称 MHS 兼容。

每个 tarball 包含轻量 loop 辅助文件，因此没有相邻示例导入。普通后台插件运行在受信进程内；能力声明用于安装审核和策略，不隔离任意代码。checkpoint 拒绝自动重放 pending 副作用；模拟器回执不是生产设备/CRM 的持久账本。

## 验证

使用仓库固定的 Node/pnpm 版本。外部验证器构建作者 tarball，将指定示例复制到仓库外，安装真实依赖，检查公开导入并运行各自快速测试：

```sh
node --import tsx tools/release/external-examples.ts --author-only \
  --example examples/fde/knowledge-qa \
  --example examples/fde/meeting-actions \
  --example examples/fde/code-review \
  --example examples/fde/finance-reconcile \
  --example examples/fde/recruiting-screen \
  --example examples/fde/compliance-audit
```

重复 `--example` 可加入十二个示例中的任意一个。`--author-only` 跳过完整 CLI 打包，只验证作者契约与示例流程，不代表浏览器或完整分发验收。CRM/设备快速测试启动短小的真实 stdio MCP 进程，文件名使用 `.e2e.test.mjs`。运维测试注入模拟执行端口，不证明操作系统隔离。安装匹配作者 tarball 后，各目录也可独立执行 `npm run build` 与 `npm test`。

夹具验证不代表真实模型质量、客户 API、物理设备或跨平台验收。
