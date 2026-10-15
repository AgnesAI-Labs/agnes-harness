import { Button } from '@agnes/web-ui'
import { useId, useState } from 'react'
import { type PickMode, WorldMap } from './map.js'
import { array, asJson, type Data, type Device, jsonText, number, record, text } from './model.js'
import { ActionFeedback, useAction, useMhs, useSnapshot } from './react.js'

const INVALID_INPUT = Symbol('invalid-json')
export function validValue(schema: Data, value: unknown): boolean {
  if (value === undefined || typeof value === 'symbol') return false
  if (Array.isArray(schema.enum) && !schema.enum.some((v) => JSON.stringify(v) === JSON.stringify(value)))
    return false
  switch (schema.type) {
    case 'number':
    case 'integer':
      return (
        typeof value === 'number' &&
        Number.isFinite(value) &&
        (schema.type !== 'integer' || Number.isInteger(value)) &&
        value >= number(schema.minimum ?? schema.min, -Infinity) &&
        value <= number(schema.maximum ?? schema.max, Infinity)
      )
    case 'boolean':
      return typeof value === 'boolean'
    case 'string':
      return (
        typeof value === 'string' &&
        value.length >= number(schema.minLength) &&
        value.length <= number(schema.maxLength, 4096)
      )
    case 'object':
      return value !== null && typeof value === 'object' && !Array.isArray(value)
    case 'array':
      return Array.isArray(value)
    default:
      return true
  }
}
function JsonInput({
  id,
  value,
  onChange,
  disabled,
}: {
  id: string
  value: unknown
  onChange(v: unknown): void
  disabled: boolean
}) {
  const [draft, setDraft] = useState(value === undefined ? '' : jsonText(value)),
    [invalid, setInvalid] = useState(false)
  return (
    <textarea
      id={id}
      value={draft}
      disabled={disabled}
      aria-invalid={invalid}
      onChange={(e) => {
        const raw = e.target.value
        setDraft(raw)
        try {
          const v = JSON.parse(raw)
          setInvalid(false)
          onChange(v)
        } catch {
          setInvalid(true)
          onChange(INVALID_INPUT)
        }
      }}
    />
  )
}
export function Input({
  id,
  schema,
  value,
  onChange,
  disabled = false,
  onPick,
}: {
  id: string
  schema: Data
  value: unknown
  onChange(v: unknown): void
  disabled?: boolean
  onPick?: (mode: PickMode) => void
}) {
  const { t } = useMhs(),
    pick = text(record(schema.ui).pick)
  if (onPick && ['point', 'pose', 'polygon'].includes(pick))
    return (
      <span>
        <code>{value === undefined ? '—' : jsonText(value)}</code>
        <Button id={id} disabled={disabled} onClick={() => onPick(pick as PickMode)}>
          {t('pick')}
        </Button>
      </span>
    )
  if (Array.isArray(schema.enum))
    return (
      <select
        id={id}
        value={value === undefined ? '' : JSON.stringify(value)}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value === '' ? undefined : JSON.parse(e.target.value))}
      >
        <option value="">—</option>
        {schema.enum.map((v) => (
          <option key={JSON.stringify(v)} value={JSON.stringify(v)}>
            {String(v)}
          </option>
        ))}
      </select>
    )
  if (schema.type === 'boolean')
    return (
      <input
        id={id}
        type="checkbox"
        checked={value === true}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
      />
    )
  if (schema.type === 'number' || schema.type === 'integer')
    return (
      <input
        id={id}
        type="number"
        value={typeof value === 'number' ? value : ''}
        step={schema.type === 'integer' ? 1 : 'any'}
        min={
          typeof (schema.minimum ?? schema.min) === 'number'
            ? number(schema.minimum ?? schema.min)
            : undefined
        }
        max={
          typeof (schema.maximum ?? schema.max) === 'number'
            ? number(schema.maximum ?? schema.max)
            : undefined
        }
        disabled={disabled}
        onChange={(e) => onChange(e.target.value === '' ? undefined : Number(e.target.value))}
      />
    )
  if (schema.type === 'string')
    return (
      <input
        id={id}
        value={typeof value === 'string' ? value : ''}
        maxLength={number(schema.maxLength, 4096)}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value)}
      />
    )
  return <JsonInput id={id} value={value} onChange={onChange} disabled={disabled} />
}
export function ToolForm({ device, tool }: { device: Device; tool: Data }) {
  const { t } = useMhs(),
    snapshot = useSnapshot(),
    schema = record(tool.inputSchema),
    properties = record(schema.properties),
    action = useAction(),
    id = useId()
  const [values, setValues] = useState<Data>(() =>
    Object.fromEntries(
      Object.entries(properties)
        .filter(([, v]) => Object.hasOwn(record(v), 'default'))
        .map(([k, v]) => [k, record(v).default]),
    ),
  )
  const [confirm, setConfirm] = useState(false),
    [pick, setPick] = useState<{ name: string; mode: PickMode }>()
  const required = array(schema.required).map(text),
    invalid = Object.entries(properties).some(([key, def]) =>
      required.includes(key)
        ? !validValue(record(def), values[key])
        : values[key] !== undefined && !validValue(record(def), values[key]),
    )
  const disabled = !device.available || action.busy || action.pending
  const update = (key: string, value: unknown) => {
    setConfirm(false)
    setValues((v) => ({ ...v, [key]: value }))
  }
  const run = () => {
    setConfirm(false)
    void action.run('call', {
      device: device.id,
      tool: text(tool.name),
      args: asJson(Object.fromEntries(Object.entries(values).filter(([, v]) => v !== undefined))),
    })
  }
  return (
    <details className="mhs-tool">
      <summary>
        {text(tool.name)} {tool.motion === true && '↗'}
      </summary>
      <p>{text(tool.description)}</p>
      <form
        onSubmit={(e) => {
          e.preventDefault()
          if (disabled || invalid) return
          if (tool.motion === true || record(tool.ui).confirm) setConfirm(true)
          else run()
        }}
      >
        {Object.entries(properties).map(([key, raw]) => (
          <label key={key} htmlFor={`${id}-${key}`} className="mhs-field">
            <span>
              {key}
              {required.includes(key) && ' *'}
            </span>
            <Input
              id={`${id}-${key}`}
              schema={record(raw)}
              value={values[key]}
              disabled={disabled}
              onChange={(v) => update(key, v)}
              onPick={(mode) => setPick({ name: key, mode })}
            />
          </label>
        ))}
        {pick && (
          <WorldMap
            maps={snapshot.maps}
            devices={snapshot.devices}
            mode={pick.mode}
            onPick={(v) => {
              update(pick.name, v)
              setPick(undefined)
            }}
            onCancel={() => setPick(undefined)}
          />
        )}
        <Button
          htmlType="submit"
          appearance="primary"
          disabled={disabled || invalid}
          {...(invalid ? { disabledReason: t('required') } : {})}
          loading={action.busy}
        >
          {t('run')}
        </Button>
      </form>
      {confirm && (
        <fieldset aria-labelledby={id} className="mhs-confirm">
          <strong id={id}>{t('confirm')}</strong>
          <p>{t('confirmHelp')}</p>
          <Button onClick={() => setConfirm(false)}>{t('cancel')}</Button>
          <Button disabled={disabled || invalid} onClick={run}>
            {t('run')}
          </Button>
        </fieldset>
      )}
      <ActionFeedback action={action} />
      <Operation receipt={action.receipt} device={device.id} />
    </details>
  )
}

