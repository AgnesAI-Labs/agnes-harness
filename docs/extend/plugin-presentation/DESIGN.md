# Plugin presentation proposal

English | [简体中文](DESIGN.zh-CN.md)

**Status: proposed; no runtime or UI implementation in this change.**

[Author guide](../README.md) · [Exact bilingual content](CONTENT.md)

## Goal and baseline

An administrator should understand a plugin's purpose, contributions, effective surfaces, origin and operating state within five seconds. The first screen leads with the business outcome. Technical identities remain visible in details.

At the inspected source revision `7b5271ffa`, all **37** manifests under `packages/base/extensions/*/agnes.extension.json` lack human-facing metadata. Of **126** package manifests under `packages/` and `examples/` (excluding dependencies and build output), **10** have npm descriptions: 10/70 package manifests and 0/56 example manifests. npm descriptions are neither a validated display contract nor localized. The earlier 6/97 count does not describe this revision.

`web-admin/src/admin/plugins/admin/views.tsx` specializes example names and summaries by package ID. `web-ui/src/locales/admin-list.ts` also specializes four official helper packages. Both tables must go when manifests supply the same information. Generic labels for categories, contribution types and status remain shared UI translations.

The seven package `kinds` (`tool`, `loop`, `model-adapter`, `mcp`, `skills`, `ui`, `bundle`) are not the provider-kind catalog. `extension-api/src/provider-kind.ts` includes policy, compaction, memory, persistence, sandbox, child agents, references and webhooks; feedback, intelligent UI and observability have separate public ports. Preserve these distinctions. A category is an editorial aid, not a new runtime kind.

Several of the 37 manifests have no-op extension entries; actual functionality lives in seams/providers. `sandbox` is not listed as a normal extension in the base package. A description must explain its role without claiming registrations or availability merely because a manifest exists.

## Public author metadata

Define one reusable `PluginMetadata` in protocol's extension-manifest schema and export its generated type through the public extension-api. Accept the same object in these author contracts:

- `agnes.extension.json.metadata` for an extension.
- `package.json.agnes.metadata` for a package overview, including bundles and provider-library examples.
- `package.json.agnes.plugins[].metadata` for a specific ordinary plugin row.

Row metadata overrides the package overview **as a complete metadata object**; an extension uses its own manifest metadata. A package card uses package metadata. Multi-row packages expand into named contribution rows; do not repeat a package summary as if it described each independent row. Built-in row declarations in `packages/base/package.json` must carry or publicly reference the associated extension's validated metadata. Copying values into Host or Web source is forbidden. A manifest with no runtime row is content inventory, not a fake active card.

```json
{
  "metadata": {
    "displayName": "Progress checks",
    "summary": "Detects repeated writes and stalled work, then requests revision or escalation within configured limits.",
    "description": "Checks execution for repetition, missing progress and unfinished plans. The selected repair policy can request another attempt, escalate or park the task; limits come from the session configuration.",
    "category": "agent-loop",
    "locales": {
      "zh-CN": {
        "displayName": "执行进度检查",
        "summary": "发现重复写入和停滞的执行，并按配置限制要求修正或升级处理。",
        "description": "检查重复执行、缺少进展与未完成计划。选定的修正策略可要求再次尝试、升级处理或暂存任务，次数限制来自会话配置。"
      }
    }
  }
}
```

The block is optional. When present, `displayName`, `summary`, `description` and `category` are required; `docsUrl` and `locales` are optional. Locales allow **only** `en` and `zh-CN`, each containing partial overrides of displayName, summary, description and docsUrl. Category does not vary by locale. Missing localized fields inherit the base value. Official and example content supplies complete English base text and Chinese text. Third parties need no translation to install.

| Field | Validation |
| --- | --- |
| displayName | 1–80 Unicode code points; trimmed, printable, single line |
| summary | 1–240 code points; trimmed, printable, single line; one sentence is editorial guidance |
| description | 1–1,200 code points; trimmed, printable, single paragraph |
| category | One stable enum value below |
| docsUrl | 1–2,048 code points; absolute HTTPS URL; no credentials or control characters |
| locales | At most two known locale keys; unknown fields rejected in every object |
| whole block | At most 24 KiB UTF-8 JSON, including localized values |

