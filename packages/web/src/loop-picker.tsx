import {
  type AdminLoop,
  type AdminModelAdapter,
  isAdminLoop,
  isAdminModelAdapter,
  isSessionDefaultsSnapshot,
  type PackageInstalledDescriptor,
  resolvePluginMetadata,
  type SessionDefaultsSnapshot,
} from '@agnes/protocol'
import { useBusinessAgents } from '@agnes/web-admin/agents'
import {
  ChoiceLabel,
  choiceName,
  type ResolvedComposition,
  readComposition,
} from '@agnes/web-admin/settings/choices'
import { homeNavigation } from '@agnes/web-client'
import { tr as hostText } from '@agnes/web-foundation/locale-bridge'
import { composerLocaleCatalog } from '@agnes/web-foundation/locales/composer'
import {
  ADVANCED_SETTINGS_STORAGE_KEY,
  advancedSettingsValue,
  Button,
  Field,
  Icon,
  Popover,
  Select,
  SettingsInput,
  useUiText,
} from '@agnes/web-ui'
import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { recipePresets } from './session-permission.js'

export type LoopSelection = { id: string; version: string }
export type NewSessionCatalog = SessionDefaultsSnapshot & {
  composition?: ResolvedComposition
  loops: readonly AdminLoop[]
  modelAdapters: readonly AdminModelAdapter[]
}
export const loopIdentity = (loop: LoopSelection): string => JSON.stringify([loop.id, loop.version])
/** What a recipe does, where its name alone does not say (the same help the admin catalog shows). */
const PRESET_DESCRIPTIONS: Record<string, string> = { minimal: 'choiceHelp.minimal', ptc: 'choiceHelp.ptc' }

/**
 * Names a loop the Host catalog lists by id only after the installed plugin that is its sole source,
 * such as 「Jev Agent Loop」 for `agnes.jev`. A loop with a name of its own keeps it.
 */
export function namedLoops(
  loops: readonly AdminLoop[],
  installed: readonly PackageInstalledDescriptor[],
  locale: 'en' | 'zh-CN',
  t: (key: string) => string,
): AdminLoop[] {
  return loops.map((loop) => {
    if (choiceName(loop, t) !== loop.id) return loop
    if (loops.filter((entry) => entry.sourcePackage === loop.sourcePackage).length !== 1) return loop
    const item = installed.find((entry) => entry.id === loop.sourcePackage)
    const label = resolvePluginMetadata(item?.metadata, locale)?.displayName
    return label ? { ...loop, label } : loop
  })
}

/** Read only same-origin public descriptions through the authenticated launcher BFF. */
export async function loadNewSessionCatalog(
  fetcher: typeof fetch = fetch,
  includeComposition = true,
): Promise<NewSessionCatalog> {
  const request = async (path: string, message: string) => {
    const response = await fetcher(path, { credentials: 'same-origin', cache: 'no-store' })
    if (!response.ok) throw new Error(message)
    return response.json()
  }
  const [value, adapters, composition] = await Promise.all([
    request('/admin/api/loops', 'session catalog unavailable') as Promise<Record<string, unknown>>,
    request('/admin/api/model-adapters', 'adapter catalog unavailable') as Promise<{
      modelAdapters?: unknown
    }>,
    includeComposition
      ? request('/admin/api/composition', 'composition unavailable')
          .then(readComposition)
          .catch(() => undefined)
      : undefined,
  ])
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
  if (
    !adapters ||
    !Array.isArray(adapters.modelAdapters) ||
    adapters.modelAdapters.length > 4096 ||
    !adapters.modelAdapters.every(isAdminModelAdapter)
  )
    throw new Error('invalid adapter catalog')
  return {
    ...snapshot,
    loops: value.loops,
    modelAdapters: adapters.modelAdapters,
    ...(composition ? { composition } : {}),
  }
}

