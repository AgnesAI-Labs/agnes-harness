import {
  type AdminLoop,
  type AdminModelAdapter,
  isAdminLoop,
  isAdminModelAdapter,
  isSessionDefaultsSnapshot,
  type SessionDefaultsSnapshot,
} from '@agnes/protocol'
import { Button, Field, Popover, Select, SettingsInput, useUiText } from '@agnes/web-ui'
import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { tr as hostText } from './locale-bridge.js'
import { composerLocaleCatalog } from './locales/composer.js'
import { ChoiceLabel, choiceName, type ResolvedComposition, readComposition } from './settings/choices.js'

export type LoopSelection = { id: string; version: string }
export type NewSessionCatalog = SessionDefaultsSnapshot & {
  composition?: ResolvedComposition
  loops: readonly AdminLoop[]
  modelAdapters: readonly AdminModelAdapter[]
}
export const loopIdentity = (loop: LoopSelection): string => JSON.stringify([loop.id, loop.version])

/** Read only same-origin public descriptions through the authenticated launcher BFF. */
export async function loadNewSessionCatalog(fetcher: typeof fetch = fetch): Promise<NewSessionCatalog> {
  const response = await fetcher('/admin/api/loops', { credentials: 'same-origin', cache: 'no-store' })
  if (!response.ok) throw new Error('session catalog unavailable')
  const value = (await response.json()) as Record<string, unknown>
  const snapshot = { revision: value?.revision, defaults: value?.defaults }
  if (
    !value ||
    typeof value !== 'object' ||
    !Array.isArray(value.loops) ||
    value.loops.length > 4096 ||
    !value.loops.every(isAdminLoop) ||
    !isSessionDefaultsSnapshot(snapshot)
  )
    throw new Error('invalid session catalog')
  const adaptersResponse = await fetcher('/admin/api/model-adapters', {
    credentials: 'same-origin',
    cache: 'no-store',
  })
  if (!adaptersResponse.ok) throw new Error('adapter catalog unavailable')
  const adapters = (await adaptersResponse.json()) as { modelAdapters?: unknown }
  if (
    !adapters ||
    !Array.isArray(adapters.modelAdapters) ||
    adapters.modelAdapters.length > 4096 ||
    !adapters.modelAdapters.every(isAdminModelAdapter)
  )
    throw new Error('invalid adapter catalog')
  let composition: ResolvedComposition | undefined
  try {
    const result = await fetcher('/admin/api/composition', { credentials: 'same-origin', cache: 'no-store' })
    if (result.ok) composition = readComposition(await result.json())
  } catch {
    /* Catalogs remain usable when provenance is unavailable. */
  }
  return {
    ...snapshot,
    loops: value.loops,
    modelAdapters: adapters.modelAdapters,
    ...(composition ? { composition } : {}),
  }
}

