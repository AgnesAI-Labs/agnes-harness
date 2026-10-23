# 协议分层

[English](protocol-tiers.md) | 简体中文

协议的 RPC 方法分为两层。分层定义在 `packages/protocol/src/method-tiers.ts`（`METHOD_TIERS`）；测试要求每个方法都已分类并列在本页。

## 客户端契约

第三方客户端依赖的方法：会话、提交、决策与事件。承诺保持稳定，变更以新增为主或经版本化迁移。

### 连接与会话生命周期

- `initialize`
- `authenticate`
- `_agnes/v1/auth.claim`
- `_agnes/v1/agents.resolve`
- `session/new`
- `_agnes/v1/session.open`
- `session/load`
- `session/set_mode`
- `_agnes/v1/session.attach`
- `_agnes/v1/session.detach`
- `_agnes/v1/session.list`
- `_agnes/v1/session.groups`
- `_agnes/v1/session.fork`
- `_agnes/v1/session.btw`
- `_agnes/v1/session.rename`
- `_agnes/v1/session.archive`
- `_agnes/v1/session.pin`
- `_agnes/v1/session.revealWorkspace`
- `_agnes/v1/session.bookmarks.set`
- `_agnes/v1/session.control`
- `_agnes/v1/session.controls`
- `_agnes/v1/session.budget`
- `_agnes/v1/session.setPreset`
- `_agnes/v1/session.setModel`
- `_agnes/v1/session.setYolo`
- `_agnes/v1/session.setToolFilter`
- `_agnes/v1/participant.join`
- `_agnes/v1/participant.leave`
- `_agnes/v1/participant.list`
- `_agnes/v1/workspace.list`
- `_agnes/v1/workspace.add`
- `_agnes/v1/workspace.reveal`
- `_agnes/v1/workspace.remove`

`workspace.reveal` 接受 `path` 或 `workspaceId` 中的一个，只打开列表中经过重新校验的规范工作区。
与 `session.revealWorkspace` 相同，它要求本地桌面所有者和可用的交互桌面，拒绝任意路径及远程凭据。

`workspace.remove` 接受 `workspaceId` 和可选的 `expectedRevision`，要求本地所有者身份。
它归档项目的所有会话并移除项目列表项，绝不删除磁盘文件。`WORKSPACE_RUNNING` 表示须先停止运行中的会话；
`WORKSPACE_STALE` 表示须刷新版本。这些拒绝不会修改列表或归档会话。重复移除返回 `removed: false`；
重新添加文件夹会恢复项目列表项，会话仍保持归档。已有会话绑定保留，支持从「已归档」恢复。

### 提交与回合控制

- `_agnes/v1/submit`
- `_agnes/v1/submit.ack`

`submit` 的 `kind: control, payload.action: promote` 将现有队列项（`itemId`）原子转换为
`next-step` 指导（`kind: steer`），保留条目身份、内容、附件与来源，要求当前轮仍在运行且固定 Loop 支持 steer。
队列修改与控制回执同时提交；条目过期或拒绝时不改变原项。重放沿用原命令 ID，从回执恢复，
不会新增消息。旧服务端可拒绝这个新增动作；客户端不得用删除后重发来模拟。

- `session/prompt`
- `session/cancel`

### 决策与审批

- `_agnes/v1/approval.decide`
- `_agnes/v1/approval.withdraw`
- `_agnes/v1/decision.list`
- `session/request_permission`
- `_agnes/v1/ext.ui.response`

### 事件与通知

- `session/update`
- `_agnes/v1/session.event`
- `_agnes/v1/session.loading`
- `_agnes/v1/session.loadingCancel`
- `_agnes/v1/session.preview`
- `_agnes/v1/daemon.notice`

### 会话内容、工作区与界面

