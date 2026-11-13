# Connect a local frontend to another computer

English | [简体中文](remote-frontend.zh-CN.md)

[Deployment](deployment.md) · [Plugins](packages.md) · [Web workbench](web.md)

A and B run the same complete standard Harness. A hosts the frontend and its browser connects directly to B's HTTP/WebSocket service. No SSH is involved; A’s local BFF handles only credential exchange, while session traffic goes directly to B. B enables an installed cloud plugin; A needs no cloud plugin.

## Key and publication contract

Cloud plugin **0.5.0** reads `AGH_CLOUD_KEY` at activation. Missing, empty or whitespace-only values fail activation and do not publish a port. The third-party sandbox operator injects the Key into B's daemon/Worker process environment. Setting it only on a launcher that reuses an existing daemon is insufficient. The plugin snapshots the value; restart B's processes to rotate it.

An installed, trusted, enabled plugin contributes the profile query `frontend.publish`, listed in its client descriptor. It takes `{}` and returns the structure below. `keySha256` must be the actual 64-character lowercase SHA-256 verifier; the original Key is never returned:

```json
{"enabled":true,"access":"key-owner","host":"0.0.0.0","port":8443,"auth":{"keySha256":"<64-character verifier>"}}
```

A's **Settings → Advanced → Cloud connection** accepts B's origin and a selection from **A's local credential dropdown**. It never accepts a raw Key or creates/replaces a credential. **Manage local credentials** opens A's **Settings → Permissions → Credentials**: create a generic credential with B's Key as its value, then return to select it. **Refresh credentials** reloads the list. Even when opened from a cloud session, the dropdown and management action always use A, never B. Duplicate labels include a reference suffix.

Browser storage contains only the origin and `secret://generic/...` reference. Changing the selection updates only the binding; disconnecting preserves the credential. Previous saved bindings are selected automatically. Reopening the same browser reconnects; another browser needs a new selection. This browser-owned binding is not yet counted in backend configuration references. Deleting the credential prevents the next authorization. Raw Keys never enter browser storage, URLs, journals or sidebar state.

1. The browser POSTs B's origin and credential reference to **A's local** `/_agnes/cloud-connection/authorize`. This exact-origin BFF invokes admin-tier `admin.cloud.authorize` over its private daemon connection, requiring credential-read/write and package-activation administration permissions.
2. A's daemon reads its credential store and POSTs `{key}` to B's `/_agnes/remote-frontend/auth`. B requires an exact, case-sensitive match to its deployment Key. This version does not contact a third-party entitlement service.
3. B issues an eight-hour temporary bearer capability. A's browser receives only that capability and connects directly to B; conversation traffic does not pass through A's BFF.
4. All HTTP APIs, plugin resources and WebSocket upgrades use `/_agnes/remote-access/<capability>/...`. Relative module imports retain the prefix. B validates then strips it before forwarding to fixed local endpoints. Bare API/resource/socket requests fail authentication. Expiry closes sockets and reconnect renews authorization. The temporary capability is also sensitive: avoid logging full resource URLs. Responses set `no-store` and `no-referrer`.

`key-owner` grants this profile's full workbench authority, including workspaces, tools, settings and plugin administration. Standard execution policies and tool approvals remain. It does not provide per-user identities or tenant isolation. A matching caller can still disable/remove the cloud plugin; protection against that disconnection is not implemented. The server retains legacy `public-owner` compatibility for other declarations, but **A's updated cloud connection refuses an unauthenticated downgrade**. Plugin 0.5.0 always uses `key-owner`.

`agh serve` owns the listener, reads the current ready installed roster and calls the declaration through a private connection. Missing, disabled, blocked, conflicting or failed declarations provide no cloud service. Each HTTP request/upgrade checks the declaration. The 500 ms reconciliation loop closes listeners and connections after revocation/configuration changes, plus any bounded Worker RPC timeout. Closing the launcher also stops publication; existing tasks are not implicitly cancelled. Default local Host/Origin checks and the separate multi-user authenticated remote WSS transport remain intact.

