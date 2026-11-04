# Skills: bring your team's methods into each task

English | [简体中文](skills.zh-CN.md)

<a id="skills把团队方法带进每一次任务"></a>

[Documentation](../README.md) · [Plugin development](../develop/plugins.md)

Capture project conventions, checks, and common methods as a Skill for agents to use during tasks. Start with a workspace example, then learn how sources, name conflicts, and maintenance work.

A Skill provides instructions and resources; it does not grant execution permission. AGH discovers candidates, reviews revisions, resolves same-name candidates, and exposes usable content to a session. A file's existence does not prove that the model has read it.

## Import a complete Skill

Open a community repository in **Plugins → Market** and choose **Check and install**. The installation window starts a background check and shows its current stage, content review and installation result. A single Skill is selected automatically; choose one when several are found. Confirm the reviewed content before installation. Opening community details does not download or execute source. A repository topic does not certify compatibility. The CLI also accepts local directories, archives and `git:` / `url:` sources.

The review shows the complete file list, immutable source identity and known interpreter requirements. This path retains scripts outside `scripts/`, templates, HTML, images and license notices. It supports up to 2048 files, 32 MiB total, 8 MiB per file and 16 path segments, subject to stricter acquisition limits. Links, native executables, native extensions, WASM and unsupported files are refused rather than silently omitted. Install from the common Skill directory, not a foreign host's activation patch.

Installation does not execute package scripts, install dependencies or grant command permissions. New imports remain disabled; review and enable them under **Plugins → Skills**. The backend checks fixed interpreter versions and reports unknown dependencies explicitly. These checks do not prove that the Skill's full functionality works. Script execution uses the session's ordinary command and sandbox policy; output belongs in the task workspace, not the installed Skill directory.

The complete-import frontmatter profile accepts `name`, `description`, `license`, `metadata`, `compatibility` and AGH's invocation flags. Foreign tool restrictions, models, hooks and other unknown behavior fields are refused; AGH does not silently remove them or emulate their host.

Node SDK: `client.packages.skillImport(...)` uses `_agnes/v1/packages.skillImport`; check `initialize().features` for `packages.skill-import.v1`. Prepare returns a proposal and digest; commit requires that exact digest. Each call binds the initialized client ID, profile and command ID; the same authenticated principal can continue a proposal from another CLI connection in the same profile. The CLI exposes the same review boundary:

```sh
agh plugins skill-import prepare path:/absolute/path/to/repository skill-subdirectory
agh plugins skill-import commit PROPOSAL_ID SHA256_FROM_PREPARE
agh plugins skill-import status PROPOSAL_ID
agh plugins skill-import cancel PROPOSAL_ID
```

Use forward slashes in SDK local source refs; CLI and Web convert native Windows path separators. Complete imports record `AGH-SKILL.json`; keep it with the directory. All retained resources affect the reviewed revision. Editing scripts, templates or the marker requires fresh trust; ordinary user-maintained disk Skills retain their existing edit semantics. Same-name replacements are refused. Use the existing reviewed removal flow when replacing an installation; this entry does not perform in-place upgrades or promise running-command version leases.

## Ask the agent to create a Skill

For example: “Create a simple skill called 数学老师skill.” The agent uses an ASCII directory identifier such as `math-teacher`; `SKILL.md` frontmatter can keep the Chinese display name and must provide `name` and `description`.

Instruction-only drafts (`SKILL.md` plus optional `.md`, `.txt`, `.json`, `.yaml`, `.yml` or `.csv` resources outside `scripts/`) use static validation. AGH checks frontmatter and invocation flags, names and collisions, file counts and sizes, relative paths and resource integrity. It does not generate a JavaScript plugin or run Node author tests. Review the name, description, file list, target and SHA256 digest in the install confirmation. Full access automatically allows installation, trust and enablement of the frozen revision, including the source-read decision for an import. Other permission levels retain the single confirmation. The default scope is the workspace; user scope and install-only are also supported. Wait for `ready` before using it on the next turn (`installed` means install-only).

Scripts, package manifests and other file types keep the plugin candidate → author tests → human publication path. Installation does not execute those scripts or grant them execution permission. Existing local-source imports retain their separate source-read approval. An invalid or conflicting draft is refused without overwriting files; denial, cancellation, expired ownership or a changed lease cannot authorize installation. The private receipt retains the authoring session, plugin snapshot, content digest and resource revision. Update an already installed Skill Helper to receive this flow; installed helper packages are not automatically upgraded.

