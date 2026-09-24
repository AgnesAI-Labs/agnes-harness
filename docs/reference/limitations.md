# Supported scope and known limitations

English | [简体中文](limitations.zh-CN.md)

<a id="支持范围与已知限制"></a>

[Documentation](../README.md) · [Verification methods and scope](../maintainers/verification.md)

Use this page to decide whether AGH fits your trial or integration. It distinguishes implemented capabilities with constraints, environments still needing acceptance, and exploratory directions. Actual recorded results are collected in [verification](../maintainers/verification.md).

| Area | Current boundary |
| --- | --- |
| Release | Pre-alpha; project-authored code uses [Apache-2.0](../../LICENSE), with third-party exceptions in [NOTICE](../../NOTICE). No public npm release, consumer installer, or automatic-update commitment |
| Platforms | Recorded local process checks used macOS/Node 24. Linux/Windows, clean-machine installation, signing, and upgrade delivery need separate acceptance |
| Windows Web assets | Mainline uses posix URL-path normalization to fix vendor asset routing. Passing related tests on macOS does not establish a real Windows browser pass |
| Windows security | Some file/symlink, restricted-token, and network-sandbox boundaries remain incomplete; parity with macOS/Linux is not established |
| Web | A local loopback workbench, without a verified public-service remote-login/reverse-proxy deployment. Validate browser capabilities separately |
| Ordinary plugins | Trusted in-process code. `ctx.extension()` supports all 17 hook categories, while Service/Projection/Slot/Resource contributions must use verified row Cordis APIs |
| Full-stack integration | Requires an `agnes.plugins` backend row, matching-rowId `agnes.clientDescriptors`, service definitions/policy, and the current session allow-list. Arbitrary Cordis services do not automatically become remote |
| Hot updates | Constrained transactions exist. Some changes require rebuilding; failed compensation/timeouts can cause refusal or taint handling. No guarantee of uninterrupted updates or rollback of external effects |
| Rollback | Bounded previous-version retention; not a full version archive. Revoked/deleted snapshots are not automatically revived |
| Plugin removal | An isolated recorded build passed the local demo's disable/remove cleanup. Real browsers, other plugin combinations, and cross-platform removal still need final acceptance. Active references continue to block deletion |
| Long-running operation | Built-in, managed, and ordinary row leases now follow row lifetime, fixing the old default 24-hour expiry. Writer leases remain separate. Workload-specific stability and resource use still require [verification](../maintainers/verification.md) |
| MCP session calls | Startup and turn reload use per-server rows. This path skips OAuth bindings; management tests do not prove session tool availability. See [MCP runtime behavior](../guide/mcp.md#runtime-behavior-and-versions) |
| Skills | Permanent deletion and same-name priority overrides are implemented. Deletion has no undo/cancellation and can partially fail with persistent markers. Package/runtime files cannot be deleted individually; runtime priority overrides are refused |
| Hooks / extension migration | `registerHook` exposes 17 event categories. Third-party backend entries have moved from `agnes.extensions` to `agnes.plugins`. Built-in compatibility does not authorize legacy third-party entry formats |
| Models | Provider catalogs and contracts determine capabilities. Automated documentation demos use local model fixtures; external-model quality and tool selection need separate verification |
| Python | Production Python runtime and the Python thin SDK are not usable paths described by these guides |
| Desktop / system integration | No desktop client, system-login startup registration, or automatic updates |
| Domain / enterprise | Business APIs, identity, data, and deployment policies need scenario-specific integration and acceptance; see [FDE](../guide/why-agh.md) |
| MHS / devices | [AGH MHS guides and examples are coming soon](../guide/mhs.md). No verified general-purpose MHS adapter, compatibility list, or end-to-end device example |
| Performance / evaluation | No leadership or improvement figures without fixed models, budgets, tasks, and reproducible measurement |

See [verification](../maintainers/verification.md) for recorded commands and scope. Recheck current source after upgrades, especially long-running behavior, MCP OAuth session support, plugin/client descriptor contracts, default security policy, and distribution status.
