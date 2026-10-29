import { useEffect, useRef, useState } from 'react'
import { PLUGIN_CONFIG_NAMESPACE, pluginConfigCatalog } from './locales/plugin-config.js'
import { SettingsTextArea } from './settings-layout.js'
import { useUiText } from './ui-locale.js'

/** Keep malformed JSON typing locally, and block save until the whole draft is parseable. */
export function PluginSchemaJson({
  value,
  path,
  disabled,
  onChange,
  onInvalid,
}: {
  value: unknown
  path: string
  disabled: boolean
  onChange(value: unknown): void
  onInvalid(path: string, invalid: boolean): void
}) {
  const { t } = useUiText(PLUGIN_CONFIG_NAMESPACE, pluginConfigCatalog)
  const encoded = JSON.stringify(value ?? null, null, 2)
  const published = useRef(encoded)
  const [text, setText] = useState(encoded)
  const [invalid, setInvalid] = useState(false)
  useEffect(() => {
    if (encoded !== published.current) {
      setText(encoded)
      setInvalid(false)
      onInvalid(path, false)
      published.current = encoded
    }
  }, [encoded, path, onInvalid])
  useEffect(() => () => onInvalid(path, false), [path, onInvalid])
  const id = `plugin-config-json-${encodeURIComponent(path)}`
  return (
    <div>
      <p>{t('fallback')}</p>
      <SettingsTextArea
        id={id}
        rows={8}
        aria-label={`${t('json')} ${path || '/'}`}
        aria-invalid={invalid}
        aria-describedby={invalid ? `${id}-syntax` : undefined}
        data-testid={`plugin-config-json${path || '/'}`}
        disabled={disabled}
        value={text}
        onChange={(event) => {
          const next = event.currentTarget.value
          setText(next)
          try {
            const value = JSON.parse(next)
            published.current = JSON.stringify(value ?? null, null, 2)
            onChange(value)
            setInvalid(false)
            onInvalid(path, false)
          } catch {
            setInvalid(true)
            onInvalid(path, true)
          }
        }}
      />
      {invalid && (
        <p id={`${id}-syntax`} role="alert">
          {t('syntax')}
        </p>
      )}
    </div>
  )
}
