# 源码导航

[English](source-map.md) | 简体中文

[文档导航](../README.zh-CN.md) · [架构](architecture.zh-CN.md)

从你想改变的行为找代码，再沿同一行的测试检查现有合同。首次阅读可以按 CLI/Web → SDK → daemon/worker → Host/Core 的顺序跟踪一次请求；开发插件则先看 Cordis、包治理和前端槽位。

下面链接指向与本文同一版本的源码；复现步骤与验收范围见[验证记录](../maintainers/verification.zh-CN.md)。是否启用某条路径，还需核对配置、调用者和相应测试。

| 行为 | 主要源码 | 验证起点 |
| --- | --- | --- |
| 参数/启动/运行目录 | [cli](../../packages/cli/src)、[启动资源](../../packages/cli/launch/resources.ts) | [CLI 参数](../../packages/cli/test/args.test.ts)、[共享本地验收](../../tools/acceptance/shared-local-delivery.e2e.test.ts) |
| TUI | [cli-tui](../../packages/cli-tui/src) | [测试](../../packages/cli-tui/test) |
| Web 展示与连接 | [web](../../packages/web/src)、[web-server](../../packages/web-server/src) | [Web 测试](../../packages/web/test) |
| Web 外观与语言基础 | [web-foundation](../../packages/web-foundation/src) | [基础模块测试](../../packages/web-foundation/test) |
| Web 会话展示 | [web-conversation](../../packages/web-conversation/src) | [模块测试](../../packages/web-conversation/test) |
| Web 管理与设置 | [web-admin](../../packages/web-admin/src) | [模块测试](../../packages/web-admin/test) |
| 前端插件与槽位 | [web-client](../../packages/web-client/src)、[web-slots](../../packages/web-slots/src)、[web-units](../../packages/web-units/src) | [名册对账](../../packages/web/test/client-modules.reconcile.test.ts) |
| 协议/校验 | [protocol schema](../../packages/protocol/schema)、[method table](../../packages/protocol/src/methods.ts)、[protocol-validation](../../packages/protocol-validation/src) | [protocol tests](../../packages/protocol/test) |
| SDK 会话/传输 | [sdk](../../packages/sdk/src)、[Node 资源管理](../../packages/sdk/src/resource-control.node.ts)、[Node 包客户端](../../packages/sdk/src/package-admin.node.ts) | [sdk tests](../../packages/sdk/test) |
| daemon/worker | [daemon-foundation](../../packages/daemon-foundation/src)、[daemon-surfaces](../../packages/daemon-surfaces/src)、[daemon-admin](../../packages/daemon-admin/src)、[daemon-rpc](../../packages/daemon-rpc/src)、[Daemon supervisor](../../packages/daemon/src/supervisor)、[daemon](../../packages/daemon/src)、[worker-runtime](../../packages/worker-runtime/src) | [daemon tests](../../packages/daemon/test) |
| 可观测性 / 安全诊断 | [observability](../../packages/observability/src), [provider kind](../../packages/observability/src/contract.ts), [diagnostics RPC](../../packages/daemon-rpc/src/local/methods/diagnostics.ts) | [测试](../../packages/observability/test/provider.test.ts) |
| Intelligent UI kind 令牌 | [intelligent-ui-contract](../../packages/intelligent-ui-contract/src) | [服务绑定](../../packages/host/test/service-bindings.test.ts) |
| UI 数据源解析 | [合同](../../packages/intelligent-ui-contract/src)、[解析器](../../packages/host/src/runtime/sessions/ui-data-source.ts) | [解析测试](../../packages/host/test/ui-data-source.test.ts) |
| Git worktree kind 令牌 | [git-worktree-contract](../../packages/git-worktree-contract/src) | [服务绑定](../../packages/host/test/service-bindings.test.ts) |
| 执行循环/恢复 | [core-common](../../packages/core-common/src), [core-child-control](../../packages/core-child-control/src), [core-ledger](../../packages/core-ledger/src), [core-effects](../../packages/core-effects/src), [Core artifacts](../../packages/core/src/artifacts), [core](../../packages/core/src) | [core tests](../../packages/core/test) |
| provider 类型/统一生命周期/组合目录 | [类型合同](../../packages/extension-api/src/provider-kind.ts)、[服务合同](../../packages/extension-api/src/service-provider.ts)、[注册表](../../packages/host-common/src/assemble/provider-registry.ts)、[绑定](../../packages/host-common/src/assemble/service-binding.ts)、[选择](../../packages/host-providers/src/assemble/provider-selection.ts)、[provider 架构](architecture-plugins.zh-CN.md) | [注册与选择测试](../../packages/host/test/owners/host-common/test/assemble/provider-registry.test.ts)、[服务绑定](../../packages/host/test/service-bindings.test.ts)、[Host 装配](../../packages/host/test/assemble/tool-providers.test.ts) |
| 配置/装配/凭据/平台 | [host-common](../../packages/host-common/src), [host-infrastructure](../../packages/host-infrastructure/src), [host-computer-use](../../packages/host-computer-use/src), [host-artifacts](../../packages/host-artifacts/src), [host-extensions](../../packages/host-extensions/src), [host-providers](../../packages/host-providers/src), [Host runtime](../../packages/host/src/runtime), [host](../../packages/host/src)、[system-node](../../packages/system-node/src) | [host tests](../../packages/host/test) |
| 模型/流解析 | [ai](../../packages/ai/src) | [ai tests](../../packages/ai/test) |
| 标准工具/接缝 | [base extensions](../../packages/base/extensions)、[base](../../packages/base/src) | [base tests](../../packages/base/test) |
| Code 工作流 | [code](../../packages/code/src) | [code tests](../../packages/code/test) |
| Cordis 生命周期 | [cordis](../../packages/cordis/src)、[cordis-loader](../../packages/cordis-loader/src)、[plugin-runtime](../../packages/plugin-runtime/src) | [增量调和](../../packages/host/test/assemble/incremental-apply.slow.test.ts) |
| 包治理 | [package-manager](../../packages/package-manager/src)、[package-isolation](../../packages/package-isolation/src) | [package-manager tests](../../packages/package-manager/test) |
| 资源治理 | [resource-control-store](../../packages/resource-control-store/src)、[resource-control-runtime](../../packages/resource-control-runtime/src)、[resource-control-worker](../../packages/resource-control-worker/src) | [Skills Cordis](../../packages/resource-control-runtime/test/skills-cordis.test.ts) |
| 资源 CLI/Web | [resource-control-cli](../../packages/resource-control-cli/src)、[resource-control-web](../../packages/resource-control-web/src) | [资源 CLI 测试](../../packages/resource-control-cli/test) |
| 外部渠道/格式转换 | [channels](../../packages/channels/src)、[bridges](../../packages/bridges/src) | [channels tests](../../packages/channels/test)、[bridges tests](../../packages/bridges/test) |
| 工程约束 | [guards](../../tools/guards) | [ratchet](../../tools/guards/ratchet.json) |