export interface LoopPickerView {
  visible: boolean
  resolvedLoop?: LoopSelection | undefined
  loopSource?: { layer: string; name: string } | undefined
  disabled: boolean
  loops: readonly AdminLoop[]
  selected?: LoopSelection
  error?: string
  label: string
  inherited: string
  unavailable: string
  onSelect(loop: LoopSelection | undefined): void
  presets?: readonly { id: string; isDefault: boolean }[]
  preset?: string | undefined
  inheritedPreset?: string | undefined
  presetLabel?: string
  bundles?: readonly {
    id: string
    sourcePackage: string
    label?: string
    displayName?: string
    version?: string
  }[]
  selectedBundles?: readonly string[]
  bundlesLabel?: string
  onBundles?(bundles: string[]): void
  onPreset?(preset: string | undefined): void
}
let view: LoopPickerView = {
  visible: false,
  disabled: true,
  loops: [],
  label: '',
  inherited: '',
  unavailable: '',
  onSelect() {},
}
const listeners = new Set<() => void>()
export function updateLoopPicker(next: LoopPickerView): void {
  view = next
  for (const listener of listeners) listener()
}
const subscribe = (listener: () => void) => {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/** One composer chip; the popover keeps composition controls out of the writing surface. */
export function LoopPicker() {
  const { t: fallback } = useUiText('@agnes/web/composer', composerLocaleCatalog)
  const tr = (key: string) => {
    const value = hostText(key)
    return value === key ? fallback(key) : value
  }
  const state = useSyncExternalStore(subscribe, () => view)
  const [open, setOpen] = useState(false)
  const trigger = useRef<HTMLButtonElement>(null)
  useEffect(() => {
    if (!state.visible || state.disabled) setOpen(false)
  }, [state.visible, state.disabled])
  useEffect(() => {
    if (!open) return
    const onEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setOpen(false)
        trigger.current?.focus()
      }
    }
    document.addEventListener('keydown', onEscape)
    return () => document.removeEventListener('keydown', onEscape)
  }, [open])
  if (!state.visible) return null
  const selected = state.selected ? loopIdentity(state.selected) : ''
  const stale = !!state.selected && !state.loops.some((entry) => loopIdentity(entry) === selected)
  const resolved = state.resolvedLoop ?? state.loops[0]
  const inheritedLoop =
    state.loops.find((entry) => resolved && loopIdentity(entry) === loopIdentity(resolved)) ?? resolved
  const active = state.loops.find((entry) => loopIdentity(entry) === selected) ?? inheritedLoop
  const sourceKey =
    state.loopSource?.layer === 'admin'
      ? 'admin'
      : state.loopSource?.layer === 'default'
        ? 'builtin'
        : state.loopSource
          ? 'profile'
          : 'unknown'
  const origin = `${tr(`composer.agent.source.${sourceKey}`)}${state.loopSource && sourceKey === 'profile' ? ` · ${state.loopSource.layer}: ${state.loopSource.name}` : ''}`
  const defaultText = inheritedLoop
    ? `${tr('composer.agent.default')} (${choiceName(inheritedLoop, tr)} · ${inheritedLoop.id} ${inheritedLoop.version})`
    : tr('composer.agent.unresolved')
  const content = (
    <section
      className="agent-picker-panel"
      data-testid="agent-options"
      aria-label={tr('composer.agent.title')}
    >
      <Field label={state.label} hint={origin}>
        {state.loops.length === 1 && !stale ? (
          <div data-testid="new-session-loop-readonly" title={`${defaultText} · ${origin}`}>
            <ChoiceLabel entry={active ?? { id: '', version: '' }} t={tr} />
          </div>
        ) : (
          <Select<string>
            data-testid="new-session-loop"
            aria-label={state.label}
            aria-invalid={stale || !!state.error}
            disabled={state.disabled}
            value={selected}
            className="agent-picker-select"
            options={[
              { value: '', label: defaultText, title: origin },
              ...state.loops.map((entry) => ({
                value: loopIdentity(entry),
                label: <ChoiceLabel entry={entry} t={tr} />,
              })),
              ...(stale && state.selected
                ? [{ value: selected, label: <ChoiceLabel entry={state.selected} t={tr} />, disabled: true }]
                : []),
            ]}
            onChange={(value) => state.onSelect(state.loops.find((entry) => loopIdentity(entry) === value))}
          />
        )}
      </Field>
      <Field
        label={state.bundlesLabel ?? tr('composer.agent.bundles')}
        hint={tr('composer.agent.bundlesHint')}
      >
        {state.bundles?.length === 1 ? (
          <label className="agnes-settings-checkbox" htmlFor="agent-single-bundle">
            <SettingsInput
              id="agent-single-bundle"
              type="checkbox"
              disabled={state.disabled}
              checked={state.selectedBundles?.includes(state.bundles[0]!.id) ?? false}
              onChange={(event) => state.onBundles?.(event.target.checked ? [state.bundles![0]!.id] : [])}
            />
            <ChoiceLabel entry={state.bundles[0]!} t={tr} />
          </label>
        ) : state.bundles?.length ? (
          <Select<string[]>
            mode="multiple"
            aria-label={state.bundlesLabel}
            data-testid="new-session-bundles"
            disabled={state.disabled}
            value={[...(state.selectedBundles ?? [])]}
            placeholder={tr('composer.agent.noBundles')}
            className="agent-picker-select"
            options={state.bundles.map((entry) => ({
              value: entry.id,
              label: <ChoiceLabel entry={entry} t={tr} />,
              title: entry.sourcePackage,
            }))}
            onChange={(bundles) => state.onBundles?.(bundles)}
          />
        ) : (
          <p className="field-hint">{tr('composer.agent.noBundles')}</p>
        )}
      </Field>
      {state.presets && (
        <Field label={tr('composer.agent.preset')}>
          {state.presets.length === 1 ? (
            <div data-testid="new-session-preset-readonly" title={tr('composer.agent.presetSource')}>
              <ChoiceLabel entry={state.presets[0]!} t={tr} />
            </div>
          ) : (
            <Select<string>
              aria-label={tr('composer.agent.preset')}
              data-testid="new-session-preset"
              disabled={state.disabled}
              value={state.preset ?? ''}
              className="agent-picker-select"
              options={[
                {
                  value: '',
                  label: `${tr('composer.agent.default')} (${state.inheritedPreset ? choiceName({ id: state.inheritedPreset }, tr) : tr('composer.agent.unresolved')})`,
                  title: tr('composer.agent.presetSource'),
                },
                ...state.presets.map((entry) => ({
                  value: entry.id,
                  label: <ChoiceLabel entry={entry} t={tr} />,
                })),
              ]}
              onChange={(preset) => state.onPreset?.(preset || undefined)}
            />
          )}
        </Field>
      )}
      {(state.error || stale) && (
        <p id="new-session-loop-error" role="status" className="resource-safe-error">
          {state.error ?? state.unavailable}
        </p>
      )}
    </section>
  )
  return (
    <Popover open={open} onOpenChange={setOpen} trigger="click" placement="topLeft" content={content}>
      <Button
        ref={trigger}
        type="text"
        className="composer-agent"
        data-testid="composer-agent"
        disabled={state.disabled}
        aria-expanded={open}
        aria-label={tr('composer.agent.title')}
        aria-describedby={stale || state.error ? 'new-session-loop-error' : undefined}
      >
        <span>{tr('composer.agent.chip')}</span>
        <span className="agent-chip-value">
          {active ? choiceName(active, tr) : tr('composer.agent.unresolved')}
        </span>
        <span aria-hidden="true">⌄</span>
      </Button>
    </Popover>
  )
}
