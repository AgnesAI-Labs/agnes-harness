# Applications

English | [简体中文](applications.zh-CN.md)

[Plugin metadata](plugin-metadata.md) · [UI registries](../develop/ui-extension-registries.md)

An application supplies product identity, presentation defaults and an agent catalogue. Installing,
trusting or enabling its package only makes it a candidate. An administrator explicitly previews and
adopts it in **Settings → Application**. Selecting it does not enable dependencies or change execution
profiles, composition hashes, saved sessions, pins, actors, permissions or model personas.

```json
{
  "application": {
    "id": "acme",
    "brand": {
      "name": { "en": "Acme", "zh-CN": "艾克米" },
      "title": { "en": "Acme Workbench" },
      "assistantName": { "en": "Ava" },
      "mark": "assets/mark.png"
    },
    "presentation": {
      "home": "acme/kit#overview",
      "skin": "acme",
      "navigation": { "entries": ["acme/kit#overview"], "hideBuiltin": ["agents", "automation"] },
      "roles": { "navigation": { "packageId": "acme/kit", "clientId": "navigation" } }
    },
    "defaultAgent": "acme/kit#work",
    "agents": ["acme/kit#work"]
  }
}
```

This is the `agnes.application` value in `package.json`; all fields except `id` are optional. Brand
text uses the existing localized `{en, "zh-CN"?}` contract. `favicon` has the same asset shape as
`mark`. Inspect derives length, MIME and SHA-256 from the immutable package snapshot. Assets must be
package-contained regular files, at most 128 KiB each, with matching length, SHA-256, extension and
raster signature (PNG, JPEG, WebP, GIF or ICO). Symlinks, traversal, URLs and SVG are refused. Assets
are read from verified installed package bytes; the browser renders bounded blob URLs under CSP.

Home and navigation page references use `package#page`. Pages must be statically declared by profile
clients (`homeEntries` or `examplePages`), and agents must be Bundles with their own `launch`. A skin
must be declared by this package. Cross-package targets require declared dependencies and deployment
validation. Unknown targets fail closed.

The standard takeover roles are `navigation`, `conversation`, `composer`, `goal`, `interaction` and
`deliverables`. A referenced client must have an explicit stable `client.id`, `lifetime: "profile"`
and `presentationRoles: ["navigation"]` (as appropriate) in its descriptor. That optional static
field expands the descriptor from 16 to 17 fields; the manifest backbone remains 29. Inspect,
immutable snapshots, trust hashing and the browser roster preserve these declarations. The current
application or explicit user choice filters product candidates **before** priority election. An
unselected application's lower priority cannot take over. Ordinary pages, settings, cards and slots
retain their existing scopes and semantics.

The consent preview binds source and signature status, package/version/integrity, brand and assets,
hidden entries, home/skin, agents, role code sources, dependency permissions/diff, scope and recovery.
Adoption and clearing use the existing admin principal/method allowlists and configuration CAS revision.
A changed preview or stale revision is refused. Brand changes are normal package upgrades and require
fresh trust and explicit adoption; old sessions retain their execution pins. Trusted JavaScript runs
with the workbench and is not a sandbox.

No selection means the host AGH application. Installing B never replaces selected A. If A is disabled,
untrusted, removed, changed or has unavailable assets/references, its saved selection remains
**unresolved**, with a reason, while presentation falls back to AGH. It never silently selects B.
URL overrides take precedence over user preferences, application defaults and host defaults, in that
order. Clearing removes application defaults and preserves user preferences.

Open **`/?admin`** for the separate host recovery bootstrap. It selects the host identity and skin
before importing application JavaScript, CSS, roles or navigation. The URL grants no authority;
mutations use the same authenticated BFF and admin checks. **`agh app clear [--profile NAME] [--json]`**
is dispatched before generic boot, loads no plugins and only clears presentation. A running daemon
uses online CAS; otherwise an atomic write uses the shared configuration lock and revision.