Categories: `agent-loop` (Agent Loop / Agent 执行), `tools` (Tools / 工具), `safety-approval` (Safety & Approval / 安全与审批), `memory-context` (Memory & Context / 记忆与上下文), `collaboration` (Collaboration / 协作), `integrations` (Integrations / 集成), `observability` (Observability / 可观测性), `ui` (UI / 界面), `developer` (Developer / 开发者). No category becomes `Uncategorized / 未分类`; do not guess it from ID. Existing kind filters remain available as a secondary technical filter.

Resolve a supported UI locale field-by-field from its override, then the base text. For absent metadata show the full ID, known kinds and **No description provided / 作者未提供用途说明**. Do not invent summaries from IDs, call a model, fetch remote docs or use a private list. Display author text as escaped text, without HTML/Markdown execution; documentation links require an explicit click with `noopener noreferrer`. Render base English when a translation is missing.

`package-manager/src/inspect.ts` validates package and row metadata before installation. `plugin-manifest.ts` accepts the new field; `extension-api/src/manifest.ts` continues to validate extension metadata via the shared schema. Catalog descriptors, contribution summaries, previews, lock entries and immutable package snapshots carry the validated metadata. Read it from the exact snapshot being displayed, including historical versions. Preserve public metadata in packed packages and agent candidates. Invalid present metadata refuses inspection/installation; absence remains valid. No new trust grant, loader behavior, configuration behavior or authorization path follows from metadata. A metadata edit changes ordinary package integrity naturally; existing trust/update review remains in force, while the metadata is excluded from the capability hash input.

This is an optional public-contract addition with no migration or compatibility shim. Generated declarations/validators/references must come from the protocol generator in implementation. Do not hand-edit generated files. Proposal documentation stays explicitly proposed until implemented.

## Derived contributions and appearances

Author copy answers **why**. Runtime-owned data answers **what exists and where it applies**. Use existing read APIs and projections; extend the existing plugin-tree read envelope with a bounded, read-only `presentation` projection where facts are not exposed today. Do not change canonical PluginRow, target hashes or generation selection to transport UI copy.

A backend projection has rows keyed by `(packageId, snapshotId, rowId)` plus generation/target identity. It includes validated metadata, verified origin, contributions, dependency references and inspection completeness. Projection items carry contribution kind, stable ID, owner row, optional display label, surfaces and evidence (`registered`, `configured`, `observed`). Each facet reports `known`, `unavailable` or `partial`; empty known differs from unknown. Reuse existing protocol response bounds (128 rows / contribution items per page); paginate detail contribution lists when larger, returning an explicit continuation cursor. Do not truncate and imply completeness. Browser-only facts merge only when their roster revision matches the same row/snapshot. Current and retained-version data never merge by package ID alone.

| Information | Existing authority / implementation anchor | Projection rule |
| --- | --- | --- |
| Tools | `host-extensions/src/ext-host/ports.ts` and Host generation tool catalog, stamped `ToolSource` | Count actual registered tool IDs by verified row owner; do not count capabilities.tools.names as active tools |
| Loops, policies, adapters, memory, compaction, persistence, sandbox, child agents, reference resolvers, webhook triggers | `host-common/src/assemble/provider-registry.ts`, public `ProviderCatalogEntry` (`sourcePackage`, kind, id/version, active, selectedFor, scope, restartRequired) | Reuse provider catalog; add owner row/snapshot identity to read projection when catalog only knows sourcePackage; registered and selected are separate |
| Seams and services | Verified row-mount provides/inject plus live Cordis services and `host-extensions/src/ext-host/services.ts` | Declarative `provide` is not active until mount checks export equality and registration succeeds; no-op rows show zero extension registrations |
| UI panels and tool cards | `web-client/src/registry.ts`, current roster + `actualSlots` already passed to PluginAdminPage | Use owned live slot registrations; distinguish registered from currently visible (another contribution may win the slot) |
| Settings | Public `settingsSections` registry; plugin-config read contract, `config-panel.tsx` and D3 configuration tab | Registered section links plus supported row configuration; a schema alone does not imply a custom settings page |
| Commands / Skills | `web-client/src/services-commands.ts` CommandService.list; Skill resource registry and existing slash catalog | Generic client commands remain commands; only actual slash entries become slash chips. Skills come from selected live resource registrations, not package kinds |
| Events | Live hook registrations, owned projection subscriptions and observed extension event types | Distinguish listens-to from emitted events; events are appended, not pre-registered. A capability.events flag is permission only; unavailable history means emission unknown |
| Surface pages | Existing `PluginAdminApi.surfaceLinks()` and deployed service grants | Link only a currently available mounted surface; declared surfaces are labeled configured |
| Dependencies | Package snapshot dependencies; runtime tree provides/inject graph, provider selections and composition origins | Separate npm dependency ranges from required services and selected providers; package-manager computes reverse edges from full inventory, not filtered cards |
| Dependents / impact | `package-manager/src/lifecycle.ts` assertNoReferences, current profile/generation/deployment references, durable pins | Reuse reference collection for read projection with operation context; current inventory blockers alone are not proof of no references |
| Trust and permissions | Existing capability/provenance review and inventory (`trusted`, capabilityHash, declaredCapabilities) | Author metadata cannot claim official origin, trust, permission or disable safety |

