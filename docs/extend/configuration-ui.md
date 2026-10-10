# Schema-driven configuration UI

English | [简体中文](configuration-ui.zh-CN.md)

[Extension guide](README.md) · [Settings and conversation registries](../develop/ui-extension-registries.md)

Register a settings section through `settingsSections` from `@agnes/web-client`. Its component can use `SchemaConfigForm` from `@agnes/web-ui`; the host keeps the same navigation, layout, theme and locale service. Registration does not create a backend endpoint or grant permission to change configuration.

```tsx
import { SchemaConfigForm, type ConfigSchema } from '@agnes/web-ui'

const schema: ConfigSchema = {
  type: 'object', additionalProperties: false,
  required: ['credentialRef', 'limit'],
  properties: {
    credentialRef: {
      type: 'string', format: 'credential-reference',
      'x-ui': { labelKey: 'example.credential', hintKey: 'example.credentialHint' },
    },
    limit: {
      type: 'integer', minimum: 1, maximum: 10,
      'x-ui': { labelKey: 'example.limit' },
    },
  },
}

// Inside your registered component. The caller owns draft state and authorized service adapters.
<SchemaConfigForm schema={schema} value={draft} onChange={setDraft} t={context.t}
  readOnly={!canConfigure}
  onSave={async (value, { signal }) => { await saveConfiguration(value, signal) }}
  onTest={async (value, { signal }) => { await testConfiguration(value, signal) }}
  testId="example-config" />
```

`saveConfiguration`, `testConfiguration`, `draft`, `setDraft` and `canConfigure` are caller-provided. Bind them to your declared, authorized backend services using the existing client-module service/effect paths; changes that require confirmation still use the effect path. Ordinary service calls require an active session. Do not infer grants from a schema or bypass the existing install, trust, confirmation, revision and recovery checks. Backend validation remains authoritative; client validation improves feedback.

Supply `example.*` keys in both locale catalogs registered with the host. Labels, hints, placeholders and enum option labels use keys, not translated strings. Missing field translations fail closed rather than displaying keys. For enum options set `x-ui.optionKeys`, mapping each value to its title key. Use `x-ui.id` and `x-ui.testId` when retaining existing selectors; otherwise IDs derive from the form test ID and property name.

## Declare and register a configuration section

`createSchemaSettingsComponent` turns a schema, read/save/test adapters and permission declaration into a component for the existing settings registry. No second navigation or handwritten form is needed. Adapters use the plugin's declared service/effect paths. Reads return `{ values, revision? }`; saves receive that revision and return the authoritative updated document. Conflict handling and permission enforcement remain on the backend.

```tsx
import { settingsSections } from '@agnes/web-client'
import { createSchemaSettingsComponent } from '@agnes/web-ui'

const component = createSchemaSettingsComponent({
  schema, testId: 'example-config',
  scope: context => resourceIdentity(context),
  canConfigure: context => hasWritePermission(context),
  load: (context, signal) => readConfiguration(context, signal),
  save: (document, context, signal) => saveConfiguration(document, context, signal),
  test: (document, context, signal) => testConfiguration(document, context, signal),
})
const unregister = settingsSections.register({
  group: 'plugins', groupTitleKey: 'example.group', id: 'example-config', titleKey: 'example.settings',
  icon: 'settings', order: 50, component,
})
```

The service adapters, permission check and resource identity in this example are plugin-owned. `scope` is a stable, non-secret resource identity: changing resources aborts old operations; changing locale retains the draft and translates fields. Call `unregister()` on disposal. Failed reads offer retry; unknown fields, missing translations and unsupported schemas prevent submission. This declaration grants no permission and displays no backend messages or credential values in errors.

## Supported schema and components

