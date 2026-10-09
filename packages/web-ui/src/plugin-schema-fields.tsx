import { useState } from 'react'
import { Button } from './ui/button.js'
import { SettingsInput, SettingsSelect } from './settings-layout.js'
import { PLUGIN_CONFIG_NAMESPACE, pluginConfigCatalog } from './locales/plugin-config.js'
import { useUiText } from './ui-locale.js'
import {
  childPath,
  isSchemaObject,
  pluginFormKind,
  pluginSchemaDefault,
  pluginVariantIndex,
  resolvePluginSchema,
  type PluginSchema,
} from './plugin-schema-model.js'
import { PluginSchemaSecret } from './plugin-schema-secret.js'
import { PluginSchemaJson } from './plugin-schema-json.js'

export type PluginFormIssue = Readonly<{ path: string; code: string }>
export interface PluginSchemaFieldsProps {
  root: PluginSchema
  schema: PluginSchema
  value: unknown
  path: string
  depth?: number
  disabled?: boolean
  issues: readonly PluginFormIssue[]
  onChange(value: unknown): void
  onInvalid(path: string, invalid: boolean): void
}

export function PluginSchemaFields(props: PluginSchemaFieldsProps) {
  const { root, value, path, issues, onChange, onInvalid, disabled = false, depth = 0 } = props
  const { t } = useUiText(PLUGIN_CONFIG_NAMESPACE, pluginConfigCatalog)
  const schema = resolvePluginSchema(root, props.schema)
  const node = isSchemaObject(schema) ? schema : {}
  const kind = pluginFormKind(schema, depth)
  const [branch, setBranch] = useState<number | undefined>()
  const [newKey, setNewKey] = useState('')
  const id = `plugin-config-field-${encodeURIComponent(path)}-${depth}`
  const fieldIssues = issues.filter((issue) => issue.path === path)
  const common = {
    id,
    disabled: disabled || node.readOnly === true,
    'aria-label': String(node.title ?? (path || t('title'))),
    'aria-invalid': fieldIssues.length > 0,
    'aria-describedby': `${id}-help`,
    'data-testid': `plugin-config-field${path || '/'}`,
  }
  const child = (
    childSchema: PluginSchema,
    childValue: unknown,
    key: string | number,
    change: (value: unknown) => void,
  ) => (
    <PluginSchemaFields
      key={key}
      root={root}
      schema={childSchema}
      value={childValue}
      path={childPath(path, key)}
      depth={depth + 1}
      disabled={common.disabled}
      issues={issues}
      onChange={change}
      onInvalid={onInvalid}
    />
  )
  const secret =
    node['x-secret'] === true || node.writeOnly === true || node.format === 'credential-reference'
  let control
  if (secret) {
    control = (
      <PluginSchemaSecret {...common} path={path} value={value} onChange={onChange} onInvalid={onInvalid} />
    )
  } else if (kind === 'json') {
    control = (
      <PluginSchemaJson
        path={path}
        value={value}
        disabled={common.disabled}
        onChange={onChange}
        onInvalid={onInvalid}
      />
    )
  } else if (kind === 'variant') {
    const variants = (node.oneOf ?? node.anyOf) as PluginSchema[]
    const index = branch ?? pluginVariantIndex(variants, value)
    const selected = variants[index] ?? true
    control = (
      <div>
        <SettingsSelect
          {...common}
          data-testid={`plugin-config-variant${path || '/'}`}
          aria-label={t('variant')}
          value={index}
          onChange={(event) => setBranch(Number(event.currentTarget.value))}
        >
          {variants.map((variant, index) => (
            <option key={index} value={index}>
              {isSchemaObject(variant)
                ? String(variant.title ?? `${t('variant')} ${index + 1}`)
                : `${t('variant')} ${index + 1}`}
            </option>
          ))}
        </SettingsSelect>
        <p>{t('variantHelp')}</p>
        <Button
          htmlType="button"
          disabled={common.disabled}
          onClick={() => onChange(pluginSchemaDefault(root, selected))}
        >
          {t('defaults')}
        </Button>
        <PluginSchemaFields
          key={index}
          root={root}
          schema={selected}
          value={value}
          path={path}
          depth={depth + 1}
          disabled={common.disabled}
          issues={issues}
          onChange={onChange}
          onInvalid={onInvalid}
        />
      </div>
    )
  } else if (kind === 'object') {
    if (!isSchemaObject(value))
      control = (
        <PluginSchemaJson
          path={path}
          value={value}
          disabled={common.disabled}
          onChange={onChange}
          onInvalid={onInvalid}
        />
      )
    else {
      const properties = isSchemaObject(node.properties) ? node.properties : {}
      const required = Array.isArray(node.required) ? (node.required as string[]) : []
      const update = (key: string, next: unknown) => onChange({ ...value, [key]: next })
      const remove = (key: string) =>
        onChange(Object.fromEntries(Object.entries(value).filter(([name]) => name !== key)))
      control = (
        <div className="agnes-settings-stack">
          {Object.entries(properties).map(([key, schema]) => (
            <fieldset key={key} disabled={common.disabled}>
              <legend>
                {key}
                {required.includes(key) ? ` · ${t('required')}` : ''}
              </legend>
              {Object.hasOwn(value, key) ? (
                <>
                  {child(schema as PluginSchema, value[key], key, (next) => update(key, next))}
                  <Button htmlType="button" disabled={common.disabled} onClick={() => remove(key)}>
                    {t('clear')}
                  </Button>
                </>
              ) : (
                <Button
                  htmlType="button"
                  disabled={common.disabled}
                  onClick={() => update(key, pluginSchemaDefault(root, schema as PluginSchema))}
                >
                  {t('create')}
                </Button>
              )}
            </fieldset>
          ))}
          {Object.entries(value)
            .filter(([key]) => !Object.hasOwn(properties, key))
            .map(([key, item]) => (
              <fieldset key={key}>
                <legend>{key}</legend>
                <SettingsInput
                  aria-label={t('rename')}
                  data-testid={`plugin-config-key${childPath(path, key)}`}
                  disabled={common.disabled}
                  defaultValue={key}
                  onBlur={(event) => {
                    const name = event.currentTarget.value
                    if (name && name !== key && !Object.hasOwn(value, name))
                      onChange(
                        Object.fromEntries(
                          Object.entries(value).map(([existing, value]) => [
                            existing === key ? name : existing,
                            value,
                          ]),
                        ),
                      )
                    else event.currentTarget.value = key
                  }}
                />
                {child((node.additionalProperties ?? true) as PluginSchema, item, key, (next) =>
                  update(key, next),
                )}
                <Button htmlType="button" disabled={common.disabled} onClick={() => remove(key)}>
                  {t('remove')}
                </Button>
              </fieldset>
            ))}
          {node.additionalProperties !== false && (
            <div>
              <SettingsInput
                aria-label={t('key')}
                data-testid={`plugin-config-new-key${path || '/'}`}
                disabled={common.disabled}
                value={newKey}
                onChange={(event) => setNewKey(event.currentTarget.value)}
              />
              <Button
                htmlType="button"
                data-testid={`plugin-config-add-key${path || '/'}`}
                disabled={common.disabled || !newKey || Object.hasOwn(value, newKey)}
                onClick={() => {
                  update(
                    newKey,
                    pluginSchemaDefault(root, (node.additionalProperties ?? true) as PluginSchema),
                  )
                  setNewKey('')
                }}
              >
                {t('addKey')}
              </Button>
            </div>
          )}
        </div>
      )
    }
  } else if (kind === 'array') {
    if (!Array.isArray(value))
      control = (
        <PluginSchemaJson
          path={path}
          value={value}
          disabled={common.disabled}
          onChange={onChange}
          onInvalid={onInvalid}
        />
      )
    else
      control = (
        <div className="agnes-settings-stack">
          {value.map((item, index) => (
            <fieldset key={index}>
              <legend>{index + 1}</legend>
              {child((node.items ?? true) as PluginSchema, item, index, (next) =>
                onChange(value.map((item, i) => (i === index ? next : item))),
              )}
              <Button
                htmlType="button"
                disabled={common.disabled}
                onClick={() => onChange(value.filter((_, i) => i !== index))}
              >
                {t('remove')}
              </Button>
            </fieldset>
          ))}
          <Button
            htmlType="button"
            data-testid={`plugin-config-add-item${path || '/'}`}
            disabled={common.disabled || (typeof node.maxItems === 'number' && value.length >= node.maxItems)}
            onClick={() =>
              onChange([...value, pluginSchemaDefault(root, (node.items ?? true) as PluginSchema)])
            }
          >
            {t('add')}
          </Button>
        </div>
      )
  } else if (kind === 'enum') {
    const choices = (Array.isArray(node.enum) ? node.enum : [node.const]) as unknown[]
    const selected = choices.findIndex((item) => JSON.stringify(item) === JSON.stringify(value))
    control = (
      <SettingsSelect
        {...common}
        value={selected}
        onChange={(event) => onChange(structuredClone(choices[Number(event.currentTarget.value)]))}
      >
        {selected < 0 && <option value={-1}>{JSON.stringify(value)}</option>}
        {choices.map((item, index) => (
          <option key={index} value={index}>
            {typeof item === 'string' ? item : JSON.stringify(item)}
          </option>
        ))}
      </SettingsSelect>
    )
  } else if (kind === 'boolean') {
    control = (
      <input
        {...common}
        type="checkbox"
        checked={value === true}
        onChange={(event) => onChange(event.currentTarget.checked)}
      />
    )
  } else if (kind === 'null') {
    control = (
      <PluginSchemaJson
        path={path}
        value={value}
        disabled={common.disabled}
        onChange={onChange}
        onInvalid={onInvalid}
      />
    )
  } else {
    const format = node.format === 'email' ? 'email' : node.format === 'uri' ? 'url' : 'text'
    control = (
      <>
        <SettingsInput
          {...common}
          type={kind === 'number' ? 'number' : format}
          step={node.type === 'integer' ? 1 : 'any'}
          value={String(value ?? '')}
          onChange={(event) => {
            const next = event.currentTarget.value
            onChange(kind === 'number' ? (next === '' ? null : Number(next)) : next)
          }}
        />
      </>
    )
  }
  return (
    <div className="config-field" data-testid={`plugin-config-node${path || '/'}@${depth}`}>
      {typeof node.title === 'string' && <label htmlFor={id}>{node.title}</label>}
      {control}
      <div id={`${id}-help`}>
        {typeof node.description === 'string' && <p>{node.description}</p>}
        {typeof node.format === 'string' && <p>{t('format', { format: node.format })}</p>}
        {fieldIssues.map((issue, index) => (
          <p role="alert" key={`${issue.code}:${index}`}>
            {t('invalid', { code: issue.code })}
          </p>
        ))}
      </div>
    </div>
  )
}
