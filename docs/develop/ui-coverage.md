# Web UI capability coverage

English | [简体中文](ui-coverage.zh-CN.md)

This inventory covers the plugin architecture and shared workbench at the integration baseline `71a90c62` and the settings implementation in this change. It records available controls separately from backend support and browser acceptance. The product remains a developer preview. See [architecture](architecture.md), [provider architecture](architecture-plugins.md), [source map](source-map.md) and [Web guide](../guide/web.md).

Open **Plugins** in workbench settings or `/admin/plugins`. The runtime navigation contains **Plugins**, **Providers**, **Agent Loop & Models**, **Bundles & Presets**, **Security**, **MCP & Skills** and **Examples**. Both hosts use the same settings renderer; model accounts and resource management retain their existing controllers.

| Architectural capability | UI exposure and operation | Limits / acceptance evidence still needed |
| --- | --- | --- |
| Plugin kinds: tool, loop, model adapter, MCP, Skills, UI, bundle | Plugins: kind badges and filter, installed/discover search, detail view | Kinds are package declarations; the provider catalog describes the eight runtime provider kinds separately. |
| Real lifecycle: installed, enabled, active, draining, restart-required, failed | Plugins: backend state badges, draining session counts, failure reasons and repair hints; browser module state remains separate | No optimistic activation success; operation polling and reconciliation confirm changes. |
| Review before install | Source check and catalog review show source, integrity, license, capability hash, declared permissions, warnings and blockers | Install and trust/enable keep separate confirmation gates. Backend plugins run trusted code. |
| Install npm, path/folder, tgz/archive, Git, HTTPS archive and workspace extension | Plugins: Install from source; folder uses `path`, archive uses `file`, Git uses `git` | Backend source validation determines supported references. Credentials must never be pasted into a source. Local scan references are owner-generated. |
| Trust / revoke, enable / disable, update, rollback, remove | Existing plugin detail actions and confirmations | Existing package admin permission and recovery checks apply to all operations. |
| Code generations and session pins | Plugins: Code generations lists ID, actual state, packages and bound-session count; draining summary and orphan-pin release | Session code stays pinned across close/resume. A new default never silently changes an existing binding. |
| Local plugin folders and hot reload | Plugins: Local plugins shows actual home/workspace roots; Rescan local plugins requests the existing watcher | Rescan completion is not activation success: inspect resulting plugin states. Automatic watcher reload and historical session coexistence need the integrated browser gate. |
| Plugin creator | Plugins: Ask the agent to build a plugin opens a new task with a reviewable prompt | Draft is not sent automatically. Creator tooling must be enabled in the profile to scaffold through the agent. |
| All provider kinds: loop, model-adapter, compaction, persistence, sandbox, tool-runtime, tool-policy, child-agent | Providers: every kind has a section, even when empty; identity/version, source, capabilities, selection scope, lifecycle scope and restart requirement | Reads the real combined Host registry. Active means selected for the reported scope, not running-session count. Startup-only kinds are configured through profile/bundle contracts. |
| Agent Loop admin default | Agent Loop & Models: select exact ID/version or inherit profile; save with revision check | Missing/ambiguous versions are rejected by the backend. |
| Loop for each new session; existing session identity | Composer: new-session loop picker; session information shows persisted loop | Loop identity is immutable. Resume retains the bound version; legacy missing identity is not replaced by today’s default. |
| Model adapter default, model catalog, account/route selection | Agent Loop & Models: adapter/model default; Configure model accounts opens existing account settings. Composer: per-session model/thinking/context controls | Wire API and credentials remain owned by the model configuration backend. Account changes follow backend effect/restart status. |
| Bundles: compose and order | Bundles & Presets: installed bundle catalog with source package, ordered checkboxes, Move up/down, revision-checked save | Desired bundle changes require the effect reported by the backend (currently restart-required). UI does not claim a running Host changed. |
| Select preset per new session | Bundles & Presets: allowed preset list with Start a session; composer has Session presets selector | Only Host-allowed presets are offered. A selected bundle contributes presets after backend assembly. |
| Independent bundle overrides per session | Backend composition can pin a session tree; current public session creation SDK accepts `preset` and `loop`, not a bundle list | **API gap:** UI can choose contributed presets and deployment bundle order, but cannot submit an independent bundle list per session. No unsupported parameter is invented. |
| Configuration dump and provenance | Bundles & Presets: choose preset, Explain desired composition, readable table of choice/layer/source plus full safe JSON dump and live session bindings | Static desired configuration and live sessions are explicitly distinguished. Secret/config snapshots are not exposed. |
| Permission presets: read-only / workspace-write / full-access | Security: availability from the Host, Start a session links; composer choices request real backend presets when available | Read-only is refused if absent, instead of merely suppressing approvals. The legacy workspace/full approval mode remains compatible where those named presets are absent. Preset enforcement is owned by backend security. |
| Sandbox selection and status | Security: selected provider, source, declared capabilities, lifecycle/restart scope | Provider declaration does not establish actual workspace enforcement. **API gap:** no public admin snapshot of each workspace’s sandbox probe; the page explains that execution probes and fails closed. |
| MCP servers: install/create, edit, enable/disable, status, authentication, tools and removal | MCP & Skills embeds the existing management page and offers its standalone link; workbench resource settings keep current workspace scope | Live definitions apply next turn and are composition-filtered. Per-workspace operation remains on the existing resource surface. |
| Skills: inventory, installation/copy, trust, enable/disable, refresh, remove and root diagnostics | Existing Skills management in MCP & Skills and workbench settings | Live resource behavior is backend-owned, separate from pinned plugin code. |
| FDE gallery: data report, support triage, CRM assistant, contract review, operations runbook, device inspection | Examples reads backend-discovered FDE bundle descriptors; Review and install uses the existing capability/trust flow; Compose installed bundles leads to presets and session start | Empty gallery explains source-checkout discovery. Demonstration fixtures are not evidence of real business/device integration. Install → enable → compose → restart → session turn remains in the final gate. |
| Shared sessions, durable history, streaming, attachments, cancellation, follow-up/queued input | Existing conversation workbench and workspace picker | Preserved by this settings change. |
| Approvals, trace, recovery, diagnostics, session search/archive/fork/export | Existing workbench controls, trace and diagnostics panels | Backend owns authorization, effect receipts and session facts. |
| Frontend plugin panels, public slots, skins, theme/locale, Computer Use management | Existing client-module reconciliation, settings and workbench regions | Shared `@agnes/web-ui` primitives, tokens, CSP and skin hooks are preserved. |
| ask_user_question cards | Reserved in the existing conversation timeline / tool-result region | Owned by the conversation implementation; this change adds no card. |
| Deliverable cards | Reserved in the existing conversation timeline / tool-result region | Owned by the conversation implementation; this change adds no card. |
| Background-job cards | Reserved in the existing conversation timeline / tool-result region | Owned by the conversation implementation; this change adds no card. |
| Plan-mode cards | Reserved in the existing conversation timeline and composer status region | Owned by the conversation implementation; this change adds no card. |
| Child-agent cards | Reserved in the existing conversation timeline / tool-result region; provider metadata is on Providers | Owned by the conversation implementation; this change adds no card. |
| Headless, JSONL, replay, batch runs | Intentionally outside Web UI | Use the [headless guide](../guide/headless.md). |

