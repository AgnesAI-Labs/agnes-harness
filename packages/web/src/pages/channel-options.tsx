import type { JsonValue } from '@agnes/protocol'
import { type PluginSchema, PluginSchemaFields, pluginSchemaDefault } from '@agnes/web-ui'
import type { Provider } from './channel-types.js'

/** Keep the provider's schema authoritative while showing declared options directly as fields. */
export function ChannelOptions({
  provider,
  value,
  disabled,
  onChange,
}: {
  provider: Provider
  value: JsonValue
  disabled: boolean
  onChange(value: JsonValue): void
}) {
  const properties = provider.configSchema.properties
  if (!properties || typeof properties !== 'object' || Array.isArray(properties)) return null
  const data = value && typeof value === 'object' && !Array.isArray(value) ? value : {}
  const required = provider.configSchema.required as string[] | undefined
  return (
    <div className="channel-field-grid">
      {Object.entries(properties).map(([key, raw]) => {
        const schema =
          raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {}
        const title = typeof schema.title === 'string' ? schema.title : key
        return (
          <PluginSchemaFields
            key={key}
            root={provider.configSchema}
            schema={{ ...schema, title: title + (required?.includes(key) ? ' *' : '') }}
            value={data[key] ?? pluginSchemaDefault(provider.configSchema, schema as PluginSchema)}
            path={`/config/${key}`}
            disabled={disabled}
            issues={[]}
            onInvalid={() => {}}
            onChange={(next) => onChange({ ...data, [key]: next as JsonValue })}
          />
        )
      })}
    </div>
  )
}
