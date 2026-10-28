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
| 插件流传输 | [共享 gateway 与 broker](../../packages/plugin-streams/src) · [当前 profile 资源](../../packages/host-extensions/src/profile) | [Gateway 测试](../../packages/daemon-rpc/test/streams/gateway.test.ts) |
| SDK 会话/传输 | [sdk](../../packages/sdk/src)、[Node 资源管理](../../packages/sdk/src/resource-control.node.ts)、[Node 包客户端](../../packages/sdk/src/package-admin.node.ts) | [sdk tests](../../packages/sdk/test) |
| daemon/worker | [daemon-foundation](../../packages/daemon-foundation/src)、[daemon-surfaces](../../packages/daemon-surfaces/src)、[daemon-admin](../../packages/daemon-admin/src)、[daemon-rpc](../../packages/daemon-rpc/src)、[Daemon supervisor](../../packages/daemon/src/supervisor)、[daemon](../../packages/daemon/src)、[worker-runtime](../../packages/worker-runtime/src) | [daemon tests](../../packages/daemon/test) |
| 可观测性 / 安全诊断 | [observability](../../packages/observability/src), [provider kind](../../packages/observability/src/contract.ts), [diagnostics RPC](../../packages/daemon-rpc/src/local/methods/diagnostics.ts) | [测试](../../packages/observability/test/provider.test.ts) |
| Intelligent UI kind 令牌 | [intelligent-ui-contract](../../packages/intelligent-ui-contract/src) | [服务绑定](../../packages/host/test/service-bindings.test.ts) |
| UI 数据源解析 | [合同](../../packages/intelligent-ui-contract/src)、[解析器](../../packages/host/src/runtime/sessions/ui-data-source.ts) | [解析测试](../../packages/host/test/ui-data-source.test.ts) |
| Git worktree kind 令牌 | [git-worktree-contract](../../packages/git-worktree-contract/src) | [服务绑定](../../packages/host/test/service-bindings.test.ts) |
| 执行循环/恢复 | [core-common](../../packages/core-common/src), [core-child-control](../../packages/core-child-control/src), [core-ledger](../../packages/core-ledger/src), [core-effects](../../packages/core-effects/src), [Core artifacts](../../packages/core/src/artifacts), [core](../../packages/core/src) | [core tests](../../packages/core/test) |
| 状态权威、副本与恢复 | [状态归属](state-ownership.zh-CN.md) | [寄存器校验](../../packages/core-ledger/test/tracker.test.ts) |
| provider 类型/统一生命周期/组合目录 | [类型合同](../../packages/extension-api/src/provider-kind.ts)、[服务合同](../../packages/extension-api/src/service-provider.ts)、[注册表](../../packages/host-common/src/assemble/provider-registry.ts)、[绑定](../../packages/host-common/src/assemble/service-binding.ts)、[选择](../../packages/host-providers/src/assemble/provider-selection.ts)、[provider 架构](architecture-plugins.zh-CN.md) | [注册与选择测试](../../packages/host/test/owners/host-common/test/assemble/provider-registry.test.ts)、[服务绑定](../../packages/host/test/service-bindings.test.ts)、[Host 装配](../../packages/host/test/assemble/tool-providers.test.ts) |
| 配置/装配/凭据/平台 | [host-common](../../packages/host-common/src), [host-infrastructure](../../packages/host-infrastructure/src), [host-computer-use](../../packages/host-computer-use/src), [host-artifacts](../../packages/host-artifacts/src), [host-extensions](../../packages/host-extensions/src), [host-providers](../../packages/host-providers/src), [Host runtime](../../packages/host/src/runtime), [host](../../packages/host/src)、[system-node](../../packages/system-node/src) | [host tests](../../packages/host/test) |
| 模型/流解析 | [ai](../../packages/ai/src) | [ai tests](../../packages/ai/test) |
| 标准工具/接缝 | [base extensions](../../packages/base/extensions)、[base](../../packages/base/src) | [base tests](../../packages/base/test) |
| Code 工作流 | [code](../../packages/code/src) | [code tests](../../packages/code/test) |
| Cordis 生命周期 | [cordis](../../packages/cordis/src)、[cordis-loader](../../packages/cordis-loader/src)、[plugin-runtime](../../packages/plugin-runtime/src) | [增量调和](../../packages/host/test/assemble/incremental-apply.slow.test.ts) |
| 发行装配 | [distribution](../../packages/distribution/src)、[发行策略及内置载荷](../../packages/package-manager/src/release-policy.ts)、[profile 模板](../../packages/package-manager/templates) | [Host 装配测试](../../packages/host/test/assemble) |
| 包治理 | [package-manager](../../packages/package-manager/src)、[package-isolation](../../packages/package-isolation/src) | [package-manager tests](../../packages/package-manager/test) |
| 资源治理 | [resource-control-store](../../packages/resource-control-store/src)、[resource-control-runtime](../../packages/resource-control-runtime/src)、[resource-control-worker](../../packages/resource-control-worker/src) | [Skills Cordis](../../packages/resource-control-runtime/test/skills-cordis.test.ts) |
| 资源 CLI/Web | [resource-control-cli](../../packages/resource-control-cli/src)、[resource-control-web](../../packages/resource-control-web/src) | [资源 CLI 测试](../../packages/resource-control-cli/test) |
| 外部渠道/格式转换 | [channels](../../packages/channels/src)、[bridges](../../packages/bridges/src) | [channels tests](../../packages/channels/test)、[bridges tests](../../packages/bridges/test) |
| 工程约束 | [guards](../../tools/guards) | [scope 有效行报告（不阻断增长）](../../tools/guards/scope-line-count.json) |

