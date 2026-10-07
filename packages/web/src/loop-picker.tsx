import {
  type AdminLoop,
  type AdminModelAdapter,
  isAdminLoop,
  isAdminModelAdapter,
  isSessionDefaultsSnapshot,
  type SessionDefaultsSnapshot,
} from '@agnes/protocol'
import { Select } from '@agnes/web-ui'
import { useSyncExternalStore } from 'react'

export type LoopSelection = { id: string; version: string }
export type NewSessionCatalog = SessionDefaultsSnapshot & {
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
  return { ...snapshot, loops: value.loops, modelAdapters: adapters.modelAdapters }
}

export interface LoopPickerView {
  visible: boolean
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
  bundles?: readonly { id: string; sourcePackage: string }[]
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

/** The host places this in the existing composer left slot beside its model picker. */
export function LoopPicker() {
  const state = useSyncExternalStore(subscribe, () => view)
  if (!state.visible) return null
  const selected = state.selected ? loopIdentity(state.selected) : ''
  const stale = !!state.selected && !state.loops.some((entry) => loopIdentity(entry) === selected)
  return (
    <span
      style={{
        display: 'inline-flex',
        flexWrap: 'wrap',
        alignItems: 'center',
        gap: '0.375rem',
        maxWidth: '100%',
      }}
    >
      {state.bundles && state.bundles.length > 0 && (
        <Select<string[]>
          mode="multiple"
          aria-label={state.bundlesLabel}
          data-testid="new-session-bundles"
          disabled={state.disabled}
          value={[...(state.selectedBundles ?? [])]}
          placeholder={state.bundlesLabel}
          style={{ minWidth: 190, maxWidth: 280 }}
          options={state.bundles.map(({ id, sourcePackage }) => ({
            value: id,
            label: id,
            title: sourcePackage,
          }))}
          onChange={(bundles) => state.onBundles?.(bundles)}
        />
      )}
      {state.presets && (
        <Select<string>
          aria-label={state.presetLabel}
          data-testid="new-session-preset"
          disabled={state.disabled}
          value={state.preset ?? ''}
          style={{ minWidth: 150, maxWidth: 240 }}
          options={[
            {
              value: '',
              label: state.inheritedPreset
                ? `${state.inherited} · ${state.inheritedPreset}`
                : state.inherited,
            },
            ...state.presets.map(({ id }) => ({ value: id, label: id })),
          ]}
          onChange={(preset) => state.onPreset?.(preset || undefined)}
        />
      )}
      <Select<string>
        aria-label={state.label}
        aria-invalid={stale || !!state.error}
        aria-describedby={state.error || stale ? 'new-session-loop-error' : undefined}
        disabled={state.disabled}
        value={selected}
        style={{ minWidth: 170, maxWidth: 280 }}
        options={[
          { value: '', label: state.inherited },
          ...state.loops.map((entry) => ({
            value: loopIdentity(entry),
            label: `${entry.label ?? entry.id} · ${entry.version}`,
          })),
          ...(stale && state.selected
            ? [{ value: selected, label: `${state.selected.id} · ${state.selected.version}`, disabled: true }]
            : []),
        ]}
        onChange={(value) => state.onSelect(state.loops.find((entry) => loopIdentity(entry) === value))}
      />
      {state.error || stale ? (
        <span id="new-session-loop-error" role="status" style={{ color: 'var(--agnes-status-danger-text)' }}>
          {state.error ?? state.unavailable}
        </span>
      ) : null}
    </span>
  )
}
