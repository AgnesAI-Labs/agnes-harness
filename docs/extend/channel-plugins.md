# Write an IM channel plugin

English | [简体中文](channel-plugins.zh-CN.md)

[Full integration manual](channel-bridge-integration.md) · Examples, media, binding and acceptance.

The backend supplies one shared channel bridge. Each platform is an independently installed
plugin; installing Harness alone does not connect to any IM account.

Import the public adapter types, `channelKind` and `CHANNEL_CONFIG_SCHEMA` from
`@agnes/plugin-runtime/channel-contract`. Declare that module as a Host-provided external so
its kind token is shared with the Host. Extension API 5.5 adds the optional
`ctx.profileRuntime.registerChannel(provider, { instances: [] })` author entry.

The provider has `id`, `version`, a validated protocol `ChannelManifest`, and `create({ config })`
returning a `ChannelAdapter`. The adapter implements platform protocols and presentation only;
it must implement cancellation and release its connections in `disconnect`. Its manifest and
capability ceiling are captured at registration, and the bridge refuses a different adapter.

Declare `inject: ['profileRuntime', 'services', 'providers']`, `store: true`, the reviewed network
ceiling, explicit `secrets` grants (exact references or `secret://namespace/*`),
`managedServices` with id `channel`, scope `profile`, an in-process artifact and bounded
start/stop deadlines, and the services returned by
`managedServiceCapabilities('channel', CHANNEL_CONFIG_SCHEMA)`. Registering the provider alone
in the catalog does not create a live connection; use `registerChannel` for the owned lifecycle.
Embedder Hosts without a daemon channel bridge reject registration.

Each configured instance specifies a unique id, an existing absolute workspace, an installed
agent reference (or `default` for the general assistant), `allowFrom`, `requireMention`, and credential name-to-`secret://` references.
Only credentials declared by the platform manifest can be resolved. Keep adapter `config`
non-sensitive: secrets belong in the credential reference mapping. Package configuration is the
initial value; a native `channel.configure` override takes precedence until changed through the
same managed configuration service. The standard plugin settings UI and `agh plugins config`
commands can supply the initial value.

After the package is stopped and removal is committed, uninstall clears its channel configuration
overrides, observed targets and bindings in this profile. Reinstallation uses the package's initial
configuration (an empty instance list for DingTalk). Disable, update and restart preserve this state;
credentials and unrelated plugin data are retained. Binding controls in existing sessions use the
currently enabled channel services while retaining session identity, workspace checks and journals.

To remove one connection, open **Plugins → Channels**, expand its **Details** and choose
**Delete instance**. Confirm the affected instance, complete native configuration approval,
then continue the same deletion. This disconnects the instance and clears its observed targets
and bindings; other instances, conversation history and saved credentials remain. Changed
configuration, changed bindings or inaccessible bindings refuse deletion until refreshed and
reviewed. An unconfirmed response must reconcile the same operation rather than claim success.
For a failed resource whose shutdown is confirmed, the backend can read a persisted binding
summary without starting a transport, resolving credentials or granting message forwarding.
This lets administrators delete a broken connection through the same native approval. Unknown
shutdown or unreadable binding metadata remains blocked; a runtime read failure is not labelled
as an inaccessible foreign binding.

General assistant sessions can be bound without installing a role agent. Binding always preserves
the selected session's agent. Start a General assistant session before binding to use the default agent.

The backend owns session namespaces, agent launch admission, SDK discovery/journals, durable
outbound references, queue/reconnect supervision, identity/approval forwarding and shutdown.
It stops intake on retirement and refuses post-retirement adapter calls. An uncertain teardown
fails shutdown confirmation and uses native managed-resource recovery; never blindly restart
an unknown external operation.

