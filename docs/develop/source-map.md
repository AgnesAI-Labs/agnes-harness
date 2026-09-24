# 源码导航

[文档导航](../README.md) · [架构](architecture.md)

从你想改变的行为找代码，再沿同一行的测试检查现有合同。首次阅读可以按 CLI/Web → SDK → daemon/worker → Host/Core 的顺序跟踪一次请求；开发插件则先看 Cordis、包治理和前端槽位。

下面链接指向与本文同一版本的源码；复现步骤与验收范围见[验证记录](../maintainers/verification.md)。是否启用某条路径，还需核对配置、调用者和相应测试。

| 行为 | 主要源码 | 验证起点 |
| --- | --- | --- |
| 参数/启动/运行目录 | [cli](../../packages/cli/src)、[cli-launch](../../packages/cli-launch/src) | [CLI 参数](../../packages/cli/test/args.test.ts)、[共享本地验收](../../tools/acceptance/shared-local-delivery.test.ts) |
| TUI | [cli-tui](../../packages/cli-tui/src) | [测试](../../packages/cli-tui/test) |
| Web 展示与连接 | [web](../../packages/web/src)、[web-server](../../packages/web-server/src) | [Web 测试](../../packages/web/test) |
| 前端插件与槽位 | [web-client](../../packages/web-client/src)、[web-slots](../../packages/web-slots/src)、[web-units](../../packages/web-units/src) | [名册对账](../../packages/web/test/client-modules.reconcile.test.ts) |
| 协议/校验 | [protocol schema](../../packages/protocol/schema)、[method table](../../packages/protocol/src/methods.ts)、[protocol-validation](../../packages/protocol-validation/src) | [protocol tests](../../packages/protocol/test) |
| SDK 会话/传输 | [sdk](../../packages/sdk/src) | [sdk tests](../../packages/sdk/test) |
| daemon/worker | [daemon](../../packages/daemon/src)、[worker-runtime](../../packages/worker-runtime/src) | [daemon tests](../../packages/daemon/test) |
| 执行循环/恢复 | [core](../../packages/core/src) | [core tests](../../packages/core/test) |
| 配置/装配/凭据/平台 | [host](../../packages/host/src)、[system-node](../../packages/system-node/src) | [host tests](../../packages/host/test) |
| 模型/流解析 | [ai](../../packages/ai/src) | [ai tests](../../packages/ai/test) |
| 标准工具/接缝 | [base extensions](../../packages/base/extensions)、[base](../../packages/base/src) | [base tests](../../packages/base/test) |
| Code 工作流 | [code](../../packages/code/src) | [code tests](../../packages/code/test) |
| Cordis 生命周期 | [cordis](../../packages/cordis/src)、[cordis-loader](../../packages/cordis-loader/src)、[plugin-runtime](../../packages/plugin-runtime/src) | [增量调和](../../packages/host/test/assemble/incremental-apply.test.ts) |
| 包治理 | [package-manager](../../packages/package-manager/src)、[package-isolation](../../packages/package-isolation/src) | [package-manager tests](../../packages/package-manager/test) |
| 资源治理 | [resource-control-store](../../packages/resource-control-store/src)、[resource-control-runtime](../../packages/resource-control-runtime/src)、[resource-control-worker](../../packages/resource-control-worker/src) | [Skills Cordis](../../packages/resource-control-runtime/test/skills-cordis.test.ts) |
| 资源 CLI/Web | [resource-control-cli](../../packages/resource-control-cli/src)、[resource-control-web](../../packages/resource-control-web/src) | [资源 CLI 测试](../../packages/resource-control-cli/test) |
| 外部渠道/格式转换 | [channels](../../packages/channels/src)、[bridges](../../packages/bridges/src) | [channels tests](../../packages/channels/test)、[bridges tests](../../packages/bridges/test) |
| 工程约束 | [guards](../../tools/guards) | [ratchet](../../tools/guards/ratchet.json) |

包公开出口以各自 package.json 的 `exports` 为准。上表深链接用于读代码，应用和插件不应据此深导入其他包私有 src。Python runtime 与 Python thin client 尚不作为可用公开路线。
