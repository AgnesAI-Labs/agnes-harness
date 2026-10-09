# Web UI capability coverage

English | [简体中文](ui-coverage.zh-CN.md)

This inventory covers the current plugin architecture, shared workbench and settings controls. It records available controls separately from backend support and browser acceptance. The product remains a developer preview. See [architecture](architecture.md), [provider architecture](architecture-plugins.md), [source map](source-map.md) and [Web guide](../guide/web.md).

One settings shell owns group navigation, layout, keyboard tabs and `?settings=<section-id>` deep links. `/admin/plugins` redirects there. Groups are Models & accounts, Agent, Plugins, Skills, MCP, Tools & search, Automation, Security, Diagnostics, History & archive, Computer Use and General. Native accounts/resources retain their controllers through registry bridges. See [registry APIs](ui-extension-registries.md) and [terminology](ui-glossary.md).

| Architectural capability | UI exposure and operation | Limits / acceptance evidence still needed |
| --- | --- | --- |
| Plugin kinds: tool, loop, model adapter, MCP, Skills, UI, bundle | Plugins: kind badges and filter, installed/discover search, detail view | Kinds are package declarations; the provider catalog describes the registered runtime provider kinds separately. |
| Real lifecycle: installed, enabled, active, draining, restart-required, failed | Plugins: backend state badges, draining session counts, failure reasons and repair hints; browser module state remains separate | No optimistic activation success; operation polling and reconciliation confirm changes. |
| Review before install | Source check and catalog review show source, integrity, license, capability hash, declared permissions, warnings and blockers | Install and trust/enable keep separate confirmation gates. Backend plugins run trusted code. |
| Install npm, path/folder, tgz/archive, Git, HTTPS archive and workspace extension | Plugins: Install from source; folder uses `path`, archive uses `file`, Git uses `git` | Backend source validation determines supported references. Credentials must never be pasted into a source. Local scan references are owner-generated. |
| Trust review and enable / disable, update, rollback, remove | Existing plugin detail actions and confirmations | Existing package admin permission and recovery checks apply to all operations. |
| Code generations and session pins | Plugins: Code generations lists ID, actual state, packages and bound-session count; draining summary and orphan-pin release | Session code stays pinned across close/resume. A new default never silently changes an existing binding. |
| Publication status per container | Plugins: publication operation and Applied/Failed status for each composition hash, with retry-same-input recovery hint | Reads sanitized Host publication facts; no container exception text or credentials. |
| Explicit session migration | Plugins / Code generations: enter a session key, confirm migration to current plugins, view previous/new generation; backend refusal preserves bindings | Wired to `PluginAdminApi.migrateSession(sessionId)` (`POST /admin/plugins/api/sessions/migrate`). The backend owns busy checks, compatibility, idempotent receipts and refusal without rebinding. |
| Local plugin folders and hot reload | Plugins: Local plugins shows actual home/workspace roots; Rescan local plugins requests the existing watcher | Rescan completion is not activation success: inspect resulting plugin states. Automatic watcher reload and historical session coexistence need the integrated browser gate. |
| Plugin creator | Plugins: Ask the agent to build a plugin opens a new task with a reviewable prompt | Draft is not sent automatically. Creator tooling must be enabled in the profile to scaffold through the agent. |
| All provider kinds: loop, model-adapter, compaction, persistence, sandbox, tool-runtime, tool-policy, child-agent, memory | Providers: every kind has a section, even when empty; identity/version, source, capabilities, selection scope, lifecycle scope and restart requirement | Reads the real combined Host registry. Active means selected for the reported scope, not running-session count. Startup-only kinds are configured through profile/bundle contracts. |
| Agent Loop admin default | Agent Loop & Models: select exact ID/version or inherit profile; save with revision check | Missing/ambiguous versions are rejected by the backend. |
| Loop for each new session; existing session identity | Composer: new-session loop picker; session information shows persisted loop | Loop identity is immutable. Resume retains the bound version; legacy missing identity is not replaced by today’s default. |
| Model adapter default, model catalog, account/route selection | Agent Loop & Models: adapter/model default; Configure model accounts opens existing account settings. Composer: per-session model/thinking/context controls | Wire API and credentials remain owned by the model configuration backend. Account changes follow backend effect/restart status. |
| Bundles: compose and order | Bundles & Presets: installed bundle catalog with source package, ordered checkboxes, Move up/down, revision-checked save | Desired bundle changes require the effect reported by the backend (currently restart-required). UI does not claim a running Host changed. |
| Select preset per new session | Bundles & Presets: allowed preset list with Start a session; composer has a permission preset control inside the Agent chip | Only Host-allowed presets are offered. A selected bundle contributes presets after backend assembly. |
| Bundles for each new session | Composer: ordered bundle selection inside the Agent chip; bundle settings also opens a new task with the selected bundle | `session.new({bundles})` applies session bundles after deployment, preset and admin layers; explicit Loop wins. Host validates and pins the composition; resume retains it. |
| Configuration dump and provenance | Bundles & Presets: choose preset, Explain desired composition, readable table of choice/layer/source plus full safe JSON dump and live session bindings | Static desired configuration and live sessions are explicitly distinguished. Secret/config snapshots are not exposed. |
| Permission presets: read-only / workspace-write / full-access | Security: Host availability and Start a session links; admin defaults include permission preset; new drafts inherit admin then profile defaults and display the inherited preset | Read-only is refused if absent, instead of merely suppressing approvals. The legacy workspace/full approval mode remains compatible where those named presets are absent. Preset enforcement is owned by backend security. |
| Sandbox selection and status | Security: latest platform L1 probe, permission preset requirements, and open-session canonical workspace path, provider, readiness, measured enforcement and policy digest | `Host.securityStatus()` reads existing probe/binding facts; refresh runs no probe command. Closing or unmeasured workspaces never imply confinement. |
| MCP servers: install/create, edit, enable/disable, status, authentication, tools and removal | Dedicated MCP section in the common shell; original controller keeps workspace scope | Live definitions apply next turn and are composition-filtered. Per-workspace operation remains on the existing resource surface. |
| Skills: inventory, installation/copy, trust, enable/disable, refresh, remove and root diagnostics | Dedicated Skills section in the common shell | Live resource behavior is backend-owned, separate from pinned plugin code. |
| FDE gallery: data report, support triage, CRM assistant, contract review, operations runbook, device inspection | Examples always lists 2 official Loops, 12 FDE bundles and 3 community examples from packaged entries, outside a checkout too. Install directly starts capability review, installation, trust and enable | Packaged sources use a fixed allowlist and the normal installer. Demonstration fixtures do not establish real business/device integration. Activation/restart requirements remain backend-owned. |
| Shared sessions, durable history, streaming, attachments, cancellation, follow-up/queued input | Existing conversation workbench and workspace picker | Available in the session workbench. |
| Approvals, trace, recovery, diagnostics, session search/archive/fork/export | Existing workbench controls, trace and diagnostics panels | Backend owns authorization, effect receipts and session facts. |
| Frontend plugin panels, public slots, skins, theme/locale, Computer Use management | Existing client-module reconciliation, settings and workbench regions | Shared `@agnes/web-ui` primitives, tokens, CSP and skin hooks are preserved. |
| ask_user_question cards | Native EN/zh question form stays visible after the turn settles and process history collapses; option/free-text/submit IDs | Multiple-choice submission and answered state verified through the real adapter with synthetic session ports; real session acceptance remains. |
| Deliverable cards | Authorized file links stay outside collapsed process history; open/download IDs and artifact hash | Browser download and native card cleanup tested; real artifact authorization remains a backend gate. |
| Background-job cards | Existing `job_list`, `job_output`, `job_kill` result cards and background shell receipts remain visible; stable card/detail IDs | The tool-call status is separate from the captured job status/output in details. No polling, kill or lifecycle state is fabricated by the layout. |
| Plan-mode cards | `/plan` composer command and shared live approval region; plan preview and backend-supplied allow/reject actions have stable IDs | Pending approval stays outside collapsed process history. Browser fixture covers allow/reject presentation; real write/exec gating remains backend-owned. |
| Child-agent cards | Existing `subagent_*` result cards remain visible with stable detail IDs; provider metadata stays on Providers | Child identity/status comes from backend result text; tool completion never implies child completion. Real continuation/interrupt/cancel remains in the final gate. |
| Headless, JSONL, replay, batch runs | Intentionally outside Web UI | Use the [headless guide](../guide/headless.md). |

