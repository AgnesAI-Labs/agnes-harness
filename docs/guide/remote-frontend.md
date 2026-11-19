# Connect a local frontend to another computer

English | [简体中文](remote-frontend.zh-CN.md)

The current branch pairs with cloud plugin 0.9.0. Billing uses trusted Core sideband evidence only; legacy result payload phases do not count. Core and plugin must be deployed together; the source update alone does not upgrade an existing sandbox.

[Deployment](deployment.md) · [Plugins](packages.md) · [Web workbench](web.md)

A and B run the same complete standard Harness. A hosts the frontend. Ordinary connections use B's HTTP/WebSocket service directly, without SSH; LLMSG sandboxes use the isolated local ingress relay below. The BFF handles only credential exchange for direct connections. B enables an installed cloud plugin; A needs no cloud plugin.

## LLMSG sandbox ingress

The user selects a local credential holding an LLMSG-issued `agh_sk_` Key and clicks Save and connect. Connection settings show the credential and status, without a sandbox address or manual address entry. A's daemon calls `POST /llmsg/api/agh/connection` with `Authorization: Bearer <managed Key>` and `{}` to discover the bound HTTPS `8443-<instance>.<region>.tencentags.com` origin. Legacy calls with `sandbox_url` must still match the exact bound address. This queries an existing instance; it does not provision, resume, renew or bill a sandbox.

A's daemon uses `AGH_LLMSG_API_BASE_URL` when present; otherwise it defaults to `https://api.llm.sg`, requesting `POST https://api.llm.sg/llmsg/api/agh/connection`. An explicit override is authoritative: an empty or invalid value, authentication failure, timeout or other connection failure retains the existing error behavior and never falls back to the default service. Configure overrides as an LLMSG API **origin**, without `/v1` or an API path, then restart that daemon through its normal lifecycle. HTTPS is required, except an explicit loopback HTTP broker for isolated tests. This is an A-side deployment setting, separate from B's three cloud plugin variables. The user selects only a managed Key; the address and traffic token are retrieved by the backend. Explicit legacy `?remote=` links and internal destination validation remain supported.

The daemon obtains the platform traffic token and uses it during B's existing Key exchange. Only the private daemon-to-launcher RPC carries that token. The launcher registers an expiring, bounded grant on A's isolated cloud listener. The browser receives only the existing temporary AGH capability and a `proxied` flag. HTTP, WebSocket and plugin assets then use that isolated origin; each outbound request adds `e2b-traffic-access-token` for the fixed authorized sandbox. Cookie, Authorization and spoofed traffic headers from the browser are not forwarded, redirects are not followed, and A's owner APIs remain unavailable on this listener. The 49983 management endpoint is not relayed.

A fresh connection obtains current credentials. After an established WebSocket disconnects or an upstream rejects access, the next request/handshake refreshes credentials through the same managed reference. Concurrent refreshes share one operation, failures back off for 30 seconds, and the browser capability's original expiry is never extended. A failed business write is returned to the caller and is never automatically replayed. Missing configuration, invalid address, rejected Key, unavailable instance (409) and rate limiting (429) produce localized connection errors; upstream response details and tokens are not projected.

Ordinary IP/domain connections retain the existing direct transport. This ingress adaptation does not change B's cloud models, tool approval, billing plugin, workspace isolation or model-gateway egress rules. Validate those separately on the target sandbox.

## Key and publication contract

Cloud plugin **0.6.0** reads `AGH_CLOUD_KEY` at activation. Missing, empty or whitespace-only values fail activation and do not publish a port. The third-party sandbox operator injects the Key into B's daemon/Worker process environment. Setting it only on a launcher that reuses an existing daemon is insufficient. The plugin snapshots the value; restart B's processes to rotate it.

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

`key-owner` grants this profile's full workbench authority, including workspaces, tools, settings and plugin administration. Standard execution policies and tool approvals remain. It does not provide per-user identities or tenant isolation. A matching caller can still disable/remove the cloud plugin; protection against that disconnection is not implemented. The server retains legacy `public-owner` compatibility for other declarations, but **A's updated cloud connection refuses an unauthenticated downgrade**. Plugin 0.6.0 always uses `key-owner`.

`agh serve` owns the listener, reads the current ready installed roster and calls the declaration through a private connection. Missing, disabled, blocked, conflicting or failed declarations provide no cloud service. Each HTTP request/upgrade checks the declaration. The 500 ms reconciliation loop closes listeners and connections after revocation/configuration changes, plus any bounded Worker RPC timeout. Closing the launcher also stops publication; existing tasks are not implicitly cancelled. Default local Host/Origin checks and the separate multi-user authenticated remote WSS transport remain intact.

