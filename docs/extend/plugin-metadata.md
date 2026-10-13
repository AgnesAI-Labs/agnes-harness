# Plugin purpose metadata

English | [简体中文](plugin-metadata.zh-CN.md)

[Plugin author kit](README.md) · [Content inventory](plugin-presentation/CONTENT.md) · [Page design](plugin-presentation/DESIGN.md)

Explain the user outcome in the public `PluginMetadata` contract exported by `@agnes/extension-api`. Use it as `package.json.agnes.metadata` or `package.json.agnes.plugins[].metadata`. A package overview describes the package; a row's complete metadata object describes that row and takes precedence over the overview when a row is displayed. Metadata is optional, including for third-party packages.

```json
{
  "agnes": {
    "metadata": {
      "displayName": "Project file search",
      "summary": "Lets the agent find project files and search their contents.",
      "description": "Find files by name and search readable project text to locate the information needed for a task.",
      "category": "tools",
      "docsUrl": "https://example.org/docs/file-search",
      "locales": {
        "zh-CN": {
          "displayName": "项目文件搜索",
          "summary": "让 Agent 查找项目文件并检索文件内容。",
          "description": "按名称查找文件并检索可读项目文本，定位任务需要的信息。"
        }
      }
    }
  }
}
```

When present, `displayName`, `summary`, `description` and `category` are required. Name (1–80), summary (1–240), description (1–1,200) and optional docs URL (1–2,048) are bounded in Unicode code points. Text must be trimmed, printable and a single line/paragraph; control characters and Unicode line separators are rejected. Write a summary as one sentence about the problem solved. Descriptions may add scope or prerequisites. The schema uses a code-point-bounded pattern and a UTF-16 ceiling so its generated validator also accepts supplementary Unicode characters within the limit.

Category is one of `agent-loop`, `tools`, `safety-approval`, `memory-context`, `collaboration`, `integrations`, `observability`, `ui`, `developer`, `business-agent`. It is an editorial grouping, not a runtime kind or permission. Use `business-agent` for a bundle that delivers one business workflow; clients list those packages as business agents. `docsUrl` must be an absolute HTTPS URL without credentials, whitespace or control characters. `locales` accepts only `en` and `zh-CN`; either may partially override name, summary, description and docs URL. Unknown keys are rejected. Each complete metadata block is limited to 24 KiB of UTF-8 JSON.

Two optional fields describe how a package is offered:

```json
{
  "category": "business-agent",
  "samplePrompt": {
    "en": "Review the sample supplier contract clause by clause.",
    "zh-CN": "逐条审查示例供应商合同。"
  },
  "experimental": true
}
```

`samplePrompt` is a prompt a person can send as written to try the package. `en` is required and `zh-CN` is optional; a client shows the current language and falls back to `en`. Each value is one paragraph of 1–600 code points under the same text rules as the summary. `experimental: true` marks a package whose behavior may still change; clients list it apart from stable packages. Omit it otherwise. Both fields are display data with no effect on loading or authorization.

Installation inspection validates package and row metadata without importing plugin code. Extension admission uses the same protocol schema. Validated package metadata travels with previews, catalog entries, lock entries and immutable runtime snapshots; version changes follow the existing integrity, trust and pin rules. Metadata grants no capability and does not affect the capability hash, loading, authorization or enable/disable semantics.

The page resolves each localized field independently, then falls back to its base value. Without metadata it displays the full ID, known kinds, an uncategorized label and “No description provided”. Author text is rendered as text. Documentation opens only after an explicit click. Official/example labels come from existing provenance/catalog sources, never from author text or a package namespace.

“Provides” and “Where it appears” use existing readable registrations and inventory. An author summary or capability declaration is not proof of a registered tool. Unloaded or unavailable contributions remain unavailable rather than being inferred from their IDs. See the approved design's Phase B scope for the small presentation projection.

`PackagePresentation.presets` summarizes what each bundle preset's policy guarantees, so a client can state them before installation:

```json
{ "bundle": "acme/research#research", "id": "research", "toolPolicy": "default", "readOnly": "yes", "confirmBeforeActions": "no", "network": "none" }
```

The backend derives every field from package data without running plugin code; an author cannot write it. Read-only patches follow runtime precedence: the preset first, then session bundles and their parents in declaration order, applying each parent once; an explicit `false` overrides an earlier `true`. `readOnly` is `yes` when the resulting platform `toolPolicy.readOnly` is true, under any policy provider. Otherwise it is `no` for a known false value under the default provider and `unknown` for a custom provider or unresolved external bundle. An explicit patch after an external bundle can establish the value again.

`confirmBeforeActions` is `no` under the default tool-policy provider, where confirmation follows the session's permission mode and the preset promises nothing; it is `unknown` for a custom provider. `network` reads the package's declared capabilities: `allowed` when any plugin names a host, `none` when every plugin declares capabilities and none names a host, and `unknown` when declarations are incomplete and no host is named. A client should promise only a `yes` or a `none` and otherwise list the declared capabilities.

The optional `PackagePresentation` read field on preview, inventory and catalog DTOs carries bounded row IDs, author metadata, optional public extension source IDs and config-schema presence. Inventory/catalog origin is derived by the backend. These static declarations are not registrations and do not participate in targets, capability hashes or activation. The page combines them with existing runtime/provider and composition tool catalogs, browser slots, surface links and verified resource descriptors. Global settings sections, commands and events without readable package ownership are not attributed. Existing catalog pagination and lifecycle blockers/pins remain unchanged.
