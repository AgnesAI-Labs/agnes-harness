# 文档维护

[English](maintenance.md) | 简体中文

[文档首页](../README.zh-CN.md) · [验证](verification.zh-CN.md) · [发布检查](release.zh-CN.md) · [许可边界](provenance.zh-CN.md)

根目录 [README.md](../../README.md) 是默认英文项目介绍；[README.zh-CN.md](../../README.zh-CN.md) 是对应的中文版。[README.en.md](../../README.en.md) 保留旧英文地址，作为导航页，不重复维护正文。`docs/` 存放用户指南、开发教程与技术参考；包内生成文档由对应生成器维护。

## 项目表达

- 先说明 AGH 能帮助使用者完成什么，并提供清晰的体验、开发与反馈入口。能力描述应能落到教程、实现或可复现证据。
- 两份 README 和每组中英文文档在项目定位、支持范围、命令与协作政策上保持一致。
- 描述具体场景，不使用缺乏依据的性能数字、客户案例或兼容性承诺。
- MHS 方向与开放状态统一维护在[设备方向](../guide/mhs.zh-CN.md)。“即将开放”指 AGH 的接入指南与示例。
- 第三方许可和归属保留在 LICENSE、NOTICE 与[许可边界](provenance.zh-CN.md)中。研究叙事、内部任务与写作参考不进入用户指南。

## 随代码更新

| 变更范围 | 中英文都需要更新的页面 | 验证方式 |
| --- | --- | --- |
| CLI、构建、后台发现 | [安装](../guide/install.zh-CN.md)、[命令参考](../reference/cli.zh-CN.md)、两份 README | 参数测试、完整构建、本地进程验收 |
| 模型账号与路由 | [首次运行](../guide/quickstart.zh-CN.md)、[配置](../reference/configuration.zh-CN.md) | 配置测试，并单独验证真实提供方 |
| Web、会话、认证 | [Web](../guide/web.zh-CN.md)、[会话](../guide/sessions.zh-CN.md)、[安全](../guide/security.zh-CN.md) | 协议测试与浏览器交互 |
| 插件、MCP、Skills | [扩展](../develop/plugins.zh-CN.md)、[MCP](../guide/mcp.zh-CN.md)、[Skills](../guide/skills.zh-CN.md) | 示例、授权、更新与清理 |
| 皮肤与界面契约 | [皮肤](../develop/skins.zh-CN.md) | Token、区域 hook 与包清单检查 |
| 架构、schema、API | [架构](../develop/architecture.zh-CN.md)、[API](../reference/api.zh-CN.md)、包内生成参考 | 调用链复核、生成检查与使用方测试 |
| 支持与发布 | [限制](../reference/limitations.zh-CN.md)、[能力矩阵](../reference/capabilities.zh-CN.md)、[发布](release.zh-CN.md) | 对应版本与环境的验证证据 |

## 双语文档约定

- `docs/` 下每篇维护中的 Markdown 文档都提供默认英文 `name.md` 和完整简体中文 `name.zh-CN.md`。两种语言都应提供完整内容。
- 英文页顶部使用 `English | [简体中文](name.zh-CN.md)`，中文页使用 `[English](name.md) | 简体中文`。切换应进入同一主题的另一种语言。
- 导航与教程链接留在当前语言。源码、schema、生成参考、许可证和根目录双语政策可共用同一目标。
- 在同一次变更中更新两种语言。命令、标识符、默认值、限制、前提条件与预期结果应等价；解释性文字、图示标签和示例提示词需翻译，执行契约保持一致。
- 默认英文页面通过显式锚点别名保留原有中文章节深链接。修改标题时保留这些别名，新链接使用当前语言的章节标题。
- 除结构检查外，也要复核语义。配对与链接检查可以发现缺页或导航错误，不能证明每一处翻译都准确保留了技术含义。

## 文档检查

```sh
node tools/public-docs/verify.mjs
pnpm exec vitest run tools/public-docs/examples.test.ts --maxWorkers=1
pnpm gen:check
```

检查覆盖根目录入口、中英文配对、语言切换、链接与锚点、常见敏感信息模式，以及[源码核对清单](../../tools/public-docs/source-checks.json)。它不抓取外部网址，也不能替代教程执行、浏览器验收或发行审核。包内生成文档应先修改生成器，再重新生成。

修改操作步骤或失败行为时应核对真实源码。测试、构建与外部验收需要分别报告；可复现命令与范围见[验证](verification.zh-CN.md)，版本与 npm 策略见[版本管理](versioning.zh-CN.md)。
