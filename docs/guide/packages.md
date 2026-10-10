# Install, enable, update, and remove plugins

English | [简体中文](packages.zh-CN.md)

<a id="插件安装信任更新与清理"></a>

[Documentation](../README.md) · [Develop plugins](../develop/plugins.md)

Follow a plugin from inspection and installation through updates and removal. Start with the repository's text-statistics plugin, then apply the same process to your own package.

## Sharing

Install a plugin without copying trust hashes:

```sh
agh plugins add /ABS/DOWNLOADS/hello-tool.tgz
agh plugins add ../hello-tool
agh plugins add https://example.com/team/hello-tool.git
agh plugins add https://example.com/hello-tool.zip
```

The command displays the source, integrity, capability hash, requested capabilities, warnings and blockers. Confirming `plugins add` installs, trusts and enables that exact reviewed version. Use `--yes` for an explicitly authorized script; otherwise a noninteractive invocation exits with a reason and a hint to use `--yes`. Legacy `agh install` continues to install disabled and untrusted. `agh plugins trust <id>` reviews the installed declaration and retrieves the hash automatically; `agh plugins enable <id>` displays it again before enabling.

In **Settings → Plugin management → Install from source**, choose **Local path**, **Git URL**, or **Archive HTTPS URL**. Local paths name files on the daemon's machine. `file:` accepts absolute paths, folders outside the daemon workspace, relative folders, `.tgz`/`.tar.gz`/`.tar`, and ZIP files. Explicit relative `file:` references still resolve against the daemon workspace; bare CLI paths resolve against the CLI's cwd. Sources cannot be symlinks. Archives can contain a package at their root or inside one enclosing directory; traversal paths, links, special entries and oversized archives are refused. HTTPS archive downloads do not follow redirects or accept credentials.

Git URLs may omit the commit or name a branch/tag after `#`. Inspection pins the resolved commit in the preview; installation checks the reviewed content digest. A Git repository must contain an installable plugin entry and its runtime artifacts. Acquisition runs no package lifecycle scripts.

To share a plugin with its third-party JavaScript dependencies:

```sh
# Install the author's dependencies and build the plugin first, if its exports point into dist/.
agh plugins pack /ABS/PLUGIN/hello-tool ./hello-tool.tgz
# On your friend's machine:
agh plugins add ./hello-tool.tgz
```

`pack` validates the static manifest, bundles the backend entry and declared frontend entries, preserves third-party legal comments and license/notice files, then emits a `package/` tarball. Host SDK imports declared in `agnes.hostProvidedExternals` stay external and are supplied by AGH; older packages retain their Agnes SDK external imports. The friend does not need the author's `node_modules`, source checkout or capability hash. Static JavaScript/TypeScript imports are supported; native addons and dependencies that load undeclared dynamic files need an author-provided distributable. Packing runs no plugin code, tests or install scripts and refuses an existing output file or output inside the source folder.

## Capabilities

Declare requested access in `package.json`. The same declaration appears for installed packages, local plugins, and plugins scaffolded by the agent:

```json
{
  "agnes": {
    "plugins": [{ "apiRange": "^1.4.0", "export": "main" }],
    "capabilities": {
      "network": ["api.example.com", "*.example.org"],
      "filesystem": { "read": ["workspace/reports/*"], "write": ["workspace/output/*"] },
      "exec": ["node"],
      "secrets": ["weather-api-key"],
      "credentials": ["example-account"],
      "model": true,
      "childAgents": true,
      "ui": true
    }
  }
}
```

List names/scopes, never secret values. String lists support `*` globs. Filesystem scopes can be absolute, relative, or `workspace/` paths rooted at the tool cwd. Booleans request model access, child agents or UI. An empty object requests no capabilities; an omitted declaration is shown as undeclared for compatibility. Changes to a declaration change the trust hash and require review.

Administrators can create `plugin-capabilities.json` beside the profile's `agnes-lock.json`:

```json
{
  "allow": ["network:*.example.com", "filesystem.read:workspace/*", "model", "ui"],
  "deny": ["exec:*", "secrets:*", "credentials:*"]
}
```

The policy vocabulary is `network:<host>`, `filesystem.read:<scope>`, `filesystem.write:<scope>`, `exec:<command>`, `secrets:<name>`, `credentials:<name>`, `model`, `childAgents`, and `ui`. Omit `allow` to allow all declared requests except deny rules; `allow: []` allows none. Deny wins. A wildcard request cannot hide a narrower denied scope. Malformed policy fails closed. Inspection, installation, trust and enable read this policy; changing it blocks disallowed installed packages from new activation without deleting their data.