## Maintained merge gate

`pnpm e2e:web` builds or validates a reusable local build, starts the real daemon/Web launcher from
the repository root with a fresh home, and runs the SDK and role/test-ID UI suites offline with
cached Chromium. The UI matrix covers every settings section in en/zh-CN and light/dark; mutation
flows verify persisted results through public SDK/CLI. Translation keys, axe violations, console
errors and page errors fail. Reviewed screenshot comparisons use the declared ready manifest,
0.2% pixel tolerance and no automatic baseline blessing. The current ready-screen manifest, including
plugin-kind rows and grouped version selection, declares reviewed macOS and Linux baselines. See the [gate instructions](../../tools/e2e-web/README.md)
for coverage, artifact paths, the required CI check and local baseline review.

## Admin glue

The launcher’s private Node SDK connection supplies these fixed HTTP routes, with exact Origin/Host checks, server-established grants and no-store responses:

- `GET /admin/api/runtime → RuntimeAdminSnapshot`: description-only `providers`, allowed `presets` and `localPluginFolders`, plus optional sanitized `publication`; no provider factories, preset configuration, source bytes or credentials.
- `POST /admin/api/reload-local {}`: activation permission and recovery checks; requests the existing owner-configured watcher rescan. The response confirms the rescan request finished; plugin state remains the activation authority.
- The private daemon methods are `_agnes/v1/sessionSelection.runtime({})` and `_agnes/v1/sessionSelection.reloadLocal({})`. Browser SDK control-plane blocking and daemon grant checks cover the existing `sessionSelection` family.
- Existing loop/model defaults, bundle selection, preset-specific composition dump, package lifecycle and resource endpoints are reused. No Core/Host provider implementation is added. The adapter catalog now accepts optional `wireApi` (legacy `api` fallback) and matches configured models using the registered wire API.