包公开出口以各自 package.json 的 `exports` 为准。上表深链接用于读代码，应用和插件不应据此深导入其他包私有 src。Python runtime 与 Python thin client 尚不作为可用公开路线。

运行时包的生产源码、测试和共享 testkit 使用独立的 TypeScript 项目；根 `typecheck` 覆盖三者及工具脚本。

本地 RPC 经 `@agnes/daemon-admin/app-server` 认证并分派设置操作；daemon-admin 拥有组合、上下文、计划模式及历史的实现。Runtime doctor 的组合探测位于 `@agnes/daemon-admin/runtime-doctor`，本地 RPC 保留认证与分派。RPC 原有工厂出口保持兼容。本地 RPC 仅允许从 Base 导入具名公开拒绝标记 `ScheduleRejected`。MCP 命名使用 protocol 的可移植 `sha256Hex` 出口：UTF-8 编码（包括未配对代理项的替换）与现有后缀均保持不变。

学习偏好：`packages/memory-file` 拥有官方文件提供器，`packages/extension-api/src/memory.ts` 拥有公共 SPI，`packages/web-admin/src/settings/memory.tsx` 拥有编辑器，`packages/base/src/memory` 拥有 remembering 技能。

MCP 传输健康回调：[implementation](../../packages/base/src/mcp/transport-health.ts) · [tests](../../packages/base/test/mcp/transport-health.test.ts)

可关闭对话框 DOM 绑定：[web-ui](../../packages/web-ui/src/dom/dialog-binding.ts) · [tests](../../packages/web-ui/test/dialog-binding.test.ts)

Host 组合合同测试：[owner suites](../../packages/host/test/owners)

Daemon、Host、Web 的私有实现路径直接使用所属包；已删除过时的一行转发路径。插件作者使用 `@agnes/host/author-testkit`，它自动提供生产注册桥；参阅[导入选择图](../extend/imports.zh-CN.md)。

大型前端入口保留原有出口，具体职责分给领域模块：

| 入口 | 所属模块 |
| --- | --- |
| 轨迹视图 | [纯轨迹模型](../../packages/web-units/src/trace-model.ts)、[React 视图](../../packages/web-units/src/trace.tsx) |
| 插件管理 | [页面生命周期与操作](../../packages/web-admin/src/admin/plugins/admin/page.tsx)、[视图](../../packages/web-admin/src/admin/plugins/admin/views.tsx)、[控制面板](../../packages/web-admin/src/admin/plugins/control-panel.tsx) |
| 设置与模型选择 | [对话框辅助](../../packages/web-admin/src/settings/dialog.ts)、[模型选择辅助](../../packages/web/src/model-picker)、[设置词典](../../packages/web-admin/src/settings/locales)、[插件词典](../../packages/web-admin/src/admin/plugins/locales/admin) |
| 资源管理 | [MCP 表单](../../packages/resource-control-web/src/mcp-form.ts)、[页面](../../packages/resource-control-web/src/admin.tsx) |
| 客户端服务与插槽 | [服务合同](../../packages/web-client/src/service-contracts.ts)、[服务入口](../../packages/web-client/src/services.ts)、[插槽核心](../../packages/web-slots/src/core.ts)、[插槽合同](../../packages/web-slots/src/types.ts) |
| 静态 Web 服务 | [选项](../../packages/web-server/src/server-types.ts)、[资源](../../packages/web-server/src/server-assets.ts)、[安全校验](../../packages/web-server/src/server-security.ts)、[HTTP 辅助](../../packages/web-server/src/server-http.ts) |
| Web 样式 | [有序清单](../../packages/web/public/style.css)、[领域片段](../../packages/web/public/styles)、[源文件拼接工具](../../tools/web-style-source.mjs) |

