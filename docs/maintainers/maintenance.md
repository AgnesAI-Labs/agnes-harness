# 文档维护

[文档导航](../README.md) · [验证与复现](verification.md) · [发布检查](release.md) · [许可说明](provenance.md)

根 [README.md](../../README.md) 是中文项目入口，[README.en.md](../../README.en.md) 提供英文介绍；`docs/` 保存使用指南、开发教程和技术参考。包内生成文档由各包的生成器维护。

## 项目表达

- 以 AGH 的使用价值为主线，给读者明确的体验、构建与反馈入口；优势连接到教程、实现或可复现证据。
- 中英文 README 保持定位、支持范围、上手命令和协作政策一致。深度指南当前以中文为主。
- 场景说明使用具体任务，不写未经验证的性能数字、客户成果或兼容承诺。
- MHS 的目标与开放状态集中在[设备接入方向](../guide/mhs.md)；“即将开放”指 AGH 的接入文档与示例。
- 第三方许可与归属保留在 LICENSE、NOTICE 和[许可说明](provenance.md)。调研过程、内部任务和写作参考不进入使用手册。

## 随代码更新

| 变更 | 对应文档 | 验证方式 |
| --- | --- | --- |
| CLI、构建与后台发现 | [安装](../guide/install.md)、[命令参考](../reference/cli.md)、两份 README | 参数测试、完整构建、本地进程验收 |
| 模型账号与路由 | [首次运行](../guide/quickstart.md)、[配置](../reference/configuration.md) | 配置测试与实际提供方分别核验 |
| Web、会话与认证 | [Web](../guide/web.md)、[会话](../guide/sessions.md)、[安全](../guide/security.md) | 协议测试与浏览器操作 |
| 插件、MCP 与 Skills | [扩展指南](../develop/plugins.md)、[MCP](../guide/mcp.md)、[Skills](../guide/skills.md) | 示例、授权、更新与清理测试 |
| 皮肤和界面合同 | [皮肤开发](../develop/skins.md) | token、区域钩子与包清单校验 |
| 架构、Schema 与 API | [架构](../develop/architecture.md)、[API](../reference/api.md)、包内生成参考 | 调用路径复核、生成一致性与消费者测试 |
| 支持范围与发布 | [限制](../reference/limitations.md)、[能力清单](../reference/capabilities.md)、[发布检查](release.md) | 当前版本与实际环境证据 |

## 文档检查

```sh
node tools/public-docs/verify.mjs
pnpm exec vitest run tools/public-docs/examples.test.ts --maxWorkers=1
pnpm gen:check
```

检查器验证文档入口、本地链接与锚点、常见敏感信息形状及[源码锚点清单](../../tools/public-docs/source-checks.json)。它不抓取外链，也不替代教程实操、浏览器验收或发行物审查。生成文档修改其生成源，再运行对应生成器。

更新步骤和失败语义时核对实际源码。测试、构建和外部验收分别报告；复现命令与范围见[验证说明](verification.md)。版本和 npm 分发策略见[版本管理](versioning.md)。
