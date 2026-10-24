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

In **Settings → Plugin management → Install from source**, choose **Local path**, **Git URL**, or **Archive HTTPS URL**. Local paths name files on the daemon's machine. `file:` accepts absolute paths, folders outside the daemon workspace, relative folders, `.tgz`/`.tar.gz`/`.tar`, and ZIP files. Explicit relative `file:` references still resolve against the daemon workspace; bare CLI paths resolve against the CLI's cwd. Sources cannot be symlinks. Archives can contain a package at their root or inside one enclosing directory; traversal paths, links, special entries and oversized archives are refused. Only npm packages may contain `node_modules`, `.git` or `fixtures/out`; an archive, URL or Git tree with one is refused with reason `excluded-directory` (folder sources skip them), so share dependencies with `agh plugins pack`. HTTPS archive downloads do not follow redirects or accept credentials.

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

Declare requested access in each plugin's `agnes.plugins[].capabilities`. One shape serves installed packages, local plugins, plugins scaffolded by the agent and the bundled official plugins:

```json
{
  "agnes": {
    "plugins": [
      {
        "apiRange": "^5.0.0",
        "export": "main",
        "capabilities": {
          "network": ["api.example.com", "*.example.org"],
          "filesystem": { "read": ["workspace/reports/*"], "write": ["workspace/output/*"] },
          "exec": ["node"],
          "secrets": ["weather-api-key"],
          "credentials": ["example-account"],
          "model": true,
          "childAgents": true,
          "ui": true,
          "uiData": ["finance.differences.read"]
        }
      }
    ]
  }
}
```

List names/scopes, never secret values. String lists support `*` globs. `uiData` is the exception: each entry is an exact capability name such as `finance.differences.read` (`^[a-z][a-z0-9-]*(?:\.[a-z][a-z0-9-]*)+$`), at most 32 names. Trust shows the atom `uiData:<name>`, and the capability hash covers the list. A glob does not match that pattern. Filesystem scopes can be absolute, relative, or `workspace/` paths rooted at the tool cwd. Booleans request model access, child agents or UI. The same object also carries what a plugin registers: `tools` (`prefix`, `names`), `hooks`, `slots`, `events`, `resources`, `services`, `projections`, plus `tools.invoke`, `network.publicRead`, `artifacts` and `subagent`. `network` is always a list of host patterns and `ui` is a flag; skins and client modules sit under the entry's `contributes`. A package shows the union of its plugins' authority. An empty object requests no capabilities; an omitted declaration is shown as undeclared for compatibility. Changes to a declaration change the trust hash and require review.

The profile `policy.capabilityCeiling` is an install-time category check on every declared plugin capability. For example, `network` admits declared network scopes, `hooks` admits a declared hook list, and `filesystem.read` admits declared read scopes. An empty ceiling refuses all nonempty declarations; omitted plugin declarations remain undeclared for compatibility. The `plugin-capabilities.json` scope policy applies in addition. Neither check confines plugin JavaScript or enforces declared registration names. Author packing/dev inspection without a profile has no category ceiling; installation still applies the destination profile.

Administrators can create `plugin-capabilities.json` beside the profile's `agnes-lock.json`:

```json
{
  "allow": ["network:*.example.com", "filesystem.read:workspace/*", "model", "ui"],
  "deny": ["exec:*", "secrets:*", "credentials:*"]
}
```

The policy vocabulary is `network:<host>` (or `network:<host>:<port>`), `filesystem.read:<scope>`, `filesystem.write:<scope>`, `exec:<command>`, `secrets:<name>`, `credentials:<name>`, `model`, `childAgents`, and `ui`. Omit `allow` to allow all declared requests except deny rules; `allow: []` allows none. Deny wins. A wildcard request cannot hide a narrower denied scope, and a deny rule without a port covers that host on every port. Malformed policy fails closed. Inspection, installation, trust and enable read this policy; changing it blocks disallowed installed packages from new activation without deleting their data.

A declaration with no network hosts means only that no network access was requested; it does not guarantee that plugin code cannot access the network. This is the community trust model. Declarations help review trusted code; they are not a security sandbox. Host-observed tool exec/sandbox launches, network fetches and filesystem access report undeclared use in plugin logs, without recording command arguments, targets or credential values. Existing sandbox and egress authorization still decide whether an operation runs. Direct Node APIs, plugin initialization and injected service implementations are outside this observation boundary.

