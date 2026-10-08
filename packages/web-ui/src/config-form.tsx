import { type ReactNode, useEffect, useRef, useState } from 'react'
import {
  type ConfigIssue,
  type ConfigSchema,
  configChoices,
  configIssues,
  configSchemaSupported,
} from './config-schema.js'
import { CONFIG_FORM_NAMESPACE, configFormCatalog } from './locales/config-form.js'
import type { Translate } from './locales/index.js'
import { SettingsInput, SettingsSelect, SettingsState, SettingsTextArea } from './settings-layout.js'
import { Button } from './ui/button.js'
import { Field } from './ui/field.js'
import { useUiText } from './ui-locale.js'

/** A schema control can retain a native page's existing Field/label wrapper and IDs. */
export function SchemaControl({
  schema,
  value,
  onChange,
  t,
  disabled,
  id,
  testId,
  ariaLabel,
  invalid,
  describedBy,
}: {
  schema: ConfigSchema
  value: unknown
  onChange(value: unknown): void
  t: Translate
  disabled?: boolean | undefined
  id?: string | undefined
  testId?: string | undefined
  ariaLabel?: string | undefined
  invalid?: boolean | undefined
  describedBy?: string | undefined
}) {
  const arrayText = Array.isArray(value) ? value.join('\n') : String(value ?? '')
  const [draftText, setDraftText] = useState(arrayText)
  const lastValue = useRef(value)
  useEffect(() => {
    if (JSON.stringify(lastValue.current) !== JSON.stringify(value)) setDraftText(arrayText)
    lastValue.current = value
  }, [value, arrayText])
  const ui = schema['x-ui']
  const props = { id: id ?? ui?.id, 'data-testid': testId ?? ui?.testId, 'aria-label': ariaLabel, disabled }
  const choices = configChoices(schema)
  if (choices)
    return (
      <SettingsSelect
        {...props}
        value={String(value ?? '')}
        onChange={(event) => onChange(choices.find((item) => String(item) === event.target.value))}
      >
        {choices.map((item) => (
          <option key={String(item)} value={String(item)}>
            {ui?.optionKeys?.[String(item)] ? t(ui.optionKeys[String(item)]!) : String(item)}
          </option>
        ))}
      </SettingsSelect>
    )
  if (schema.type === 'boolean')
    return (
      <SettingsInput
        {...props}
        type="checkbox"
        checked={value === true}
        onChange={(event) => onChange(event.target.checked)}
      />
    )
  if (schema.type === 'array' || ui?.control === 'textarea')
    return (
      <SettingsTextArea
        {...props}
        value={draftText}
        onChange={(event) => {
          setDraftText(event.target.value)
          const next =
            schema.type === 'array'
              ? event.target.value
                  .split('\n')
                  .map((line) => line.trim())
                  .filter(Boolean)
              : event.target.value
          lastValue.current = next
          onChange(next)
        }}
      />
    )
  const numeric = schema.type === 'number' || schema.type === 'integer'
  return (
    <SettingsInput
      {...props}
      type={numeric ? 'number' : 'text'}
      autoComplete="off"
      spellCheck={schema.format === 'credential-reference' ? false : undefined}
      value={String(value ?? '')}
      min={schema.minimum}
      max={schema.maximum}
      step={schema.type === 'integer' ? 1 : numeric ? 'any' : undefined}
      maxLength={schema.maxLength}
      placeholder={ui?.placeholderKey ? t(ui.placeholderKey) : undefined}
      onChange={(event) =>
        onChange(numeric && event.target.value !== '' ? Number(event.target.value) : event.target.value)
      }
    />
  )
}

function translatedFields(schema: ConfigSchema, t: Translate): boolean {
  return Object.values(schema.properties ?? {}).every((field) => {
    const ui = field['x-ui']
    if (!ui) return false
    const keys = [ui.labelKey, ui.hintKey, ui.placeholderKey, ...Object.values(ui.optionKeys ?? {})].filter(
      (key): key is string => !!key,
    )
    return (
      keys.every((key) => !!t(key) && t(key) !== key) &&
      (field.type !== 'object' || translatedFields(field, t))
    )
  })
}

