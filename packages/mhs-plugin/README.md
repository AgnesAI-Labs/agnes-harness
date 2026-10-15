# MHS Harness plugin (preview)

[简体中文](README.zh-CN.md)

`@agnes/mhs` connects the profile-owned `@agnes/mhs-hub` to the public extension API. It exports seven tools, a bounded context hook, profile service and stream adapters, and a managed-service runtime factory. Device semantics and schemas remain in MHS packages.

The seven tools are `list_devices`, `read_device`, `call_device`, `set_device`, `stop_device`, `watch_device` and `unwatch_device`. Calls and settings declare `requiresApproval: always` and `replay: never`; a second trusted admission check binds effective device arguments and revision before dispatch. Stop is a risk-reducing operation with a confirmed/unknown receipt. Watches bind to the real invoking session/lane and cannot select another conversation. Stills use `ToolContext.session.imageInput` and its current model policy; neither raw media bytes nor video enters a text result or the ledger.

`createMhsPlugin(connector)` registers session tools and context against an existing current Hub. `startMhsHub(init)` is called by a profile managed-service supervisor once; it opens storage, recovers unknown outcomes, installs shutdown, binds the device listener, then reports readiness. Multiple sessions do not own separate listeners. `startManagedMhsHub(runtime, { authority, wakes })` consumes the real generic `ManagedServiceInit & ManagedServiceRuntime`: its owned store, device listener, readiness proof and shutdown lifecycle. `registerMhsStreams(north, streams, bindControl)` installs `mhs.media`, `mhs.events` and `mhs.control` through `PluginStreamsPort`. The trusted binder maps the verified grant to its exact device and Hub lease; browser input cannot pick a control target. Media recovery is bounded to one keyframe request per second per stream; disconnect stops the admitted device. `mhsServices` accepts trusted service contexts separately from user input; `mhsStreams` supplies events, bounded media frames and control through server-bound leases.

`createMhsNativeProfileAdapter(assertActive)` connects the real Hub to native profile services. Its `authority` accepts only the matching effective arguments and device revision from consumed Host admission; `definitions(north)` supplies strict `mhs.*` services, with urgent Stop and a bounded manual lease. `register(ctx, north)` registers them through the public services facet. Pass `adapter.bindControl` to `registerMhsStreams`: it resolves only a live grant issued by the native lease handler, with the same actor, source and profile, and binds its device and Hub lease. The gateway first calls the current profile authority’s `authorizeControl` with the authenticated credential. No derived control binding survives a process restart. `mhsOwnedStore(store)` adapts the Host owner store to Hub CAS revisions and paginated scans. The managed composition supplies the current-activation callback, a lifecycle-bound owner store, and the authenticated bound-wake SDK port.

The installed `mhsPlugin` injects the public `profileRuntime` facet. Enabling it publishes one managed Hub in the shared profile worker, with the real owner store, native profile services, authenticated streams and bound-notification producer. Session instances resolve this current Hub. Disabling revokes admission, drains motion, closes listeners and hides the profile client contribution. An unconfirmed shutdown stays failed and refuses restart.

The Developer page consumes generic `hub.status`, `hub.configuration`, `hub.check`, `hub.retry` and `hub.configure` services. Device endpoints come from actual listener binding; automatic ports can be replaced by an explicitly reviewed port through native configuration approval. Reconfiguration drains the old Hub and closes its streams; the UI reconnects to the current Hub, and device SDKs must use the selected device endpoint. No direct North WebSocket or browser-supplied role grants control.

This is a source preview with no published-package or physical-device compatibility claim. Physical-device, browser decoder/GPU, bundled-example and Windows acceptance remain separate integration responsibilities. Native profile decisions surface in the Web sidebar’s **Approvals** section; see the [profile service guide](../../docs/develop/profile-services.md). See the [Hub contract](../mhs-hub/README.md) and [device SDK](../mhs-device/README.md).

The browser contribution is implemented by [`@agnes/mhs-ui`](../mhs-ui/README.md), declared in `agnes.client.json` with a profile lifetime, primary MHS entry and public tool-view slots. Run `pnpm --filter @agnes/mhs build:client` to produce its package-local assets. Building the client does not start the Hub; enabling the installed plugin does. Hosts without the profile-runtime contract refuse activation.

The installed Hub also accepts reviewed backend producer bridges through `mhs.producer` and `mhs.producer.media`. Child manifests must declare exact managed `requires` grants. The generic profile runtime stamps current child authority on each forwarded stream; direct browser access cannot impersonate that bridge. Device commands still originate from native-admitted Hub operations, and media uses a separate bounded lane.

The profile client also declares approved `mhs.pause` and `mhs.clip`. Clip bytes use the separate `mhs.clip` control stream, bound to that exact service's native grant; media/control sockets cannot substitute it. Tools with a string `clip` parameter offer bounded PCM16 WAV upload, then populate the parameter only after cache acknowledgement. The context hook puts maps first (at most 3000 UTF-8 bytes) and includes positions, zones and tool parameter schemas within a total 6000-byte limit. `read_device` supports `since`, values history and bounded history paging; profile queries additionally support cancellation/deadlines and event replay.

Clip uploads use ordered 2 KiB binary chunks on the existing 4 KiB/30-frame-per-second control contract. The browser paces chunks at 40 ms, and the Hub assembles at most 1 MiB under the approved hash before sending it to the device. Partial, excess, expired or repeated uploads cannot trigger a device tool.

Advanced external Hub mode keeps the AGH-managed profile resource and local approval/journal,
but replaces its South listener with one reviewed `mhs-peer/v1` device-ingress connection.
Configure `externalHub: { address, allowlist }` alongside `listenerPorts` through `hub.configure`.
The exact normalized address must be allowlisted; use a numeric host and `wss:` with a valid TLS
certificate (only loopback permits `ws:`). Credentials, URL queries, fragments, redirects and
DNS hostnames are refused. No browser network/CSP authority is added. `mhs.connection` projects
local/external readiness without credentials; a disconnected peer is failed and requires Retry.

On the remote machine, a device adapter can call `serveExternalHubPeer(socket, devices, signal)`
from `@agnes/mhs-hub` after authenticating a server-owned WebSocket at `/mhs-peer/v1` over its
TLS/VPN access boundary. Give this socket exclusive ownership of those SDK devices; it replaces
their observation/state callbacks. This is an explicit versioned peer adapter, not the old North
protocol or a public unauthenticated listener. The adapter validates registrations and bounded
media, retains device-local deadman, and stops its fleet on peer loss. Native admission on the
AGH side remains mandatory for calls, writes and manual leases. The peer forwards pause/resume,
resource holder/caller details and approved clips; clip chunks reuse the bounded hash-checked
assembler and complete only after the remote SDK acknowledges caching.

Switching local/external drains the old Hub through the managed configuration receipt. Disable
stops the attached fleet and closes this profile's peer, without terminating the external service.
A missing stop acknowledgement stays unknown. Stores, sockets and control leases remain bound
to each current profile; old pinned sessions cannot re-open a disabled connection.