Optional `tls: {"certFile":"...","keyFile":"..."}` names B-local certificate/private-key files. Both enable HTTPS/WSS; otherwise the listener uses HTTP/WS. HTTP is for trusted test networks; deployments should use HTTPS/WSS or the sandbox platform's HTTPS gateway to protect Keys and capabilities in transit. APIs and WebSockets share one port.

## Two-computer setup

1. Update and build the matching standard Harness on both A and B through the repository toolchain entry with `--filter @agnes/cli build:local`, then restart their daemons to load the new code. Update B to cloud plugin 0.6.0.
2. Inject `AGH_CLOUD_KEY` on B. If its daemon already exists, stop/restart it through B's deployment procedure under the new environment so daemon and Worker inherit the value. Install `agh plugins add /absolute/path/to/agh-cloud-plugin-0.6.0.tgz`, review and trust it; keep `agh serve` running for that home/profile.
3. The launcher prints `key-owner frontend: ...`. Configure host/port/TLS using normal plugin settings and permit the port in B's firewall. Do not put the Key in plugin configuration.
4. Open A's own page, **Settings → Advanced → Cloud connection**. Enter B's reachable origin, such as `http://192.168.1.20:8443`, and select the local credential whose value matches B’s Key, then **Save and connect**. Do not use bind address `0.0.0.0` as a target.
5. Use the **Local / Cloud** tabs below session search to switch environments. Local retains the standard project and temporary-conversation sections. Once ready, the cloud plus creates a B session using B's workspace, tools and current model execution. B's bare cloud URL no longer opens an anonymous workbench; connect from A with the Key.

Browser private-network permissions, mixed-content and certificate rules still apply. HTTPS frontends need a compatible secure remote endpoint.

## Client routing and state

The `remote` page parameter selects B. Before loading controllers after Key authorization the browser checks the protected `/_agnes/remote-frontend` for publication version, access mode, instance identity and fixed WebSocket path. A serves its own frontend code/vendor modules; backend HTTP, plugin assets and sockets use B. CSP adds only the explicitly selected origin and its WS(S) counterpart. A's cookies are not sent to B, and backend HTTP does not follow redirects to arbitrary targets.

The unified A sidebar shows one environment's session list at a time using **Local / Cloud** tabs and identifies each session by its backend/session pair. A remembers the cloud origin in this browser and reconnects after reload. **Load more** fetches additional cloud history, up to 5,000 sessions. The sidebar reuses the standard brand, new-conversation, collapse, search and settings components. New conversation, search and its shortcut follow the selected tab. Rows retain the original timestamps, activity and action menus; rename, pin, archive and other actions run through that environment’s existing controllers.

The **Cloud** tab uses a compact status dot for **Not configured**, **Connecting**, **Ready**, **Disconnected** or **Connection failed**, including while Local is selected. Green means ready, red disconnected/failed, amber connecting and gray unconfigured; hover or assistive text names the state. Ready requires completed frontend startup and successful backend session/activity reads; a saved address alone is insufficient. Repair a failed cloud connection through local settings. The cloud list's plus opens the cloud settings page if unconfigured. The legacy `?connection=1` route opens that same settings page.

A retains an independent frontend runtime context for each environment, both serving A's frontend code. The cloud context calls B directly or uses the LLMSG ingress relay. Switching tabs does not reload these contexts or cancel the other environment's tasks. Drafts and live conversations remain separate. The outer sidebar receives only session/activity projections and sends navigation commands to the selected context. Each backend still owns session facts, workspace access, execution and approvals.

Journals, drafts and model/permission memory are separated by backend origin and instance identity. Whether a local or cloud session is selected, the unified sidebar's Plugins, Agents, Automation, MHS and Settings entries always open **A's local management pages**. Management shortcuts inside a cloud conversation also navigate to A. Opening B's own Web directly still manages B. This changes UI navigation only; it does not reduce the deployment Key's existing backend authority.

Cloud-session workspace selection, input `@` file search and `$` skill references still read **B**. Execution uses B's plugins, MCP, skills and model credentials; changing A's management configuration does not replace them. Session search, creation and row actions still target their respective environment. Cloud connection preferences always belong to A's browser. Saving a connection keeps settings open to observe its status; then create or select a cloud session in its group. Cloud failure does not interrupt local conversations; reconnect once service recovers. Explicit disconnection or changing the cloud origin releases the previous cloud page context. Reconnection restores B's records, but unsubmitted drafts are not guaranteed across an explicit disconnect. Tasks already started on B follow B's backend lifecycle.