## Admin glue

The launcher’s private Node SDK connection supplies these fixed HTTP routes, with exact Origin/Host checks, server-established grants and no-store responses:

- `GET /admin/api/runtime → RuntimeAdminSnapshot`: description-only `providers`, allowed `presets` and `localPluginFolders`; no provider factories, preset configuration, source bytes or credentials.
- `POST /admin/api/reload-local {}`: activation permission and recovery checks; requests the existing owner-configured watcher rescan. The response confirms the rescan request finished; plugin state remains the activation authority.
- The private daemon methods are `_agnes/v1/sessionSelection.runtime({})` and `_agnes/v1/sessionSelection.reloadLocal({})`. Browser SDK control-plane blocking and daemon grant checks cover the existing `sessionSelection` family.
- Existing loop/model defaults, bundle selection, preset-specific composition dump, package lifecycle and resource endpoints are reused. No Core/Host provider implementation is added.

The runtime catalog currently requires a production supervisor with configured local-plugin roots. An embedder without this fitted admin port gets an unavailable state, not a fabricated catalog.

## Browser acceptance

The explicit smoke tier is outside Vitest:

```sh
AGH_WEB_URL=http://127.0.0.1:PORT pnpm test:web-smoke
pnpm test:web-smoke --list
```

The runner uses installed/cached Playwright and cached Chromium; it never downloads a browser. `AGH_PLAYWRIGHT_PACKAGE` can select the Playwright package folder and `AGH_CHROMIUM_PATH` can select an existing Chromium executable. Output defaults to a temporary directory; `AGH_WEB_TEST_OUTPUT` can override it. Use an isolated synthetic home/server for mutations.

`tools/e2e-web/navigation.spec.ts` covers all seven pages in English and Simplified Chinese, provider sections, local-plugin controls, the creator entry and uncaught page errors. Stable `settings-nav-*`, `settings-page-*`, `providers-*`, `security-*`, `plugin-generations`, `local-plugins`, `reload-local-plugins`, `new-session-preset`, `bundle-order`, `config-dump` and `config-choice-sources` IDs supplement accessible names.

Full acceptance still requires the integrated runtime: plugin install/trust/enable/update/rollback, defaults and session choices, bundle/preset provenance, real sandbox refusal paths, MCP/Skills changes, all conversation cards, and an FDE bundle session turn. Navigation smoke alone does not establish delivery readiness.
