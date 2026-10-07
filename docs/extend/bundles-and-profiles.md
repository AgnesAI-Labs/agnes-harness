# Bundles and profiles

English | [简体中文](bundles-and-profiles.zh-CN.md)

[Documentation](../README.md) · [Plugin kinds](README.md) · [Package management](../guide/packages.md)

A profile selects an application built from plugins. A bundle packages reusable profile patches and presets as static data. Installing a bundle does not execute an entry module or grant permissions. Installation, integrity verification, trust and enablement remain separate steps.

## Publish a bundle

Declare `agnes.kinds: ["bundle"]` and an `agnes.bundles` map in `package.json`. Bundle identifiers are `<package-id>#<bundle-name>`; names use lowercase letters, digits and hyphens and start with a letter. A package can publish several bundles. Each document accepts `extends`, `profile` and `presets`:

```json
{
  "name": "acme/research",
  "version": "1.0.0",
  "agnes": {
    "kinds": ["bundle"],
    "bundles": {
      "base": { "profile": { "toolPolicy": { "readOnly": true } } },
      "research": {
        "extends": ["acme/research#base"],
        "profile": {
          "loop": { "id": "example.dag", "version": "1.0.0" },
          "compaction": { "engine": "sliding-window" }
        },
        "presets": { "research": { "name": "research", "extends": "standard" } }
      }
    }
  }
}
```

The [research example](../../examples/bundles/research/README.md) declares its companion packages too. Install, trust and enable those packages independently. References do not install dependencies. Host reads bundle metadata only from enabled, trusted, integrity-verified installed packages. Workspace bundle discovery is not supported in this version.

## Select and patch

In the user profile, select bundles and optionally patch their choices:

```yaml
bundles: ["acme/research#research"]
composition:
  toolPolicy:
    deny: ["network_search"]
```

The compiler applies bundle parents before children, once per resolution; cycles and unknown identifiers are errors. Later selected bundles win. Direct profile composition overrides profile bundles. Existing top-level `loop`, `compaction.engine`, `persistence.provider` and `sandbox.provider` fields retain compatibility and override their corresponding profile composition fields. Preset composition follows profile composition, saved admin bundles follow presets, and an explicit session patch is last. Admin selection is stored separately with optimistic revision checks and takes effect on restart.

| Patch field | Meaning |
| --- | --- |
| `loop` | Exact `{id, version}` selection |
| `modelAdapters` | Adapter registration ids available to the composed model routes; activate registrations with package or plugin rows |
| `compaction` | `{engine}` selection; `null` disables compaction |
| `persistence`, `sandbox` | `{provider}` selection; uses the Host provider catalog; defaults are `sqlite` and `local` |
| `packages` | Package references merged by id; lock/trust and capability ceilings still apply |
| `plugins` | Ordinary row ids mapped to `{enabled, config}`; row config replaces as a whole |
| `toolPolicy` | `readOnly`, exact-name `allow` and `deny` lists; deny wins |
| `tools` | Model-visible and callable tool set; omitted or empty keeps the existing set |
| `mcp` | MCP server ids (also accepts `mcp/<server-id>`) or attested tool package ids; omitted or empty keeps defaults |
| `skills` | Skill resource ids, names or installed package ids; omitted or empty keeps defaults |
| `uiModules` | Client row ids, module names or package ids visible to the session |
| `surfaces` | Deployment API surfaces: `web`, `acp`, `http`; omission keeps defaults, `[]` is headless |
| `shell` | `{modules, slots}` limits optional client modules and their declared web slots; explicit empty lists load none |

Arrays replace rather than append, except package references which merge by id. `toolPolicy` and each plugin row merge by field. Reserved object keys and non-JSON data are refused. Composition cannot turn a disabled or untrusted package into an authorized registration. Existing deployment/user/workspace ordinary row layers retain their precedence; composition sits after deployment defaults and before explicit user/workspace row overrides.