Optional `tls: {"certFile":"...","keyFile":"..."}` names B-local certificate/private-key files. Both enable HTTPS/WSS; otherwise the listener uses HTTP/WS. HTTP is for trusted test networks; deployments should use HTTPS/WSS or the sandbox platform's HTTPS gateway to protect Keys and capabilities in transit. APIs and WebSockets share one port.

## Two-computer setup

1. Update and build the matching standard Harness on both A and B through the repository toolchain entry with `--filter @agnes/cli build:local`, then restart their daemons to load the new code. Update B to cloud plugin 0.5.0.
2. Inject `AGH_CLOUD_KEY` on B. If its daemon already exists, stop/restart it through B's deployment procedure under the new environment so daemon and Worker inherit the value. Install `agh plugins add /absolute/path/to/agh-cloud-plugin-0.5.0.tgz`, review and trust it; keep `agh serve` running for that home/profile.
3. The launcher prints `key-owner frontend: ...`. Configure host/port/TLS using normal plugin settings and permit the port in B's firewall. Do not put the Key in plugin configuration.
4. Open A's own page, **Settings → Advanced → Cloud connection**. Enter B's reachable origin, such as `http://192.168.1.20:8443`, and select the local credential whose value matches B’s Key, then **Save and connect**. Do not use bind address `0.0.0.0` as a target.
5. **Projects** shows expandable **Local sessions** and **Cloud sessions**. Once ready, the cloud plus creates a B session using B's workspace, tools and current model execution. B's bare cloud URL no longer opens an anonymous workbench; connect from A with the Key.

Browser private-network permissions, mixed-content and certificate rules still apply. HTTPS frontends need a compatible secure remote endpoint.

## Client routing and state

The `remote` page parameter selects B. Before loading controllers after Key authorization the browser checks the protected `/_agnes/remote-frontend` for publication version, access mode, instance identity and fixed WebSocket path. A serves its own frontend code/vendor modules; backend HTTP, plugin assets and sockets use B. CSP adds only the explicitly selected origin and its WS(S) counterpart. A's cookies are not sent to B, and backend HTTP does not follow redirects to arbitrary targets.

The unified A sidebar groups sessions by environment and identifies each by its backend/session pair. A remembers the cloud origin in this browser and reconnects after reload. **Load more** fetches additional history, up to 5,000 sessions per group. The sidebar reuses the standard brand, new-conversation, collapse, search and settings components. Search and its shortcut open the selected environment’s original session search panel. Rows retain the original timestamps, activity and action menus; rename, pin, archive and other actions run through that environment’s existing controllers.

The **Cloud sessions** group header uses a compact status dot for **Not configured**, **Connecting**, **Ready**, **Disconnected** or **Connection failed**, including while collapsed. Green means ready, red disconnected/failed, amber connecting and gray unconfigured; hover or assistive text names the state. Ready requires completed frontend startup and successful backend session/activity reads; a saved address alone is insufficient. Repair a failed cloud connection through local settings. The cloud group's plus opens the cloud settings page if unconfigured. The legacy `?connection=1` route opens that same settings page.

A retains an independent frontend runtime context for each environment, both serving A's frontend code. The cloud context calls B directly. Switching or collapsing groups does not reload these contexts or cancel the other environment's tasks. Drafts and live conversations remain separate. The outer sidebar receives only session/activity projections and sends navigation commands to the selected context. Each backend still owns session facts, workspace access, execution and approvals.

Journals, drafts and model/permission memory are separated by backend origin and instance identity. File references, directory selection, plugins, MCP and model credentials belong to their environment. Settings and plugin navigation target the current environment shown in the toolbar; settings fall back to local if cloud is unavailable, and cloud connection preferences always belong to A's browser. Saving a connection keeps settings open to observe its status; then create or select a cloud session in its group. Cloud failure does not interrupt local conversations; reconnect once service recovers. Explicit disconnection or changing the cloud origin releases the previous cloud page context. Reconnection restores B's records, but unsubmitted drafts are not guaranteed across an explicit disconnect. Tasks already started on B follow B's backend lifecycle.

