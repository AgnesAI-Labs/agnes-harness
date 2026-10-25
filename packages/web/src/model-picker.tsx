import { tr } from '@agnes/web-foundation/locale-bridge'
import {
  Button,
  contextBudgetLabel,
  Icon,
  Popover,
  SessionAuxiliaryModels,
  type SessionAuxiliarySnapshot,
  SettingsInput,
  type Translate,
} from '@agnes/web-ui'
import { type KeyboardEvent, type ReactElement, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { SessionModelSettings } from './model-picker/session-settings.js'
import {
  changedSlots,
  flatModels,
  groupModels,
  sameOption,
  thinkingBadge,
  thinkingChoices,
  thinkingSupported,
} from './model-picker/state.js'
import type { ModelPickerOption, ModelPickerProps } from './model-picker/types.js'

export type {
  ModelPickerOption,
  ModelPickerProps,
  ModelPickerSettings,
  ModelPickerState,
} from './model-picker/types.js'

/** With few models the whole list is visible, so a search field only adds an extra row. */
const searchThreshold = 7
const NO_MOTION = { motionName: '' }
// Keep right-aligned panels inside narrow viewports.
const PANEL_ALIGN = { overflow: { shiftX: true, adjustX: true, adjustY: true } }

/**
 * Session model selector. The app keeps the confirmed model; this component owns only the
 * transient popover: search, the provider-grouped list and the current model's session settings.
 *
 * Selecting switches model and closes the panel; thinking effort and context window belong to the
 * current session model and submit immediately through `onSettingsChange`, without an Apply button.
 */
export function ModelPickerControl(props: ModelPickerProps): ReactElement {
  const { state, t = tr } = props
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const trigger = useRef<HTMLButtonElement>(null)
  const refocus = useRef(false)
  const disabled = state.disabled || state.pending || state.options.length === 0
  const badge = thinkingBadge(state.settings, t)

  // The host disables the button during requests; wait until it is enabled before restoring focus or focus falls to body.
  useEffect(() => {
    if (open || disabled || !refocus.current) return
    refocus.current = false
    trigger.current?.focus({ preventScroll: true })
  }, [open, disabled])
  useEffect(() => {
    if (state.disabled) setOpen(false)
  }, [state.disabled])

  const close = (returnFocus: boolean): void => {
    refocus.current = returnFocus
    setOpen(false)
  }
  return (
    <Popover
      open={open}
      trigger="click"
      placement="topRight"
      align={PANEL_ALIGN}
      arrow={false}
      destroyOnHidden={true}
      // Opened many times a day, often from the keyboard: no entrance or exit motion.
      motion={NO_MOTION}
      rootClassName="model-picker-surface"
      onOpenChange={(next) => {
        if (next && disabled) return
        if (next) setOpen(true)
        // Outside clicks leave focus where the pointer went; Escape restores it in the shared popover.
        else if (!busy) close(false)
      }}
      content={<ModelPanel {...props} t={t} close={close} onBusy={setBusy} />}
    >
      <Button
        ref={trigger}
        id="model"
        appearance="ghost"
        htmlType="button"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? 'model-picker-popover' : undefined}
        aria-label={state.accessibleName}
        aria-busy={state.pending || busy}
        title={state.accessibleName}
        disabled={disabled}
        {...(state.disabledReason ? { disabledReason: state.disabledReason } : {})}
        onKeyDown={(event) => {
          if (disabled || open) return
          if (!['ArrowDown', 'ArrowUp'].includes(event.key)) return
          event.preventDefault()
          setOpen(true)
        }}
      >
        <span data-model-label={true}>{state.label}</span>
        {badge ? <span data-model-level={true}>{badge}</span> : null}
        <Icon name="chevron-down" className="model-chevron" />
      </Button>
    </Popover>
  )
}

type PanelProps = ModelPickerProps & {
  t: Translate
  close(returnFocus: boolean): void
  onBusy(busy: boolean): void
}