Surfaces use a small **generic contribution-kind/slot map**, never per-plugin ID text: tools/Skills/slash entries → chat; workbench slots → workbench; owned settings sections/config → settings; selected tool policy → approval flow; hooks, selected Loops, compaction, memory and telemetry → background execution (detail states their scope). Model adapters also affect chat; reference resolvers affect the composer; webhook providers affect trigger entry; skin presets affect appearance settings and the application when selected. The mapping explains a verified registration, not a guarantee it is selected in every session. Show `Available; not selected / 已提供，尚未选用` when appropriate, and `Not inspected / 尚未确认` for disabled/unloaded packages. Never import disabled/untrusted code simply to enumerate it. Author declarations stay in Permissions & trust or an explicitly labeled configured section.

Backend projection is computed from existing registries at their published generation; UI ownership is computed by the browser's live registry. Avoid a second persistent catalog or event history store. Capability review is reused, not interpreted as registration evidence. Provider-only, seam-only and official built-in rows need metadata as well as package cards. Preserve the existing Providers tab as a linked technical catalog, but give it the same metadata presentation so built-ins are discoverable without installing a package.

## Origin, state and disable impact

Separate **origin** from **installation source**: Official / Example / Third-party / Locally authored, plus folder/npm/git/tarball in technical details. Built-in origins follow Host-owned row provenance; examples follow trusted bundled catalog/source provenance. Never infer official/example from `agnes`/`community` namespaces or an author-controlled metadata flag. A reviewed local candidate can prove local authorship; an arbitrary folder install only proves local source and is labeled `Local source; author unverified`. This extra unknown state prevents a copied third-party folder being called locally authored. Official and example are separate filters and badges; samples are not official production defaults. Trust is a separate badge for this exact integrity/capability hash.

Cards show desired enabled/disabled, actual backend state, browser failure when relevant, and pins/retained sessions. A green enabled switch alone never means running. Known stale/offline facts retain the stale notice and disable dependent actions according to existing rules.

Do not display an absolute **safe to disable** promise. Show observable impact:

- `Referenced by … / 被…引用`: dependency/profile/provider/deployment blockers, with links.
- `Old sessions retain this version / 旧会话仍保留此版本`: pinned/bound session count; pins are not a blanket disable blocker when current lifecycle permits draining.
- `Restart required / 需要重启`: only the current provider lifecycle/restart result.
- `No blocking references found / 未发现阻塞引用`: only for a complete, current operation-specific backend reference result; explain which contributions new sessions lose.
- `Impact not confirmed / 停用影响尚未确认`: unavailable, partial or stale facts; never substitute zero counts.

A read-only impact projection factors reference collection out of existing lifecycle checks and preserves each operation's policy. Disable/remove are not interchangeable. The mutation still rechecks current facts and shows its existing blockers/error; no frontend green light overrides backend authorization. No new bulk disable, automatic pin release or dependency-removal action.

## List wireframe and flow