A bundle can provide presets with the usual preset inheritance, plus `bundles` and `composition` fields. Bundle-provided presets join the profile’s allowed presets. Choose a preset when creating a session to obtain its loop and invocation policy.

## Inspect and select in admin

```sh
agh config dump --profile local-dev --preset research
```

This local command resolves the same profile, lock and saved configuration inputs as boot without importing plugin entry modules or calling a model. Output identifies the desired tree, the preset, selected bundles, package choices and a stable hash. `sources` records each choice as `default`, `profile`, `preset`, `admin` or `session`. `sessions` also reports active session keys, generation ids, composition hashes, presets, bundles and provider choices from running workers. Arbitrary package/plugin config and credentials are omitted.

In the plugin admin page, the bundle selector lists installed trusted bundle ids. Select bundles in override order, save and restart the Host. The explanation button shows the default preset’s desired composition. The local admin endpoints are:

- `GET /admin/api/bundles`: catalog, selection, revision and `restart-required` effect.
- `PUT /admin/api/bundles`: `{revision, bundles}`; requires `packages.activate` and a writable admin context.
- `GET /admin/api/composition`: default preset dump.
- `POST /admin/api/composition`: `{preset}` dump; requires `packages.read`.

These endpoints use the existing exact-origin/Host checks. A stale revision refuses the write. Dumps say `status: "live"` when active sessions are present, otherwise `"desired"`. `validation: "static"` still qualifies the desired tree: offline inspection does not prove executable registrations or enumerate registrations created by entry modules. Live records are accepted only while their worker's process identity matches. If process identity cannot be established, the worker omits live inspection without preventing sessions from running. Host validates real loop, adapter, compaction, persistence and sandbox catalogs before accepting composed startup; missing ids and a loop requiring disabled compaction are errors.

## Host lifecycle boundary

`resolveComposition(profile, {preset, admin, session, rows, catalog})` is the pure compiler. Embedders should supply catalogs for tools, UI modules and providers to validate those identifiers. `profileForComposition(profile, tree)` compiles a tree into a separate immutable Host profile for generation-based admission.

`createHost` automatically compiles a selected preset into its composition container. `Host.createSession` and hosted-session admission bind the session to that container's plugin generation. Different bundles can run side by side in the same daemon. Close and hibernation retain both bindings; reopening uses the original composition and generation. Session deletion releases both. Children inherit their parent's composition. Changing generation-owned choices through a live preset switch is refused; create a new session for the other composition.

Tools are filtered before model requests and discovery as well as at invocation. Skills are filtered for discovery, prompt preload, document reads and file reads. MCP tool visibility follows server prefixes or attested package identity. Package and plugin row choices constrain each container's registrations. Client module rosters and service admission use the session's retained generation plus its module/slot selection. A module loads only when all its declared slots are selected. Built-in conversation controls remain part of the Web host; `shell` selects optional plugin panels and slots.

Surface listeners are deployment choices resolved from the default preset at startup. `surfaces: []` makes `agh start` run the daemon without a Web listener or static Web server; local headless SDK access remains available. `web` enables the local Web surface, `http` enables remote API transport and package HTTP surfaces, and `acp` allows the local stdio ACP mode. Changing these choices requires restart. A headless session does not load optional Web modules, and does not stop listeners serving other sessions.

Complete runtime target deliveries remain owned by the generation runtime. Composition projects that catalog into each container, preserving resource-owned rows. Delivery is acknowledged only after all containers converge; retained sessions continue using their pinned generations. Live provider metadata is available through `Host.compositionSessions()` and the local inspection endpoints.

The read-only policy checks tool metadata and exact names at invocation, including loop-scheduled calls. It adds a refusal and does not widen existing approvals, sandbox limits, resource trust or network permissions. Unknown metadata does not satisfy read-only policy. Changing composition does not rewrite an existing session’s pinned loop or reopen its persistence store.