/** Optional origin/help text must not hold the draft's model and permission controls. */
export async function loadNewSessionComposition(fetcher: typeof fetch = fetch) {
  const response = await fetcher('/admin/api/composition', { credentials: 'same-origin', cache: 'no-store' })
  if (!response.ok) throw new Error('composition unavailable')
  return readComposition(await response.json())
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
  /** The Host's current recipe catalog. */
  presets?: readonly { id: string; isDefault: boolean }[]
  preset?: string | undefined
  /** The recipe a draft runs when it names none; the 「Default」 entry carries its name. */
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

/**
 * Whether 「Show advanced settings」 is on, which it is unless this browser turned it off. The settings dialog
 * owns the switch and stores it in this browser; the chip reads it each time it renders, which
 * includes every time its popover opens.
 */
function advancedSettingsShown(): boolean {
  try {
    return advancedSettingsValue(globalThis.localStorage?.getItem(ADVANCED_SETTINGS_STORAGE_KEY))
  } catch {
    return true
  }
}

/**
 * One composer chip that selects how the agent works. Bundles, the permission preset and where the
 * default comes from are advanced: they show with advanced settings on, or while one is in effect.
 */
export function LoopPicker() {
  const { t: fallback, locale } = useUiText('@agnes/web/composer', composerLocaleCatalog)
  const tr = (key: string) => {
    const value = hostText(key)
    return value === key ? fallback(key) : value
  }
  const published = useSyncExternalStore(subscribe, () => view)
  const [open, setOpen] = useState(false)
  const selected = published.selected ? loopIdentity(published.selected) : ''
  const stale = !!published.selected && !published.loops.some((entry) => loopIdentity(entry) === selected)
  const composition =
    advancedSettingsShown() || !!published.selectedBundles?.length || published.preset !== undefined
  const recipes = recipePresets(published.presets)
  // When other advanced controls already expose this picker, the agent gallery is needed only
  // after opening it. Agent-only profiles still read eagerly to decide whether the chip exists.
  const staticAvailable =
    published.loops.length >= 2 ||
    stale ||
    !!published.error ||
    (composition && (!!published.bundles?.length || recipes.length > 0))
  const agents = useBusinessAgents(
    {},
    { enabled: published.visible && (open || (!staticAvailable && !published.disabled)) },
  )
  const state = { ...published, loops: namedLoops(published.loops, agents.installed, locale, tr) }
  const launchable = agents.agents.filter((agent) => agents.readyAgents.includes(agent.ref))
  // The recipes a draft may choose. The default one is the 「Default」 entry, never listed twice.
  const choices = recipes.filter((entry) => entry.id !== state.inheritedPreset)
  const presetValue = state.preset === state.inheritedPreset ? '' : (state.preset ?? '')
  const presetDescription = (id: string) => {
    const key = PRESET_DESCRIPTIONS[id]
    return key ? { title: tr(key) } : {}
  }
  const advancedAvailable = launchable.length > 0 || staticAvailable
  const trigger = useRef<HTMLButtonElement>(null)
  useEffect(() => {
    if (!state.visible || state.disabled || !advancedAvailable) setOpen(false)
  }, [state.visible, state.disabled, advancedAvailable])
  useEffect(() => {
    if (!open) return
    const onEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        // Let an open Select consume its first Escape; a closed Select must not trap it.
        if (document.querySelector('.agent-picker-panel [role="combobox"][aria-expanded="true"]')) return
        event.preventDefault()
        event.stopPropagation()
        setOpen(false)
        trigger.current?.focus()
      }
    }
    document.addEventListener('keydown', onEscape, true)
    return () => document.removeEventListener('keydown', onEscape, true)
  }, [open])
  if (!state.visible) return null
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
      {launchable.length > 0 && (
        <Field label={tr('composer.agent.title')}>
          <Select<string>
            data-testid="new-session-agent"
            aria-label={tr('composer.agent.title')}
            disabled={state.disabled}
            value=""
            options={launchable.map((agent) => ({ value: agent.ref, label: agent.name }))}
            onChange={(ref) => {
              const agent = launchable.find((entry) => entry.ref === ref)
              if (agent) {
                setOpen(false)
                homeNavigation.open('agents', { focus: agent.entry.id, agent: agent.ref, start: true })
              }
            }}
          />
        </Field>
      )}
      <Field label={state.label} {...(composition ? { hint: origin } : {})}>
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
      {composition && (
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
              virtual={false}
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
      )}
      {composition && recipes.length > 0 && (
        <Field label={tr('composer.agent.preset')}>
          {recipes.length === 1 && recipes[0] ? (
            <div data-testid="new-session-preset-readonly" title={tr('composer.agent.presetSource')}>
              <ChoiceLabel entry={recipes[0]} t={tr} />
            </div>
          ) : (
            <Select<string>
              aria-label={tr('composer.agent.preset')}
              data-testid="new-session-preset"
              virtual={false}
              disabled={state.disabled}
              value={presetValue}
              className="agent-picker-select"
              options={[
                {
                  // No preset is sent: the session follows the administrator default.
                  value: '',
                  label: tr('composer.agent.defaultPreset').replace(
                    '{name}',
                    state.inheritedPreset
                      ? choiceName({ id: state.inheritedPreset }, tr)
                      : tr('composer.agent.unresolved'),
                  ),
                  title: tr('composer.agent.presetSource'),
                },
                ...choices.map((entry) => ({
                  value: entry.id,
                  label: <ChoiceLabel entry={entry} t={tr} />,
                  ...presetDescription(entry.id),
                })),
                ...(presetValue && !choices.some((entry) => entry.id === presetValue)
                  ? [
                      {
                        value: presetValue,
                        label: <ChoiceLabel entry={{ id: presetValue }} t={tr} />,
                        disabled: true,
                      },
                    ]
                  : []),
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
    <Popover open={open} onOpenChange={setOpen} trigger="click" placement="top" content={content}>
      <Button
        ref={trigger}
        type="text"
        className="composer-agent"
        data-testid="composer-agent"
        hidden={!advancedAvailable}
        disabled={state.disabled}
        aria-expanded={open}
        aria-label={tr(state.loops.length >= 2 ? 'composer.agent.title' : 'composer.agent.more')}
        aria-describedby={stale || state.error ? 'new-session-loop-error' : undefined}
      >
        <span hidden={state.loops.length < 2}>{tr('composer.agent.chip')}</span>
        <span className="agent-chip-value" hidden={state.loops.length < 2}>
          {active ? choiceName(active, tr) : tr('composer.agent.unresolved')}
        </span>
        <Icon name={state.loops.length >= 2 ? 'chevron-down' : 'ellipsis'} className="model-chevron" />
      </Button>
    </Popover>
  )
}
