# 开发者教学示例

[English](README.md) | 简体中文

这里保留五个独立可安装的教学插件，每个示例重点讲一种机制；它们使用合成数据，不是行业产品。构建未提供的应用，智能体页不显示占位卡片。

| 示例 | 教学重点 | 保留原因 |
| --- | --- | --- |
| [知识问答](knowledge-qa/README.zh-CN.md) | 工具、证据引用与无来源拒答 | 最小只读检索合同及拒答测试 |
| [财务对账](finance-reconcile/README.zh-CN.md) | 工具加交互面板 | 精确分币、真实 Host 策略、数据源拒绝与结构化回执测试 |
| [客服分流](support-triage/README.zh-CN.md) | 审批动作 | 草稿、持久化问题、模拟发送；机制演示脚本复用 |
| [数据报告](data-report/README.zh-CN.md) | 报告交付 | 计算结果、Markdown/HTML 图表和官方打开/下载卡片 |
| [运维巡检](ops-runbook/README.zh-CN.md) | 定时自动化 | 后台诊断、巡检报告；交互式修复单独请求批准 |

## 安装与运行

从[安装指南](../../docs/guide/install.zh-CN.md)构建 CLI。在示例目录执行 `agh plugins add .`，审阅权限并启用后，从智能体页选择已安装的智能体，或执行 `agh --new --agent PACKAGE#NAME -p "task"`。教学包不会在新用户推荐、空会话提示或引导中推广；开发者按来源路径安装；后端完整目录仍保留教学元数据供检查。安装不会自动启动会话。

每个 Bundle 显式声明 `launch` 和 preset，继承部署选择的主模型。启动审阅显示模型、权限、来源和可编辑草稿；确认只创建空会话并填入草稿，发送才执行。无密钥 Demo 只作确定性教学，真实模型配置见每包 `real-model.bundle.json`。这些配置只选择模型，不保存凭据。

## 可信执行与验证

五个示例共用公开 `@agnes/plugin-runtime` 的 `defineWorkflowLoop`，不导入兄弟示例。客服发送与交互式重启使用 `ask_user_question`，工具权限仍独立校验。财务使用现有结构化审阅回执；未知结果不会自动重放。`write` / `present` 交付有边界的报告。运维后台任务使用 `shell` / `job_output`，巡检方式和调度步骤见其 README。知识问答保留无来源拒答和可选公共检索；私有文档不会作为公共查询发送。

所有后端插件是受信任的进程内代码，能力声明用于审阅与策略，不是任意代码沙箱。Loop 5.0.0 使用官方 checkpoint codec 1；旧 checkpoint 拒绝恢复，升级后请新建会话。`/plan on` 的官方计划审批先于业务执行，不能替代后续业务确认或工具授权。

从仓库根目录运行定向测试：

```sh
pnpm exec vitest run --config examples/fde/vitest.config.mjs --maxWorkers=1
pnpm release:external-examples --author-only \
  --example examples/fde/knowledge-qa \
  --example examples/fde/finance-reconcile \
  --example examples/fde/support-triage \
  --example examples/fde/data-report \
  --example examples/fde/ops-runbook
```

开发验证使用仓库固定工具链入口。外部作者测试检查安装依赖、公开导入和示例自己的测试；不能证明真实模型质量、生产连接器或跨平台验收。后台任务测试使用夹具，浏览器扫测另见[演示指南](../../docs/guide/demos.zh-CN.md)。
