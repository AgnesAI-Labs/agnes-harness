# Write an IM channel plugin

English | [简体中文](channel-plugins.zh-CN.md)

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

General assistant sessions can be bound without installing a role agent. Binding always preserves
the selected session's agent. Start a General assistant session before binding to use the default agent.

The backend owns session namespaces, agent launch admission, SDK discovery/journals, durable
outbound references, queue/reconnect supervision, identity/approval forwarding and shutdown.
It stops intake on retirement and refuses post-retirement adapter calls. An uncertain teardown
fails shutdown confirmation and uses native managed-resource recovery; never blindly restart
an unknown external operation.

Use fake gateways for lifecycle and refusal tests, then independently verify each real platform.
See [architecture and compatibility](../develop/channel-plugins.md). In Extension API 5.6, use
the composer’s Channels dialog to configure instances through native approval; Plugins → Channels
provides a multi-channel management overview. Declare `channelServiceCapabilities()` to enable Host-owned session binding services;
`configSchema` describes non-sensitive provider options. Create a session before binding, send the
bot a message, then refresh and select its verified chat target. Only the same workspace is allowed.
Only future messages are exported; unbound chats never create sessions. Reconnect requires inbound
confirmation. Pending transitions stay paused until explicitly unbound. Handle native approvals in AGH.

The composer’s Channels button opens a compact dialog. Enabled channel plugins are discovered dynamically. Choose a channel, select stored credentials and platform options, approve the native configuration operation, then confirm an observed chat target in the same dialog. The backend derives the instance ID, workspace and agent from the authorized session. Plugins → Channels summarizes connections by provider and shows session titles, chat targets and connection status, with configure, unbind and move actions. Moving a connection replaces its old routing metadata and requires fresh target confirmation. New plugins require no frontend vendor list.
