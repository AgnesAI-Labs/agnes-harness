import { type InputHTMLAttributes, useEffect, useRef, useState } from 'react'
import { PLUGIN_CONFIG_NAMESPACE, pluginConfigCatalog } from './locales/plugin-config.js'
import { SettingsInput } from './settings-layout.js'
import { useUiText } from './ui-locale.js'

/** Partial reference typing stays local; plaintext never enters the configuration draft. */
export function PluginSchemaSecret({
  value,
  path,
  onChange,
  onInvalid,
  ...props
}: {
  value: unknown
  path: string
  onChange(value: unknown): void
  onInvalid(path: string, invalid: boolean): void
} & Omit<InputHTMLAttributes<HTMLInputElement>, 'value' | 'onChange' | 'onInvalid'>) {
  const { t } = useUiText(PLUGIN_CONFIG_NAMESPACE, pluginConfigCatalog)
  const encoded = typeof value === 'string' && value.startsWith('secret://') ? value : 'secret://'
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
  return (
    <>
      <SettingsInput
        {...props}
        type="text"
        autoComplete="off"
        value={text}
        aria-invalid={invalid || props['aria-invalid']}
        onChange={(event) => {
          const next = event.currentTarget.value
          const reference = /^secret:\/\/[a-z0-9-]+\/[a-z0-9._-]+$/.test(next)
          if ('secret://'.startsWith(next) || next.startsWith('secret://')) setText(next)
          setInvalid(!reference)
          onInvalid(path, !reference)
          if (reference) {
            published.current = next
            onChange(next)
          }
        }}
      />
      <p role={invalid ? 'alert' : undefined}>{t('secretHelp')}</p>
    </>
  )
}