This version requires updated standard Harness on A and B and cloud plugin 0.6.0 on B. It supports one local environment and one cloud connection.

Cloud plugin 0.6.0 reads two required deployment environment variables at startup. Model listing and inference share the same API base and deployment Key:

```sh
export AGH_CLOUD_KEY='your-platform-key'
export AGH_CLOUD_API_BASE_URL='https://api-llmsg-dev.agnes-dev.com/v1/'
```

B's `cloud.models.list` appends `models` and uses GET; its model adapter appends `chat/completions` and uses OpenAI-compatible POST/SSE on the same gateway. Both send `Authorization: Bearer <AGH_CLOUD_KEY>`. With the configuration above, the endpoints are `https://api-llmsg-dev.agnes-dev.com/v1/models` and `https://api-llmsg-dev.agnes-dev.com/v1/chat/completions`. The [New API listing contract](https://docs.newapi.pro/zh/docs/api/ai-model/models/list/listmodels) and [chat protocol example](https://www.agnes-ai.cn/zh-Hans/docs/quickstart) describe the protocols; the deployment environment owns the destination.

The Base URL may include a deployment path, must be HTTP(S), and cannot contain credentials, query strings or fragments. Its trailing slash is normalized. Missing/invalid values refuse activation. Version 0.4's `AGH_CLOUD_MODELS_BASE_URL` and `AGH_CLOUD_INFERENCE_BASE_URL` are no longer read; remove them and set `AGH_CLOUD_API_BASE_URL` before restarting B's daemon/Workers. No legacy address fallback is retained. Keep the existing `AGH_CLOUD_KEY` and A's corresponding credential binding. Existing conversations pin their plugin generation: create a new cloud conversation to verify this upgrade, or use the existing runtime-settings action to migrate an eligible old conversation to the current plugins.

A's cloud frame uses the cloud model picker through `conversation.input.model.catalog`. B's own Web page also uses it when an existing session's recorded route is `agnes-cloud-primary`; native drafts and sessions on other routes delegate to the unchanged native picker using `actions.renderDefault`. B's native model memory only accepts models from its configured local catalog; viewing a contributed model cannot replace that preference. This requires B's matching updated standard frontend. Switching away from a cloud session clears its frontend catalog contribution; stale catalog responses cannot repopulate the native session. It fetches metadata from B, searches/refreshes the catalog, and selects a draft or existing-session model through the ordinary session contract. B validates the route/model before saving it. An existing session retains its current model until the user switches it. New cloud drafts use the cloud catalog. B fits the plugin-owned `agnes-cloud-primary` route in memory, independently of persisted native accounts/defaults. No original local routes, credentials or default choices are rewritten. A's local sessions and B's ordinary local sessions retain native model controls. Profile-owned slot props expose `value` (current picker state) and `actions.select` / `actions.setCatalog`; catalog publication is scoped to this frontend context and clearing/unloading restores its native catalog.

The model adapter reuses the Host-provided public `@agnes/ai/model-adapter` entry (`PiAdapter`, `isChatModelId`). Runtime `ModelAdapterDefinition.contributeRoutes(signal)` is optional: existing adapters are unchanged. Installed providers can return their own routes for assembly without modifying profile configuration; route API must equal their registration ID, and collisions with persisted/other contributed routes are refused. Routes follow registration/instance cleanup. When switching to a newly listed model, the worker refreshes its runtime model image, then runs the same strict selection validation. Streaming, tool round trips, cancellation, request capture and model errors use the standard Core/Worker path; no local-model fallback occurs after cloud failure.

The upstream catalog has IDs, not complete capabilities or prices. This version exposes chat models as text-only with native tool calls and no reasoning controls, using deployment budgets of 32,768 context / 4,096 output tokens. Plugin settings `modelContextWindow` / `modelMaxTokens` override these budgets (output must be below context). Zero cost metadata means **unknown pricing**, not free service; tool charging follows the reporting contract below. Known Agnes image/video generation IDs are filtered by the existing chat-model predicate; unknown vendor IDs require operator verification. Verify vendor-specific capabilities before widening them.

