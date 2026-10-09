/**
 * Tools as forms (mhs-ui-design section 10): each parameter becomes a control from its schema, the
 * call runs through `hub/call`, and the job shows its progress, pause, result or rejection.
 * Writable state fields become controls that save through `hub/set`.
 */
import { useState } from 'react'
import { paramsOf } from '../core/describe.js'
import type { Device, Field, Json, Param, Tool } from '../core/types.js'
import { elapsed, t, word } from '../i18n/i18n.js'
import { useJob, useNow, useStore } from '../react/hooks.js'
import { fieldLabel } from '../widgets/fields.js'
import type { Pick } from '../widgets/map.js'
import { Bar, Button, niceStep, Segmented, Select, Slider, TextInput, Toggle } from './ui.js'

export type RequestPick = (mode: Pick['mode'], onPick: (value: unknown) => void) => void

function initial(p: Param): unknown {
  if (p.default !== undefined) return p.default
  if (p.enum?.length) return undefined
  if (p.type === 'boolean') return false
  // A slider always shows a value, so it starts with the one it shows.
  if ((p.type === 'number' || p.type === 'integer') && p.minimum !== undefined && p.maximum !== undefined) {
    const mid = (p.minimum + p.maximum) / 2
    return p.type === 'integer' ? Math.round(mid) : mid
  }
  return undefined
}

export function ParamControl(props: {
  name: string
  param: Param
  value: unknown
  onChange: (v: unknown) => void
  requestPick?: RequestPick | undefined
  disabled?: boolean
}) {
  const { param, value, onChange } = props
  if (param.ui?.pick && props.requestPick) {
    return (
      <span className="mhs-pick">
        <Button
          small
          onClick={() => props.requestPick?.(param.ui?.pick as Pick['mode'], onChange)}
          disabled={props.disabled}
        >
          {t('tool.pick')}
        </Button>
        <code>{value === undefined ? '—' : JSON.stringify(value)}</code>
      </span>
    )
  }
  if (param.enum?.length) {
    const options = param.enum.map(String)
    const short = options.length <= 4 && options.every((o) => o.length <= 12)
    return short ? (
      <Segmented
        value={value === undefined ? '' : String(value)}
        options={options}
        onChange={onChange}
        disabled={props.disabled}
      />
    ) : (
      <Select
        value={value === undefined ? '' : String(value)}
        options={options}
        onChange={onChange}
        placeholder="—"
        disabled={props.disabled}
      />
    )
  }
  if (param.type === 'boolean')
    return <Toggle on={value === true} onChange={onChange} disabled={props.disabled} label={props.name} />
  if (param.type === 'number' || param.type === 'integer') {
    if (param.minimum !== undefined && param.maximum !== undefined)
      return (
        <Slider
          value={typeof value === 'number' ? value : (param.minimum + param.maximum) / 2}
          min={param.minimum}
          max={param.maximum}
          step={niceStep(param.minimum, param.maximum, param.type === 'integer')}
          onChange={onChange}
          disabled={props.disabled}
        />
      )
    return (
      <input
        type="number"
        className="mhs-input mhs-num"
        value={typeof value === 'number' ? value : ''}
        min={param.minimum}
        max={param.maximum}
        disabled={props.disabled}
        onChange={(e) => onChange(e.target.value === '' ? undefined : Number(e.target.value))}
      />
    )
  }
  if (param.type === 'string')
    return (
      <TextInput
        value={typeof value === 'string' ? value : ''}
        onChange={(v) => onChange(v === '' ? undefined : v)}
        maxLength={param.maxLength}
        multiline={(param.maxLength ?? 0) > 120}
        disabled={props.disabled}
      />
    )
  return <JsonInput value={value} onChange={onChange} disabled={props.disabled} />
}