## Troubleshooting

Every `agnes.plugins` entry must declare a tested extension API `apiRange` (for example, `^1.4.0`). New installs and updates refuse missing or incompatible ranges before importing plugin code. No range is inferred from the installed Host version.

Older installed packages without this declaration remain visible with an `incompatible` blocker and the reference `plugin-api-range-required`. They cannot be trusted, enabled, activated, or selected as rollback targets. Their files and lock entries are preserved so they can be updated or removed. To migrate, obtain a compatible release or add a tested range to every plugin entry in the author's source, rebuild or repack as needed, and use **Update from a new source** (or remove and reinstall). Review the new integrity and trust declaration before enabling it. Do not edit the installed cache or lock: that invalidates integrity. Previously installed official helpers also need this update; restarting or rebuilding AGH preserves their pinned snapshots.

Failed plugin states carry a short fix hint and a documentation link. In plugin details, use the **Fix guide** link; CLI failures also print the hint.

The plugin's primary state describes its current version. A failed retained generation does not block a healthy current version. Under **Versions**, retained failures are shown with their version and a public error code; runtime diagnostics retain the affected session bindings. Current failures, trust revocation, policy blockers and restart requirements keep their normal refusal behavior.

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

AGH includes four official helpers. On each startup, missing release defaults that the profile has never been offered are automatically installed, trusted, enabled and activated without a network download:

| Plugin | Purpose |
| --- | --- |
| `@agnes/skill-helper` | Create, import, and install Skills in a session |
| `@agnes/mcp-helper` | Prepare MCP integrations and query actual connection state |
| `@agnes/plugin-helper` | Create tool or Skill plugins, inspect packages, and install/enable them after confirmation |
| `@agnes/document-reader` | Read PDF text and page images, scanned PDF, DOC, DOCX, and selected ZIP entries; OCR runs offline |

The distribution also includes `@agnes/deliverables-ui`, `@agnes/goal-ui` and `@agnes/interaction-ui` as the default file, goal and interaction presentations. Startup also adds these presentations to existing profiles that have never been offered them. If the profile's capability ceiling blocks an optional UI package, AGH records it as offered and omitted, so later startups do not retry it automatically; other verification failures still stop initialization.

Existing installations keep their pinned plugin snapshots when the application is rebuilt or restarted. To pick up the PDF page images and expanded ZIP handling in `@agnes/document-reader` 0.1.2, select the installed package's **Update from a new source** action in Web Plugin management and use `file:./bundled-plugins/document-reader` from the newly built application. Check the preview and complete the normal update/activation flow.

They appear under Settings → Plugin management → Installed and can be disabled or removed. Later startups and upgrades respect that choice. Removing a helper does not delete plugins, Skills, or MCP services it previously created or integrated. Installing third-party capabilities still requires the relevant confirmation.