包公开出口以各自 package.json 的 `exports` 为准。上表深链接用于读代码，应用和插件不应据此深导入其他包私有 src。Python runtime 与 Python thin client 尚不作为可用公开路线。

运行时包的生产源码、测试和共享 testkit 使用独立的 TypeScript 项目；根 `typecheck` 覆盖三者及工具脚本。

本地 RPC 经 `@agnes/daemon-admin/app-server` 认证并分派设置操作；daemon-admin 拥有组合、上下文、计划模式及历史的实现。Runtime doctor 的组合探测位于 `@agnes/daemon-admin/runtime-doctor`，本地 RPC 保留认证与分派。RPC 原有工厂出口保持兼容。本地 RPC 仅允许从 Base 导入具名公开拒绝标记 `ScheduleRejected`。MCP 命名使用 protocol 的可移植 `sha256Hex` 出口：UTF-8 编码（包括未配对代理项的替换）与现有后缀均保持不变。

学习偏好：`packages/memory-file` 拥有官方文件提供器，`packages/extension-api/src/memory.ts` 拥有公共 SPI，`packages/web-admin/src/settings/memory.tsx` 拥有编辑器，`packages/base/src/memory` 拥有 remembering 技能。

MCP 传输健康回调：[implementation](../../packages/base/src/mcp/transport-health.ts) · [tests](../../packages/base/test/mcp/transport-health.test.ts)

可关闭对话框 DOM 绑定：[web-ui](../../packages/web-ui/src/dom/dialog-binding.ts) · [tests](../../packages/web-ui/test/dialog-binding.test.ts)

Host 组合合同测试：[owner suites](../../packages/host/test/owners)

Daemon、Host、Web 的私有实现路径直接使用所属包；已删除过时的一行转发路径。插件作者显式从 `@agnes/host/testkit` 提供注册桥。

大型前端入口保留原有出口，具体职责分给领域模块：

| 入口 | 所属模块 |
| --- | --- |
| 轨迹视图 | [纯轨迹模型](../../packages/web-units/src/trace-model.ts)、[React 视图](../../packages/web-units/src/trace.ts) |
| 插件管理 | [页面生命周期与操作](../../packages/web-admin/src/admin/plugins/admin/page.tsx)、[视图](../../packages/web-admin/src/admin/plugins/admin/views.tsx)、[控制面板](../../packages/web-admin/src/admin/plugins/control-panel.tsx) |
| 设置与模型选择 | [对话框辅助](../../packages/web-admin/src/settings/dialog.ts)、[模型选择辅助](../../packages/web/src/model-picker)、[设置词典](../../packages/web-admin/src/settings/locales)、[插件词典](../../packages/web-admin/src/admin/plugins/locales/admin) |
| 资源管理 | [MCP 表单](../../packages/resource-control-web/src/mcp-form.ts)、[页面](../../packages/resource-control-web/src/admin.tsx) |
| 客户端服务与插槽 | [服务合同](../../packages/web-client/src/service-contracts.ts)、[服务入口](../../packages/web-client/src/services.ts)、[插槽核心](../../packages/web-slots/src/core.ts)、[插槽合同](../../packages/web-slots/src/types.ts) |
| 静态 Web 服务 | [选项](../../packages/web-server/src/server-types.ts)、[资源](../../packages/web-server/src/server-assets.ts)、[安全校验](../../packages/web-server/src/server-security.ts)、[HTTP 辅助](../../packages/web-server/src/server-http.ts) |
| Web 样式 | [有序清单](../../packages/web/public/style.css)、[领域片段](../../packages/web/public/styles)、[源文件拼接工具](../../tools/web-style-source.mjs) |

CSS 片段保留原来的级联顺序，同一领域的后置覆盖仍在后面。两条构建路径先拼接为现有 `/style.css`，再追加对话样式；样式源码测试与主题 token 生成读取相同的拼接源码，开发模式监听每个片段。

`RemoteTransport` 纯类型合同位于 [extension-api](../../packages/extension-api/src/remote-transport.ts)，Core 导出同一类型。Ledger 测试助手位于 [core-ledger/testkit](../../packages/core-ledger/testkit)。

会话展示按职责拆为 [Web controllers](../../packages/web/src/app)、[区域挂载](../../packages/web/src/regions)、[时间线节点](../../packages/web/src/timeline)、[composer](../../packages/web-units/src/composer)、[消息与回合](../../packages/web-ui/src/conversation/messages) 和 [客户端对账](../../packages/web/src/client-modules/reconcile)。原入口保留现有导出。