function ModelPanel({
  state,
  t,
  onSelect,
  onSettingsChange,
  onAuxiliaryRead,
  onAuxiliarySelect,
  onError,
  close,
  onBusy,
}: PanelProps): ReactElement {
  const [panel, setPanel] = useState<'thinking' | 'context' | 'auxiliary'>()
  const [auxiliary, setAuxiliary] = useState<SessionAuxiliarySnapshot>()
  const [auxiliaryFailed, setAuxiliaryFailed] = useState(false)
  const back = useRef<HTMLButtonElement>(null)
  const returning = useRef<string>()
  const [query, setQuery] = useState('')
  const [selecting, setSelecting] = useState(false)
  const [failure, setFailure] = useState<'select' | 'settings'>()
  const groups = groupModels(state.options, query, t('settings.modelPicker.configuredAccount'))
  const visible = flatModels(groups)
  // Decided on the whole catalog so typing a search never toggles the headings.
  const oneAccount = new Set(state.options.map((option) => `${option.route}\u0000${option.label}`)).size < 2
  const [active, setActive] = useState(() =>
    Math.max(
      0,
      visible.findIndex((option) => sameOption(option, state.selected)),
    ),
  )
  const request = useRef(0)
  const search = useRef<HTMLInputElement>(null)
  const listbox = useRef<HTMLDivElement>(null)
  const searchable = state.options.length > searchThreshold
  const busy = state.pending || selecting
  const activeIndex = Math.min(active, Math.max(visible.length - 1, 0))

  const auxiliaryAvailable = state.auxiliaryAvailable && onAuxiliaryRead && onAuxiliarySelect
  useEffect(() => {
    if (!state.auxiliaryAvailable || !onAuxiliaryRead || !onAuxiliarySelect) return
    let disposed = false
    void onAuxiliaryRead()
      .then((value) => {
        if (!disposed) {
          setAuxiliary(value)
          setAuxiliaryFailed(false)
        }
      })
      .catch(() => {
        if (!disposed) setAuxiliaryFailed(true)
      })
    return () => {
      disposed = true
    }
  }, [state.auxiliaryAvailable, onAuxiliaryRead, onAuxiliarySelect])
  useLayoutEffect(() => {
    if (panel) back.current?.focus({ preventScroll: true })
    else if (returning.current)
      document.getElementById(`model-picker-${returning.current}`)?.focus({ preventScroll: true })
  }, [panel])
  function enter(next: 'thinking' | 'context' | 'auxiliary') {
    returning.current = next
    setPanel(next)
  }
  const titles = {
    thinking: t('modelSettings.thinkingLabel'),
    context: t('modelSettings.windowLabel'),
    auxiliary: t('modelSettings.slots.sessionTitle'),
  }
  const capacity = state.settings ? contextBudgetLabel(state.settings.capacity) : ''
  const notes = {
    thinking: state.selected?.id,
    context: t('modelSettings.capacityValue', { capacity }),
    auxiliary: undefined,
  }
  // Only a model with settings can say it has no levels; without them the row is just unavailable.
  const noLevels = !!state.settings && !thinkingSupported(state.settings, t)
  const changed = auxiliary ? changedSlots(auxiliary) : 0
  const settingsAddress = new URLSearchParams(window.location.search)
  settingsAddress.set('settings', 'auxiliary-models')
  const values = {
    thinking: noLevels
      ? t('modelSettings.thinkingUnsupported')
      : (thinkingChoices(state.settings, t).find(
          (choice) => choice.value === (state.settings?.thinking ?? ''),
        )?.label ??
        state.settings?.thinking ??
        t('modelSettings.presetAuto')),
    // The capacity already sits beside the model row, so automatic is not followed by it here.
    context:
      state.settings?.contextWindow === undefined || state.settings.contextWindow === state.settings.capacity
        ? t('modelSettings.presetAuto')
        : contextBudgetLabel(state.settings.contextWindow),
    auxiliary: !auxiliaryAvailable
      ? t('modelSettings.slots.follow')
      : auxiliaryFailed
        ? t('modelSettings.slots.unavailable')
        : !auxiliary
          ? t('modelSettings.slots.loading')
          : changed
            ? t('modelSettings.slots.changed', { count: changed })
            : t('modelSettings.slots.follow'),
  }

  // biome-ignore lint/correctness/useExhaustiveDependencies: focus moves once, when the panel mounts.
  useLayoutEffect(() => {
    ;(searchable ? search.current : listbox.current)?.focus({ preventScroll: true })
    return () => {
      // A reply that lands after the panel closed must not touch it.
      request.current += 1
      onBusy(false)
    }
  }, [])
  useLayoutEffect(() => {
    listbox.current
      ?.querySelector(`#model-picker-option-${activeIndex}`)
      ?.scrollIntoView?.({ block: 'nearest' })
  }, [activeIndex])

  /** Run one request at a time; keep the panel open during requests and explain failures inline. */
  async function run(kind: 'select' | 'settings', action: () => Promise<boolean>): Promise<void> {
    if (state.disabled || busy) return
    const current = ++request.current
    setSelecting(true)
    onBusy(true)
    setFailure(undefined)
    try {
      const accepted = await action()
      if (current !== request.current) return
      if (accepted) close(true)
    } catch (error) {
      if (current !== request.current) return
      setFailure(kind)
      onError(error)
    } finally {
      if (current === request.current) {
        setSelecting(false)
        onBusy(false)
      }
    }
  }

  function select(option: ModelPickerOption | undefined): void {
    if (!option) return
    // The current model settings are directly below, so clicking it need not send the same setModel again.
    // With no settings to show (no reported capacity), reselection reconfirms defaults and still submits.
    if (sameOption(option, state.selected) && state.settings && onSettingsChange) {
      if (!busy) close(true)
      return
    }
    void run('select', () => onSelect(option))
  }

  function listKeys(event: KeyboardEvent<HTMLElement>, fromSearch: boolean): void {
    if (event.nativeEvent.isComposing) return
    const move = (index: number) => {
      event.preventDefault()
      if (visible.length) setActive((index + visible.length) % visible.length)
    }
    if (event.key === 'ArrowDown') move(activeIndex + 1)
    else if (event.key === 'ArrowUp') move(activeIndex - 1)
    // Inside the search field, Home/End move the cursor and Space remains text input.
    else if (event.key === 'Home' && !fromSearch) move(0)
    else if (event.key === 'End' && !fromSearch) move(visible.length - 1)
    else if (event.key === 'Enter' || (event.key === ' ' && !fromSearch)) {
      event.preventDefault()
      select(visible[activeIndex])
    }
  }

  const activeId = visible.length ? `model-picker-option-${activeIndex}` : undefined
  return (
    <section
      id="model-picker-popover"
      className="model-picker"
      role="dialog"
      aria-label={panel ? titles[panel] : t('settings.modelPicker.aria')}
      onKeyDown={(event) => {
        if (event.defaultPrevented || event.nativeEvent.isComposing || !panel) return
        if (
          event.key === 'Escape' ||
          (event.key === 'ArrowLeft' && !(event.target instanceof HTMLInputElement))
        ) {
          event.preventDefault()
          event.stopPropagation()
          setPanel(undefined)
        }
      }}
    >
      {/*
        One shrinkable column: the search row and the help line keep their height, so a long catalog
        takes the remaining space and scrolls inside the list instead of pushing them out of the panel.
      */}
      <div className="model-picker-body" hidden={!!panel}>
        {searchable ? (
          <div className="model-picker-search">
            <Icon name="search" />
            <SettingsInput
              ref={search}
              type="search"
              role="combobox"
              autoComplete="off"
              spellCheck={false}
              value={query}
              placeholder={t('settings.modelPicker.search')}
              aria-label={t('settings.modelPicker.searchAria')}
              aria-expanded={true}
              aria-controls="model-listbox"
              aria-autocomplete="list"
              aria-activedescendant={activeId}
              onChange={(event) => {
                setQuery(event.currentTarget.value)
                setActive(0)
              }}
              onKeyDown={(event) => listKeys(event, true)}
            />
          </div>
        ) : null}
        {state.selected ? null : (
          <p className="model-picker-help" data-model-picker-help="">
            {t('settings.modelPicker.help')}
          </p>
        )}
        <div
          ref={listbox}
          id="model-listbox"
          className="model-picker-list"
          role="listbox"
          tabIndex={-1}
          aria-label={t('settings.modelPicker.listAria')}
          aria-busy={busy}
          aria-activedescendant={activeId}
          onKeyDown={(event) => listKeys(event, false)}
        >
          {groups.map((group) => (
            // biome-ignore lint/a11y/useSemanticElements: a listbox group is not a form fieldset.
            <div key={group.key} role="group" aria-label={group.label} className="model-picker-group">
              {oneAccount ? null : (
                <p className="model-picker-group-title" aria-hidden="true">
                  {group.label}
                </p>
              )}
              {group.entries.map(({ option, index }) => {
                const selected = sameOption(option, state.selected)
                return (
                  // biome-ignore lint/a11y/useKeyWithClickEvents: the listbox owns the keyboard through aria-activedescendant.
                  <div
                    id={`model-picker-option-${index}`}
                    key={option.id}
                    className="model-picker-option"
                    role="option"
                    tabIndex={-1}
                    aria-selected={selected}
                    aria-disabled={busy}
                    data-active={index === activeIndex}
                    onMouseMove={() => setActive(index)}
                    onClick={() => select(option)}
                  >
                    <span className="model-picker-model" translate="no">
                      {option.id}
                    </span>
                    <span className="model-picker-capacity">
                      {option.contextWindow ? contextBudgetLabel(option.contextWindow) : ''}
                    </span>
                    <span className="model-picker-check">{selected ? <Icon name="check" /> : null}</span>
                  </div>
                )
              })}
            </div>
          ))}
        </div>
        {visible.length ? null : (
          <p className="model-picker-empty" role="status">
            {t('settings.modelPicker.noMatch', { query: query.trim() })}
          </p>
        )}
        {(state.settings && onSettingsChange) || auxiliaryAvailable ? (
          <div className="model-picker-session">
            <div className="model-picker-section-head">
              <p className="model-picker-group-title">{t('modelSettings.session')}</p>
              <span>{t('modelSettings.slots.sessionHelp')}</span>
            </div>
            {(['thinking', 'context', 'auxiliary'] as const).map((kind) => {
              const unsupported = kind === 'thinking' && noLevels
              return (
                <Button
                  key={kind}
                  id={`model-picker-${kind}`}
                  appearance="ghost"
                  className="model-picker-nav"
                  disabled={
                    state.disabled ||
                    busy ||
                    unsupported ||
                    (kind === 'auxiliary' ? !auxiliaryAvailable : !state.settings || !onSettingsChange)
                  }
                  onClick={() => enter(kind)}
                  onKeyDown={(event) => {
                    if (event.key === 'ArrowRight' || event.key === 'Enter') {
                      event.preventDefault()
                      enter(kind)
                    }
                  }}
                >
                  <span>{titles[kind]}</span>
                  <span className="model-picker-value">{values[kind]}</span>
                  {unsupported ? null : <Icon name="chevron-right" />}
                </Button>
              )
            })}
          </div>
        ) : null}
      </div>
      {panel ? (
        <div className="model-picker-head">
          <Button
            ref={back}
            appearance="ghost"
            className="model-picker-back"
            onClick={() => setPanel(undefined)}
          >
            <Icon name="chevron-left" />
            {titles[panel]}
          </Button>
          {notes[panel] ? (
            <span className="model-picker-head-note" translate="no">
              {notes[panel]}
            </span>
          ) : null}
        </div>
      ) : null}
      {state.settings && onSettingsChange ? (
        <SessionModelSettings
          key={JSON.stringify([state.selected?.route, state.selected?.id, state.settings])}
          panel={panel}
          settings={state.settings}
          t={t}
          disabled={state.disabled || busy}
          commit={(next) => run('settings', () => onSettingsChange(next))}
          close={close}
        />
      ) : null}
      <p className="model-picker-error" role="alert">
        {failure
          ? t(failure === 'select' ? 'settings.modelPicker.failed' : 'settings.modelPicker.settingsFailed')
          : ''}
      </p>
      {auxiliaryAvailable ? (
        <div hidden={panel !== 'auxiliary'}>
          <p className="model-picker-intro">{t('modelSettings.slots.sessionIntro')}</p>
          {auxiliary && onAuxiliarySelect ? (
            <SessionAuxiliaryModels
              models={state.options}
              snapshot={auxiliary}
              save={onAuxiliarySelect}
              onSaved={(slot, target) => setAuxiliary((current) => ({ ...current, [slot]: target }))}
              disabled={state.disabled || busy}
              t={t}
            />
          ) : (
            <p className="model-picker-hint" role={auxiliaryFailed ? 'alert' : 'status'}>
              {values.auxiliary}
            </p>
          )}
          <div className="model-picker-aux-footer">
            <span>{t('modelSettings.slots.sessionHelp')}</span>
            <a className="model-picker-defaults-link" href={`?${settingsAddress}`}>
              {t('modelSettings.slots.editDefaults')}
            </a>
          </div>
        </div>
      ) : null}
    </section>
  )
}