The bootstrap receipt remembers offered defaults, including ones omitted under the capability ceiling. Older receipts preserve offers proven by their recorded integrity hashes or currently installed defaults, then add any remaining missing defaults. Previously offered defaults stay removed or disabled; defaults marked for fresh profiles only are never backfilled. Existing packages with the same IDs retain their enabled/trusted state during initialization. After initial setup, you can reinstall a removed helper from discovery. Initial installation follows deployment policy, preserves failure records, and resumes after recovery without marking a failed installation as enabled.

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
{ "agnes": { "provides": ["tool", "loop", "model-adapter", "mcp", "skills", "ui"] } }
```

Declare only the kinds the package provides. The plugin admin list and detail show these badges; the kind filter matches declared kinds. Older packages without the field remain visible under “All kinds”.

The Plugins page loads on opening, revalidates on package/tree changes and when returning to the tab, and refreshes after your actions. It does not poll the plugin tree while idle. Active install/update operations use bounded backoff and pause while the browser tab is hidden.

An installed plugin that still needs trust is labeled **Awaiting trust** with a review action. This remains visible after leaving an unfinished install-and-enable flow. Update review shows the version step and added or removed capabilities; unavailable permission or file comparisons are stated explicitly.

The plugin list and overview show one primary status: Ready, Blocked, After restart, History only, Disabled or Awaiting trust. The reason and next action come from the backend. Trust revocation takes priority over disabling. “History only” means only existing session versions are available, including open sessions; new sessions do not yet have a ready version. Expand **Status dimensions** for trust, requested enablement, observed runtime, browser modules and generation/session counts. “Running” means the plugin runtime is available, not that a tool is executing. Catalog `active` still means selected in configuration. A restart action opens instructions; it does not claim to restart the service.

The retained-generation summary counts backend-reported installed plugin bindings and distinct sessions. Its details preserve names, versions and generation identifiers; removed package bindings remain inspectable in runtime diagnostics. Pending cleanup alone does not imply old-version use. Frontend failures remain visible separately from backend state, with a retry action where supported.

Agent-authored candidates show their type (plugin or Skill), version, new/update label and relative source-turn time before opening a review. This time comes from the recorded source session turn, rather than an inferred candidate creation timestamp; unavailable details are labeled explicitly.

“Defaults for new sessions” reads host catalogs and saves exact loop/adapter versions and a model ID using a configuration revision. Existing sessions retain their bindings. Unavailable saved choices must be replaced or cleared; a conflicting save requires reloading the catalogs. The local daemon queries its Host-bearing shared worker for catalogs; the launcher relays them over its private Unix connection. In the workbench, a new task preselects the saved Loop and model next to the existing model picker. You can change the Loop before the first message; existing sessions keep their binding. Session Trace shows the recorded Loop ID/version from session metadata, including after reopening.

The fixed local admin routes are `GET /admin/api/loops` (loops plus defaults/revision), `GET /admin/api/model-adapters`, `GET /admin/api/defaults`, and `PUT /admin/api/defaults` with `{ revision, defaults: { preset?, permission?, providers?: { loop?, 'model-adapter'? }, model? } }`. `preset` is the default recipe and `permission` the default level (`read-only`, `workspace-write` or `full-access`); retired permission-as-preset defaults are refused with a clean-home hint. Each `providers.<kind>` selection is `{ provider, version }`, the same shape as everywhere else; `model` names a model of the selected adapter and is only valid beside it. Writes require plugin activation permission and the same-origin admin context. The trusted launcher supplies an `AdminSessionSelection` relay to the daemon; Host composes real catalogs and existing configuration storage with `createAdminSessionSelection`. Adapter models include their configured `route` when available so the workbench selects the actual runtime model. This endpoint does not import plugin factories or accept credentials.

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

In Web, use Settings → Plugins → Add plugin → Install from source → Inspect/Install → Enable. The Enable confirmation reviews and binds the current integrity and capability hashes, then activates only after that check succeeds. There is no separate trust action in the normal Web flow. An installed package's switch is on only while the package is actually running. If a dependency, policy, or candidate-loading failure prevents that, the switch stays off and the row shows an error tag; open its details to see the reason and retry Enable from the action menu.

Git source inspection reports a fixed reason when the repository cannot be downloaded or its ref is unavailable, when root `package.json` is missing or invalid, or when the source has no AGH plugin declarations. A repository containing only `SKILL.md` is a Skill, not a plugin. These refusals do not install or trust code. `PackageAdminError.sourceFailure` is optional; older responses retain the general source-rejected message.

The Plugins page has Installed and Discover tabs. Discover starts with three official examples; expand More official examples for the rest. The row menu contains settings (when declared), details and lifecycle actions. Details group the existing information into Overview, Settings, Permissions and Versions. Versions shows ongoing sessions using the previous generation; their work continues without interruption. Technical IDs, sources and integrity values are under Technical details.

A package declaring `metadata.exampleOf` is managed only on its parent plugin’s **Examples** page: review installation and activation there, launch it there, and stop it before reviewing removal. These packages are excluded from ordinary Plugins lists and discovery; FDE business-agent examples without `exampleOf` keep their existing flow. A direct source review explains the parent relationship and offers the parent’s normal reviewed install/enable flow. An example requires its parent to be installed, trusted, enabled and compatible; disabling the parent makes the example’s launch surfaces unavailable. Re-enabling the parent restores enabled examples. The relationship grants no service access.


<a id="更新与回滚"></a>

## Update and roll back

Management generation lists read retained descriptions, session bindings and already reported failures;
they do not re-hash every historical executable archive. Listing a historical generation is not an
archive health check. Resume, migration and execution still verify the selected archive and fail closed.
Static composition and bundle views reuse resolved display metadata while configuration, package lock,
capability policy and runtime snapshot records remain unchanged. Applying configuration and admitting a
session always use fresh validation; editing installed source bytes directly is not an activation path.

Rebuilding AGH preserves an installed package’s reviewed capability snapshot. Immutable package bytes are verified again at startup. Older client descriptors that were normalized without their declared streams remain usable with their original grants and capability hash; discovering those streams does not authorize them. Use the normal reviewed update flow, even from the same source and version, to approve the current declarations. Changed installed bytes still fail integrity verification.

Runtime snapshot records carry a format version. Earlier plugin-core records (including records without a version) are verified using their original metadata and capability digest rules, with the same byte and tree checks. A format upgrade needs no manual recovery and does not rewrite snapshot identities, trust decisions or session pins. New snapshots use the current format; obtaining new agent or application declarations follows the normal integrity-verified, reviewed package update path. Retained package-operation results also keep their historical metadata and labels on disk; management responses project them into the current display contract. Corrupt records and modified bytes still fail closed.

A runtime pin reusing the current installed integrity must also match the verified installation's version, source type and reference, tree integrity and capability hash. A self-consistent archive record cannot grant trust to replacement bytes or a substituted source. Historical sessions retain their independent snapshot and generation identities and original bytes across reviewed updates.

Release-owned bundled defaults (the helpers and default presentations) follow the installed distribution. At startup, AGH verifies the shipped version, integrity and capability hash against the installed snapshot. A trusted, enabled default still using its reserved bundled source refreshes through the verified package update and pinned runtime publication paths only when its capability hash is unchanged. Default refresh and pinned target publication finish before profile-managed resources register or start on boot. Existing sessions retain their snapshots. Removed defaults are not reinstalled; disabled or untrusted defaults and packages pinned to another source are left untouched.

Startup hashes unchanged bundled content without copying it into a candidate staging directory. Installed inventory is rechecked after updates and before building one complete runtime target for the refresh. The target is probed and published once; an interrupted update or failed publication is retried on the next start, without publishing intermediate combinations. Package admission, dependency, trust and runtime snapshot checks remain in force.

If capabilities change or ordinary dependency/reference checks block refresh, **Plugins → Built-in → Versions** shows **Update available**, the installed → shipped versions, and **Review update**. This opens the normal content and capability review before updating. Copied release payloads preserve each package’s declared version. Only `0.0.0` placeholders receive the distribution version (the declared public candidate for private workspace builds). An explicit release version may raise a package version, but never lower it; copied examples pin the resulting parent version. Equal version labels still compare integrity.

An installed dependent blocks a parent update only when its declared range does not admit the candidate version. The preview names those dependents. **Review parent and dependent updates together** inspects their current distribution sources and shows each candidate's version and capabilities before **Update together**. The request binds every installed and candidate digest; unavailable, stale or incompatible candidates leave the installed combination intact. The package lock commits the reviewed set together, and one runtime target publishes the combination. Disabled dependents remain disabled. Active references and source policy still apply.

Version matching accepts a valid prerelease for `*` and its exact version, including `0.1.0-alpha.0`. Other supported comparator sets admit prereleases only when an explicit prerelease comparator names the same major/minor/patch tuple, following npm semver rules. API compatibility ranges retain this restriction; an unrelated prerelease never satisfies a stable API range.

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

Each package activation creates an immutable plugin generation. New sessions bind the current generation; existing sessions retain their packages, versions, loop and frontend bundles through hibernation and worker restart. Disable or uninstall stops new bindings while existing sessions drain. Closing or hibernating a session preserves its durable code pin and disk snapshot. Retired in-memory containers close after their last open session and an idle timeout (default 60 seconds, configurable with `limits["worker.generation_idle_close_ms"]`; 0 collects immediately). Reopening the session reconstructs its original generation from the snapshot. Once a session is deleted, the Host owner calls `releaseSessionGeneration(sessionKey)`; generations with no remaining session references are disposed and collected.

Trust revocation is stronger than disable: a generation or saved composition is checked against the current package trust decision before its archived code is imported. A revoked, removed, or invalidly bound package refuses cold resume with `E_SESSION_VERSION_OLDER`, preserving `E_WORKSPACE_UNTRUSTED` in `detail.cause` and `E_GENERATION_UNTRUSTED` in the explanation; the session pin stays intact for administrative recovery. Disable alone keeps trusted pinned code available. The current grant must match the installed integrity and capability hash; an immutable historical archive preserves its originally approved binding across upgrades. A generation using the installed integrity must also match its version and tree integrity. Explicit hosts without a package lock must re-read their source authority and verify the exact archived snapshot identity, version, integrity, tree integrity and capability hash.

Storage, filesystem, sandbox and platform backends require restart. Resume fails explicitly if the pinned snapshot is missing, its package files changed, or the deployment's loop/adapter configuration is incompatible. It never substitutes the current generation. MCP definitions and Skills are live resources: cold resume uses current trusted/enabled resources, filtered by the pinned session composition. Historical resource archives do not replace that live set. `Host.pluginGenerationStatus()` and the internal worker command `pluginGenerations.status` expose durable and open session counts, container liveness, and active/draining/historical/restart-required/failed plugin state for administration. Draining means an open session still uses old code; historical means only saved sessions reference it, shown as “Saved sessions use an older version”. Eligible saved sessions can use the existing “Migrate session to current plugins” action in runtime settings. Browser roster requests can supply `sessionId` to load that session's generation; assets use immutable generation routes.

Candidate loading, dependencies and activation timeouts can still cause an activation to fail. The prior generation continues serving its bound sessions. The browser loads its own bundle roster, so Host activation does not prove browser loading.

Privileged generation migration requires a closed session and checks durable execution facts inside the pin-change serialization guard. Pending approvals, user answers, parked tool continuations, unfinished jobs, child agents or deferred invocations, unknown external outcomes and resource recovery fences refuse with `E_GENERATION_EXECUTION_UNSETTLED`; `detail.reasons` identifies the blocking kind, binding and ledger sequence. The pin and ledger remain unchanged. Closing or cancelling does not establish an unknown external outcome. An unfinished chat turn without an execution binding does not block migration. Background job tools persist structured status receipts; legacy background-start receipts remain fenced until a durable terminal status is available.

Implementation: [shell commands](../../packages/cli/src/commands/package.ts), [SDK](../../packages/sdk/src/package-admin.node.ts), [Web administration](../../packages/web-admin/src/admin/plugins/admin.tsx), [EntryTree](../../packages/cordis-loader/src/entry-tree.ts), [Host publication](../../packages/host-providers/src/runtime-target-publisher.ts).

The shipped local-dev and enterprise templates explicitly admit the modern declaration categories used by the bundled examples. Existing custom profiles with narrower ceilings must add any newly declared categories they intend to admit; this changes admission only, not the operating-system rights of trusted code.


### Plugin list refresh and file cleanup

The Web plugin page checks its administrative context when opened. It can reuse a recent inventory for 30 seconds when that context is unchanged. Returning focus does not repeatedly reload fresh data; plugin change notifications and the refresh button still trigger a read. A background refresh retains the displayed list. Backend authorization and operation previews remain authoritative.

Open **Settings → Runtime & diagnostics → Plugin file cleanup** to inspect unused retention records. This check runs when you open the cleanup panel, independently of the plugin list. A failed check displays a retry action, not a claim that records exist. Clearing a record requires confirmation and the removal permission; the backend rechecks usage and skips records that are in use again. Releasing retention records allows files to be reclaimed; it does not promise immediate disk-space recovery.

On Windows, an unused snapshot whose directory cannot yet be renamed because it is busy stays tracked for a later collection. Its contents and recovery journal are verified before deferring cleanup; damaged snapshots and other errors still fail explicitly. Temporary directory contention does not turn a successful publication into an activation failure.

The local discovery catalog verifies bundled and repository example payloads on its first read, rather than delaying daemon readiness. Subsequent offline reads reuse the verified catalog until its existing expiry; installation still re-inspects the selected payload.