Use fake gateways for lifecycle and refusal tests, then independently verify each real platform.
See [architecture and compatibility](../develop/channel-plugins.md). In Extension API 5.6, use
the composer’s Channels dialog to configure instances through native approval. The trigger appears only after an existing session is loaded, editable and connected and its initial channel overview is available; it is hidden for loading, read-only, disconnected and draft states. Bound connections show the channel icon/name/status and open their existing configuration directly. Plugins → Channels
provides a multi-channel management overview. Collapsible channel groups preview three connections
each, with controls to show more or expand/collapse all groups. Compact rows show session and
connection status; Details reveals the workspace, instance ID, unbind and move actions. Search
matches sessions, chats, instance IDs and workspaces, showing all matches regardless of the preview limit.
Declare `channelServiceCapabilities()` to enable Host-owned session binding services;
`configSchema` describes non-sensitive provider options. Create a session before binding, send the
bot a message, then refresh and select its verified chat target. Only the same workspace is allowed.
Only future messages are exported; unbound chats never create sessions. Reconnect requires inbound
confirmation. Pending transitions stay paused until explicitly unbound. Handle native approvals in AGH.

The composer’s Channels button opens a compact dialog. Enabled channel plugins are discovered dynamically. Choose a channel, select stored credentials and platform options, approve the native configuration operation, then confirm an observed chat target in the same dialog. The backend derives the instance ID, workspace and agent from the authorized session. Plugins → Channels summarizes connections by provider and shows session titles, chat targets and connection status, with configure, unbind and move actions. Moving a connection replaces its old routing metadata and requires fresh target confirmation. New plugins require no frontend vendor list.

Bound sessions mirror new AGH user text, labeled as an AGH user message, alongside assistant replies through the same durable outbound queue. Channel ingress uses a `channel:<sha256>` command correlation, preserved from the native inbox into `user/message.commandId` and the projected user node. All channel inputs are suppressed on outbound to prevent echoes. Correlation is presentation and deduplication metadata, never authorization. Only messages after the binding baseline are eligible; legacy user nodes without correlation are not backfilled. System inputs and reference material are omitted. User attachments produce an open-in-AGH notice rather than exporting their contents. Existing logs need no migration, and adapter interfaces and plugin permissions are unchanged.

For bound sessions the composer displays each channel name and its current sharing, confirmation or connection status. Each binding opens its exact saved connection for editing. Unbound sessions retain the Channels picker; merely configuring an instance does not count as a session binding.

## Channel icon

From Extension API 5.7.0, providers may set `manifest.icon` to a PNG/JPEG data URL, for example `icon: "data:image/png;base64,..."` (replace the ellipsis with standard padded base64). Embed your package artwork at build time and use the same manifest for the provider and adapter. Declare an API range of `^5.7.0` when using this field.

The complete string must not exceed 32768 characters. Harness checks image structure, a 24 KiB decoded budget and a 1048576 pixel budget; a square image up to 512 × 512 is recommended. SVG, remote URLs and filesystem paths are not accepted. Channel overview, channel selection and connection editing use this artwork. Missing, invalid or failed images fall back to the shared channel icon. Existing plugins without icons continue to work without migration or additional permissions.

Channel ingress must submit actual `file`/`image` content through the supported session API so native attachment admission persists and authorizes originals. A synthetic `attachment://hash` URI is not proof of storage. Use bounded downloads and surface partial failures without credentials or temporary URLs. Only definitive image-admission data/MIME/pixel refusals may degrade to ordinary file content with a stable, separate command correlation and explicit notice; uncertainty, authorization, storage and quota errors never trigger this retry. Audio/video originals are files, not a promise of model understanding.

From Extension API 5.8.0, channel manifests may provide `displayNames: { "en": "Example", "zh-CN": "示例" }`. Harness selects the current language, falling back to `displayName`, then `id`. Names must be 1–64 characters and not whitespace-only. Declare `^5.8.0` when using the field; channel and binding identities stay unchanged. See the [bridge integration guide](channel-bridge-integration.md).

The binding dialog keeps a chat selector visible even before any message arrives. An empty target list is different from a failed runtime: refreshing reads state only; it does not restart a resource. If startup failed, return to connection settings, save and complete native approval to reconnect. Fixed `channel-*` startup codes identify the state directory, workspace, binding store, credentials, adapter, backend or platform phase without exposing platform exception text or secrets.
