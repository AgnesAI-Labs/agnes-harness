# Applications

English | [简体中文](applications.zh-CN.md)

[Plugin metadata](plugin-metadata.md) · [UI registries](../develop/ui-extension-registries.md)

An application supplies product identity, presentation defaults and an agent catalogue. Installing,
trusting or enabling its package only makes it a candidate. An administrator explicitly previews and
adopts it in **Settings → Application**. Selecting it does not enable dependencies or change execution
profiles, composition hashes, saved sessions, pins, actors, permissions or model personas.


Catalog application cards may include `applicationAssets.mark`: bounded raster discovery bytes derived from the declared package asset. These bytes are presentation hints only; installation re-inspects the source and adoption uses the verified immutable package and its consent digest. The gallery groups role agents under one application card. Install and adopt retains separate installation/trust review and explicit application consent, then opens the declared home.


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

```json
{
  "application": {
    "id": "acme-operations",
    "brand": {
      "name": {
        "en": "Acme",
        "zh-CN": "Acme"
      },
      "title": {
        "en": "Acme Operations",
        "zh-CN": "Acme 运营台"
      },
      "assistantName": {
        "en": "Ava",
        "zh-CN": "艾娃"
      },
      "mark": "assets/mark.png",
      "favicon": "assets/favicon.png"
    },
    "presentation": {
      "home": "@acme/operations#acme-overview",
      "navigation": {
        "entries": [
          "@acme/operations#acme-overview"
        ],
        "hideBuiltin": [
          "automation"
        ]
      }
    },
    "defaultAgent": "@acme/operations#desk",
    "agents": [
      "@acme/operations#desk"
    ]
  }
}
```

This is the `agnes.application` value in `package.json`; all fields except `id` are optional. Brand
text uses the existing localized `{en, "zh-CN"?}` contract. `favicon` has the same asset shape as
`mark`. Inspect derives length, MIME and SHA-256 from the immutable package snapshot. Assets must be
package-contained regular files, at most 128 KiB each, with matching length, SHA-256, extension and
raster signature and decoded pixels (PNG, JPEG, WebP, GIF or PNG-backed ICO). Decoding is bounded to 1,048,576 total pixels, 32 frames and a two-second codec timeout. Symlinks, traversal, URLs and SVG are refused. Assets
are read from verified installed package bytes; the browser renders bounded blob URLs under CSP.

Home and navigation page references use `package#page`. Pages must be statically declared by profile
clients (`homeEntries` or `examplePages`), and agents must be Bundles with their own `launch`. A skin
must be declared by this package. Cross-package targets require declared dependencies and deployment
validation. Unknown targets fail closed. The browser preserves page package identity through loading, failure and conflicting ordinary page names; another package cannot supply an adopted page default.

The standard takeover roles are `navigation`, `conversation`, `composer`, `goal`, `interaction` and
`deliverables`. A referenced client must have an explicit stable `client.id`, `lifetime: "profile"`
and `presentationRoles: ["navigation"]` (as appropriate) in its descriptor. That optional static
field expands the descriptor from 16 to 17 fields; the manifest backbone remains 29. Inspect,
immutable snapshots, trust hashing and the browser roster preserve these declarations. The current
application or explicit user choice filters product candidates **before** priority election. An
unselected application's lower priority cannot take over. Ordinary pages, settings, cards and slots
retain their existing scopes and semantics.

Build a replacement using public exports: [Build a presentation plugin](presentations.md).

## Choose one interface implementation

In **Settings → Application → Interface implementations**, an administrator can replace each standard
role independently. Keep application A's brand and navigation while choosing plugin B for deliverables,
or keep the default AGH application and choose B without adopting any application. Each row shows the
current implementation and its source (**Default / Application / Your choice**), candidates from
installed, trusted, enabled packages, and **Restore default**. Only profile clients that statically
declare the role in `presentationRoles` are candidates; authors need no application declaration.

Preview the source/signature, package integrity, role and visible parts replaced, client entry and
dependency trust surface, presentation-only scope and recovery before confirming. That information and
the client declaration are bound to the consent digest. Selection uses the application configuration
CAS revision and existing administrator permissions. Explicit role choice wins over the application's
role, then the host default. Restoring one role removes only that choice, restoring the application's
implementation when available. It never changes execution profiles or hashes.

A disabled, untrusted, removed, changed or failing implementation remains saved as **unresolved**, with
a reason. The host falls back to the application's implementation or its own default; it never chooses
another community candidate automatically. Changed code/declarations require fresh preview and consent.
At each role mount, the host matches the stored consent against the actual module integrity and its
attested client/dependency binding. A stale selection response cannot admit a newer roster entry;
missing or mismatched bindings remain unresolved until a matching reviewed implementation is available.

Settings adoption previews first summarize brand, pages/navigation, agents, replaced roles and dependency permissions. Added and removed dependencies are separate; unverifiable previous consent is explicitly unknown. The complete JSON, client entry points, integrity and consent digests remain copyable in **Technical details**. Individual **Interface implementations** previews use the same summary for visible parts and current permissions; a backend result of not applicable is not presented as “no changes”. Application and interface candidates refresh on plugin change notifications and when returning to the window; an idle page does not poll. **Refresh candidates** updates them without a full page reload. Failed reads retain the last list and show an error; refreshing never adopts an application or interface choice.

