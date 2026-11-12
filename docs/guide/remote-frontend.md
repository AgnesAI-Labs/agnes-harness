# Connect a local frontend to another computer

English | [简体中文](remote-frontend.zh-CN.md)

[Deployment](deployment.md) · [Plugins](packages.md) · [Web workbench](web.md)

A and B run the same complete standard Harness. A hosts the frontend and its browser connects directly to B's HTTP/WebSocket service. No SSH or A-side BFF relay is involved. B enables an installed cloud plugin; A needs no cloud plugin.

## Publication contract

An installed, trusted, enabled plugin contributes the profile query `frontend.publish`, listed in its client descriptor. It takes `{}` and returns:

```json
{"enabled":true,"access":"public-owner","host":"0.0.0.0","port":8443}
```

`public-owner` explicitly delegates this profile's local workbench authority to everyone who can reach the port. There is no login, connection Token, Origin allowlist or reduced remote method set. Workspaces, tools, settings and package administration are public. Standard execution rules and tool approvals still apply. This is one profile, not multiple user identities or tenant isolation.

`agh serve` reads the current ready installed roster and calls the declared profile service through its private connection. It owns the public listener and forwards only to its own fixed local Web/daemon endpoints. At this explicit publication boundary, request provenance is translated to local workbench authority. The default local listeners keep their Host/Origin checks. The daemon's authenticated remote WSS remains a separate transport with its existing identity requirements.

Only one publication owner is allowed. Missing, disabled, blocked, ambiguous or failed declarations provide no remote service; local development folders and old session pins cannot open the port. Every HTTP request and WebSocket upgrade checks the current declaration. A 500 ms reconciliation loop closes the listener and sockets on revocation/configuration change; failed Worker RPCs can add their bounded timeout to this delay. Closing the Web launcher stops publication. Existing tasks are not implicitly cancelled.

Optional `tls: {"certFile":"...","keyFile":"..."}` names B-local files and enables HTTPS/WSS. Both paths are required; otherwise use HTTP/WS. HTTP APIs and WebSockets share one port. TLS encrypts traffic without adding user authentication.

## Two-computer setup

1. Build the modified standard Harness on A and B through the repository toolchain entry with `--filter @agnes/cli build:local`.
2. On B run `agh plugins add /absolute/path/to/agh-cloud-plugin`, review and confirm, or use the Web plugin installer. Keep `agh serve` running for the same home/profile.
3. After activation the launcher prints `public-owner frontend: ...`. Change host/port/TLS through standard plugin configuration. Allow the chosen port in B's firewall.
4. Open A's own AGH page. Go to **Settings → Advanced → Cloud connection**, enter B's reachable origin such as `http://192.168.1.20:8443`, then **Save and connect**. Address, reconnect and disconnect controls all live in this settings page; the outer workbench has no cloud connection buttons. Do not use the bind address `0.0.0.0` as a target.
5. **Projects** shows expandable **Local sessions** and **Cloud sessions** groups together. Use the plus beside a group to create a conversation in that environment; cloud conversations use B's workspaces, models and tools. Select any session to switch. Opening B's published origin directly also serves B's own workbench.

Browser private-network permissions, mixed-content and certificate rules still apply. An HTTPS frontend needs a compatible secure remote endpoint. Certificate validation is not bypassed.

## Client routing and state

The `remote` page parameter selects B. Before loading controllers the browser checks `/_agnes/remote-frontend` for publication version, access mode, instance identity and fixed WebSocket path. A serves its own frontend code/vendor modules; backend HTTP, plugin assets and sockets use B. CSP adds only the explicitly selected origin and its WS(S) counterpart. A's cookies are not sent to B, and backend HTTP does not follow redirects to arbitrary targets.

The unified A sidebar groups sessions by environment and identifies each by its backend/session pair. A remembers the cloud origin in this browser and reconnects after reload. **Load more** fetches additional history, up to 5,000 sessions per group. The sidebar reuses the standard brand, new-conversation, collapse, search and settings components. Search and its shortcut open the selected environment’s original session search panel. Rows retain the original timestamps, activity and action menus; rename, pin, archive and other actions run through that environment’s existing controllers.

The **Cloud sessions** group header uses a compact status dot for **Not configured**, **Connecting**, **Ready**, **Disconnected** or **Connection failed**, including while collapsed. Green means ready, red disconnected/failed, amber connecting and gray unconfigured; hover or assistive text names the state. Ready requires completed frontend startup and successful backend session/activity reads; a saved address alone is insufficient. Repair a failed cloud connection through local settings. The cloud group's plus opens the cloud settings page if unconfigured. The legacy `?connection=1` route opens that same settings page.

A retains an independent frontend runtime context for each environment, both serving A's frontend code. The cloud context calls B directly. Switching or collapsing groups does not reload these contexts or cancel the other environment's tasks. Drafts and live conversations remain separate. The outer sidebar receives only session/activity projections and sends navigation commands to the selected context. Each backend still owns session facts, workspace access, execution and approvals.

Journals, drafts and model/permission memory are separated by backend origin and instance identity. File references, directory selection, plugins, MCP and model credentials belong to their environment. Settings and plugin navigation target the current environment shown in the toolbar; settings fall back to local if cloud is unavailable, and cloud connection preferences always belong to A's browser. Saving a connection keeps settings open to observe its status; then create or select a cloud session in its group. Cloud failure does not interrupt local conversations; reconnect once service recovers. Explicit disconnection or changing the cloud origin releases the previous cloud page context. Reconnection restores B's records, but unsubmitted drafts are not guaranteed across an explicit disconnect. Tasks already started on B follow B's backend lifecycle.

Update A's standard frontend for this feature. A B installation that already supports publication can keep cloud plugin 0.1.0. This version supports one local environment and one cloud connection.

Third-party allocation, purchased Keys, model-market catalogs and usage metering are later plugin integrations. User-facing third-party model catalog queries belong to A's standard client/BFF. This publication prototype does not implement those services.

Remote frontend plugin code executes in A’s workbench under the existing trusted-plugin model. This prototype isolates backend execution and storage by environment; it does not sandbox that browser code away from A’s page. Connecting therefore selects both B’s backend and its trusted frontend contributions.