function JsonInput(props: {
  value: unknown
  onChange: (v: unknown) => void
  disabled?: boolean | undefined
}) {
  const [text, setText] = useState(props.value === undefined ? '' : JSON.stringify(props.value))
  const [bad, setBad] = useState(false)
  return (
    <span className="mhs-json-input">
      <TextInput
        multiline
        value={text}
        placeholder={t('tool.json')}
        disabled={props.disabled}
        onChange={(v) => {
          setText(v)
          if (v.trim() === '') {
            setBad(false)
            props.onChange(undefined)
            return
          }
          try {
            props.onChange(JSON.parse(v))
            setBad(false)
          } catch {
            setBad(true)
          }
        }}
      />
      {bad && <span className="mhs-note mhs-note-bad">{t('tool.json.invalid')}</span>}
    </span>
  )
}

/** The status line of a job this page started. */
export function JobStatus(props: { id: string }) {
  const store = useStore()
  const job = useJob(props.id)
  const now = useNow(500)
  const [started] = useState(() => Date.now())
  if (!job) return null
  if (job.state === 'rejected' || job.state === 'failed')
    return (
      <div className="mhs-job" data-state="bad">
        {job.text}
      </div>
    )
  if (job.state === 'ended' && job.result) {
    const r = job.result
    const ok = r.status === 'done'
    return (
      <div className="mhs-job" data-state={ok ? 'ok' : 'bad'}>
        <strong>
          {ok
            ? t('tool.done', { elapsed: elapsed(((r.time ?? now / 1000) * 1000 - started) / 1000) })
            : `${word('status', r.status)} · ${word('reason', r.reason ?? '', r.reason)}`}
        </strong>{' '}
        {r.detail}
        {r.notes?.length ? <div className="mhs-note">{r.notes.join('; ')}</div> : null}
      </div>
    )
  }
  const p = job.progress
  return (
    <div className="mhs-job" data-state={job.state === 'paused' ? 'warn' : 'busy'}>
      <div className="mhs-job-head">
        <strong>
          {job.state === 'paused'
            ? t('tool.paused', { reason: p?.reason ?? '' })
            : t('tool.running', { elapsed: elapsed((now - started) / 1000) })}
        </strong>
        {job.job && (
          <span className="mhs-job-actions">
            {job.state === 'paused' ? (
              <Button
                small
                onClick={() => void store.control('hub/resume', job.job as string).catch(() => undefined)}
              >
                {t('tool.resume')}
              </Button>
            ) : null}
            <Button
              small
              kind="ghost"
              onClick={() => void store.control('hub/cancel', job.job as string).catch(() => undefined)}
            >
              {t('tool.cancel')}
            </Button>
          </span>
        )}
      </div>
      {p?.total ? <Bar done={p.done ?? 0} total={p.total} /> : null}
      {p?.text && <div className="mhs-note">{p.text}</div>}
    </div>
  )
}

export function ToolForm(props: { device: Device; tool: Tool; requestPick?: RequestPick | undefined }) {
  const store = useStore()
  const params = paramsOf(props.tool)
  const [values, setValues] = useState<Json>(() =>
    Object.fromEntries(params.map(([name, p]) => [name, initial(p)]).filter(([, v]) => v !== undefined)),
  )
  const [job, setJob] = useState<string | undefined>()
  const [confirming, setConfirming] = useState(false)
  const [open, setOpen] = useState(params.length === 0)
  const missing = params
    .filter(([name, , required]) => required && values[name] === undefined)
    .map(([n]) => n)
  const disabled = !props.device.available || store.conn !== 'open'
  const run = () => {
    setConfirming(false)
    setJob(store.call(props.device.id, props.tool.name, values))
  }
  const confirm = props.tool.ui?.confirm
  return (
    <div className="mhs-tool" data-open={open || undefined}>
      <div className="mhs-tool-head">
        <button
          type="button"
          className="mhs-tool-name"
          onClick={() => setOpen(!open)}
          title={props.tool.description}
        >
          <code>{props.tool.ui?.label ?? props.tool.name}</code>
          <span className="mhs-tool-desc">{props.tool.description}</span>
        </button>
        <Button
          small
          kind="primary"
          disabled={disabled || missing.length > 0}
          title={missing.length ? `${t('tool.required')}: ${missing.join(', ')}` : undefined}
          onClick={() => (confirm ? setConfirming(true) : run())}
        >
          {t('tool.run')}
        </Button>
      </div>
      {open && params.length > 0 && (
        <div className="mhs-tool-params">
          {params.map(([name, p, required]) => (
            <div key={name} className="mhs-param" title={p.description}>
              <span className="mhs-param-name">
                {p.ui?.label ?? name}
                {required && (
                  <i className="mhs-required" title={t('tool.required')}>
                    *
                  </i>
                )}
              </span>
              <ParamControl
                name={name}
                param={p}
                value={values[name]}
                onChange={(v) => setValues((old) => ({ ...old, [name]: v }))}
                requestPick={props.requestPick}
                disabled={disabled}
              />
              {p.description && <span className="mhs-param-hint">{p.description}</span>}
            </div>
          ))}
        </div>
      )}
      {confirming && (
        <div className="mhs-confirm">
          <span>
            {typeof confirm === 'string'
              ? confirm
              : t('tool.confirm', { tool: props.tool.name, device: props.device.id })}
          </span>
          <Button small kind="danger" onClick={run}>
            {t('tool.confirm.yes')}
          </Button>
          <Button small kind="ghost" onClick={() => setConfirming(false)}>
            {t('tool.confirm.no')}
          </Button>
        </div>
      )}
      {job && <JobStatus id={job} />}
    </div>
  )
}