This version requires updated standard Harness on A and B and cloud plugin 0.5.0 on B. It supports one local environment and one cloud connection.

Cloud plugin 0.5.0 reads two required deployment environment variables at startup. Model listing and inference share the same API base and deployment Key:

```sh
export AGH_CLOUD_KEY='your-platform-key'
export AGH_CLOUD_API_BASE_URL='https://api-llmsg-dev.agnes-dev.com/v1/'
```

B's `cloud.models.list` appends `models` and uses GET; its model adapter appends `chat/completions` and uses OpenAI-compatible POST/SSE on the same gateway. Both send `Authorization: Bearer <AGH_CLOUD_KEY>`. With the configuration above, the endpoints are `https://api-llmsg-dev.agnes-dev.com/v1/models` and `https://api-llmsg-dev.agnes-dev.com/v1/chat/completions`. The [New API listing contract](https://docs.newapi.pro/zh/docs/api/ai-model/models/list/listmodels) and [chat protocol example](https://www.agnes-ai.cn/zh-Hans/docs/quickstart) describe the protocols; the deployment environment owns the destination.

The Base URL may include a deployment path, must be HTTP(S), and cannot contain credentials, query strings or fragments. Its trailing slash is normalized. Missing/invalid values refuse activation. Version 0.4's `AGH_CLOUD_MODELS_BASE_URL` and `AGH_CLOUD_INFERENCE_BASE_URL` are no longer read; remove them and set `AGH_CLOUD_API_BASE_URL` before restarting B's daemon/Workers. No legacy address fallback is retained. Keep the existing `AGH_CLOUD_KEY` and A's corresponding credential binding. Existing conversations pin their plugin generation: create a new cloud conversation to verify this upgrade, or use the existing runtime-settings action to migrate an eligible old conversation to the current plugins.

Only A's cloud frame replaces the model picker, through `conversation.input.model.catalog`. It fetches metadata from B, searches/refreshes the catalog, and selects a draft or existing-session model through the ordinary session contract. B validates the route/model before saving it. An existing session retains its current model until the user switches it. New cloud drafts use the cloud catalog. B fits the plugin-owned `agnes-cloud-primary` route in memory, independently of persisted native accounts/defaults. No original local routes, credentials or default choices are rewritten. A's local sessions and B's own local page retain native model controls. Profile-owned slot props expose `value` (current picker state) and `actions.select` / `actions.setCatalog`; catalog publication is scoped to this frontend context and clearing/unloading restores its native catalog.

The model adapter reuses the Host-provided public `@agnes/ai/model-adapter` entry (`PiAdapter`, `isChatModelId`). Runtime `ModelAdapterDefinition.contributeRoutes(signal)` is optional: existing adapters are unchanged. Installed providers can return their own routes for assembly without modifying profile configuration; route API must equal their registration ID, and collisions with persisted/other contributed routes are refused. Routes follow registration/instance cleanup. When switching to a newly listed model, the worker refreshes its runtime model image, then runs the same strict selection validation. Streaming, tool round trips, cancellation, request capture and model errors use the standard Core/Worker path; no local-model fallback occurs after cloud failure.

The upstream catalog has IDs, not complete capabilities or prices. This version exposes chat models as text-only with native tool calls and no reasoning controls, using deployment budgets of 32,768 context / 4,096 output tokens. Plugin settings `modelContextWindow` / `modelMaxTokens` override these budgets (output must be below context). Zero cost metadata means **unknown pricing**, not free service; third-party charging and usage reporting remain outside this iteration. Known Agnes image/video generation IDs are filtered by the existing chat-model predicate; unknown vendor IDs require operator verification. Verify vendor-specific capabilities before widening them.

Catalog successes are cached for 60 seconds and manual Refresh forces a fetch. Requests have an eight-second timeout, no redirects and bounded JSON/model counts. Empty/rejected/unavailable/invalid states never expose upstream diagnostics or silently fall back to local models. Existing runtime snapshots remain immutable; runtime assembly refreshes the catalog for new selections. Changing Key or endpoint environments requires restarting B's daemon/Workers under the new environment. The installation and test instructions live in the independent plugin folder's README.
