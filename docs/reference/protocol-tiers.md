# Protocol tiers

English | [简体中文](protocol-tiers.zh-CN.md)

The protocol's RPC methods fall into two tiers. The split lives in `packages/protocol/src/method-tiers.ts` (`METHOD_TIERS`); a test requires that every method is classified and listed here.

## Client contract

What third-party clients rely on: sessions, submit, decisions and events. These methods are promised stable; changes are additive or follow a versioned migration.

### Connection and session lifecycle

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

`workspace.reveal` accepts exactly one of `path` or `workspaceId` and opens only a listed,
revalidated canonical workspace. Like `session.revealWorkspace`, it requires a local desktop
owner and an interactive desktop; arbitrary paths and remote credentials are refused.

`workspace.remove` accepts `workspaceId` and optional `expectedRevision`. It requires the local
owner, archives all sessions in the workspace and removes only its listing, never disk files.
`WORKSPACE_RUNNING` means stop its running sessions first; `WORKSPACE_STALE` means refresh the
revision. Neither refusal changes the listing or archives sessions. Repeated removal returns
`removed: false`; re-adding the folder restores its listing and leaves sessions archived.
Existing session bindings remain valid for recovery through the archive.

### Submit and turn control

- `_agnes/v1/submit`
- `_agnes/v1/submit.ack`

`submit` with `kind: control, payload.action: promote` atomically changes an existing queued
item (`itemId`) into `next-step` guidance (`kind: steer`). It preserves the item's identity,
content, attachments and provenance and requires an open turn and the pinned Loop's steer capability. Queue
mutation and the control receipt commit together; stale selections and refusals leave the item
unchanged. Replay uses the original command ID and recovers the receipt without another send.
Older servers may refuse this additive action; clients must not emulate it with remove/send.

- `session/prompt`
- `session/cancel`

### Decisions and approvals

- `_agnes/v1/approval.decide`
- `_agnes/v1/approval.withdraw`
- `_agnes/v1/decision.list`
- `session/request_permission`
- `_agnes/v1/ext.ui.response`

### Events and notifications

- `session/update`
- `_agnes/v1/session.event`
- `_agnes/v1/session.loading`
- `_agnes/v1/session.loadingCancel`
- `_agnes/v1/session.preview`
- `_agnes/v1/daemon.notice`

### Session content, workspace and surfaces

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

### Profile operations and bound notifications

- `_agnes/v1/extension.callScoped`
- `_agnes/v1/extension.readOperation`
- `_agnes/v1/extension.wakes.enqueue`
- `_agnes/v1/extension.wakes.read`
- `_agnes/v1/profile.decisions.list`
- `_agnes/v1/profile.decisions.answer`

## Admin contract

Package administration, resource control, configuration, scheduling, diagnostics and computer use. These methods may evolve between releases; use the SDK rather than depending on their wire shape.

### Diagnostics

- `_agnes/v1/admin.feedback`
- `_agnes/v1/doctor.run`
- `_agnes/v1/admin.observability`
- `_agnes/v1/trace.clear`
- `_agnes/v1/session.factChain`
- `_agnes/v1/trace.request`
- `_agnes/v1/diagnostics.export`
- `_agnes/v1/diagnostics.collect`
- `_agnes/v1/diagnostics.events`

### Credentials

- `_agnes/v1/admin.credentials.list`
- `_agnes/v1/admin.credentials.create`
- `_agnes/v1/admin.credentials.set`
- `_agnes/v1/admin.credentials.rename`
- `_agnes/v1/admin.credentials.delete`

### Other administration

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

### Plugin trees, configuration and candidates

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

### Package administration

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

### Client modules and skins

- `_agnes/v1/skins.list`
- `_agnes/v1/skins.read`
- `_agnes/v1/clientModules.list`
- `_agnes/v1/clientModules.read`
- `_agnes/v1/clientModules.callService`
- `_agnes/v1/clientModules.callEffect`

### Resource control

- `_agnes/v1/resources.list`
- `_agnes/v1/resources.get`
- `_agnes/v1/resources.desired.set`
- `_agnes/v1/resources.operation.get`
- `_agnes/v1/resources.operation.cancel`

### Skills

- `_agnes/v1/skills.refresh`
- `_agnes/v1/skills.remove`
- `_agnes/v1/skills.priority.set`
- `_agnes/v1/skills.trust.set`

### MCP servers

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

### Extension calls and surfaces

- `_agnes/v1/extension.ack`
- `_agnes/v1/extension.call`
- `_agnes/v1/directory.upsert`
- `_agnes/v1/apis.list`
- `_agnes/v1/pluginRuntime.status`
- `_agnes/v1/pluginStreams.endpoint`
- `_agnes/v1/surfaces.mounts`

### Session defaults and selection

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

### Configuration

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

### Computer use

- `_agnes/v1/computerUse.status`
- `_agnes/v1/computerUse.permissions.status`
- `_agnes/v1/computerUse.permissions.grant`
- `_agnes/v1/computerUse.doctor`
- `_agnes/v1/computerUse.operation.start`
- `_agnes/v1/computerUse.operation.status`
- `_agnes/v1/computerUse.operation.cancel`

### Approval grants

- `_agnes/v1/approvalGrants.list`
- `_agnes/v1/approvalGrants.revoke`
- `_agnes/v1/approvalGrants.forSession`
- `_agnes/v1/approvalGrants.revokeForSession`

### Scheduling and jobs

- `_agnes/v1/jobs.enqueue`
- `_agnes/v1/jobs.poll`
- `_agnes/v1/jobs.cancel`
- `_agnes/v1/schedules.list`
- `_agnes/v1/schedules.upsert`
- `_agnes/v1/schedules.archive`
- `_agnes/v1/schedules.control`