/** A writable state field as a control; read-only fields are shown by FieldView instead. */
export function StateControl(props: { device: Device; name: string; field: Field; value: unknown }) {
  const store = useStore()
  const { field, name } = props
  const [draft, setDraft] = useState<unknown>(undefined)
  const [note, setNote] = useState<string | undefined>()
  const [saving, setSaving] = useState(false)
  const disabled = !props.device.available || store.conn !== 'open' || saving
  const shown = draft ?? props.value
  const save = (v: unknown) => {
    if (v === props.value) {
      setDraft(undefined)
      return
    }
    setSaving(true)
    store.set(props.device.id, { [name]: v }).then(
      (r) => {
        const refused = r.refused?.[name]
        setNote(
          refused ? t('set.refused', { reason: refused }) : r.notes?.length ? r.notes.join('; ') : undefined,
        )
        setDraft(undefined)
        setSaving(false)
      },
      (e: Error) => {
        setNote(e.message)
        setDraft(undefined)
        setSaving(false)
      },
    )
  }
  let control: React.ReactNode
  if (field.type === 'boolean')
    control = <Toggle on={shown === true} onChange={save} disabled={disabled} label={name} />
  else if (field.enum)
    control =
      field.enum.length <= 4 ? (
        <Segmented value={String(shown ?? '')} options={field.enum} onChange={save} disabled={disabled} />
      ) : (
        <Select value={String(shown ?? '')} options={field.enum} onChange={save} disabled={disabled} />
      )
  else if (
    (field.type === 'number' || field.type === 'integer') &&
    field.min !== undefined &&
    field.max !== undefined
  )
    control = (
      <Slider
        value={typeof shown === 'number' ? shown : field.min}
        min={field.min}
        max={field.max}
        step={niceStep(field.min, field.max, field.type === 'integer')}
        onChange={setDraft}
        onCommit={save}
        disabled={disabled}
      />
    )
  else if (field.type === 'number' || field.type === 'integer')
    control = (
      <input
        type="number"
        className="mhs-input mhs-num"
        value={typeof shown === 'number' ? shown : ''}
        disabled={disabled}
        onChange={(e) => setDraft(Number(e.target.value))}
        onBlur={(e) => save(Number(e.target.value))}
      />
    )
  else
    control = (
      <TextInput value={String(shown ?? '')} onChange={setDraft} onCommit={save} disabled={disabled} />
    )
  return (
    <div className="mhs-field mhs-field-writable" title={field.description}>
      <span className="mhs-field-label">
        {fieldLabel(name, field)} {field.unit && <small>{field.unit}</small>}
      </span>
      {control}
      {saving && <span className="mhs-note">{t('set.saving')}</span>}
      {note && <span className="mhs-note">{note}</span>}
    </div>
  )
}
