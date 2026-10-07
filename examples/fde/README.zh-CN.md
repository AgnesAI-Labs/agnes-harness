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

## 开始交付

按[安装指南](../../docs/guide/install.zh-CN.md)构建 `agh`。打开对应 README，在目录中执行 `agh plugins add .`，通过 `agh run --bundle PACKAGE#NAME` 或 Web **Admin → Plugins → Bundles** 面板选择已安装 bundle。每份 README 提供预设、提示、模型目标与预期结果。Web bundle 变更需要重启 Host 并新建会话。

全新 local-dev 配置提供无密钥 Demo 路由。工具依据和客服/CRM 草稿来自夹具，Demo 不进行真实推理。已有部署须保留该路由或配置真实模型。每个示例的 `real-model.bundle.json` 展示显式 loop target 配置。

无交互运行会拒绝审批请求。发送客服回复、CRM 备注、运维重启和设备动作在 CLI 中到达审批边界，在 Web 完成确认。示例测试覆盖批准与拒绝，不产生真实客户副作用。合同评审与数据报告可在无交互模式完成。

## 从示例到客户

保留可复用 loop，替换夹具连接器、业务规则与 `SKILL.md`。明确客户可暴露的数据、需要人工审核的动作和证明成功的回执。运维场景启动前选择已注册沙箱提供方。设备的单位、动作边界与物理安全留在已验证的控制器/适配器中；设备示例受 MHS 启发，不宣称 MHS 兼容。

每个 tarball 包含轻量 loop 辅助文件，因此没有相邻示例导入。普通后台插件运行在受信进程内；能力声明用于安装审核和策略，不隔离任意代码。checkpoint 拒绝自动重放 pending 副作用；模拟器回执不是生产设备/CRM 的持久账本。

## 验证

使用仓库固定的 Node/pnpm 版本。外部验证器构建作者 tarball，将指定示例复制到仓库外，安装真实依赖，检查公开导入并运行各自快速测试：

```sh
node --import tsx tools/release/external-examples.ts --author-only \
  --example examples/fde/contract-review \
  --example examples/fde/data-report
```

重复 `--example` 可加入六个示例中的任意一个。`--author-only` 跳过完整 CLI 打包，只验证作者契约与示例流程，不代表浏览器或完整分发验收。CRM/设备快速测试启动短小的真实 stdio MCP 进程，文件名使用 `.e2e.test.mjs`。运维测试注入模拟执行端口，不证明操作系统隔离。安装匹配作者 tarball 后，各目录也可独立执行 `npm run build` 与 `npm test`。

夹具验证不代表真实模型质量、客户 API、物理设备或跨平台验收。