Catalog successes are cached for 60 seconds and manual Refresh forces a fetch. Requests have an eight-second timeout, no redirects and bounded JSON/model counts. Empty/rejected/unavailable/invalid states never expose upstream diagnostics or silently fall back to local models. Existing runtime snapshots remain immutable; runtime assembly refreshes the catalog for new selections. Changing Key or endpoint environments requires restarting B's daemon/Workers under the new environment. The installation and test instructions live in the independent plugin folder's README.

## Tool usage reporting

Requires matching standard Harness Extension API 5.15.0. Older hosts refuse this package. Upgrade/restart B's daemon before installing. Sessions pin their plugin generation: create a new session or migrate an eligible existing one through runtime settings.

Cloud credentials accept `AGH_API_KEY` or the existing `AGH_CLOUD_KEY`; model bases accept `OPENAI_BASE_URL` or `AGH_CLOUD_API_BASE_URL`. Both aliases must agree when supplied. The plugin never mutates environment variables or native model credentials, and does not substitute a generic `OPENAI_API_KEY` for the cloud Key.

```sh
export LLMSG_TRACK_URL='https://api-llmsg-dev.agnes-dev.com/llmsg/api/track/tool_calls'
```

This is a complete report URL, without appending `/v1/`. If absent, the plugin uses the model gateway origin's `/llmsg/api/track/tool_calls`. POST uses the same Bearer Key as inference and sends only `request_id` and the `tool_calls` name/count map.

Only tool calls produced by the cloud primary route are eligible. The pure projection reuses `request/sent`, `tool/call`, `effect/intent`, `tool/result` and `cost/ledger`, taking the ID from `X-Oneapi-Request-Id`, never the response-body ID or a generated ID. Only successful calls count once; explicit not-sent results, approval refusals, unexecuted calls, HTTP non-2xx responses and other failures do not. Successful empty results still count. Internal retries deduplicate by tool-use ID. Deferred acceptance stays pending; count once only after a final successful Core result linked to the original call in the same lane. Final errors, cancellation and unknown outcomes do not count, and repeated results never add another count. Child sessions report independently without adding their counts to the parent.

A committed turn end triggers enqueue, but each model request is reported separately and completely. Empty requests are skipped. Requests with unsettled calls wait rather than report a partial count. More than 50 tool names, names outside 1–64 characters, counts outside 1–1000, absent request IDs or mismatched Key identities remain blocked; never split, truncate or manufacture another ID.

The current-profile managed resource uses the Host-owned persistent store. Projection folding has no I/O; completion hooks persist queue records/receipts only. Background HTTP has independent cancellation. Enqueued records recover automatically after restart. A crash between ledger commit and enqueue is recovered when that session is reopened; the plugin does not enumerate unopened historical sessions. Persist the plugin store across sandbox restarts; erased sandbox disks cannot be recovered.

HTTP success (including duplicate acknowledgement) settles a record. Timeouts, 429 and 5xx retry the identical ID/body with bounded exponential backoff. Other statuses remain blocked. Old records cannot be sent with a rotated Key. Disabling stops delivery while preserving stored records and committed conversation outcomes. `cloudusage.check` exposes queued/blocked/sent counts, never credentials or upstream diagnostics. Stored records contain billing identifiers/counts, not raw Keys, arguments, conversation content or workspace files.

### Frontend isolation and native navigation

A's trusted workbench and local management remain at `http://127.0.0.1:<port>`. Cloud conversations load the standard frontend assets at the distinct origin `http://127.0.0.1:<isolated-port>`. That origin serves allowlisted build assets and, for LLMSG, only authorized B capability paths; it cannot access A's BFF, local plugin resources, credentials, daemon socket or upload handlers. A's main document never grants B script execution. Only the isolated cloud document grants the selected B origin in its CSP.

An origin- and window-checked message bridge gives the cloud frame a temporary capability for A's currently configured B. The cloud cannot choose a credential reference or an authorization destination, read A's credential list, or change connection settings. Only locale, theme and font scale cross as presentation preferences. The isolated listener receives an ephemeral port at web-server startup; restarting A creates a fresh cloud page context and can discard unsent drafts, while B retains its persisted sessions. Local/cloud grouping is rendered inside A's native sidebar, preserving its brand, application navigation, plugin home entries and sidebar slots. Settings remain modal; close settings before selecting a sidebar conversation.

Cloud model slots receive the presentation-only `owner.remote` hint as well as `owner.draft`, and publish catalog data with `actions.setCatalog`. The plugin delegates rendering to `actions.renderDefault()`, reusing the native keyboard-accessible model selector.
