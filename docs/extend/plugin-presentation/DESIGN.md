# Plugin presentation proposal

English | [简体中文](DESIGN.zh-CN.md)

**Status: Phase A approved; simplified Phase B implemented, awaiting the shared acceptance run.**

The lead approved the metadata contract and content on 2026-10-10. Phase B keeps the optional contract, category/search cards and six detail sections. It uses only today's readable catalogs/registries and a small `PackagePresentation` read field. Evidence levels, observed events, new pagination, dependency/dependent graphs and disable-impact analysis are deferred; existing blockers/pins remain authoritative. Builds, tests and screenshots have not been run during development.

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

`package-manager/src/inspect.ts` validates package and row metadata before installation. `plugin-manifest.ts` accepts the new field; `extension-api/src/manifest.ts` continues to validate extension metadata via the shared schema. Catalog descriptors, previews, lock entries and immutable package snapshots carry validated package metadata; the read-only row presentation carries row metadata. Read it from the exact snapshot being displayed, including historical versions. Preserve public metadata in packed packages and agent candidates. Invalid present metadata refuses inspection/installation; absence remains valid. No new trust grant, loader behavior, configuration behavior or authorization path follows from metadata. A metadata edit changes ordinary package integrity naturally; existing trust/update review remains in force, while the metadata is excluded from the capability hash input.

This is an optional public-contract addition with no migration or compatibility shim. Generated declarations/validators/references must come from the protocol generator in implementation. Do not hand-edit generated files. The bilingual author guide documents the implemented contract.

## Derived contributions and appearances (simplified Phase B)

`PackagePreview`, `PackageInstalledDescriptor` and `PackageCatalogDescriptor` have an optional, read-only `presentation` field. It contains `rows` (ID, optional author metadata/source ID and whether a config schema is present), plus backend-derived `origin` on displayed inventory/catalog rows. Package-manager reads the public declarations from the exact inventory directory, without importing code. Row text is author purpose; it is displayed separately from runtime contributions. The field is excluded from runtime targets, capability hashes and activation decisions. It is computed rather than persisted as a second catalog.

The admin makes optional reads through existing `runtime()` and `composition()` endpoints. A small ephemeral `PluginPresentation` combines these with the existing browser slot callback and surface links. A missing read does not prevent inventory from rendering. The model never turns `capabilities.tools.names`, `events` or package `kinds` into registered contributions.

| Information | Reused source | Presentation |
| --- | --- | --- |
| Tools | Existing composition session `toolGroups`, built from the real source-stamped tool catalog | Deduplicate IDs owned by this package/public bundled extension source; exclude sessions whose readable package pin differs from the displayed revision |
| Loops / policies / provider kinds | `RuntimeAdminSnapshot.providers`, the existing `ProviderCatalogEntry` projection | Match `sourcePackage`; show provider ID, selection and lifecycle scope; do not combine a known different actual package integrity with current inventory |
| Bundles | Existing runtime bundle catalog | Match sourcePackage; installing a bundle does not select it |
| Panels / settings slots | Existing `actualSlots(packageId)` callback | Derive chat/workbench/settings/approval locations from generic slot names; do not infer which competing panel wins |
| Configuration | Verified ordinary row `configSchema` presence in `presentation.rows` | Settings chip and section; editing stays in the existing configuration tab, with drafts retained |
| Packaged Skills / skins | Existing verified inventory contribution descriptors | Show available packaged resource/theme IDs without claiming session selection |
| Plugin pages | Existing `surfaceLinks` feed | Show only readable mounted surface IDs/links |
| Trust / permissions / versions | Existing inventory, CapabilityReview, ProvenanceReview, generation summary and rollback facts | Reuse the current status and blockers/pins; author text cannot change authority |

The global `settingsSections` registry currently has no per-package owner. It is not attributed to a plugin by guessing its ID. Settings slots and schema support supply only the facts already readable with ownership. Slash-command and event registration ownership are likewise not invented from author text.

Generic mappings: tools/Skills/bundles → chat; workbench slots → workbench; configuration/settings slots → settings; policies/approval slots → approval flow; Loops, context/storage/execution providers and telemetry → background; skin descriptors → appearance settings/application. These describe available contributions; selection and slot placement can vary. Missing registration data displays “Registrations are not currently available to inspect”, rather than claiming zero.

