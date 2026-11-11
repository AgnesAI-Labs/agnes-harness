# Channel plugins

English | [简体中文](channel-plugins.zh-CN.md)

The channel bridge is owned by the backend. An installed plugin supplies one platform adapter
through the public `@agnes/plugin-runtime/channel-contract` contract. It does not copy the runner,
discover the daemon, or read credential files. No vendor adapter is bundled with Harness.

The bridge reuses the existing channel runner and the daemon's current-profile managed resources.
`profileRuntime.registerChannel` registers a `channelKind` provider and a managed resource named
`channel`. Its ordinary profile services (`channel.configuration`, `channel.configure`,
`channel.status`, `channel.check`, `channel.retry`, `channel.reconcile`) retain native effect
admission, package trust, activation checks and shutdown confirmation. The daemon composes the
bridge factory; embedders without that factory refuse channel registration.

Configuration contains an `instances` array. Every instance has a unique id, an absolute workspace,
an agent reference and credential references. Credentials must be `secret://` references, resolved
by the backend only when starting the instance and only within the plugin's reviewed `secrets`
grants. The credential mapping never accepts raw secrets; adapter options must remain non-sensitive.
Each instance owns its SDK journal and outbound references. The instance id namespaces session
keys so two installations of the same IM do not share conversations. Existing session authorization,
participant binding and approval replay checks remain in the runner and daemon.

This adds an optional author API in Extension API 5.5. Existing plugins and the generic runner
remain compatible. Legacy external DingTalk YAML files are not automatically imported: operators
create AGH credentials and configure the corresponding references. No migration deletes old data.

The first implementation uses the existing daemon-owned profile resource lifecycle rather than
introducing another supervisor or system service. A future process-isolated implementation may
replace this implementation behind the same channel contract. The stateless adapter factory is
generation-scoped, allowing plugin enable/disable and upgrades without restarting the daemon;
its running instances remain current-profile managed resources, never session-owned resources.

Profile activation publication lives in `assemble/profile-publication.ts`; extracting this existing
owner operation keeps the runtime-target assembler within its stage budget. The architecture
guard records the exact moved `RuntimeTarget` references rather than relaxing any size ceiling.

Extension API 5.6 adds Plugins → Channels and a Channels button beside the composer. Configuration
uses native `channel.configure` approval; provider `configSchema` renders non-sensitive options.
Packages must declare `channelServiceCapabilities()` for Host-owned session query/bind/unbind services.
Only authenticated, observed chat targets in the session's canonical workspace can be bound.
Unbound chats do not create sessions. Binding exports only projection nodes after its watermark;
restart requires a fresh inbound target confirmation. Each instance has at most one target per
session and one session per target. Unbind pauses and drains forwarding. Incomplete transitions
remain pending across restart. Native approvals remain in AGH rather than replaying existing
approvals into the external chat. Other platform plugins reuse the same interface and bridge.

Browser SDK control-plane restrictions remain unchanged. The fixed same-origin channel BFF checks
the method, typed parameters and current provider catalog. Backend session ownership, workspace
identity and native command receipts remain authoritative.

The compact session dialog and connection overview discover provider declarations without a vendor list. The fixed same-origin BFF derives workspace, agent and instance identity from authorized session reads, merges managed configuration and rejects stale configuration digests. Native approvals, effect receipts and binding versions remain the authority. The overview labels only readable sessions; inaccessible bindings hide identities and prevent replacement. Removed or replaced instance fingerprints are pruned so restoring old configuration cannot restore old routing.

Bound sessions mirror new AGH user text, labeled as an AGH user message, alongside assistant replies through the same durable outbound queue. Channel ingress uses a `channel:<sha256>` command correlation, preserved from the native inbox into `user/message.commandId` and the projected user node. All channel inputs are suppressed on outbound to prevent echoes. Correlation is presentation and deduplication metadata, never authorization. Only messages after the binding baseline are eligible; legacy user nodes without correlation are not backfilled. System inputs and reference material are omitted. User attachments produce an open-in-AGH notice rather than exporting their contents. Existing logs need no migration, and adapter interfaces and plugin permissions are unchanged.

Activated bindings also reconcile the authoritative projection every five seconds when live events are missed. Each route has at most one pending reconciliation; detach and shutdown cancel its timer. Reconciliation retains the binding baseline and durable delivery references, so delivered content is not replayed.

Channel retirement must confirm external cleanup before replacement. A failed or timed-out strict shutdown retains the failed instance and blocks automatic replacement and shutdown confirmation; inspect and reconcile the external connection before restarting its owner. Participant registration uses the resolved AGH session identity, including when a channel route binds an existing Web session.

Extension API 5.12.0 adds channel targets. A managed service that declares `channelTargets` receives `init.channels`; the Host-owned `ChannelTargets` store in `host-extensions/profile/channel-targets.ts` keeps pairings and the delivery ledger in the profile metadata namespace `host:channel-targets`, and each channel row reaches it through a bridge keyed by its package and row. The runner offers each inbound event to the bridge's target router before session routing; a pairing code or a paired chat stops there, after the runner's dedupe claim. Minting a code requires a person's approval: `core/channel-pairing` is a Host-owned decision owner in the profile decision journal, and `createChannelPairingApprovals` holds the single mint authorization function. The admin method `_agnes/v1/channels.pairing` lists targets, mints and revokes. Removing either package releases its pairings in `clearChannelState`.

Extension API 5.13.0 extends them. The router copies `MessageEvent.quotedMessageId` to the service's message event. A `cardAction` in a paired chat always stops at the router, so it never reaches the session approval or slot handlers. It reaches the service as an `action` event only when the clicker is the paired owner in the same chat and the bridge's delivery ledger shows the clicked message was sent by that pairing's service. A service send with `actions` becomes a `card` block; `Outbound.sendDirect` passes it through `degrade`, so a channel without cards receives numbered text. The bridge checks the composed card against `cardBytes` only when the adapter renders cards.
