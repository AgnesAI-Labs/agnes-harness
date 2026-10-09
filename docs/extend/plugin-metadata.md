# Plugin purpose metadata

English | [简体中文](plugin-metadata.zh-CN.md)

[Plugin author kit](README.md) · [Content inventory](plugin-presentation/CONTENT.md) · [Page design](plugin-presentation/DESIGN.md)

Explain the user outcome in the public `PluginMetadata` contract exported by `@agnes/extension-api`. Use it as `agnes.extension.json.metadata`, `package.json.agnes.metadata`, or `package.json.agnes.plugins[].metadata`. A package overview describes the package; a row's complete metadata object describes that row and takes precedence over the overview when a row is displayed. Metadata is optional, including for third-party packages.

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

Category is one of `agent-loop`, `tools`, `safety-approval`, `memory-context`, `collaboration`, `integrations`, `observability`, `ui`, `developer`. It is an editorial grouping, not a runtime kind or permission. `docsUrl` must be an absolute HTTPS URL without credentials, whitespace or control characters. `locales` accepts only `en` and `zh-CN`; either may partially override name, summary, description and docs URL. Unknown keys are rejected. Each complete metadata block is limited to 24 KiB of UTF-8 JSON.

Installation inspection validates package and row metadata without importing plugin code. Extension admission uses the same protocol schema. Validated package metadata travels with previews, catalog entries, lock entries and immutable runtime snapshots; version changes follow the existing integrity, trust and pin rules. Metadata grants no capability and does not affect the capability hash, loading, authorization or enable/disable semantics.

The page resolves each localized field independently, then falls back to its base value. Without metadata it displays the full ID, known kinds, an uncategorized label and “No description provided”. Author text is rendered as text. Documentation opens only after an explicit click. Official/example labels come from existing provenance/catalog sources, never from author text or a package namespace.

“Provides” and “Where it appears” use existing readable registrations and inventory. An author summary or capability declaration is not proof of a registered tool. Unloaded or unavailable contributions remain unavailable rather than being inferred from their IDs. See the approved design's Phase B scope for the small presentation projection.
