# Capability matrix

English | [简体中文](capabilities.zh-CN.md)

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
| `runtime.state-store` | Runtime session state store | partial | Opening a session, acquiring its writer lease, and creating a run are committed with ledger attestation. A repeated write-open or writer-lease request returns its original result. Empty-continue advance, invocation admission and close, observe-only dispatch admission, mark_running, no-hook receipt intake, action-result probe, in-memory query admission, and outbox claim, acknowledgement, and failure commit in this store. State-store methods outside that set still refuse. | State-store methods outside that set | `packages/host/src/runtime/providers/state.ts` |
| `runtime.advance-transition` | Run advance | partial | An empty continue and consumption of an existing signal commit. An unknown signal, an already-consumed signal, a conversation contribution, and wait, complete, or fail refuse before any write. | Conversation contribution and the other transitions | `packages/host/src/runtime/state/control.ts` |
| `runtime.dispatch-budget` | Dispatch budget | partial | Dispatch admission commits in observe mode when the reservation is empty and no live-agent quota is requested. A non-empty budget reservation or a live-agent quota refuses before any write and does not pin the domain. | Bounded reservation and live-agent quota | `packages/host/src/runtime/state/control.ts` |
| `runtime.dispatch-hooks` | Dispatch hooks and taint acknowledgement | partial | Dispatch admission with no hook results and no approval-taint acknowledgement commits. Either input refuses before any write. | Hook results and approval taint acknowledgement | `packages/host/src/runtime/state/control.ts` |
| `runtime.control-command` | Control commands | partial | mark_running commits an execution attempt into the running state. Every other control command refuses before any write. | Other control commands | `packages/host/src/runtime/state/control.ts` |
| `runtime.intake-result-handling` | Receipt result handling | partial | No-hook receipt intake publishes the ready view, the result outbox, and the completion signal in one commit. A rejected admission publishes that same result in its own transaction. Inline-pure and staged result handling refuse before any write. | Inline-pure and staged result handling | `packages/host/src/runtime/state/control.ts` |
| `code.runtime.lifecycle` | Code-mode runtime lifecycle | stub | The extension surface exists, but no runtime lifecycle is connected to it. | After `runtime.python.execution` | `packages/code/src/extensions/code-mode/index.ts` |
| `ai.models.catalogue-probe` | Provider model-catalogue probe | partial | Common OpenAI/Anthropic reachability works; protocol-specific catalogues and some auth variants refuse. | Provider-specific implementation | `packages/ai/src/adapters/pi/probe-models.ts`<br>`packages/ai/src/adapters/pi/probe.ts` |
| `approval.ticket-store` | Parked approval tickets | stub | The approval policy has no durable ticket store. | Requires durable storage | `packages/base/extensions/approval-policy/src/tickets.ts` |
| `artifacts.background-jobs` | Artifact background jobs | stub | Local artifact reads/writes exist, but asynchronous artifact jobs do not. | Requires job execution | `packages/base/extensions/artifacts-local/src/jobs.ts` |
| `cli.onboarding.account` | Agnes account sign-in at first run | stub | The API-key path is wired end to end; the account path needs the platform's PKCE/token/refresh and subscription-catalogue contract, which this build does not carry. The selector offers it and refuses rather than opening a flow that cannot finish. | Requires account integration | `packages/cli/src/onboarding/tui.ts`, `packages/cli-tui/src/locale-extended.ts` |
| `client.legacy-slot-presentation` | Legacy slot presentation in the client host | stub | Domain views present through the selected renderer, the selected fallback and the built-in generic view. A legacy slot refuses, because the schema its props follow has no agreed source yet. | Requires a source for the slot schema | `packages/web-client/src/runtime/client-host.ts` |
| `client.runtime-transport` | Runtime client transport in the daemon | stub | The daemon's HTTP listener serves the generated runtime client routes behind its own admission and validates each request, but no backend is assembled behind them, so every valid request answers `operation_not_supported`. The push socket route is not served. | Requires the runtime backends behind each operation | `packages/daemon/src/runtime/transport.ts` |
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