This is the community trust model. Declarations help review trusted code; they are not a security sandbox. Host-observed tool exec/sandbox launches, network fetches and filesystem access report undeclared use in plugin logs, without recording command arguments, targets or credential values. Existing sandbox and egress authorization still decide whether an operation runs. Direct Node APIs, plugin initialization and injected service implementations are outside this observation boundary.

## Troubleshooting

Every `agnes.plugins` entry must declare a tested extension API `apiRange` (for example, `^1.4.0`). New installs and updates refuse missing or incompatible ranges before importing plugin code. No range is inferred from the installed Host version.

Older installed packages without this declaration remain visible with an `incompatible` blocker and the reference `plugin-api-range-required`. They cannot be trusted, enabled, activated, or selected as rollback targets. Their files and lock entries are preserved so they can be updated or removed. To migrate, obtain a compatible release or add a tested range to every plugin entry in the author's source, rebuild or repack as needed, and use **Update from a new source** (or remove and reinstall). Review the new integrity and trust declaration before enabling it. Do not edit the installed cache or lock: that invalidates integrity. Previously installed official helpers also need this update; restarting or rebuilding AGH preserves their pinned snapshots.

Failed plugin states carry a short fix hint and a documentation link. In plugin details, use the **Fix guide** link; CLI failures also print the hint.

| Failure | Fix |
| --- | --- |
| Missing export | Export the function named by `agnes.plugins`; verify `package.json.exports`. |
| API range mismatch | Use a compatible plugin version or update the Host. |
| Missing inject | Install and enable the required service provider. |
| Schema error | Correct the manifest/configuration to match its schema. |
| Capability blocked | Review the declaration and administrator allow/deny policy; retry after an authorized change. |
| Frontend load failure | Rebuild declared assets, check their paths, then reload the page. |
| Activation failure | Check entry points and activation logs, repair the package, then retry. |

<a id="开箱可用的助手插件"></a>

## Built-in helper plugins

AGH includes four official helpers. On a new local configuration, or the first upgrade of an existing configuration to a version with default helpers, missing helpers are automatically installed, trusted, and enabled without a network download:

| Plugin | Purpose |
| --- | --- |
| `@agnes/skill-helper` | Create, import, and install Skills in a session |
| `@agnes/mcp-helper` | Prepare MCP integrations and query actual connection state |
| `@agnes/plugin-helper` | Create tool or Skill plugins, inspect packages, and install/enable them after confirmation |
| `@agnes/document-reader` | Read PDF text and page images, scanned PDF, DOC, DOCX, and selected ZIP entries; OCR runs offline |

Existing installations keep their pinned plugin snapshots when the application is rebuilt or restarted. To pick up the PDF page images and expanded ZIP handling in `@agnes/document-reader` 0.1.2, select the installed package's **Update from a new source** action in Web Plugin management and use `file:./bundled-plugins/document-reader` from the newly built application. Check the preview and complete the normal update/activation flow.

They appear under Settings → Plugin management → Installed and can be disabled or removed. Later startups and upgrades respect that choice. Removing a helper does not delete plugins, Skills, or MCP services it previously created or integrated. Installing third-party capabilities still requires the relevant confirmation.

When upgrading from a version with only Skill/MCP Helper, AGH adds Plugin Helper and Document Reader without restoring removed older helpers. Upgrading from the three-helper version adds only Document Reader. Existing packages with the same IDs retain their versions and enabled/trusted state. After initial setup, you can reinstall a removed helper from discovery. Initial installation follows deployment policy, preserves failure records, and resumes after recovery without marking a failed installation as enabled.

<a id="管理其他插件"></a>

## Manage other plugins

| Stage | What to check |
| --- | --- |
| Inspect and install | Source, version, content hash, and capability declarations |
| Review and enable | Whether this version may provide capabilities in the current instance |
| Inspect actual state | Whether backend rows are ready and frontend contributions loaded |
| Update or remove | Whether the new version is active and old capabilities were removed |

A successful ordinary installation starts disabled. Internally, AGH also records the reviewed version and capability scope before activation. `desired` is the requested state; `actual` is the runtime state. Inspect both to distinguish a request from an available capability.

<a id="安装后端示例"></a>

## Plugin kinds, states and session defaults

Packages can declare an optional multi-value field in `package.json`:

