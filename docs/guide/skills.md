# Skills: bring your team's methods into each task

English | [简体中文](skills.zh-CN.md)

<a id="skills把团队方法带进每一次任务"></a>

[Documentation](../README.md) · [Plugin development](../develop/plugins.md)

Capture project conventions, checks, and common methods as a Skill for agents to use during tasks. Start with a workspace example, then learn how sources, name conflicts, and maintenance work.

A Skill provides instructions and resources; it does not grant execution permission. AGH discovers candidates, reviews revisions, resolves same-name candidates, and exposes usable content to a session. A file's existence does not prove that the model has read it.

<a id="创建一个工作区-skill"></a>

## Create a workspace Skill

In the target project, which need not be the AGH source repository, create `.agh/skills/review-notes/SKILL.md`:

```markdown
---
name: review-notes
description: Review inconsistencies in project documentation without modifying files
---
Read the README and related documentation, then list conflicting statements and their files.
Suggest changes only. Do not write files or install dependencies.
```

Create a Web session for the project. In Skills management, refresh that workspace and check the source, content revision, and trust state. You can also inspect and manage it from the CLI:

```sh
node packages/cli/dist/local/agnes.mjs resources list --kind skill
node packages/cli/dist/local/agnes.mjs skills refresh --root-key workspace-agnes --workspace-id WORKSPACE_ID
node packages/cli/dist/local/agnes.mjs resources get SKILL_RESOURCE_ID
node packages/cli/dist/local/agnes.mjs skills trust SKILL_RESOURCE_ID REVISION trusted
node packages/cli/dist/local/agnes.mjs resources enable SKILL_RESOURCE_ID --expected-revision REVISION
```

`WORKSPACE_ID` is the registered workspace's 64-character hexadecimal identifier, available in workspace/resource data. Do not use a path or another session's ID. Use `--root-key user-agnes` for a Skill under your AGH home; there is no need to move a project Skill there. Read current resource data before writing.

Confirm `trust=trusted`, `desired=enabled`, `actual=ready`, and `winner`, then explicitly ask the workspace session to use `review-notes`. Host can preload an explicitly named, uniquely matched, available Skill. A vague description is not a deterministic activation syntax.

<a id="来源与冲突"></a>

## Sources and conflicts

Disk sources include workspace `.agh/skills`, `AGH_HOME/skills`, and `.agents/skills`, `.claude/skills`, and `.codex/skills` under the operating-system user's home. Packages can also contribute Skills. `AGH_HOME` does not relocate other tools' user directories. Each session reads its own workspace rather than substituting the worker's startup directory.

Default priorities, with higher values taking precedence:

| Source | Default | User override | Permanent deletion |
| --- | --- | --- | --- |
| Workspace `.agh/skills` | 500 | Yes | Yes, only the selected Skill directory |
| Cordis runtime contribution | 450 | No | No; removed through the plugin lifecycle |
| `AGH_HOME/skills` | 400 | Yes | Yes |
| User `.agents/skills` | 300 | Yes | Yes; may affect other applications sharing it |
| User `.claude/skills` | 200 | Yes | Yes; may affect other applications sharing it |
| User `.codex/skills` | 100 | Yes | Yes; may affect other applications sharing it |
| Package contribution | 50 | Yes | No; manage through its plugin |

Names are grouped after trimming whitespace and ignoring case. Candidates not marked for deletion are ordered by effective priority descending, then by `sourceId` for ties. The resolved `winner` must still pass its own trust/desired checks to become ready. A higher-priority candidate that is untrusted, rejected, or disabled does not automatically yield to a lower-priority candidate merely because it is unavailable.

A failed refresh may leave stale or last-known content. Stale data is not evidence of a successful scan. Disk changes require revision and trust review again.

<a id="调整同名候选优先级"></a>

## Change same-name candidate priority

1. Open Settings → Skills, choose the workspace, and inspect the Skill's source, current winner, shadowed candidates, and effective priority.
2. Enter an **integer from 50 to 500** in the priority field, save, and confirm. This only changes the persistent override for that resourceId in the current profile. It does not edit files, grant trust, or enable the Skill.
3. Wait for completion and check the winner and actual state again. Review and enable a new winner separately if necessary; saving a priority is not enough.
4. Restoring default priority removes the override and uses the source's default from the table. Concurrent priority edits can happen without a content revision change, so saving also checks `expectedPriority`. Refresh on conflict rather than retrying blindly.

For example, an `AGH_HOME/skills` candidate defaults to 400 and a workspace candidate to 500. To use the home candidate, lower the workspace candidate to 350. Do not set both to 500 and guess the winner. Deleting a higher-priority item may allow another candidate to take its place, but the remaining item does not inherit trust or enablement. Active turns hold immutable snapshots. Management success does not prove that an in-progress turn has switched; inspect the next turn or a new session after completion.