Official examples use a read-only packaged catalog; local workspace discovery remains separate. The runtime catalog requires a production supervisor. An embedder without this fitted admin port gets an unavailable state, not a fabricated catalog.

## Browser acceptance

The explicit smoke tier is outside Vitest:

```sh
AGH_WEB_URL=http://127.0.0.1:PORT pnpm test:web-smoke
pnpm test:web-smoke --list
```

The runner uses the repository-pinned Playwright and an installed Chromium; it never downloads a browser. `AGH_CHROMIUM_PATH` can select an existing Chromium executable. Output defaults to a temporary directory; `AGH_WEB_TEST_OUTPUT` can override it. Use an isolated synthetic home/server for mutations.

`navigation.spec.ts` covers both locales, provider kinds, the legacy route alias and narrow keyboard-scrollable tables. `ui-quality.spec.ts` covers home, active demo sessions/cards, every settings destination and account/source-install dialogs at 1440×900 and 1280×800, light/dark and en/zh. Each screen is checked for unresolved locale keys, viewport overflow and uncaught errors. `locale-catalogs.test.ts` checks recursive en/zh key parity across the four frontend packages and the resource settings package.

Set `AGH_UI_AXE=1` to audit every captured 1440-pixel screen in both themes/locales for WCAG A/AA violations. Set `AGH_UI_REPORT` for screenshots, `AGH_UI_WORKSPACE` for a synthetic workspace and optional `AGH_UI_DELIVERABLE` for a synthetic file. `examples.spec.ts` requires `AGH_INSTALL_EXAMPLES=1` against a disposable real daemon: review, installation, trust/enable, dialog language switching and new-session Loop selection. `AGH_MIGRATION_SESSION` enables migration acceptance.

Stable navigation IDs/roles are in [registry APIs](ui-extension-registries.md). Existing provider, security, generation, publication, migration and composition IDs remain. Composer IDs: `composer-agent`, `agent-options`, `new-session-loop` or `new-session-loop-readonly`, `new-session-bundles`, `new-session-preset` or `new-session-preset-readonly`. Single installed choices use read-only presentation; inherited choices show resolved name/version and source.

Session information is isolated in `SessionToolsPanel`, consuming backend-owned `SessionCapabilitySet`: effective selections, enabled/disabled capabilities and source/rule provenance. A legacy tool-groups fallback supports older responses. UI does not change this shape or authorization decisions. Sandbox refusal, update/rollback, resource mutation and business integration acceptance remain backend gates.

Session creation SDK adds `bundles?: readonly string[]`, carried through ACP `ai.agnes.harness` metadata. At most 64 unique IDs from the already available bundle catalog; no package sources/config. Unknown bundles are refused by Host. Runtime catalog adds optional `bundles: {id,sourcePackage}[]`.

The runtime admin catalog adds optional `security: RuntimeSecurityStatus`, aggregated across composition containers and code generations. It exposes the most recent platform probe, allowed presets’ normalized sandbox/approval/network requirements and workspace enforcement snapshots; no seams, factories, execution authority, config or credentials.

Conversation fixtures use production components/styles and synthetic session/resource ports. Real-daemon demo turns additionally exercise question/deliverable surfaces and job cards. The conversation fixture verifies job/child disclosures and plan allow/reject presentation; `question-surfaces.spec.ts` mounts production surface forms to cover shared drafts, submissions, pending recovery, stale revisions and refusals; they do not establish backend authorization. Each delivery report records actual commands/results.

## Conversation layout acceptance

After building Web assets, start the isolated component fixture:

```sh
pnpm --filter @agnes/web build
node tools/e2e-web/serve-conversation-fixture.mjs
# Use the printed loopback URL for both variables:
AGH_WEB_URL=http://127.0.0.1:PORT AGH_CONVERSATION_FIXTURE_URL=http://127.0.0.1:PORT pnpm test:web-smoke conversation.spec.ts
```