CSS 片段保留原来的级联顺序，同一领域的后置覆盖仍在后面。两条构建路径先拼接为现有 `/style.css`，再追加对话样式；样式源码测试与主题 token 生成读取相同的拼接源码，开发模式监听每个片段。

`RemoteTransport` 纯类型合同位于 [extension-api](../../packages/extension-api/src/remote-transport.ts)，Core 导出同一类型。Ledger 测试助手位于 [core-ledger/testkit](../../packages/core-ledger/testkit)。

插件冷启动发布复用现有的协作式文件校验。[版本归档](../../packages/package-manager/src/runtime-snapshots-generations.ts) 为既有调用方保留同步创建，Host 发布使用异步创建，两者执行同一组校验步骤。独立克隆或复制的文件树先重新校验、刷盘，再发布记录；创建回读检查记录和资源，独立读取则完整校验包字节。未完成的归档由仍存活的创建进程保护，失败后清理。本地来源获取仍检查复制前后的源目录和目标目录，异步等待后再次检查目标是否被占用。

异步目录校验使用现有的受限元数据读取池扫描同层目录：最多同时读取四个目录，每个目录最多同时检查四个条目。文件读取仍限制为每次遍历最多四个句柄和 1 MiB 暂存内存。完整性、路径边界、链接和文件变化检查均保留；失败或取消后，先等待所有已开始的读取结束，再返回。

CLI/TUI 插件来源在输入入口规范化本机路径分隔符，后端来源校验不变。Ctrl-G 保留 POSIX 引号规则，Windows 原生程序使用不展开变量的参数规则。工作区 Git 状态在 Windows 上也使用 Git 能识别的 `/dev/null` 写法，并继续禁用钩子、过滤器和网络操作。终端工作区标签仅在显示时统一分隔符，使 Git 与 Windows 本机路径能一致缩写。工程脚本的 npm 命令复用[工具链检查](../../tools/toolchain/check.mjs)中选定 Node 的启动方式。历史页面对比在隔离目录中安装各版本的锁定依赖，成功或失败后均清理临时目录。[文档验收脚本](../../tools/public-docs/smoke.mjs)使用系统临时目录，连接 Windows 管道时校验守护进程身份。

Windows 文件系统仅在同一次 read/list/stat 授权内复用已完成的最终路径解析。后续操作仍重新解析路径、读取权限和 Skill 目录；POSIX 和远程读取保留原来的拒绝后复查流程。实现见[文件系统边界](../../packages/host-infrastructure/src/adapters/fs.ts)，验证见 [Skill 读取测试](../../packages/host-infrastructure/test/adapters/fs-skill-read.test.ts)。

终端输入层仅在查询期间缓存有界的光标回复片段，超时后释放未完成的输入。[原件导出](../../packages/cli/src/commands/native-bundle.ts)在各平台复用已有私有目录创建方法，建立暂存和原件目录。[旧凭据迁移](../../packages/host-infrastructure/src/adapters/file-secrets-dir.ts)同样用它创建新的目标目录，读取时不修补权限。[安全状态汇总](../../packages/host/src/runtime/lifecycle/admin-security-status.ts)不展示配方解析器明确拒绝的权限档位；会话授权和其他错误仍按原有规则处理。插件指南限制文本预览大小，结构化结果仍保留完整的标准模板。

会话展示按职责拆为 [Web controllers](../../packages/web/src/app)、[区域挂载](../../packages/web/src/regions)、[时间线节点宿主](../../packages/web/src/timeline-node-host.tsx)、[composer](../../packages/web-units/src/composer)、[消息与回合](../../packages/web-ui/src/conversation/messages) 和 [客户端对账](../../packages/web/src/client-modules/reconcile)。原入口保留现有导出。
