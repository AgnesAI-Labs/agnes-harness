import { PresetSchema } from '@agnes/protocol/gen/preset'
import { ProfileSchema } from '@agnes/protocol/gen/profile'
import { type ConfigAction, SchemaConfigForm } from './config-form.js'
import type { ConfigSchema } from './config-schema.js'
import { CONFIG_FORM_NAMESPACE, configFormCatalog } from './locales/config-form.js'
import { useUiText } from './ui-locale.js'

/** Use generated protocol constraints; metadata annotates presentation, never authorization. */
function annotate(source: unknown, kind: string): ConfigSchema {
  const schema = JSON.parse(JSON.stringify(source)) as ConfigSchema
  const properties = Object.fromEntries(
    Object.entries(schema.properties ?? {}).map(([name, field]) => [
      name,
      {
        ...field,
        'x-ui': {
          labelKey: `option.${kind}.${name}`,
          ...(name === 'level'
            ? { optionKeys: { L0: 'level.L0', L1: 'level.L1', L2: 'level.L2' } }
            : name === 'on_unavailable'
              ? { optionKeys: { deny: 'policy.deny', allow: 'policy.allow' } }
              : {}),
        },
      },
    ]),
  )
  return { ...schema, properties }
}
export const providerConfigSchemas = {
  sandbox: annotate(PresetSchema.Import('PresetDoc').$defs.PresetDoc.properties.sandbox, 'sandbox'),
  compaction: annotate(PresetSchema.Import('PresetDoc').$defs.PresetDoc.properties.compaction, 'compaction'),
  persistence: annotate(
    ProfileSchema.Import('CompositionPatch').$defs.CompositionPatch.properties.persistence,
    'persistence',
  ),
} as const

/** A registered provider settings component supplies its existing authorized read/save/test adapter. */
export function ProviderConfigForm({
  kind,
  value,
  onChange,
  onSave,
  onTest,
  readOnly,
  testId,
}: {
  kind: keyof typeof providerConfigSchemas
  value: Readonly<Record<string, unknown>>
  onChange(value: Record<string, unknown>): void
  onSave?: ConfigAction
  onTest?: ConfigAction
  readOnly?: boolean
  testId?: string
}) {
  const { t } = useUiText(CONFIG_FORM_NAMESPACE, configFormCatalog)
  return (
    <SchemaConfigForm
      schema={providerConfigSchemas[kind]}
      value={value}
      onChange={onChange}
      t={t}
      {...(onSave ? { onSave } : {})}
      {...(onTest ? { onTest } : {})}
      readOnly={readOnly || (!onSave && !onTest)}
      testId={testId ?? `provider-${kind}-config`}
    />
  )
}