Stable IDs: `ui-surface-<id>`, `ui-form-<id>`, `ui-action-<id>`, `ui-option-<field>-<index>`, `ui-free-<field>`, `background-job-card`, `child-agent-card`, `tool-detail-toggle`, `tool-detail-text`, `turn-process-toggle`, `plan-approval-card`, `approval-card`, `approval-preview`, `approval-action`. Scope repeated IDs by `[data-node-id]`, `[data-surface-id]` or `[data-tool-name]`. Approval actions retain their backend identity in `data-approval-action`; never select by position. The native job and child surfaces show existing tool results rather than introducing a new management protocol.

Additive shared presentation contracts: `ConversationMessagesProps.keepNodeVisible?: (node: UINode) => boolean` and `ApprovalView.kind?: 'plan'`. Existing consumers keep their default process-folding behavior. No protocol, provider or authorization API changed.

Set `AGH_UI_ISOLATED=1` to start a fresh real daemon and synthetic workspace for each matrix case; it also supplies a synthetic deliverable automatically.

## Schema configuration contract

See [configuration UI](../extend/configuration-ui.md). Search and child-engine controls retain existing IDs and handlers; MCP reuses shared reference validation within its managed creation flow. Sandbox/compaction/persistence form declarations derive from public generated schemas and accept authoritative caller-owned values/adapters. The catalog does not expose private configuration. A registered declaration owns loading/retry, revision preservation and resource-scoped cancellation.

Stable IDs: `<declaration.testId>`, `<declaration.testId>-form`, `search-edit-provider`, `search-endpoint`, `search-max-results`, `search-timeout`, `search-rate`, `child-engine-<engine>-<field>`, `provider-<kind>-config`. Discover versions share one card per package; `plugin-other-versions` and `plugin-version-picker` are scoped by `.plugin-row[data-plugin-id]`. Selecting a version changes the source used by inspection and normal installation review. Installed releases remain separate.

## First-run acceptance

`first-run.spec.ts` starts the real daemon through the root `agnes.mjs` launcher with a fresh private home. Eight locale/theme/viewport cases complete welcome, native account test/save against a loopback provider, default-model selection, the registered examples page, a first task and a reload. It also verifies a failed home check, non-blocking banner, registry diagnostics, refresh and dismissal. `first-run-guide` exposes `data-step`; stable IDs include `first-run-add`, `first-run-account`, `first-run-model`, `first-run-next`, `first-run-skip`, `first-run-examples`, `doctor-notice`, `doctor-panel`, `diagnostics-doctor-run`, `doctor-probe-accounts` and `doctor-check-<id>`. New screenshots retain the existing platform-specific tolerance and zero-retry baseline gate, unresolved-key scan and WCAG A/AA checks.

The screenshot helper normalizes changing disk-space numbers and checkout names, retaining localized sentences, visible folder labels, controls and layout.

Runtime self-checks are the first block of Diagnostics, with no General sub-tab. The first-run modal owns a dimmed, blurred backdrop and contains its save notice. Visual normalization preserves a visible workspace folder label.

## File memory acceptance

Agent → Memory offers off/ask/automatic access and a Markdown editor with exact revision checks, caps and last-writer metadata. `memory.spec.ts` exercises ordinary tool writes, new-session context, human edits, editor conflicts, off read/write/edit refusal and shell/symlink isolation through the real daemon and supported SDK. Four locale/theme cases use overview and editor baselines on each platform with axe and unresolved-key checks. Stable IDs: `memory-panel`, `memory-workspace`, `memory-mode`, `memory-open`, `memory-content`, `memory-save`, `memory-reload`, `memory-error`, `memory-size`, `memory-writer`. See [file memory](../guide/memory.md) for approval and privacy boundaries.

Memory settings load independently of the runtime catalog. The capacity sentence uses locale-formatted KB and line limits; `memory-actions` groups save/reload in the shared responsive toolbar.

Only sections consuming the runtime catalog show its refresh action; independently loaded settings use their own service states. Settings, search, memory and MCP fields share `--agnes-input-surface`. The existing `ui-gate.spec.ts` matrix checks independent section actions and plain-text MCP credential hints alongside field consistency and empty candidate visibility.

Workspace registration derives display names from canonical directories, falling back to the full path for roots or whitespace-only basenames. The shared browser workspace picker and SDK runtime fixture assert named registrations; the candidate-authoring flow checks both the catalog and sidebar. Workspace resolver, catalog persistence and navigation tests cover the corresponding contract, including POSIX and Windows label fallbacks. Screenshot normalization preserves workspace labels.