| API | Contract |
| --- | --- |
| `ConfigSchema` | Plain JSON/TypeBox JSON subset: closed objects, nested objects, required fields, strings, booleans, finite numbers/integers, enum or literal `anyOf`, string arrays, range/length/item bounds, patterns and unique items |
| `SchemaConfigForm` | Controlled draft, validate before save/test, translated field errors, disabled/loading, safe operation failure, draft retention, abort signal on disposal; no automatic requests, persistence, credential resolution or defaults |
| `SchemaConfigFields` | Same fields without a form or action wrapper, for existing page handlers |
| `SchemaControl` | One native shared control, retaining a page's existing Field/checkbox wrapper |
| `configIssues` / `configSchemaSupported` | Pure validation; errors contain field paths and codes, never values or backend messages |
| `ProviderConfigForm` / `providerConfigSchemas` | Sandbox and compaction options from the generated preset schema; persistence selection from the generated profile schema. Requires caller-supplied authoritative values and permitted handlers; without handlers it is read-only |

Unsupported keywords/unions, open objects, invalid patterns, cycles, excessive depth/size and unsafe property names are refused. This is not a complete JSON Schema renderer: resolve supported property schemas before passing them in; `$ref`, arbitrary unions, transforms and additional-property maps are not accepted. TypeBox symbols do not form part of JSON declarations. Keep declaration objects stable during rendering. `default` is annotation only; the caller initializes the draft.

Credential fields accept only the protocol's `secret://namespace/name` references. Never pass plaintext credentials as config defaults, initial values, saved config or test logs. Creating/replacing a credential uses the dedicated write-only credential-store API; the existing search key operation retains that separate path. MCP retains its managed form, transport-specific checks, credential-reference validation and reviewed creation flow.

The runtime provider catalog intentionally contains descriptions and identities, not current private configuration. This frontend API does not manufacture current sandbox/persistence/compaction values or add a universal configuration writer. A provider's registered panel supplies its own supported administration adapter.


## Configure any installed plugin

Open **Settings → Plugins**, select an installed package, then open **Configuration**. Choose the plugin entry when a package declares several exports. Installation and trust remain separate from saving configuration; saving an inactive entry stores its values without enabling its code.

Each `agnes.plugins` manifest entry can declare the public `PluginConfigContract` from `@agnes/extension-api`:

```json
{
  "export": "businessAgent",
  "id": "ext:acme/support",
  "apiRange": "^1.4.0",
  "configReload": "next-session",
  "configSchema": {
    "type": "object",
    "additionalProperties": false,
    "required": ["credential", "queues"],
    "properties": {
      "credential": { "type": "string", "format": "credential-reference" },
      "queues": { "type": "array", "items": { "type": "string" }, "default": [] },
      "region": { "enum": ["global", "cn"], "default": "global" }
    }
  }
}
```

Schemas use synchronous JSON Schema 2020-12, standard formats and local references. Install/update compiles the schema and rejects invalid declarations, invalid supplied `config`, invalid defaults, remote references, async validators and unregistered formats/keywords. `x-*` keywords are annotations. Schema defaults are optional values the administrator explicitly chooses, never automatic server mutations. Omitted `configSchema` means `true`, with a JSON editor; omitted `configReload` uses the public `DEFAULT_PLUGIN_CONFIG_RELOAD` (`next-session`).

The form renders objects, arrays, enums, `oneOf`/`anyOf` variant pickers, local nested/recursive references, additional-property key/value maps, descriptions and formats. Reference expansion stops at six levels. Combined assertions, tuples, unknown UI annotations and other constructs the form cannot faithfully project use a JSON editor for that subtree. All values, including unknown keys and unselected branch values, stay in the draft; editing them never strips data. The full validator still enforces `allOf`, conditionals, pattern properties, tuple schemas and other supported JSON Schema assertions. Errors name JSON Pointer field paths and codes without echoing values.

Mark every secret field with `format: "credential-reference"`, `x-secret: true` or `writeOnly: true`. These fields require `secret://namespace/name` references, including through branches, references and additional-property maps. The UI accepts references; creation/replacement of the actual credential uses the credential store's separate write-only API. JSON fallback edits use the same secret constraints. Audit history redacts references and credential-shaped keys. Plugins resolve references through their authorized secret capability, rather than expecting resolved plaintext in configuration.