```json
{ "agnes": { "kinds": ["tool", "loop", "model-adapter", "mcp", "skills", "ui"] } }
```

Declare only the kinds the package provides. The plugin admin list and detail show these badges; the kind filter matches declared kinds. Older packages without the field remain visible under “All kinds”.

The state badges report separate facts: installed, desired enabled, host-confirmed active, older version in use, restart required, and failed. The old-version badge includes an explanation on hover or keyboard focus and appears only when the backend reports older session bindings. A quiet summary counts affected installed plugins and distinct sessions, with package names, versions and generation identifiers in collapsed details. Runtime defaults and development packages absent from the installed inventory are excluded, even when a replaced composition reports their old bindings. Removed packages remain inspectable in runtime diagnostics. Pending cleanup alone does not imply old-version use. Frontend failures remain visible alongside backend state, with a retry action where supported.

Agent-authored candidates show their type (plugin or Skill), version, new/update label and relative source-turn time before opening a review. This time comes from the recorded source session turn, rather than an inferred candidate creation timestamp; unavailable details are labeled explicitly.

“Defaults for new sessions” reads host catalogs and saves exact loop/adapter versions and a model ID using a configuration revision. Existing sessions retain their bindings. Unavailable saved choices must be replaced or cleared; a conflicting save requires reloading the catalogs. The local daemon queries its Host-bearing shared worker for catalogs; the launcher relays them over its private Unix connection. In the workbench, a new task preselects the saved Loop and model next to the existing model picker. You can change the Loop before the first message; existing sessions keep their binding. Session Trace shows the recorded Loop ID/version from session metadata, including after reopening.

The fixed local admin routes are `GET /admin/api/loops` (loops plus defaults/revision), `GET /admin/api/model-adapters`, `GET /admin/api/defaults`, and `PUT /admin/api/defaults` with `{ revision, defaults: { loop?, modelAdapter? } }`. Loop selections contain `id` and `version`; model adapter selections also contain `model`. Writes require plugin activation permission and the same-origin admin context. The trusted launcher supplies an `AdminSessionSelection` relay to the daemon; Host composes real catalogs and existing configuration storage with `createAdminSessionSelection`. Adapter models include their configured `route` when available so the workbench selects the actual runtime model. This endpoint does not import plugin factories or accept credentials.

## Install the backend example

Use the [installation guide](install.md) to create a temporary AGH_HOME and start the instance from the repository root. The daemon resolves relative `file:` paths against its workspace source. If reusing a daemon started from a different cwd, check that source; working from an isolated instance's startup directory is the simplest option.

```sh
node agnes.mjs package inspect file:./examples/packages/hot-tool-plugin
node agnes.mjs install file:./examples/packages/hot-tool-plugin --yes
```

Installation shows a preview. Without `--yes`, confirmation requires an interactive terminal; non-TTY callers get a reason and hint instead of silent cancellation. Check package ID, version, source, integrity, capabilityHash, warnings, and blockers. A blocked package cannot simply be authorized. `package trust <id> --yes` displays and trusts the current installed integrity/capability hashes. You may still provide both hashes explicitly; mismatches print expected and given values. `--yes` never overrides blockers or hash checks:

```sh
node agnes.mjs package trust @agnes-examples/hot-tool-plugin --yes
node agnes.mjs package enable @agnes-examples/hot-tool-plugin --yes
node agnes.mjs package status
```

In Web, use Settings → Plugins → Install from source → Inspect/Install → Enable. The Enable confirmation reviews and binds the current integrity and capability hashes, then activates only after that check succeeds. There is no separate trust action in the normal Web flow. An installed package's switch is on only while the package is actually running. If a dependency, policy, or candidate-loading failure prevents that, the switch stays off and the failure reason appears in the same row; choose Enable again to retry.

<a id="更新与回滚"></a>

## Update and roll back

The shell `package` command has no `update` subcommand. Use the installed package's update-from-source action in Web, or inspect the source and submit TUI `/package update <id> <source> <integrity>`. The TUI command does not provide the installation confirmation wizard. Programmatic callers use Node SDK `client.packages.update`.

Practice with `hot-service/v1` and `v2`, or `client-panel/v1` and `v2`. Install and enable v1, then select the v2 source with the same package ID. Check new hashes and capability changes, and follow the interface's review and activation prompts. Inspect actual state and interface/service values, rather than relying only on 100% operation progress.

```sh
node agnes.mjs package rollback PACKAGE_ID
node agnes.mjs package operation OPERATION_ID
```

