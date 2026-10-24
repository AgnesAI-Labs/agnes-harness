import type { HTMLAttributes, ReactNode } from 'react'
import { useId, useLayoutEffect, useRef, useState } from 'react'

import { fallbackT } from '../locales/index.js'
import { createSelectPicker, type SelectPicker } from '../select-picker.js'
import { SettingsGroup, SettingsInput, SettingsSelect } from '../settings-layout.js'
import { presetChoice, type SettingsPreset } from '../settings-values.js'
import { Icon } from './icon.js'
import { Loadable } from './loadable.js'

type DataAttributes = { [name: `data-${string}`]: string | number | boolean | undefined }

/**
 * A labelled run of rows: the bare noun above, its actions on the right of the label, the rows in
 * one quiet outline. A failed save is told at the label (「Save failed · Retry」); a failed read is one
 * line with 「Retry」 that leaves what was already shown in place.
 */
export function SettingsBlock({
  label,
  actions,
  failed = false,
  onRetry,
  state,
  onReload,
  bare = false,
  children,
  ...props
}: Omit<HTMLAttributes<HTMLElement>, 'title'> &
  DataAttributes & {
    label?: ReactNode
    actions?: ReactNode
    /** The last save in this group failed. */
    failed?: boolean
    onRetry?: (() => void) | undefined
    /** Reading what the group shows: still loading, or it failed. */
    state?: 'loading' | 'error' | undefined
    onReload?: (() => void) | undefined
    /** The content brings its own surface (cards, an editor), so no outline is drawn. */
    bare?: boolean
    children?: ReactNode
  }) {
  const labelId = useId()
  const hasContent = children !== undefined && children !== null && children !== false
  return (
    <section
      {...props}
      aria-labelledby={label ? labelId : undefined}
      className={['agnes-settings-block', props.className].filter(Boolean).join(' ')}
    >
      {(label || actions || failed) && (
        <div className="agnes-settings-block-label">
          {label && <h3 id={labelId}>{label}</h3>}
          {failed && (
            <span className="agnes-settings-save-failed" role="alert" data-testid="settings-save-failed">
              {fallbackT('ui.saveFailed')}
              {onRetry && (
                <>
                  {' · '}
                  <button type="button" onClick={onRetry} data-testid="settings-save-retry">
                    {fallbackT('ui.retry')}
                  </button>
                </>
              )}
            </span>
          )}
          {actions && <span className="agnes-settings-block-actions">{actions}</span>}
        </div>
      )}
      {/* Reads show the shared way: nothing for 200 ms, then a placeholder, 「Still reading…」 after
       3 s; a failed read is one line with Retry and keeps what was already shown. */}
      {(state || hasContent) && (
        <Loadable
          loading={state === 'loading'}
          error={state === 'error' ? true : undefined}
          hasData={hasContent}
          shape="rows"
          errorText={fallbackT('ui.readFailed')}
          {...(onReload ? { onRetry: onReload } : {})}
        >
          {bare ? children : <SettingsGroup>{children}</SettingsGroup>}
        </Loadable>
      )}
    </section>
  )
}

export type SettingsTagTone = 'ok' | 'warn' | 'error' | 'muted' | 'brand'

/** The one status mark settings use: Normal / Needs attention / Failed / Disabled / Default. */
export function SettingsTag({
  tone,
  children,
  ...props
}: HTMLAttributes<HTMLSpanElement> & DataAttributes & { tone: SettingsTagTone }) {
  return (
    <span
      {...props}
      className={['agnes-settings-tag', props.className].filter(Boolean).join(' ')}
      data-tone={tone}
    >
      {children}
    </span>
  )
}

/**
 * A number chosen from a few presets: Default (nothing stored), the presets, and Custom, which keeps
 * any other stored value and edits it in its own field.
 */