/** Fields only: no new wrappers, actions or requests in migrated built-in forms. */
export function SchemaConfigFields({
  schema,
  value,
  onChange,
  t,
  disabled,
  issues = [],
  prefix = 'config',
  path = '',
}: {
  schema: ConfigSchema
  value: Readonly<Record<string, unknown>>
  onChange(value: Record<string, unknown>): void
  t: Translate
  disabled?: boolean | undefined
  issues?: readonly ConfigIssue[]
  prefix?: string
  path?: string
}) {
  const { t: text } = useUiText(CONFIG_FORM_NAMESPACE, configFormCatalog)
  if (!configSchemaSupported(schema) || schema.type !== 'object' || !translatedFields(schema, t))
    return <SettingsState tone="error">{text('error.schema')}</SettingsState>
  const fields: ReactNode[] = []
  for (const [key, field] of Object.entries(schema.properties ?? {})) {
    const ui = field['x-ui']
    const label = ui ? t(ui.labelKey) : ''
    if (!ui || !label || label === ui.labelKey)
      return <SettingsState tone="error">{text('error.schema')}</SettingsState>
    const fieldPath = `${path}/${key.replace(/~/g, '~0').replace(/\//g, '~1')}`
    const id = ui.id ?? `${prefix}-${encodeURIComponent(key)}`
    const problem = issues.find((issue) => issue.path === fieldPath || issue.path.startsWith(`${fieldPath}/`))
    if (field.type === 'object')
      fields.push(
        <fieldset key={key} disabled={disabled}>
          <legend>{label}</legend>
          {problem?.path === fieldPath && (
            <SettingsState tone="error">{text(`error.${problem.code}`)}</SettingsState>
          )}
          <SchemaConfigFields
            schema={field}
            value={
              value[key] && typeof value[key] === 'object' && !Array.isArray(value[key])
                ? (value[key] as Record<string, unknown>)
                : {}
            }
            onChange={(next) => onChange({ ...value, [key]: next })}
            t={t}
            disabled={disabled}
            issues={issues}
            prefix={id}
            path={fieldPath}
          />
        </fieldset>,
      )
    else
      fields.push(
        <Field
          key={key}
          label={label}
          htmlFor={id}
          hint={ui.hintKey ? <span id={`${id}-hint`}>{t(ui.hintKey)}</span> : undefined}
          error={problem ? <span id={`${id}-error`}>{text(`error.${problem.code}`)}</span> : undefined}
        >
          <SchemaControl
            schema={field}
            value={value[key]}
            onChange={(next) => onChange({ ...value, [key]: next })}
            t={t}
            disabled={disabled}
            id={id}
            testId={ui.testId}
            invalid={!!problem}
            describedBy={
              [ui.hintKey ? `${id}-hint` : undefined, problem ? `${id}-error` : undefined]
                .filter(Boolean)
                .join(' ') || undefined
            }
          />
        </Field>,
      )
  }
  return <>{fields}</>
}

export type ConfigAction = (
  value: Readonly<Record<string, unknown>>,
  context: { signal: AbortSignal },
) => Promise<void>
/** Caller-owned data and authorized actions; no persistence or credential resolution in the UI. */
export function SchemaConfigForm({
  schema,
  value,
  onChange,
  onSave,
  onTest,
  t,
  readOnly = false,
  testId = 'schema-config-form',
}: {
  schema: ConfigSchema
  value: Readonly<Record<string, unknown>>
  onChange(value: Record<string, unknown>): void
  onSave?: ConfigAction
  onTest?: ConfigAction
  t: Translate
  readOnly?: boolean
  testId?: string | undefined
}) {
  const { t: text } = useUiText(CONFIG_FORM_NAMESPACE, configFormCatalog)
  const [issues, setIssues] = useState<readonly ConfigIssue[]>([])
  const [status, setStatus] = useState<'saved' | 'tested' | 'error.action'>()
  const [busy, setBusy] = useState(false)
  const pending = useRef<AbortController>()
  useEffect(
    () => () => {
      pending.current?.abort()
    },
    [],
  )
  useEffect(() => {
    if (readOnly) {
      pending.current?.abort()
      pending.current = undefined
      setBusy(false)
    }
  }, [readOnly])
  const supported = configSchemaSupported(schema) && schema.type === 'object' && translatedFields(schema, t)
  async function run(action: ConfigAction | undefined, success: 'saved' | 'tested') {
    if (!action || readOnly || pending.current || !supported) return
    const errors = configIssues(schema, value)
    setIssues(errors)
    setStatus(undefined)
    if (errors.length) return
    const abort = new AbortController()
    pending.current = abort
    setBusy(true)
    try {
      await action(structuredClone(value), { signal: abort.signal })
      if (!abort.signal.aborted) setStatus(success)
    } catch {
      if (!abort.signal.aborted) setStatus('error.action')
    } finally {
      if (pending.current === abort) pending.current = undefined
      if (!abort.signal.aborted) setBusy(false)
    }
  }
  return (
    <form
      data-testid={testId}
      aria-busy={busy}
      noValidate
      onSubmit={(event) => {
        event.preventDefault()
        void run(onSave, 'saved')
      }}
    >
      <SchemaConfigFields
        schema={schema}
        value={value}
        onChange={(next) => {
          onChange(next)
          setIssues([])
          setStatus(undefined)
        }}
        t={t}
        disabled={readOnly || busy || !supported}
        issues={issues}
        prefix={testId}
      />
      {issues.some((issue) => issue.code === 'unknown' || issue.code === 'schema') && (
        <SettingsState tone="error">
          {text(`error.${issues.find((issue) => issue.code === 'unknown' || issue.code === 'schema')?.code}`)}
        </SettingsState>
      )}
      {onSave && (
        <Button htmlType="submit" loading={busy} disabled={readOnly || busy || !supported}>
          {text('save')}
        </Button>
      )}
      {onTest && (
        <Button
          htmlType="button"
          disabled={readOnly || busy || !supported}
          onClick={() => void run(onTest, 'tested')}
        >
          {text('test')}
        </Button>
      )}
      {status && (
        <SettingsState tone={status === 'error.action' ? 'error' : 'success'}>{text(status)}</SettingsState>
      )}
    </form>
  )
}