## Skills saved by task experience

With [task experience](refinement.md) on, a skill the agent learned in a session can be saved into the workspace as a skill: automatically when a review applies it, by you (`/refine --workspace`, or **Save … to workspace** on a review line), or by the model. AGH installs it in the workspace's `.agh/skills` folder, trusted and switched on, without the install confirmation above and without a turn. Such skills are **instructions only**: one `SKILL.md`, no scripts or executable files. When a script would help, the skill tells the agent to write it with its own file tools, under its usual permissions.

They appear in the skill list like any other workspace skill. **Settings → General → Task experience → Saved skills** lists them as on or **awaiting review** (switched off by the 30-day review; switching it back on in the skill list renews it for 30 days), with who saved them, **Uninstall** and **Roll back to the previous version**, and the drafts kept for you when a save would have changed a skill you wrote or changed. A skill you wrote or changed is never overwritten. Removing a saved skill here or under Settings, rolling it back, or deleting its folder is remembered: automatic and model saves never bring it back. See [Saved skills](refinement.md#saved-skills) for the rules and limits, and [Diagnostics and exports](refinement.md#diagnostics-and-exports) for what exports contain.

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

The daemon watches Skill roots, including folders created after startup. New disk Skills in the registered workspace or `$AGH_HOME/skills` are automatically trusted and enabled. Put only instructions you trust there. Edits retain the recorded trust/rejection and enable/disable decision, bound to the new revision; a rejected or disabled Skill stays rejected or disabled. Skills never grant execution permissions. Changes become visible to idle sessions on the next request; an in-flight turn keeps its snapshot.

From the target project, use the CLI to register the current directory and print its workspaceId. Refresh is an optional immediate rescan, with confirmation; no manual workspace ID is needed:

```sh
node /path/to/agnes-harness/agnes.mjs skills refresh --yes
node /path/to/agnes-harness/agnes.mjs skills list
```

Use your actual built CLI path above, or `agh` when it is on PATH. To scope another registered workspace, pass `--workspace-id WORKSPACE_ID`. `skills list` prints resource IDs, revisions, trust, desired and actual state. Explicit trust changes remain available as `agh skills trust SKILL_RESOURCE_ID REVISION trusted --yes`; enable/disable uses `agh resources enable|disable SKILL_RESOURCE_ID --expected-revision REVISION --yes`. Without a TTY, mutations require `--yes`; it confirms the reviewed change without bypassing revision checks.

Confirm `trust=trusted`, `desired=enabled`, `actual=ready`, and `winner`, then explicitly ask the workspace session to use `review-notes`. Host can preload an explicitly named, uniquely matched, available Skill. A vague description is not a deterministic activation syntax.

<a id="来源与冲突"></a>

## Sources and conflicts

Default disk sources are workspace `.agh/skills` (also workspace `.agents/skills` and `.claude/skills`) and `$AGH_HOME/skills`; packages can also contribute Skills. Importing the OS user's `~/.agents/skills`, `~/.claude/skills`, and `~/.codex/skills` requires explicit deployment configuration `AGNES_SKILLS_IMPORT_USER=1` when starting the daemon. It is off by default, including for a fresh or isolated AGH_HOME. Imported user Skills use the same automatic trust policy; opt in only for trusted folders. `AGH_HOME` does not relocate those other tools' user directories. Each session reads its own workspace rather than substituting the worker's startup directory. Hosts the CLI runs itself (`--standalone`, `--ephemeral`, `agh run`, `agh import`) read the same Skill folders under the enable and trust decisions the daemon saved for the installation (`--ephemeral` reads them from the real home): where the daemon never kept resource state every Skill counts as new, and once it has, a missing or unreadable decisions file offers no disk Skill. Each session keeps the Skill list it started with, and `--safe-mode` offers plugin Skills only.

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

A failed refresh may leave stale or last-known content. Stale data is not evidence of a successful scan. Edits retain existing decisions and update the bound revision.

A flat disk file needs no YAML frontmatter. For example, `$AGH_HOME/skills/review-notes.md` containing `# Review project notes` is named `review-notes`, with its description taken from the first nonempty heading or line (up to 1024 characters). Its entire Markdown remains the body. Empty files and malformed explicit frontmatter are rejected. Directory `SKILL.md` and packaged Skill contributions still require `name` and `description` frontmatter.

A skill root may contain a directory `<name>/SKILL.md` or a flat `<name>.md`. The directory wins when both exist. Installation-owned `context.json` supports `customSkillRoots` (absolute directories). Configure these through **Settings → Models → Run configuration → Context**; they follow `AGH_HOME/skills` at priority 400. See [default context](context.md). `SKILL.md` may set `disable-model-invocation`, `user-invocable`, and `disable`; omitted flags permit both model and user use. The daemon watches directories and relative resource files; `skills refresh --yes` requests an immediate rescan. Details and the unsupported cases are in [MCP and Skills support](mcp-skills-support.md).

## Manage skills in Web

Candidate tests retain the [Host isolation and exact-hash rules](security.md). Full access automatically allows tests on every platform, including unisolated Windows; the `workspace-write` permission still requires one confirmation. Testing alone never publishes a package. Submitting a passing candidate under full access automatically installs, trusts and enables it through the existing publication transaction; other permission levels retain human review.

Full-access tool requests also automatically allow Skill import/install, capability changes, MCP registration/start, ask-mode memory writes and credential administration confirmations. Each permission decision records its actor and reason `full-access`. Protected paths retain their hard refusals. Human-maintained local plugin and trusted disk-Skill discovery retain their documented trust paths.

Open **Plugins → Skills** for the skill list; **Plugins → To review** contains **Drafts** and **Feedback**. New skill opens a menu to ask the agent to draft a skill or learn how to import existing folders. Plugin candidate proposals appear in To review → Drafts; instruction-only Helper drafts use the install confirmation above. Open a candidate review to inspect content changes and test evidence before approving publication or rejecting it. The pending count appears only when a review needs attention.

Search My skills by name or description. The row switch and menu keep the existing enable, trust and removal confirmation flows. Where are skill folders? lists the sources reported by the daemon. Import help links to deployment instructions for other agents; it does not change the daemon's startup import setting. Refresh skills keeps its confirmation.

Expand **Skill folders**, add absolute paths, and choose **Save and scan**. Saving starts a scan automatically; newly discovered skills are enabled under the existing discovery rules. Each added folder shows its result and any access, location or metadata problem. Valid files are counted before same-name selection; the count does not mean new or enabled skills. Unreadable folders have unknown file counts, and incomplete scans show observed lower bounds.

After correcting a folder or file, choose **Rescan**. **Copy diagnostics** copies identifiers, counts, time and safe error codes without folder paths, filenames or skill contents. Reports are temporary and clear when the daemon restarts. For access errors, check directory access for the application that starts the AGH background process, or use another readable folder; the error alone does not prove a macOS privacy restriction. A host that does not return scan details shows no invented counts.

<a id="调整同名候选优先级"></a>

## Change same-name candidate priority

1. Open Plugins → Skills, choose the workspace, and open the Skill's details and expand Technical details to inspect its source, current winner, shadowed candidates, and effective priority.
2. Expand Advanced options, enter an **integer from 50 to 500** in the priority field, then choose **Save priority** and confirm. This only changes the persistent override for that resourceId in the current profile. It does not edit files or enable the Skill.
3. Wait for completion and check the winner and actual state again. Review and enable a new winner if necessary; saving a priority is not enough.
4. The current Web page does not expose reset-to-default. Use the Node client with `priority: null` when that administrative action is required. Concurrent priority edits can happen without a content revision change, so saving also checks `expectedPriority`. Refresh on conflict rather than retrying blindly.

For example, an `AGH_HOME/skills` candidate defaults to 400 and a workspace candidate to 500. To use the home candidate, lower the workspace candidate to 350. Do not set both to 500 and guess the winner. Deleting a higher-priority item may allow another candidate to take its place, but the remaining item does not inherit trust or enablement. Active turns hold immutable snapshots. Management success does not prove that an in-progress turn has switched; inspect the next turn or a new session after completion.

<a id="永久删除一个磁盘-skill"></a>

## Permanently delete a disk Skill

Use Disable for a temporary change. **Permanent deletion removes the entire selected Skill directory and every file in it, not just SKILL.md. It does not move files to Trash.** User-level directories may be shared with other applications.

1. Practice only in an isolated trial directory. Refresh and inspect the source, workspace, content revision, and same-name candidates.
2. For a workspace or user source, choose permanent deletion, review the full-directory and replacement-candidate notices, and confirm. Package/runtime sources cannot be deleted individually here.
3. Save the operation ID, wait for `succeeded`, and inspect the list, directory, and remaining candidates. A receipt only acknowledges acceptance; an operation can fail after partially deleting files.
4. `SKILL_REMOVAL_PENDING` means the item is blocked from re-enabling. Preserve the state, address causes such as file locks, then explicitly retry deletion. Failure does not mean files were restored. Once accepted, deletion cannot be canceled; restarting is not undo.

The backend does not accept arbitrary caller-supplied deletion paths. It derives the target from the registered source and resourceId, then verifies workspace identity, revision, and directory/file identity. Stale scans, symbolic links/junctions, hard links, or path replacement are rejected. A failed preflight does not write a deletion marker. Failure during execution retains identity progress and deletion markers for a constrained retry. Progress contains no file contents and is not a backup. Markers survive restarts, and refresh does not revive the same deleted resourceId. There is currently no API to restore a deleted Skill. A skill saved by task experience keeps its earlier versions in the profile's data directory and can be rolled back under **Settings → General → Task experience → Saved skills**; that does not restore a deleted one.

<a id="api权限与-cli-边界"></a>

## API, permissions, and CLI boundaries

These management actions are available through Web and the Node SDK. Current shell/TUI Skills commands have no `remove` or `priority` subcommand. Do not treat SDK method names as CLI syntax.

- `client.skills.remove({ profile, clientId, commandId, resourceId, expectedRevision })` → `_agnes/v1/skills.remove`.
- `client.skills.prioritySet({ profile, clientId, commandId, resourceId, expectedRevision, expectedPriority, priority })` → `_agnes/v1/skills.priority.set`; `priority: null` restores the default.
- Both require server-granted admin authority and `resources.skills.write`. JSON arguments cannot grant permission. The browser management page uses a constrained same-origin BFF without giving plugins the management SDK.
- Use identity, revision, and priority returned by the current instance, and retain commandId and operation receipts. Reuse a commandId to query/replay the same accepted request. A fresh retry after failed deletion is a new explicit operation. Query results with `client.resources.operation.get({ profile, operationId })` or shell `resources operation OPERATION_ID`.

Contracts: [resource schema](../../packages/protocol/schema/resource-control.json), [methods and permissions](../../packages/resource-control-contracts/src/resource-control.ts), [Node client](../../packages/sdk/src/resource-control.node.ts), [persistent control and deletion markers](../../packages/resource-control-store/src/skills.ts), [state projection](../../packages/resource-control-store/src/skill-state.ts), [journal admission](../../packages/resource-control-store/src/skill-journal.ts), [Web actions](../../packages/resource-control-web/src/admin.tsx), [worker wiring](../../packages/resource-control-worker/src/runtime-bootstrap.ts). The [worker deletion implementation](../../packages/resource-control-worker/src/skill-remove.ts) calls system-node for native deletion. Source links match this document's revision; check the matching contract when running an older build.

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

Implementation: [discovery roots](../../packages/base/extensions/skills/src/discover.ts), [candidate registry](../../packages/resource-control-runtime/src/skills.ts), [Cordis service](../../packages/resource-control-runtime/src/skills-cordis.ts), [session preloading](../../packages/host-extensions/src/resources/skill-preload.ts), [Skill Helper](../../packages/package-manager/bundled-plugins/skill-helper/README.md).

Invoke a user-invocable Skill in Web or TUI with `/skill invoke NAME ARGUMENTS`. In the Web composer, type `$` to open the installed-Skills picker, then click a row (or use the arrow keys and Enter) to insert `$NAME` into the draft. The picker is an insertion aid only: on send, the Host still loads only a unique trusted, enabled winner; unknown, disabled or user-hidden Skills are refused. Arguments remain in the user message.

Packaged Skill attachments are copied into the approved runtime snapshot. Unsupported file types are omitted by the existing attachment rules. The authoring test runner checks supported attachments against the loader's limits before review. If an installed Skill has an invalid document, unreadable attachments or exceeds the attachment budget, only that Skill becomes unavailable: Plugins → Skills shows the reason, no partial content is exposed, and healthy Skills continue loading during service startup. Repair and update the package through the existing review flow, then reload it. Package integrity checks and snapshot publication failures still fail closed. Runtime-registered Skills on Plugins → Skills are scoped to the current plugin composition and registration owner, then undergo name arbitration. They are managed through their plugin, so the Skill page cannot edit or toggle them independently. Old sessions keep their pinned plugin versions.