```text
Plugins                                       [Install from source]
[Installed] [Discover] [Providers] [Examples]
[Search name, purpose or contribution_______________]
[Category: All v] [Origin: All v] [Status: All v] [Kind v]

Support triage example             Example  Agent Loop       [Enabled]
Classifies sample support tickets and requests approval before
recording a simulated reply.
Provides  [Loop 1] [Tools 4] [Policy 1] [Skill 1] [Panel 1]
Appears   Chat · Workbench · Approval flow
Running · Trusted · Old version retained by 2 sessions
[Details]                                   [Enable for new sessions]

Progress checks                    Official  Agent Loop
Detects repeated writes and stalled work, then requests revision
or escalation within configured limits.
Provides  [Verifier] [Repair policy]    Appears Background execution
Selected for default sessions        [Details]

vendor/plugin                      Third-party  Uncategorized
No description provided
Kinds: tool    Provides: Not inspected    Installed · Not trusted
[Details]                                                 [Review]
```

Counts above are illustrative, not measurements of the named plugins. Details always list actual IDs. Use category **filtering**, not nine permanently expanded groups; it reduces page length and leaves origin orthogonal. All origins applies within the existing tab; do not add a combined route or duplicate a row that belongs to an expanded package. Built-ins absent from package inventory remain visible in Providers with the same purpose cards and a link from the installed view. Examples tab and Origin=Example clearly distinguish sample packages. Do not invent an installed package for a dormant manifest.

Search case-insensitively across ID, display name, summary, both supplied locales, actual tool/provider/Skill/command IDs and generic contribution labels. Category/origin/status/kind filters compose with AND; search tokens compose with AND across searchable fields. No matches offers Clear filters. Installed search uses current normalized inventory. Catalog search remains an offline backend query across enriched cached descriptors **before** pagination; client filtering of the first catalog page is insufficient. Disabled catalog entries search only declared contribution labels, explicitly shown as declarations. Search never loads plugins or contacts a marketplace.

Card heading is a details button. Switch/actions remain separate controls; do not nest interactive buttons in a card button. Show at most four provides chips and `+N`; summary wraps to two/three lines depending on width, full sentence remains accessible. On 375px, filters and cards stack, metadata wraps, actions have full labels and no horizontal scroll. IDs, hashes and long paths move into technical disclosure; permission failures and the no-description hint remain visible.

## Detail wireframe

```text
Support triage example                              [Close]
Example · Agent Loop · Running · Trusted
Overview | What it provides | Where it appears | Settings |
Permissions & trust | Versions & pins | Dependencies

Overview
Purpose sentence, short paragraph, explicit simulated scope, [Documentation]

What it provides
Loop: fde.support-triage@3.0.0  (registered / selected scope)
Tools: actual IDs and readable labels       Skill: actual Skill ID
Panel: actual owned workbench slot          Policy: actual policy ID

Where it appears
[Chat] [Workbench panel] [Approval flow] [Settings]
Current browser registration / selection / availability stated separately

Settings
Existing D3 schema form and configReload notice; links to registered sections

Permissions & trust
Existing CapabilityReview + ProvenanceReview, unchanged trust action

Versions & pins
Installed vs actual version; bound sessions, durable pins, existing release rules

Dependencies
Requires packages/services/providers…     Required by…
Disable impact: referenced by the selected preset; old sessions keep their code
[Disable for new sessions]                [Remove] (existing gating applies)
```

These are seven semantic sections with an in-dialog jump navigation, **not seven competing nested tabs**. Keep D3's existing Settings tab/form intact and route the Settings jump to it. Overview stays first; Permissions & trust and Dependencies are not hidden under Technical details. Initial detail load retains focus, Escape closes and restores the triggering heading; refresh never steals focus or resets a dirty config form. Read-only installations render explanations and available read links.

## Shared UI, accessibility and themes

Use `@agnes/web-ui`: extend PluginList/DetailContent, SettingsCard, SettingsToolbar, Field, SettingsInput, Select, Badge, Button, SettingsDetails and StateSwitch. Keep configuration, trust, candidate review and pins components in their current owners. External UI libraries stay in web-ui. Reuse tokens, spacing, border/radius and semantic status colors; no new private palette or CSS that bypasses skin hooks. Text labels accompany every colored status.

Follow the merged [Web UI consistency contract](../../develop/ui-consistency.md): SettingsPage owns one localized header and page actions; panels do not repeat that title. Use SettingsList/SettingsRow or the existing PluginList, with technical fields in SettingsDetails rather than nested property cards. Loading/empty/error/success states use SettingsState and preserve context and drafts. Existing native dialog hosts retain their controller and shared content; cancel precedes the primary action. Category/origin controls use SettingsSelect for native semantics or Select only when rich search is needed. Preserve all current IDs, aria relationships, IME behavior and skin hooks.

