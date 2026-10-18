# Plugin metadata and declared capabilities

English | [简体中文](plugin-metadata.zh-CN.md)

A plugin package declares optional display text in `agnes.metadata` and capability labels in `agnes.provides`. Labels describe the package; they never grant authority. Runtime permissions still come from row capabilities and Host admission.

```json
{
  "agnes": {
    "provides": ["tool", "ui"],
    "metadata": {
      "displayName": "Project search",
      "summary": "Find readable project text.",
      "description": "Search files available to the session.",
      "docsUrl": "https://example.org/docs",
      "locales": { "zh-CN": { "displayName": "项目搜索" } }
    }
  }
}
```

`provides` accepts a unique set of `tool`, `loop`, `model-adapter`, `mcp`, `skills`, `ui`, `bundle`, and `service`. It is optional; a Loop-only plugin needs no Bundle or agent. This package label set is separate from an extension's `provides` seam declaration and a row's `provide` service names. `metadata.category` and `agnes.kinds` are rejected; there is no old-manifest compatibility layer.

When metadata is present, `displayName`, `summary`, and `description` are required. Their limits are 80, 240, and 1,200 Unicode code points; text must be trimmed, printable and single-line. Optional `docsUrl` is credential-free HTTPS, at most 2,048 code points. `locales.en` and `locales.zh-CN` may override those fields independently. Missing translations fall back per field. A complete metadata block is limited to 24 KiB of UTF-8 JSON. Optional `samplePrompt` has required English fallback and optional Chinese text, at most 600 code points each; `experimental` is a boolean. Author text is rendered as text, and links open only on an explicit click.

<a id="what-a-package-includes"></a>

Rows may carry their own metadata for their settings descriptions. Source labels come from verified provenance, never from a package name or author label. The static presentation summary can count explicitly declared tools, skill files, Bundles and UI contributions; absent counts mean unknown. Static declarations and runtime registration remain distinct evidence.

## Agents are Bundles with launch information

```json
{
  "agnes": {
    "provides": ["bundle"],
    "bundles": {
      "review": {
        "presets": { "safe": { "name": "safe", "extends": "standard" } },
        "launch": {
          "title": { "en": "Review", "zh-CN": "审查" },
          "description": { "en": "Review a document.", "zh-CN": "审查文档。" },
          "preset": "safe",
          "prompt": { "text": { "en": "Review this document." }, "mode": "draft" }
        }
      },
      "reuse": { "extends": ["acme/reviewer#review"] }
    }
  }
}
```

An agent reference is `package#bundle`. `launch.title`, `description`, and `preset` are required; localized text has required `en` and optional `zh-CN`. Optional `pages` lists profile pages declared by the same package. Draft prompt text is bounded to 16 KiB per language and cannot contain secret references. `launch` is **not inherited**: `reuse` above is a reusable Bundle, not an agent. A child can declare its own complete launch block and use inherited presets. `extends` takes unique full references. There is no inline composition syntax.

Static preflight reports `structural`, `static-references`, `deployment-dependent`, or `refused`, with reasons and a next step. It validates full presets, inheritance, launch references and known runtime restrictions without importing plugin code. Declared dependency definitions and runtime exports may require deployment validation. Preset inheritance is checked after parent-to-child Bundle overrides. Fully known cycles are refused; missing inheritance definitions or a launch preset supplied by deployment are deployment-dependent. Deployment admission must validate that explicit preset and its allowed list; there is no launch default fallback. Passing installation inspection does not mean ready; mount, binding, session creation and recovery retain their checks. Ordinary isolated plugin rows are currently refused before import.

Launch declarations participate in `capabilityHash` for every package. Changing a launch requires a new trust review. `metadata.launches` is rejected. `metadata.exampleOf` remains a separate, dependency-version-checked relation for restricted example management; optional `pageEntry` requires this relation and a declared profile example page. Capability labels do not give ordinary agents example-management privileges.

## Assembly through the same Acme example

Deployment profile → plugin → agent → application presentation each has a distinct job:

| Layer | Acme example | Who chooses it and when it applies |
| --- | --- | --- |
| Deployment execution profile | `AGNES_PROFILE=local-dev`: model, permission ceilings, default Loop and runtime services | The deployer configures execution; application adoption does not modify it |
| Plugin | `@acme/operations`: `acme_status`, the page, the `desk` Bundle and application declaration | Installation, trust review and enablement make capabilities available as candidates |
| Agent | `@acme/operations#desk`: its own `launch.preset=acme`, tool scope and editable prompt draft | Launch review binds the final running mode, model, permissions and sources; the session retains its execution binding |
| Application presentation | `acme-operations`: Acme brand, Ava assistant name, `@acme/operations#acme-overview` page, hidden Automation entry and default/visible agents | An admin previews and explicitly adopts it in Settings → Application; it selects presentation defaults only |

This release **does not distribute or adopt execution profile templates**. An application is not an execution template. Deployers continue to configure profiles independently; changing presentation does not reconfigure saved sessions. See the [Acme reference application](../../examples/acme/README.md) for installation, preview and launch commands.

## Application declaration

See [Applications](applications.md) for the complete identity, raster asset, presentation role and explicit adoption contracts. Installing an application only creates a candidate; presentation selection stays outside execution resolution.

The fixed author backbone has 29 slots: 9 package-envelope fields, 14 plugin-row fields, 2 client-binding fields and 4 Bundle fields. Relative to the prior 27: remove `agnes.kinds`; add `agnes.provides`, `agnes.application`, and `bundles.*.launch`. Nested metadata and launch fields are outside this denominator. The first tool and first Loop need no new required steps.