- `_agnes/v1/session.runtime`
- `_agnes/v1/session.tools`
- `_agnes/v1/session.integrity`
- `_agnes/v1/session.readToolDetail`
- `_agnes/v1/session.deliverables`
- `_agnes/v1/session.jobs.read`
- `_agnes/v1/session.jobs.control`
- `_agnes/v1/session.workspace.list`
- `_agnes/v1/session.workspace.read`
- `_agnes/v1/session.workspace.changes`
- `_agnes/v1/session.undo.preview`
- `_agnes/v1/session.undo`
- `_agnes/v1/session.references.search`
- `_agnes/v1/session.fileUpload`
- `_agnes/v1/session.projectUI`
- `_agnes/v1/session.projectUIPatch`
- `_agnes/v1/session.view`
- `_agnes/v1/session.projectUIOpening`
- `_agnes/v1/session.projectUIHistory`
- `_agnes/v1/ui.action`
- `_agnes/v1/ui.read`
- `_agnes/v1/ui.refresh`
- `_agnes/v1/artifact.read`
- `_agnes/v1/artifact.job.status`

### Profile 操作与绑定通知

- `_agnes/v1/extension.callScoped`
- `_agnes/v1/extension.readOperation`
- `_agnes/v1/extension.wakes.enqueue`
- `_agnes/v1/extension.wakes.read`
- `_agnes/v1/profile.decisions.list`
- `_agnes/v1/profile.decisions.answer`

## 管理契约

包管理、资源控制、配置、调度、诊断与计算机使用。这些方法可能随版本演进；请通过 SDK 使用，而不是依赖其线上结构。

### 诊断

- `_agnes/v1/admin.feedback`
- `_agnes/v1/doctor.run`
- `_agnes/v1/admin.observability`
- `_agnes/v1/trace.clear`
- `_agnes/v1/session.factChain`
- `_agnes/v1/trace.request`
- `_agnes/v1/diagnostics.export`
- `_agnes/v1/diagnostics.collect`
- `_agnes/v1/diagnostics.events`

### 凭据

- `_agnes/v1/admin.credentials.list`
- `_agnes/v1/admin.credentials.create`
- `_agnes/v1/admin.credentials.set`
- `_agnes/v1/admin.credentials.rename`
- `_agnes/v1/admin.credentials.delete`

### 其他管理

- `_agnes/v1/admin.bundles.get`
- `_agnes/v1/admin.bundles.save`
- `_agnes/v1/admin.composition.get`
- `_agnes/v1/admin.search.get`
- `_agnes/v1/admin.search.save`
- `_agnes/v1/admin.search.test`
- `_agnes/v1/admin.context`
- `_agnes/v1/admin.history.search`
- `_agnes/v1/admin.plan`
- `_agnes/v1/admin.mcp.oauth.save`
- `_agnes/v1/admin.memory`
- `_agnes/v1/admin.triggers`
- `_agnes/v1/sessions.migrate`

### 插件树、配置与候选

- `_agnes/v1/plugins.candidates.list`
- `_agnes/v1/plugins.candidates.show`
- `_agnes/v1/plugins.candidates.create`
- `_agnes/v1/plugins.candidates.write`
- `_agnes/v1/plugins.candidates.test`
- `_agnes/v1/plugins.candidates.submit`
- `_agnes/v1/plugins.candidates.approve`
- `_agnes/v1/plugins.candidates.reject`
- `_agnes/v1/plugins.tree.get`
- `_agnes/v1/plugins.publicationStatus`
- `_agnes/v1/plugins.generations`
- `_agnes/v1/plugins.tree.list`
- `_agnes/v1/plugins.tree.apply`
- `_agnes/v1/plugins.tree.rollback`
- `_agnes/v1/plugins.config.get`
- `_agnes/v1/plugins.config.validate`
- `_agnes/v1/plugins.config.save`

### 包管理

- `_agnes/v1/packages.catalog.list`
- `_agnes/v1/packages.catalog.get`
- `_agnes/v1/packages.provenance`
- `_agnes/v1/packages.sourcePolicy`
- `_agnes/v1/applications.get`
- `_agnes/v1/applications.preview`
- `_agnes/v1/applications.adopt`
- `_agnes/v1/applications.clear`
- `_agnes/v1/packages.list`
- `_agnes/v1/packages.inspect`
- `_agnes/v1/packages.install`
- `_agnes/v1/packages.trust`
- `_agnes/v1/packages.untrust`
- `_agnes/v1/packages.enable`
- `_agnes/v1/packages.disable`
- `_agnes/v1/packages.update`
- `_agnes/v1/packages.rollback`
- `_agnes/v1/packages.remove`
- `_agnes/v1/packages.operation.get`
- `_agnes/v1/packages.operation.cancel`
- `_agnes/v1/packages.pins.inspect`
- `_agnes/v1/packages.pins.release`
- `_agnes/v1/packages.trustWorkspace`

