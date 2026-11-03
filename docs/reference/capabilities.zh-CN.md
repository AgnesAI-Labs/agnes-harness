# 能力矩阵

[English](capabilities.md) | 简体中文

[文档首页](../README.zh-CN.md) · [已知限制](limitations.zh-CN.md)

本页列出当前生产路径中明确拒绝、尚未接入或仅在特定条件下开放的能力。`stub` 表示尚无可用实现；`partial` 表示已有可用子集，但仍有明确边界；`wired` 表示有意采用拒绝执行或间接接入的实现，不代表未完成的工作。

机器可读的源码映射见 [`tools/guards/capability-stubs.json`](../../tools/guards/capability-stubs.json)。检查工具会拒绝没有稳定能力 ID 的新增生产代码标记（如 “not implemented”“not wired” 或 “not available in this build”），也会拒绝失效的源码标记，以及本表与登记表之间的不一致。

| 能力 ID | 功能 | 状态 | 阻塞项 / 当前边界 | 后续方向 | 源码依据 |
|---|---|---|---|---|---|
| `runtime.python.execution` | Python 代码运行时 | stub | 已有实验验证阈值，但尚无 Python 内核、原始 I/O 桥接、快照或恢复后端。 | 需要通过验证的运行时后端 | `packages/runtime-python/src/index.ts` |
| `code.runtime.lifecycle` | Code-mode 运行时生命周期 | partial | Provider 管理的独立 Node/TypeScript 与实验性 CPython cell 已接入受管工具桥；持久 kernel 和 Python raw_io:false 会被拒绝。 | Windows 与远程桥暂不支持 | `packages/code/src/extensions/code-mode/index.ts`, `packages/code/src/runtime/process.ts` |
| `ai.models.catalogue-probe` | 提供方模型目录探测 | partial | 常见 OpenAI/Anthropic 连通性探测可用；特定协议的模型目录与部分认证变体会被拒绝。 | 按提供方补充实现 | `packages/ai/src/adapters/pi/probe-models.ts`<br>`packages/ai/src/adapters/pi/probe.ts` |
| `artifacts.background-jobs` | 产物后台任务 | stub | 本地产物读写已实现，但异步产物任务尚未实现。 | 需要任务执行能力 | `packages/base/extensions/artifacts-local/src/jobs.ts` |
| `cli.onboarding.account` | 首次运行时登录 Agnes 账号 | stub | API key 路径已端到端接通；账号路径依赖平台的 PKCE、token、刷新和订阅目录契约，当前构建不包含这些能力。选择器会展示该选项并明确拒绝，避免打开无法完成的流程。 | 需要账号集成 | `packages/cli/src/onboarding/tui.ts`、`packages/cli-tui/src/locale-extended.ts` |
| `profile.additional-layers` | Workspace、local、flags 与 managed 配置层 | partial | 已验证的 workspace 覆盖层，以及仅包含隔离设置的 local/flags/managed 覆盖层可解析；这些层的其他字段仍会被拒绝，确保 profile hash 如实反映配置。 | 扩展配置层支持 | `packages/host-common/src/profile/isolation.ts` |
| `sandbox.host-filtered-network` | 主机白名单网络约束 | partial | 完全禁网可用；非空主机白名单依赖尚未实现的过滤代理。 | 需要网络过滤能力 | `packages/host-infrastructure/src/sandbox-seam.ts`<br>`packages/base/extensions/sandbox/src/backends/shared.ts` |
| `windows.runtime-enforcement` | Windows 沙箱与凭据保护 | partial | 原生私有凭据 ACL 约束已实现；原生能力不可用时会拒绝执行。受限令牌沙箱与网络隔离仍不可用，强制隔离请求必须被拒绝。完整 Windows 验收尚未完成。 | 完成 Windows 兼容性验收；当前范围不包含 OS 沙箱 | `packages/host-infrastructure/src/adapters/platform-win32.ts`<br>`packages/host-infrastructure/src/adapters/credential-files.ts`<br>`packages/base/extensions/sandbox/src/workspace-probe.ts`<br>`packages/web-ui/src/locales/config-form.ts` |
| `cli.remote-and-extra-modes` | CLI 远程传输与额外模式 | partial | 本地 print/TUI 与 ACP 可用；显式 `--connect` 使用共享 daemon。其余管理命令仍遵循文档规定的本地或拒绝执行范围。 | 按模式补充实现 | `packages/cli/src/bin.ts` |
| `sdk.optional-build-capabilities` | SDK 可选传输与认证构造 | wired | 入口未包含可选传输或认证实现时，`Unsupported` 是预期的类型化边界。 | 已完成；保留缺失能力时拒绝执行的行为 | `packages/sdk/src/errors.ts` |
| `sandbox.bwrap-runtime-selection` | Bubblewrap 选择 | wired | 编译器叶子实现有意不作为默认 seam 直接使用，由运行时后端选择器探测并选择。 | 已完成；保留间接接入方式 | `packages/base/extensions/sandbox/src/backends/bwrap.ts` |

## 会话命令传输

[协议层级清单](protocol-tiers.zh-CN.md)列出当前客户端与管理方法。以下能力统一使用持久化 submit 路径；SDK 方法继续可用。

| 能力 | SDK 方法 | Native 请求 |
|---|---|---|
| 指引 | `session.steer(content)` | `_agnes/v1/submit`，kind 为 `steer` |
| Follow-up | `session.followUp(content)` | `_agnes/v1/submit`，kind 为 `followUp` |
| 修改排队输入 | `session.editQueued(itemId, content)` | `_agnes/v1/submit`，kind 为 `editQueued` |

重试保持 `clientId` 与 `commandId` 稳定；可选 `generation` 放在 submit envelope 上。保留的 native `_agnes/v1/session.control` 包装同样走 submit 接纳和 journal。共享命令 DTO 继续作为协议合同保留。

## 支持级别说明

平台支持范围见[已知限制](limitations.zh-CN.md)。本地测试和 CI 覆盖本身不能证明安装包、签名、外部服务或实体设备支持。运行时隔离、权限与进程身份需要在各目标平台分别验证。

工具权限、计划退出及普通插件的会话确认使用公开 DecisionPort 和同一 session ledger。旧 ticket-store stub 已删除；其他领域继续自己的实际审核路径，没有可恢复切点的旧 parking 明确拒绝。见[决策恢复示例](../../examples/loops/decision-loop/README.md)。

插件可以声明当前 profile 的受管理资源和认证流，参阅 [profile 服务](../develop/profile-services.zh-CN.md)。