Inline feedback and save both call the shared `compilePluginConfig` validator on the server. Its implementation lives in `@agnes/protocol`; `@agnes/extension-api` keeps the public contract, defaults and thin validator exports. `_agnes/v1/plugins.config.get` returns `{ revision, entries, audit }`; `.validate` accepts `{ profile, id, rowId, value }` and returns `{ issues }`; `.save` additionally requires `expectedRevision`, `clientId` and `commandId`. Reads/validation require `packages.read`; saves require `packages.activate` and a server-established client identity. The SDK exposes `client.packages.config.get/validate/save`; the local Web relay uses `/admin/plugins/api/config/get`, `/validate` and `/save`.

Save returns `{ ok, revision, reason, issues, reload, refusalReason? }`, with `reason` equal to `saved`, `invalid`, `conflict`, `refused` or `pending`. Only `saved` has `ok: true`. A live save waits up to ten seconds for its response. `pending` means that apply is still in progress or its outcome is unknown; it never confirms a save. Keep the draft and reload to inspect the current configuration. A late successful acknowledgement may still commit; a late refusal leaves the original revision and history intact. Saves remain serialized until the acknowledgement or Worker exit. A stale revision never overwrites newer configuration; the UI retains the draft and offers reload. Schema failure, candidate-probe refusal or live Worker apply refusal leaves the previous desired revision and audit history unchanged. Apply refusals include a bounded, sanitized plugin reason; configuration strings, secret references and credential-shaped text are redacted. Successful configuration values and audit facts (principal, time, row, revision, redacted before/after diff) commit with the desired target in one transaction. Persisted overrides survive disable/enable and are validated again against updated manifests. An incompatible override refuses publication rather than being silently reset.

If persistence fails after a live apply, the publisher restores the previous runtime target. Desired configuration, audit facts and Worker qualification share one database transaction. A successful restore returns `refused`; failed restoration returns `pending` because the runtime outcome is unknown.

`live` saves commit the new desired revision and its audit fact only after the authorized business Worker acknowledges successful application. The canonical-artifact probe only validates the artifact and never opens the business runtime. The apply uses the existing Worker convergence/failure frames. `live` applies at the runtime admission boundary to retained sessions using the same pinned code identity; a refused apply compensates changed containers. `next-session` preserves existing session configuration and supplies the new value to subsequent sessions. Its save ordering is unchanged: existing sessions intentionally do not apply that configuration, so their live acknowledgement is not a condition of saving. Disabled or unmounted entries also store the override without opening plugin code. The tab explains the declared mode. Configuration does not replace pinned code or relax restart-only backend boundaries. The official observability plugin retains its existing `env:NAME` header-reference contract (never plaintext headers); its schema includes those references and telemetry options. The official observability plugin and the [third-party example](../../examples/third-party-plugin/package.json) demonstrate manifest schemas.

## Guardrails and verification

`tools/guards/src/frontend-ui.test.ts` rejects literal copy at JSX/HTML display positions, accessible attributes, presentation props, DOM text writes and browser confirmations; locale-bound static HTML fallbacks are allowed. It also rejects layout styles in `packages/web/src` and direct rendering of built-in settings pages outside the registry. `ui-layer.test.ts` fences Ant Design, its private entry points and assistant-ui to web-ui. These source checks complement locale parity and real-screen unresolved-key tests; runtime/plugin-supplied data is not treated as application copy.

Preserve the existing controls, DOM/test IDs and locale catalogs when migrating a built-in form. Validate real saved payloads and failure/read-only paths; compare the light/dark, English/Chinese, 1440×900 and 1280×800 screens with the approved UI. Do not update another stream's visual baselines without a documented reason.

Adapters can reject with the public App Server error envelope (including SDK errors carrying `data.messageKey`). Shared forms use `appServerErrorMessage` for safe, locale-aware feedback; unknown failures use the generic translated message and retain the draft. HTTP adapters pass the response's `error` object, never raw exception text.
