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

## Guardrails and verification

`tools/guards/src/frontend-ui.test.ts` rejects literal copy at JSX/HTML display positions, accessible attributes, presentation props, DOM text writes and browser confirmations; locale-bound static HTML fallbacks are allowed. It also rejects layout styles in `packages/web/src` and direct rendering of built-in settings pages outside the registry. `ui-layer.test.ts` fences Ant Design, its private entry points and assistant-ui to web-ui. These source checks complement locale parity and real-screen unresolved-key tests; runtime/plugin-supplied data is not treated as application copy.

Preserve the existing controls, DOM/test IDs and locale catalogs when migrating a built-in form. Validate real saved payloads and failure/read-only paths; compare the light/dark, English/Chinese, 1440×900 and 1280×800 screens with the approved UI. Do not update another stream's visual baselines without a documented reason.

Adapters can reject with the public App Server error envelope (including SDK errors carrying `data.messageKey`). Shared forms use `appServerErrorMessage` for safe, locale-aware feedback; unknown failures use the generic translated message and retain the draft. HTTP adapters pass the response's `error` object, never raw exception text.