No evidence levels, observed-event collection, new pagination, new owner/snapshot instrumentation or dependency/disable analysis are introduced. Those extensions remain on the external hardening backlog.

## Origin, state and disable impact

Separate **origin** from **installation source**: Official / Example / Third-party / Locally authored, plus folder/npm/git/tarball in technical details. Built-in origins follow Host-owned row provenance; examples follow trusted bundled catalog/source provenance. Never infer official/example from `agnes`/`community` namespaces or an author-controlled metadata flag. A reviewed local candidate can prove local authorship; an arbitrary folder install only proves local source and is labeled `Local source; author unverified`. This extra unknown state prevents a copied third-party folder being called locally authored. Official and example use separate badges and the existing examples shelf; samples are not official production defaults. Trust is a separate badge for this exact integrity/capability hash.

Cards show desired enabled/disabled, actual backend state, browser failure when relevant, and pins/retained sessions. A green enabled switch alone never means running. Known stale/offline facts retain the stale notice and disable dependent actions according to existing rules.

Do not display an absolute **safe to disable** promise. Simplified Phase B preserves the existing blocker sections, old-version generation summary, rollback target and pin actions as they are. Dependencies, reverse references and operation-specific read-only impact analysis are deferred; no new green light overrides the existing backend checks.

## List wireframe and flow

```text
Plugins                                       [Install from source]
[Installed] [Discover] [Providers] [Examples]
[Search name, purpose or contribution_______________]
[Category: All v] [Kind v]

Support triage example             Example  Agent Loop       [Enabled]
Classifies sample support tickets and requests approval before
recording a simulated reply.
Provides  [Loop 1] [Tools 4] [Policy 1] [Skill 1] [Panel 1]
Running · Trusted · Old version retained by 2 sessions
[Details]                                   [Enable for new sessions]

Progress checks                    Official  Agent Loop
Detects repeated writes and stalled work, then requests revision
or escalation within configured limits.
Provides  [Actual readable contribution types]
Selected for default sessions        [Details]

vendor/plugin                      Third-party  Uncategorized
No description provided
Kinds: tool    Provides: Not inspected    Installed · Not trusted
[Details]                                                 [Review]
```

Counts above are illustrative, not measurements of the named plugins. Category and existing kind filters apply to the current package list. Each package card shows its metadata, source, existing state/trust badges and readable contribution counts. Multi-row author purposes are available in the Overview disclosure. Manifest-only entries do not become active cards.

Search is a case-insensitive phrase match across ID, version, display name, summary, both supplied locales, row purposes, contribution IDs and readable registered IDs/translated contribution labels. Search, category and kind compose with AND. Catalog queries search bilingual metadata and row/contribution IDs in existing cached descriptors before the existing pagination; category/kind filtering remains on loaded catalog rows. No new pagination or remote browsing is introduced.

The heading button opens details. Existing switch/actions remain separate controls. Provides chips wrap with shared spacing, and summaries remain fully readable. Long IDs/hashes/source paths stay in technical disclosure. Existing loading, empty, recovery and failure states are retained. Narrow-screen layout and light/dark readability still require the shared acceptance run.

## Detail wireframe

```text
Support triage example                              [Close]
Example · Agent Loop · Running · Trusted
Overview | What it provides | Where it appears | Settings |
Permissions & trust | Versions & pins

Overview
Purpose sentence, short paragraph, explicit simulated scope, [Documentation]

What it provides
Loop: fde.support-triage@3.0.0  (registered / selected scope)
Tools: actual IDs and readable labels       Skill: actual Skill ID
Panel: actual owned workbench slot          Policy: actual policy ID

Where it appears
[Chat] [Workbench panel] [Approval flow] [Settings]
Locations derived from readable contributions; selection/placement may vary

Settings
Configuration availability; editing remains in the existing D3 settings tab

Permissions & trust
Existing CapabilityReview + ProvenanceReview, unchanged trust action

Versions & pins
Installed vs actual version; bound sessions, durable pins, existing release rules

Existing blockers and pins remain below the purpose sections.
[Disable for new sessions]                [Remove] (existing gating applies)
```

These are six semantic sections in the existing scrollable dialog. Keep D3's existing configuration tab/form intact. Overview stays first; Permissions & trust stays visible; source, integrity, browser slots and rollback facts use Technical details in Versions & pins. Initial detail load retains focus, Escape closes and restores the triggering heading; refresh never steals focus or resets a dirty config form. Read-only installations render explanations and available read links.