export function SettingsPresetSelect({
  value,
  presets,
  onChange,
  label,
  defaultLabel = fallbackT('ui.default'),
  allowDefault = true,
  unit,
  scale = 1,
  disabled,
  id,
  ...props
}: DataAttributes & {
  value: number | undefined
  presets: readonly SettingsPreset[]
  onChange(next: number | undefined): void
  /** The accessible name: the row's label. */
  label: string
  defaultLabel?: string
  /** Whether Default (nothing stored) is a choice; off for settings that always hold a number. */
  allowDefault?: boolean
  /** The custom field's unit, e.g. 「seconds」; the field shows `value / scale`. */
  unit?: string
  scale?: number
  disabled?: boolean | undefined
  id?: string
}) {
  const [custom, setCustom] = useState(false)
  const choice = custom ? 'custom' : presetChoice(value, presets)
  const generated = useId()
  const selectId = id ?? generated
  const select = useRef<HTMLSelectElement>(null)
  const picker = useRef<SelectPicker>()
  useLayoutEffect(() => {
    if (!select.current) return
    const created = createSelectPicker(select.current, { label })
    picker.current = created
    return () => {
      picker.current = undefined
      created.destroy()
    }
  }, [label])
  // The picker mirrors the select, so it is brought up to date after every render.
  useLayoutEffect(() => picker.current?.sync())
  return (
    <span className="agnes-settings-preset">
      <SettingsSelect
        {...props}
        id={selectId}
        ref={select}
        aria-label={label}
        value={choice}
        disabled={disabled}
        onChange={(event) => {
          const next = event.currentTarget.value
          setCustom(next === 'custom')
          if (next === 'default') onChange(undefined)
          else if (next !== 'custom') onChange(Number(next))
        }}
      >
        {allowDefault && <option value="default">{defaultLabel}</option>}
        {presets.map((preset) => (
          <option key={preset.value} value={String(preset.value)}>
            {preset.label}
          </option>
        ))}
        <option value="custom">{fallbackT('ui.custom')}</option>
      </SettingsSelect>
      {choice === 'custom' && (
        <span className="agnes-settings-preset-custom">
          <SettingsInput
            type="number"
            min={0}
            inputMode="numeric"
            aria-label={`${label} · ${fallbackT('ui.custom')}`}
            disabled={disabled}
            defaultValue={value === undefined ? '' : String(value / scale)}
            data-testid={props['data-testid'] ? `${props['data-testid']}-custom` : undefined}
            onBlur={(event) => {
              const raw = event.currentTarget.value.trim()
              const next = Number(raw)
              if (raw && Number.isFinite(next) && next >= 0) onChange(Math.round(next * scale))
            }}
          />
          {unit && <span>{unit}</span>}
        </span>
      )}
    </span>
  )
}

/**
 * A list of short values as chips: each removable, new ones typed and added with Enter. With
 * `suggestions`, known values are offered while typing.
 */
export function SettingsChips({
  values,
  onChange,
  label,
  addLabel = fallbackT('ui.add'),
  placeholder = fallbackT('ui.addPlaceholder'),
  suggestions,
  disabled,
  ...props
}: DataAttributes & {
  values: readonly string[]
  onChange(next: string[]): void
  label: string
  addLabel?: string
  placeholder?: string
  suggestions?: readonly string[]
  disabled?: boolean | undefined
}) {
  const [text, setText] = useState('')
  const listId = useId()
  const add = () => {
    const entry = text.trim()
    setText('')
    if (entry && !values.includes(entry)) onChange([...values, entry])
  }
  return (
    // biome-ignore lint/a11y/useSemanticElements: a group of chips and one field, named by the row.
    <span {...props} className="agnes-settings-chips" role="group" aria-label={label}>
      {values.map((entry) => (
        <span key={entry} className="agnes-settings-chip" data-on="true">
          {entry}
          <button
            type="button"
            aria-label={fallbackT('ui.remove', { label: entry })}
            disabled={disabled}
            onClick={() => onChange(values.filter((value) => value !== entry))}
          >
            <Icon name="x" />
          </button>
        </span>
      ))}
      <input
        className="agnes-settings-chip-input"
        aria-label={`${label} · ${addLabel}`}
        placeholder={placeholder}
        value={text}
        disabled={disabled}
        list={suggestions?.length ? listId : undefined}
        onChange={(event) => setText(event.currentTarget.value)}
        onBlur={add}
        onKeyDown={(event) => {
          if (event.key === 'Enter' || event.key === ',') {
            event.preventDefault()
            add()
          } else if (event.key === 'Backspace' && !text && values.length > 0) onChange(values.slice(0, -1))
        }}
      />
      {suggestions?.length ? (
        <datalist id={listId}>
          {suggestions
            .filter((entry) => !values.includes(entry))
            .map((entry) => (
              <option key={entry} value={entry} />
            ))}
        </datalist>
      ) : null}
    </span>
  )
}

/** A fixed set of choices any number of which may be on, shown as chips that toggle. */
export function SettingsChipToggle<Value extends string>({
  options,
  values,
  onChange,
  label,
  disabled,
  ...props
}: DataAttributes & {
  options: readonly { value: Value; label: string }[]
  values: readonly Value[]
  onChange(next: Value[]): void
  label: string
  disabled?: boolean | undefined
}) {
  return (
    // biome-ignore lint/a11y/useSemanticElements: toggle buttons named by the row they sit in.
    <span {...props} className="agnes-settings-chips" role="group" aria-label={label}>
      {options.map((option) => {
        const on = values.includes(option.value)
        return (
          <button
            key={option.value}
            type="button"
            className="agnes-settings-chip"
            data-on={on}
            aria-pressed={on}
            disabled={disabled}
            onClick={() =>
              onChange(
                on
                  ? values.filter((value) => value !== option.value)
                  : options
                      .map((entry) => entry.value)
                      .filter((value) => value === option.value || values.includes(value)),
              )
            }
          >
            {option.label}
          </button>
        )
      })}
    </span>
  )
}

/** Marks a page in the settings navigation as needing attention (yellow or red states only). */
export function setSettingsNavAttention(page: string, tone: 'warn' | 'error' | undefined): void {
  if (typeof document === 'undefined') return
  for (const item of document.querySelectorAll<HTMLElement>(`[data-testid="settings-nav-${page}"]`))
    if (tone) item.dataset.attention = tone
    else delete item.dataset.attention
}
