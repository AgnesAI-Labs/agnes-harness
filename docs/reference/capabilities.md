# Capability matrix

[Documentation](../README.md) · [Known limitations](limitations.md)

This is the current inventory of production paths that deliberately refuse, defer, or conditionally
expose a capability. A `stub` has no usable implementation, `partial` has a usable subset with an
explicit boundary, and `wired` is a deliberate fail-closed or indirect implementation rather than
unfinished work.

The machine-readable source mapping is
[`tools/guards/capability-stubs.json`](../../tools/guards/capability-stubs.json). The guard rejects new
production “not implemented”, “not wired”, or “not available in this build” markers without a stable
capability ID; it also rejects stale source markers and drift between this table and the registry.

| Capability ID | Feature | Status | Blocker / current boundary | Evolution | Source evidence |
|---|---|---|---|---|---|
| `runtime.python.execution` | Python code runtime | stub | Spike thresholds exist, but there is no Python kernel, raw I/O bridge, snapshot, or restore backend. | Requires a validated runtime backend | `packages/runtime-python/src/index.ts` |
| `code.runtime.lifecycle` | Code-mode runtime lifecycle | stub | The extension surface exists, but no runtime lifecycle is connected to it. | After `runtime.python.execution` | `packages/code/src/extensions/code-mode/index.ts` |
| `ai.models.catalogue-probe` | Provider model-catalogue probe | partial | Common OpenAI/Anthropic reachability works; protocol-specific catalogues and some auth variants refuse. | Provider-specific implementation | `packages/ai/src/adapters/pi/probe-models.ts`<br>`packages/ai/src/adapters/pi/probe.ts` |
| `approval.ticket-store` | Parked approval tickets | stub | The approval policy has no durable ticket store. | Requires durable storage | `packages/base/extensions/approval-policy/src/tickets.ts` |
| `artifacts.background-jobs` | Artifact background jobs | stub | Local artifact reads/writes exist, but asynchronous artifact jobs do not. | Requires job execution | `packages/base/extensions/artifacts-local/src/jobs.ts` |
| `cli.onboarding.account` | Agnes account sign-in at first run | stub | The API-key path is wired end to end; the account path needs the platform's PKCE/token/refresh and subscription-catalogue contract, which this build does not carry. The selector offers it and refuses rather than opening a flow that cannot finish. | Requires account integration | `packages/cli/src/onboarding/tui.ts` |
| `profile.additional-layers` | Workspace, local, flags, and managed profile layers | partial | Verified workspace overlays and isolation-only local/flags/managed overlays resolve; other local/flags/managed fields still fail closed to keep the profile hash honest. | Additional configuration layers | `packages/host/src/profile/isolation.ts` |
| `sandbox.host-filtered-network` | Host allowlist network enforcement | partial | Closed networking works, but a non-empty host allowlist requires a filtering proxy that does not exist. | Requires network filtering | `packages/base/extensions/sandbox/src/seam.ts`<br>`packages/base/extensions/sandbox/src/backends/shared.ts` |
| `windows.runtime-enforcement` | Windows sandbox and credential protection | partial | Native private credential ACL enforcement is implemented and refuses when the native capability is unavailable. Restricted-token sandboxing and network isolation remain unavailable; forced isolation must refuse. Full Windows acceptance is incomplete. | Windows compatibility acceptance; no OS sandbox in current scope | `packages/host/src/adapters/platform-win32.ts`<br>`packages/host/src/adapters/credential-files.ts` |
| `cli.remote-and-extra-modes` | Remote CLI transport and non-print/TUI modes | partial | Local print/TUI and ACP work; explicit `--connect` uses the shared daemon. Remaining management commands retain their documented local/refused scope. | Mode-specific implementation | `packages/cli/src/bin.ts` |
| `sdk.optional-build-capabilities` | Optional SDK transport/auth construction | wired | `Unsupported` is the intended typed boundary when an entry point omits an optional transport or auth implementation. | Complete; keep fail-closed | `packages/sdk/src/errors.ts` |
| `sandbox.bwrap-runtime-selection` | Bubblewrap selection | wired | The compiler leaf is intentionally not a direct default seam; the runtime backend selector probes and selects it. | Complete; keep indirect wiring | `packages/base/extensions/sandbox/src/backends/bwrap.ts` |

## Support-level note

Platform support is described in [known limitations](limitations.md). Local tests and CI coverage do
not by themselves establish installer, signing, external service or physical device support. Runtime
isolation, permissions and process identity require validation on each target platform.
