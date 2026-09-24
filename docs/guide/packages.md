# Install, trust, update, and remove plugins

English | [简体中文](packages.zh-CN.md)

<a id="插件安装信任更新与清理"></a>

[Documentation](../README.md) · [Develop plugins](../develop/plugins.md)

Follow a plugin from inspection and installation through updates and removal. Start with the repository's text-statistics plugin, then apply the same process to your own package.

<a id="开箱可用的助手插件"></a>

## Built-in helper plugins

AGH includes three official helpers. On a new local configuration, or the first upgrade of an existing configuration to a version with default helpers, missing helpers are automatically installed, trusted, and enabled without a network download:

| Plugin | Purpose |
| --- | --- |
| `@agnes/skill-helper` | Create, import, and install Skills in a session |
| `@agnes/mcp-helper` | Prepare MCP integrations and query actual connection state |
| `@agnes/plugin-helper` | Create tool or Skill plugins, inspect packages, and install/enable them after confirmation |

They appear under Settings → Plugin management → Installed and can be disabled or removed. Later startups and upgrades respect that choice. Removing a helper does not delete plugins, Skills, or MCP services it previously created or integrated. Installing third-party capabilities still requires the relevant confirmation.

When upgrading from a version with only Skill/MCP Helper, AGH adds the new Plugin Helper without restoring the two older helpers if you removed them. Existing packages with the same IDs retain their versions and enabled/trusted state. After initial setup, you can reinstall a removed helper from discovery. Initial installation follows deployment policy, preserves failure records, and resumes after recovery without marking a failed installation as enabled.

<a id="管理其他插件"></a>

## Manage other plugins

| Stage | What to check |
| --- | --- |
| Inspect and install | Source, version, content hash, and capability declarations |
| Trust and enable | Whether this version may provide capabilities in the current instance |
| Inspect actual state | Whether backend rows are ready and frontend contributions loaded |
| Update or remove | Whether the new version is active and old capabilities were removed |

A successful ordinary installation starts untrusted and installed-disabled. `desired` is the requested state; `actual` is the runtime state. Inspect both to distinguish a request from an available capability.

<a id="安装后端示例"></a>

## Install the backend example

Use the [installation guide](install.md) to create a temporary AGH_HOME and start the instance from the repository root. The daemon resolves relative `file:` paths against its workspace source. If reusing a daemon started from a different cwd, check that source; working from an isolated instance's startup directory is the simplest option.

```sh
node packages/cli/dist/local/agnes.mjs package inspect file:./examples/packages/hot-tool-plugin
node packages/cli/dist/local/agnes.mjs install file:./examples/packages/hot-tool-plugin
```

Installation shows a preview and requests interactive confirmation. Check package ID, version, source, integrity, capabilityHash, warnings, and blockers. A blocked package cannot simply be authorized. Use the actual preview values:

```sh
node packages/cli/dist/local/agnes.mjs package trust @agnes-examples/hot-tool-plugin INTEGRITY CAPABILITY_HASH
node packages/cli/dist/local/agnes.mjs package enable @agnes-examples/hot-tool-plugin
node packages/cli/dist/local/agnes.mjs package status
```

In Web, use Settings → Plugins → Install from source → Inspect/Install → Trust → Enable. Check package state together with each row's actual state. Service dependencies, a closed browser, policy refusal, or failed candidate loading can keep an enabled package from being usable.

<a id="更新与回滚"></a>

## Update and roll back

The shell `package` command has no `update` subcommand. Use the installed package's update-from-source action in Web, or inspect the source and submit TUI `/package update <id> <source> <integrity>`. The TUI command does not provide the installation confirmation wizard. Programmatic callers use Node SDK `client.packages.update`.

Practice with `hot-service/v1` and `v2`, or `client-panel/v1` and `v2`. Install, trust, and enable v1, then select the v2 source with the same package ID. Check new hashes and capability changes, and follow the interface's trust/activation prompts. Inspect actual state and interface/service values, rather than relying only on 100% operation progress.

```sh
node packages/cli/dist/local/agnes.mjs package rollback PACKAGE_ID
node packages/cli/dist/local/agnes.mjs package operation OPERATION_ID
```

An ordinary rollback without activation leaves the target untrusted and disabled. After a shell rollback, inspect the target hashes, trust and enable it, then check the service or interface. SDK activation can include current installed/active hashes and an explicit trust decision for the target; these checks cannot be omitted.

Rollback depends on the retained previous version and current authorization. Retention is bounded and is not a repository of arbitrary past versions. Revoked, deleted, or unverifiable snapshots cannot be automatically revived. A failed candidate may trigger fallback, but inspect the operation and actual state rather than inferring success from a submitted request.

<a id="禁用撤信任与删除"></a>

## Disable, revoke trust, and remove

```sh
node packages/cli/dist/local/agnes.mjs package disable PACKAGE_ID
node packages/cli/dist/local/agnes.mjs package remove PACKAGE_ID
node packages/cli/dist/local/agnes.mjs package cancel OPERATION_ID
node packages/cli/dist/local/agnes.mjs packages pins inspect
```

Revoke trust through Web or the Node SDK; there is no general shell `package untrust` command. Disabling withdraws capabilities. Removal handles installation state and owned files, but in-use snapshots may retain pins. Do not manually delete referenced directories. `packages pins release PIN_ID` explicitly cleans up a verified orphan pin; it must not bypass runtime safety gates. An isolated demo has verified removal of all three example packages after disabling them. Revalidate the target platform and final distribution; see [verification](../maintainers/verification.md) for the recorded baseline.

Cancellation is a request: continue checking the operation after its receipt. An operation with side effects cannot always be treated as if it never happened. Tools, event listeners, Cordis services, and frontend slots should be cleaned up with their owning fiber. Plugin removal does not undo external business data changes.

<a id="更新为何不总是立即切换"></a>

## Why an update may not switch immediately

A runtime target carries complete identity and revision information. Host supports constrained live-tree transactions and incremental reconciliation; eligible changes can reuse unchanged rows. Seamless hot updates are not guaranteed for every plugin. Dependencies, identity changes, timeouts, failed compensation, and tainted trees can lead to refusal or a full rebuild. The browser updates and cleans up its own roster, so Host activation does not prove browser loading.

Implementation: [shell commands](../../packages/cli/src/commands/package.ts), [SDK](../../packages/sdk/src/package-admin.node.ts), [Web administration](../../packages/web/src/admin/plugins/admin.ts), [EntryTree](../../packages/cordis-loader/src/entry-tree.ts), [Host publication](../../packages/host/src/runtime-target-publisher.ts).