## Shared UI, accessibility and themes

Use `@agnes/web-ui`: extend PluginList/DetailContent, SettingsCard, SettingsToolbar, Field, SettingsInput, Select, Badge, Button, SettingsDetails and StateSwitch. Keep configuration, trust, candidate review and pins components in their current owners. External UI libraries stay in web-ui. Reuse tokens, spacing, border/radius and semantic status colors; no new private palette or CSS that bypasses skin hooks. Text labels accompany every colored status.

Follow the merged [Web UI consistency contract](../../develop/ui-consistency.md): SettingsPage owns one localized header and page actions; panels do not repeat that title. Use SettingsList/SettingsRow or the existing PluginList, with technical fields in SettingsDetails rather than nested property cards. Loading/empty/error/success states use SettingsState and preserve context and drafts. Existing native dialog hosts retain their controller and shared content; cancel precedes the primary action. The category control uses SettingsSelect for native semantics or Select only when rich search is needed. Preserve all current IDs, aria relationships, IME behavior and skin hooks.

Use the existing spacing/type/control tokens in `packages/web/public/styles/01-tokens.css` and the semantic bridge in web-ui. Prefer --s8/--s12 within rows, --s16/--s24 between sections and --s24/--s32 page insets. Use --agnes-input-surface and --agnes-status-* with both theme variants, honor reduced motion and avoid a second palette. Required narrow review is 390px; the 375px layout above is an additional design target. Embedded and standalone pages share the same header/body/action rhythm.

Provide en/zh-CN translations for generic chrome, labels and empty/error/unknown states. Use stable IDs (`plugin-category-filter`, `plugin-summary`, `plugin-provides`, `plugin-appears-detail`) plus package/row/version data attributes. Fields have visible labels; details have a heading; chips are readable static text; all controls have keyboard access and focus indicators. Light and dark screenshots must show readable summary text, source labels and disabled states without relying on color alone.

## Current page, described from source

`admin/views.tsx` renders the SettingsHub navigation, candidate inbox and generation-drain notice, then a search field, KindFilter, source-install action and plugin-creator action above PluginList. Category and origin filters do not exist. `admin/page.tsx:filteredInstalled` searches ID, version and contributionText; it does not search a general purpose summary.

`web-ui/src/admin-list.tsx` renders one installed package article with a heading button, kind/status metadata, an optional description, version information, a StateSwitch and expandable technical details. Four official helpers obtain names/descriptions from UI locale keys. Recognized example names use the settings locale map; FDE entries share one broad summary rather than their individual business purpose. Other entries can display their technical package ID with no description and no missing-description explanation. Source and integrity are available through technical details, not a clear verified origin badge.

Details in `admin/views.tsx:renderDetailPluginView` show source, integrity, contribution text, actual browser slots, failure, cleanup and rollback target, plus capability/provenance review and the D3 configuration wrapper. The page has useful lifecycle facts but no unified overview of actual provides, appearances or operation-specific disable dependencies. These statements describe inspected source, not a passed behavior check.

Product builds are prohibited during development. Before and after **real** screenshots are deferred to pre-handoff acceptance; Phase A uses the source description and wireframes. Capture them then through the shared lock, one browser/page at a time, in both locales/themes at desktop and 390px. No screenshot is required to review this proposal.

## Implementation and deferred verification

The optional public contract, installation validation, immutable package metadata, bilingual author docs/content, generic category/source/status cards, metadata search and six detail sections are implemented. Both per-ID name/description tables are removed, including their use in the examples shelf and generation notice. Multi-row purpose text is visible in the Overview disclosure; it does not assert registration. The configuration tab retains its existing editor and lifetime.

Tests have been written for metadata admission/limits/localization/persistence, source-owned real contributions, declaration/disabled/revision fallback, bilingual catalog search, generic card/detail rendering, plain-text safety and metadata-free third parties. One registered Web spec covers category/search, provided settings, localized details, 390px keyboard opening and preserved configuration drafts. They have **not been run**. The allowed protocol generator was run; source and diff review are the available development evidence. Real light/dark before/after screenshots and compilation/runtime acceptance remain for the shared pre-handoff stage.