### 客户端模块与皮肤

- `_agnes/v1/skins.list`
- `_agnes/v1/skins.read`
- `_agnes/v1/clientModules.list`
- `_agnes/v1/clientModules.read`
- `_agnes/v1/clientModules.callService`
- `_agnes/v1/clientModules.callEffect`

### 资源控制

- `_agnes/v1/resources.list`
- `_agnes/v1/resources.get`
- `_agnes/v1/resources.desired.set`
- `_agnes/v1/resources.operation.get`
- `_agnes/v1/resources.operation.cancel`

### 技能

- `_agnes/v1/skills.refresh`
- `_agnes/v1/skills.remove`
- `_agnes/v1/skills.priority.set`
- `_agnes/v1/skills.trust.set`

### MCP 服务器

- `_agnes/v1/mcp.servers.list`
- `_agnes/v1/mcp.servers.get`
- `_agnes/v1/mcp.servers.status`
- `_agnes/v1/mcp.servers.tools.list`
- `_agnes/v1/mcp.servers.create`
- `_agnes/v1/mcp.servers.update`
- `_agnes/v1/mcp.servers.remove`
- `_agnes/v1/mcp.servers.trust.set`
- `_agnes/v1/mcp.servers.test`
- `_agnes/v1/mcp.servers.enable`
- `_agnes/v1/mcp.servers.disable`
- `_agnes/v1/mcp.servers.reconnect`
- `_agnes/v1/mcp.servers.oauth.status`
- `_agnes/v1/mcp.servers.oauth.status.set`

### 扩展调用与界面

- `_agnes/v1/extension.ack`
- `_agnes/v1/extension.call`
- `_agnes/v1/directory.upsert`
- `_agnes/v1/apis.list`
- `_agnes/v1/pluginRuntime.status`
- `_agnes/v1/pluginStreams.endpoint`
- `_agnes/v1/surfaces.mounts`

### 会话默认值与选择

- `_agnes/v1/sessionSelection.loops`
- `_agnes/v1/sessionSelection.runtime`
- `_agnes/v1/sessionSelection.reloadLocal`
- `_agnes/v1/sessionSelection.modelAdapters`
- `_agnes/v1/sessionSelection.defaults.get`
- `_agnes/v1/sessionSelection.defaults.save`
- `_agnes/v1/autoReview.get`
- `_agnes/v1/autoReview.save`
- `_agnes/v1/systemPrompt.get`
- `_agnes/v1/systemPrompt.save`

### 配置

- `_agnes/v1/config.get`
- `_agnes/v1/config.oauth`
- `_agnes/v1/config.providers`
- `_agnes/v1/config.test`
- `_agnes/v1/config.save`
- `_agnes/v1/config.account`
- `_agnes/v1/config.childEngines.get`
- `_agnes/v1/config.childEngines.save`
- `_agnes/v1/config.modelSlots.get`
- `_agnes/v1/config.modelSlots.save`

### 计算机使用

- `_agnes/v1/computerUse.status`
- `_agnes/v1/computerUse.permissions.status`
- `_agnes/v1/computerUse.permissions.grant`
- `_agnes/v1/computerUse.doctor`
- `_agnes/v1/computerUse.operation.start`
- `_agnes/v1/computerUse.operation.status`
- `_agnes/v1/computerUse.operation.cancel`

### 审批授权

- `_agnes/v1/approvalGrants.list`
- `_agnes/v1/approvalGrants.revoke`
- `_agnes/v1/approvalGrants.forSession`
- `_agnes/v1/approvalGrants.revokeForSession`

### 调度与任务

- `_agnes/v1/jobs.enqueue`
- `_agnes/v1/jobs.poll`
- `_agnes/v1/jobs.cancel`
- `_agnes/v1/schedules.list`
- `_agnes/v1/schedules.upsert`
- `_agnes/v1/schedules.archive`
- `_agnes/v1/schedules.control`