Use the existing spacing/type/control tokens in `packages/web/public/styles/01-tokens.css` and the semantic bridge in web-ui. Prefer --s8/--s12 within rows, --s16/--s24 between sections and --s24/--s32 page insets. Use --agnes-input-surface and --agnes-status-* with both theme variants, honor reduced motion and avoid a second palette. Required narrow review is 390px; the 375px layout above is an additional design target. Embedded and standalone pages share the same header/body/action rhythm.

Provide en/zh-CN translations for generic chrome, labels and empty/error/unknown states. Use stable IDs (`plugin-category-filter`, `plugin-origin-filter`, `plugin-summary`, `plugin-provides`, `plugin-appearances`, `plugin-dependencies`, `plugin-disable-impact`) plus package/row/version data attributes. Fields have visible labels; details have a heading; chips are readable static text; all controls have keyboard access and focus indicators. Light and dark screenshots must show readable summary text, source labels and disabled states without relying on color alone.

## Current page, described from source

`admin/views.tsx` renders the SettingsHub navigation, candidate inbox and generation-drain notice, then a search field, KindFilter, source-install action and plugin-creator action above PluginList. Category and origin filters do not exist. `admin/page.tsx:filteredInstalled` searches ID, version and contributionText; it does not search a general purpose summary.

`web-ui/src/admin-list.tsx` renders one installed package article with a heading button, kind/status metadata, an optional description, version information, a StateSwitch and expandable technical details. Four official helpers obtain names/descriptions from UI locale keys. Recognized example names use the settings locale map; FDE entries share one broad summary rather than their individual business purpose. Other entries can display their technical package ID with no description and no missing-description explanation. Source and integrity are available through technical details, not a clear verified origin badge.

Details in `admin/views.tsx:renderDetailPluginView` show source, integrity, contribution text, actual browser slots, failure, cleanup and rollback target, plus capability/provenance review and the D3 configuration wrapper. The page has useful lifecycle facts but no unified overview of actual provides, appearances or operation-specific disable dependencies. These statements describe inspected source, not a passed behavior check.

Product builds are prohibited during development. Before and after **real** screenshots are deferred to pre-handoff acceptance; Phase A uses the source description and wireframes. Capture them then through the shared lock, one browser/page at a time, in both locales/themes at desktop and 390px. No screenshot is required to review this proposal.

## Implementation and deferred verification

1. Shared optional schema/type and validators; extend package/row/extension metadata parsing and exact-snapshot projections. Update author docs in both languages.
2. Move all official and example copy in CONTENT.md into author manifests, including version/failure fixtures and the four official helper packages. Annotate remaining registered official rows, including defaults without extension manifests. Delete ID-specific name/description locale keys and regex presentation special cases; shared chrome remains translated.
3. Add the smallest read projection needed for registrations, origin, complete dependency/dependent references and operation-specific impact. Keep runtime target identities and authorization unchanged. Merge live browser registry facts by exact identity.
4. Extend shared card/detail presentation and admin search/filter models; retain candidate, trust, pins, install and D3 settings behavior.
5. Extend nearest existing protocol/package-manager/admin model tests. Add one registered Web spec for purpose/search/filter/detail behavior with a metadata-free third party and a retained version. **Write but do not run** it during development. Defer real before/after screenshots to pre-handoff acceptance under the lock.

Meaningful cases: missing metadata; zh fallback; blank/oversized/unknown fields and unsafe docsUrl refused; identical contract for third parties; validated snapshot metadata survives preview/install/catalog/retained versions; no-op/disabled rows do not report fabricated provides; wrong browser generation cannot contribute; generic commands are not mislabeled slash commands; event permission is not emission; row ownership in a multi-row package; registered vs selected providers; dependency reversal from full inventory; stale/partial impact does not promise zero references; search finds a summary and actual tool ID beyond the first catalog page; AND filters; dirty D3 form survives refresh. The Web spec uses synthetic data and stable roles/IDs.

No tsc, Vitest, builds, Web specs, CI or guards are run in the proposal/development phase. Source reading, metadata enumeration and diff review are the evidence for Phase A. Global verification later owns executable results. Public docs must not claim the proposed API is shipped.
