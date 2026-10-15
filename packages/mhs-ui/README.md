# MHS browser client

[简体中文](README.zh-CN.md)

The MHS plugin's browser module uses public Agnes client registries and owner-bound profile services and streams. It has no device sockets, credentials, storage, approval decisions or Hub lifecycle authority.

`MhsPorts` is the presentation adapter boundary. Profile queries/effects and authenticated streams follow the public Host contracts; effects return operation receipts. The package supplying the MHS backend binds these adapters and contributes the module with a profile lifetime, declared `mhs` primary home entry and exact service/stream allowlists. Unsupported Hosts must reject activation rather than bypass native approval or open a direct device WebSocket.

Developer diagnostics and local example contributions are optional adapters. A missing contribution is shown as unavailable. Example activation and launch retain the host's native package review and bounded launch flow; a scene is a resolved local component, never an arbitrary iframe.

The installed module is declared by [`@agnes/mhs`](../mhs-plugin/agnes.client.json). `pnpm --filter @agnes/mhs build:client` bundles it into that package's ignored `dist/client/` directory; only React and the public Host frontend packages remain external. This is a client build, not a Hub launcher. The default backend still refuses unsupported managed connectors.

Device summaries, writable settings and sources come from the SDK-validated device declaration and Hub queries. Source toggles use `configure.sources.<id>.on`; a switch changes only after its device receipt confirms completion. Map selectors can use `tool.ui.params.<parameter>.pick` (`point`, `pose`, `polygon`) while keeping the actual parameter schema within the SDK's JSON Schema subset. The map emits `{map,x,y}`, `{map,x,y,yaw}` (degrees), or `{map,points}`; the declared parameter shape must match. Unannotated objects and routes use JSON input.

Activity accepts limits from 1 to 1,000 and opaque cursors of up to 512 characters. A current-session filter requests a Host session-read scope, checked against the authenticated caller’s durable session ownership; absent or foreign access is refused. Activity is read in bounded cursor pages; its seven-day window and earliest available timestamp come from the Hub. Session device counts use the selected session's public UI projection and clear immediately on a session switch. Truncated argument previews remain text; the UI never invents a device ID from an incomplete record. Tool cards link to the Host's execution record when available.

Manual control consumes an approved, device-bound operation lease. It does not accept browser-supplied roles or approvals. Release, pointer cancellation, blur, hidden document, stream loss, expiry and module disposal zero local axes and request the independent stop service. These UI safeguards complement the device SDK's independent deadman; native-device safety and browser decoder/GPU acceptance require integration validation.

The real Host adapter retains the immutable input and operation id of a pending native proposal. Reconciliation retries only that proposal until native approval resolves it; running, completed, refused and unknown operations are read without redispatch. Disposal cancels pending retries, and the adapter bounds retained operation associations to 1,024. Native approval appears in the Web sidebar’s Approvals section.