import { useEffect, useState as useJobState } from 'react'
import type { Receipt } from './ports.js'

function Operation({ receipt, device }: { receipt: Receipt | undefined; device: string }) {
  const { client, t } = useMhs(),
    [operation, setOperation] = useJobState<Data>(),
    action = useAction()
  const output = receipt?.state === 'completed' ? record(receipt.output) : {},
    operationId = text(output.id)
  useEffect(() => {
    if (!operationId) {
      setOperation(undefined)
      return
    }
    const abort = new AbortController()
    let timer: ReturnType<typeof setTimeout>
    const read = async () => {
      try {
        const v = record(await client.query('operation', { operationId }, abort.signal))
        if (!abort.signal.aborted) {
          setOperation(v)
          if (v.state !== 'terminal') timer = setTimeout(read, 750)
        }
      } catch {
        if (!abort.signal.aborted) setOperation({ state: 'unknown' })
      }
    }
    void read()
    return () => {
      abort.abort()
      clearTimeout(timer)
    }
  }, [client, operationId])
  if (!operation) return null
  const state = text(operation.state),
    outcome = record(operation.outcome)
  return (
    <div role="status">
      {text(outcome.status) || state} {text(outcome.reason)}{' '}
      {typeof operation.progress === 'number' && <progress value={operation.progress} max={1} />}
      {state === 'paused' && (
        <Button onClick={() => void action.run('resume', { device, params: { call: operationId } })}>
          {t('resume')}
        </Button>
      )}
      {['running', 'accepted', 'paused'].includes(state) && (
        <Button onClick={() => void action.run('cancel', { device, params: { call: operationId } })}>
          {t('cancel')}
        </Button>
      )}
      <ActionFeedback action={action} />
    </div>
  )
}
export function StateField({ device, name, schema }: { device: Device; name: string; schema: Data }) {
  const action = useAction(),
    { t } = useMhs(),
    [value, setValue] = useState<unknown>(device.state[name]),
    [dirty, setDirty] = useState(false)
  const id = useId()
  return (
    <div className="mhs-field">
      <label htmlFor={id}>
        <span>
          {name} {text(schema.unit)}
        </span>
        <Input
          id={id}
          schema={schema}
          value={dirty ? value : device.state[name]}
          disabled={!device.available || schema.writable !== true || action.busy || action.pending}
          onChange={(v) => {
            setValue(v)
            setDirty(true)
          }}
        />
      </label>
      <Button
        disabled={
          !dirty ||
          !validValue(schema, value) ||
          !device.available ||
          schema.writable !== true ||
          action.busy ||
          action.pending
        }
        onClick={() => void action.run('set', { device: device.id, values: asJson({ [name]: value }) })}
      >
        {t('run')}
      </Button>
      <ActionFeedback action={action} />
    </div>
  )
}
