# Connect a local frontend to another computer

English | [简体中文](remote-frontend.zh-CN.md)

[Deployment](deployment.md) · [Plugins](packages.md) · [Web workbench](web.md)

A and B run the same complete standard Harness. A hosts the frontend and its browser connects directly to B's HTTP/WebSocket service. No SSH is involved; A’s local BFF handles only credential exchange, while session traffic goes directly to B. B enables an installed cloud plugin; A needs no cloud plugin.

## Key and publication contract

Cloud plugin **0.2.0** reads `AGH_CLOUD_KEY` at activation. Missing, empty or whitespace-only values fail activation and do not publish a port. The third-party sandbox operator injects the Key into B's daemon/Worker process environment. Setting it only on a launcher that reuses an existing daemon is insufficient. The plugin snapshots the value; restart B's processes to rotate it.

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

`key-owner` grants this profile's full workbench authority, including workspaces, tools, settings and plugin administration. Standard execution policies and tool approvals remain. It does not provide per-user identities or tenant isolation. A matching caller can still disable/remove the cloud plugin; protection against that disconnection is not implemented. The server retains legacy `public-owner` compatibility for other declarations, but **A's updated cloud connection refuses an unauthenticated downgrade**. Plugin 0.2.0 always uses `key-owner`.

`agh serve` owns the listener, reads the current ready installed roster and calls the declaration through a private connection. Missing, disabled, blocked, conflicting or failed declarations provide no cloud service. Each HTTP request/upgrade checks the declaration. The 500 ms reconciliation loop closes listeners and connections after revocation/configuration changes, plus any bounded Worker RPC timeout. Closing the launcher also stops publication; existing tasks are not implicitly cancelled. Default local Host/Origin checks and the separate multi-user authenticated remote WSS transport remain intact.

Optional `tls: {"certFile":"...","keyFile":"..."}` names B-local certificate/private-key files. Both enable HTTPS/WSS; otherwise the listener uses HTTP/WS. HTTP is for trusted test networks; deployments should use HTTPS/WSS or the sandbox platform's HTTPS gateway to protect Keys and capabilities in transit. APIs and WebSockets share one port.

## Two-computer setup

1. Update and build the matching standard Harness on both A and B through the repository toolchain entry with `--filter @agnes/cli build:local`, then restart their daemons to load the new code. Update B to cloud plugin 0.2.0.
2. Inject `AGH_CLOUD_KEY` on B. If its daemon already exists, stop/restart it through B's deployment procedure under the new environment so daemon and Worker inherit the value. Install `agh plugins add /absolute/path/to/agh-cloud-plugin-0.2.0.tgz`, review and trust it; keep `agh serve` running for that home/profile.
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

This version requires updated standard Harness on A and B and cloud plugin 0.2.0 on B. It supports one local environment and one cloud connection.

This iteration implements environment-Key loading, A's credential management and connection authentication only. Third-party allocation/purchase, model catalogs, inference and usage reporting are not implemented. The next stage lets B's cloud plugin use the same deployment Key to load third-party cloud models and run inference; A reads B's cloud catalog, independently of B's local model configuration.

Remote frontend plugin code executes in A’s workbench under the existing trusted-plugin model. This prototype isolates backend execution and storage by environment; it does not sandbox that browser code away from A’s page. Connecting therefore selects both B’s backend and its trusted frontend contributions.