<a id="永久删除一个磁盘-skill"></a>

## Permanently delete a disk Skill

Use Disable for a temporary change. **Permanent deletion removes the entire selected Skill directory and every file in it, not just SKILL.md. It does not move files to Trash.** User-level directories may be shared with other applications.

1. Practice only in an isolated trial directory. Refresh and inspect the source, workspace, content revision, and same-name candidates.
2. For a workspace or user source, choose permanent deletion, review the full-directory and replacement-candidate notices, and confirm. Package/runtime sources cannot be deleted individually here.
3. Save the operation ID, wait for `succeeded`, and inspect the list, directory, and remaining candidates. A receipt only acknowledges acceptance; an operation can fail after partially deleting files.
4. `SKILL_REMOVAL_PENDING` means the item is blocked from re-enabling. Preserve the state, address causes such as file locks, then explicitly retry deletion. Failure does not mean files were restored. Once accepted, deletion cannot be canceled; restarting is not undo.

The backend does not accept arbitrary caller-supplied deletion paths. It derives the target from the registered source and resourceId, then verifies workspace identity, revision, and directory/file identity. Stale scans, symbolic links/junctions, hard links, or path replacement are rejected. A failed preflight does not write a deletion marker. Failure during execution retains identity progress and deletion markers for a constrained retry. Progress contains no file contents and is not a backup. Markers survive restarts, and refresh does not revive the same deleted resourceId. There is currently no API to restore a deleted Skill.

<a id="api权限与-cli-边界"></a>

## API, permissions, and CLI boundaries

These management actions are available through Web and the Node SDK. Current shell/TUI Skills commands have no `remove` or `priority` subcommand. Do not treat SDK method names as CLI syntax.

- `client.skills.remove({ profile, clientId, commandId, resourceId, expectedRevision })` → `_agnes/v1/skills.remove`.
- `client.skills.prioritySet({ profile, clientId, commandId, resourceId, expectedRevision, expectedPriority, priority })` → `_agnes/v1/skills.priority.set`; `priority: null` restores the default.
- Both require server-granted admin authority and `resources.skills.write`. JSON arguments cannot grant permission. The browser management page uses a constrained same-origin BFF without giving plugins the management SDK.
- Use identity, revision, and priority returned by the current instance, and retain commandId and operation receipts. Reuse a commandId to query/replay the same accepted request. A fresh retry after failed deletion is a new explicit operation. Query results with `client.resources.operation.get({ profile, operationId })` or shell `resources operation OPERATION_ID`.

Contracts: [resource schema](../../packages/protocol/schema/resource-control.json), [methods and permissions](../../packages/resource-control-contracts/src/resource-control.ts), [Node client](../../packages/resource-control-client-node/src/resource-control.ts), [persistent control and deletion markers](../../packages/resource-control-store/src/skills.ts), [Web actions](../../packages/resource-control-web/src/admin.ts), [worker wiring](../../packages/resource-control-worker/src/runtime-bootstrap.ts). The [worker deletion implementation](../../packages/resource-control-worker/src/skill-remove.ts) calls system-node for native deletion. Source links match this document's revision; check the matching contract when running an older build.

<a id="cordis-运行时贡献"></a>

## Cordis runtime contributions

An ordinary trusted plugin can declare `inject: ['skills']` and use this in `apply`:

```js
ctx.skills.register({
  name: 'review-notes',
  description: 'Review conflicting documentation without modifying files',
  body: 'Read related documentation and list contradictions with evidence. Do not modify files.',
})
```

`register()` returns a disposer, and registration is cleaned up with the caller's fiber. For dynamic collections, use `registerProvider(control => ({ skills() { return [...] } }))`. Call `control.invalidate()` after data changes; unloading aborts `control.signal`. The service supports contributions, without an API to list or read other Skills.

Runtime contributions do not enter the disk trust/desired workflow; their trust comes from trusted code. Keep them distinct from disk refresh and package Skill loading. Same-name contributions from independent plugins at the same level fail. Successor fibers replacing the same row have specific handling, which does not permit arbitrary name overrides.

The bundled Skill Helper has its own installation request flow. A tool may request installation, but cannot bypass user confirmation, source review, or write boundaries. Subagents cannot request Skill installation through it.

Implementation: [discovery roots](../../packages/base/extensions/skills/src/discover.ts), [candidate registry](../../packages/resource-control-runtime/src/skills.ts), [Cordis service](../../packages/resource-control-runtime/src/skills-cordis.ts), [session preloading](../../packages/host/src/resources/skill-preload.ts), [Skill Helper](../../packages/package-manager/bundled-plugins/skill-helper/README.md).