The consent preview binds source and signature status, package/version/integrity, brand and assets,
hidden entries, home/skin, agents, role code sources, dependency permissions/diff, scope and recovery.
The dependency closure reviews managed plugins. Explicit `agnes.hostProvidedExternals` imports that
are absent from the managed inventory use the Host ABI checked at code admission; they do not require
separate plugin installation. A managed package is always reviewed even if also listed as an external,
and undeclared missing dependencies still refuse application and interface-role previews.
Adoption and clearing use the existing admin principal/method allowlists and configuration CAS revision.
A changed preview or stale revision is refused. The accepted preview is retained with its digest so dependency changes compare the previous consented transitive closure with the new one, even after upgrade or uninstall. If the old consent cannot be verified, the diff explicitly reports unknown. Brand changes are normal package upgrades and require
fresh trust and explicit adoption; old sessions retain their execution pins. Trusted JavaScript runs
with the workbench and is not a sandbox.

No selection means the host AGH application. Installing B never replaces selected A. If A is disabled,
untrusted, removed, changed or has unavailable assets/references, its saved selection remains
**unresolved**, with a reason, while presentation falls back to AGH. It never silently selects B.
URL overrides take precedence over user preferences, application defaults and host defaults, in that
order. Clearing removes application defaults and preserves user preferences. Effective-application changes immediately remove application CSS and tokens; late CSS from a revoked application cannot repaint. A browser image decode failure also falls back to the host.

Open **`/?admin`** for the separate host recovery bootstrap. It selects the host identity and skin
before importing application JavaScript, CSS, roles or navigation. The URL grants no authority;
mutations use the same authenticated BFF and admin checks. **`agh app clear [--profile NAME] [--json]`**
is dispatched before generic boot, loads no plugins and clears both the application and all explicit
role choices. The recovery page's clear action does the same; execution settings and unrelated user
preferences remain intact. A running daemon
uses online CAS; otherwise an atomic write uses the shared configuration lock and revision.

The [Acme reference application](../../examples/acme/README.md) supplies a tool, a default-Loop agent, raster identity assets, an additional page and executable SDK preview/adoption commands.

## Before starting Acme

With the same home and profile, start Web at the selected origin before installing the application, or run `node agnes.mjs daemon stop` after installation and before starting Web. `plugins add` may itself start a daemon. If its origin differs, `serve --port 4198` refuses with `local daemon Web origin does not match the selected origin`. Stop this home’s daemon and retry the same `serve` command. See the complete [Acme deployment steps](../../examples/acme/README.md#deployer-adoption).

Developer examples are the [five mechanism teaching packages](../../examples/fde/README.md). Product demos use [showcase applications](../guide/demos.md), coming in the same release.

## Conversation workbench

An optional `application.workbench` makes one application a business workbench. Existing applications
without it retain their presentation. Install review and adoption consent remain separate.

```json
{
  "workbench": {
    "tabs": [
      { "id": "object", "title": { "en": "Current object", "zh-CN": "当前对象" }, "icon": "file", "order": -30, "slot": "workbench.panel", "view": "page", "page": "acme/kit#dossier", "when": "session" },
      { "id": "signatures", "title": { "en": "Pending signatures" }, "order": -20, "slot": "workbench.panel", "view": "signatures" },
      { "id": "evidence", "title": { "en": "Evidence and reports" }, "order": -10, "slot": "workbench.panel", "view": "evidence" }
    ],
    "actions": [
      { "id": "review", "title": { "en": "Review NCR" }, "agent": "acme/kit#reviewer", "prompt": { "en": "Review the selected NCR using its controlled evidence." }, "focusTab": "object", "object": { "type": "ncr", "id": "NCR-018" } }
    ],
    "includes": ["pages", "tools", "signatures", "reports"],
    "scenarios": [{ "en": "Anomaly → investigation → disposition → signature" }]
  }
}
```

At most 8 tabs, 12 actions and 3 scenarios are accepted. Optional `includes` lists up to four unique
gallery features: `pages`, `tools`, `signatures`, `reports`; declare only capabilities your application provides. IDs are unique and bounded; localized text
requires English, optionally Chinese, with at most 2048 characters per language. Tab order is an integer
from -100 to 100. Only `workbench.panel` is a valid tab slot. A `page` view requires an owner-qualified,
declared profile page; other views cannot carry a page. `when` can be `session` (default) or `object`.
The host resolves page ownership and readiness, removes tabs on clear/unresolve, and isolates renderer
failures. Files, Changes and Terminal remain reachable through the normal dock and overflow menu.

Actions use `agent` or the application's `defaultAgent`, must target an allowed launchable agent,
and may focus a declared tab. They open the existing launch review and fill an editable request,
never submit it. From a business page, import `openApplicationWork` from `@agnes/web-client` and call
`openApplicationWork('review', {type: 'ncr', id: record.id})`. The object is bounded structured request
context, serialized into the editable prompt. Submitted context can be recovered from durable user
content in a fresh browser tab; editing its object updates the dossier. Optional browser session memory
restores pre-submission focus and launch attribution; it grants no authority and is not a backend business record. Routing
selects an existing agent at launch; it does not introduce delegation or switch a running session's role.

A page component receives `context.selection.object` and `context.selection.applicationPanel` when
used in a tab. Capture `ctx` from `apply`; use declared profile queries for current business data.
Subscribe to `ctx.session.projection` invalidations and `ctx.session.readiness` epochs to refresh after
tool writes, discard stale reads and unsubscribe on unmount. Do not poll. `signatures` reuses the
host's current decision actions, including independent `business.confirm`; full-access permission
handling does not turn a business signature into a client-side write. Under full access, the Host
auto-confirms eligible business decisions and records that mode without a pending card; standard and
workspace-write permissions retain manual confirmation. Never label an automatic confirmation as a manual click. `evidence` reads session tool
receipts and opens the existing execution records and report files. Gallery scenarios replace role
launch lists for workbench applications; role descriptions remain in collapsed details.