An ordinary rollback without activation leaves the target untrusted and disabled. After a shell rollback, inspect the target hashes, trust and enable it, then check the service or interface. SDK activation can include current installed/active hashes and an explicit trust decision for the target; these checks cannot be omitted.

Rollback depends on the retained previous version and current authorization. Retention is bounded and is not a repository of arbitrary past versions. Revoked, deleted, or unverifiable snapshots cannot be automatically revived. A failed candidate may trigger fallback, but inspect the operation and actual state rather than inferring success from a submitted request.

<a id="禁用撤信任与删除"></a>

## Disable, revoke trust, and remove

```sh
node agnes.mjs package disable PACKAGE_ID
node agnes.mjs package remove PACKAGE_ID
node agnes.mjs package cancel OPERATION_ID
node agnes.mjs packages pins inspect
```

Trust revocation remains available through the Node SDK for administrative and recovery workflows; it is not shown as a normal Web action, and there is no general shell `package untrust` command. Disabling stops capabilities from being bound to new sessions; existing sessions retain their generation until deletion. Removal handles installation state and owned files, but in-use snapshots may retain pins. Do not manually delete referenced directories. `packages pins release PIN_ID` explicitly cleans up a verified orphan pin; it must not bypass runtime safety gates. An isolated demo has verified removal of all three example packages after disabling them. Revalidate the target platform and final distribution; see [verification](../maintainers/verification.md) for the recorded baseline.

Cancellation is a request: continue checking the operation after its receipt. An operation with side effects cannot always be treated as if it never happened. Tools, event listeners, Cordis services, and frontend slots should be cleaned up with their owning fiber. Plugin removal does not undo external business data changes.

<a id="更新为何不总是立即切换"></a>

## Why an update may not switch immediately

Each package activation creates an immutable plugin generation. New sessions bind the current generation; existing sessions retain their packages, versions, loop and frontend bundles through hibernation and worker restart. Disable or uninstall stops new bindings while existing sessions drain. Closing a connection does not release a saved session's generation. Once a session is deleted, the Host owner calls `releaseSessionGeneration(sessionKey)`; generations with no remaining session references are disposed and collected.

Trust revocation is stronger than disable: a generation or saved composition is checked against the current package trust decision before its archived code is imported. A revoked, removed, or invalidly bound package refuses cold resume with typed `E_WORKSPACE_UNTRUSTED` and detail `E_GENERATION_UNTRUSTED`; the session pin stays intact for administrative recovery. Disable alone keeps trusted pinned code available. The current grant must match the installed integrity and capability hash; an immutable historical archive preserves its originally approved binding across upgrades. Explicit hosts without a package lock must re-read their source authority and verify the exact archived integrity and capability hash.

Storage, filesystem, sandbox and platform backends require restart. Resume fails explicitly if the pinned snapshot is missing, its package files changed, or the deployment's loop/adapter configuration is incompatible. It never substitutes the current generation. MCP definitions and Skills are live resources: cold resume uses current trusted/enabled resources, filtered by the pinned session composition. Historical resource archives do not replace that live set. `Host.pluginGenerationStatus()` and the internal worker command `pluginGenerations.status` expose generation counts and active/draining/restart-required/failed plugin state for administration. Browser roster requests can supply `sessionId` to load that session's generation; assets use immutable generation routes.

Candidate loading, dependencies and activation timeouts can still cause an activation to fail. The prior generation continues serving its bound sessions. The browser loads its own bundle roster, so Host activation does not prove browser loading.

Privileged generation migration requires a closed session and checks durable execution facts inside the pin-change serialization guard. Pending approvals, user answers, parked tool continuations, unfinished jobs, child agents or deferred invocations, unknown external outcomes and resource recovery fences refuse with `E_GENERATION_EXECUTION_UNSETTLED`; `detail.reasons` identifies the blocking kind, binding and ledger sequence. The pin and ledger remain unchanged. Closing or cancelling does not establish an unknown external outcome. An unfinished chat turn without an execution binding does not block migration. Background job tools persist structured status receipts; legacy background-start receipts remain fenced until a durable terminal status is available.

Implementation: [shell commands](../../packages/cli/src/commands/package.ts), [SDK](../../packages/sdk/src/package-admin.node.ts), [Web administration](../../packages/web-admin/src/admin/plugins/admin.tsx), [EntryTree](../../packages/cordis-loader/src/entry-tree.ts), [Host publication](../../packages/host-providers/src/runtime-target-publisher.ts).
