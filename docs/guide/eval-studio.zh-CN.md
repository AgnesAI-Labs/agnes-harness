# 评测工作室

[English](eval-studio.md) | 简体中文

[文档](../README.zh-CN.md) · [无界面运行](headless.zh-CN.md) · [插件生命周期](packages.zh-CN.md)

在内置插件目录安装“评测工作室”（`@agnes/eval-studio`），审核、信任并显式启用；默认不安装、不启用。仅在评测会话选用其工具。插件通过公开 UI 注册添加首页“评测”和工作台面板。

先运行 synthetic fixture：

```sh
pnpm install --frozen-lockfile
pnpm exec tsx packages/package-manager/bundled-plugins/eval-studio/src/demo.mjs > /tmp/agh-eval-demo.json
```

源码演示使用 SDK headless、内存 synthetic 会话、scripted 模型和可清理工作区，不测试生产 Loop、daemon 或真实模型。JSON 中包含通过的基线，以及漏步骤、输出错误、尝试越权工具的失败变体。复制完整 `reports[0]` 对象，进入“评测 → 基线”导入，再把 `reports[1]` 导入“候选”。用支持键盘的案例选择器检查结构、fixture 效果、预算和独立 judge，最后“导出 JSON”；双方环境绑定和逐 case 差异均保留。

数据集绑定 prompt、tool、fixture、model、Loop、Skill、pin 哈希及 seed、预算；同案例输入可比较不同环境。strict 回放验证请求等价；sequence 仅按序取响应。可信 factory 必须提供明确授权的隔离 home/workspace 和仅 fixture 工具，runner 不授予业务权限。回放本身不是效果沙箱。

报告保留实际执行数；0 case 失败。取消停止后续 case 并等待清理。缺 usage 标为未知；有限 token 预算且 usage 未知的案例不能通过。可选 judge 必须显式传入，作为另一次可能收费的调用，单列成本、usage 与不确定性。离线演示不代表真实模型质量。

页面仅在内存保存选定报告，不运行模型。停用/卸载释放两个注册并清空数据；导入失败持续显示重试指引。延迟加载工具 `eval_studio_import` 接受有界 v1 数据集/报告 JSON 或 `{baseline,candidate}` 对照 JSON，通过当前会话授权 artifact 端口保存不可变报告。工具沿用既有策略授权；安装不赋予 Host 权限或跨会话读权限。

导入报告未经证据签发验证。总数虽重新计算，调用方提供的断言仍不能证明实际执行或绕过候选人审。导出分享前检查输出；不扫描默认 home、不导入凭据、不上传、不增加遥测或旧数据迁移。Schema、限制、factory 义务和 Node API 见[包说明](../../packages/package-manager/bundled-plugins/eval-studio/README.zh-CN.md)。
