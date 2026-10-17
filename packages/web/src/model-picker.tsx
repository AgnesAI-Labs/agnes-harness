import { tr } from '@agnes/web-foundation/locale-bridge'
import {
  Button,
  contextBudgetLabel,
  Icon,
  Popover,
  SessionAuxiliaryModels,
  type SessionAuxiliarySnapshot,
  SettingsInput,
} from '@agnes/web-ui'
import { type KeyboardEvent, type ReactElement, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { SessionModelSettings } from './model-picker/session-settings.js'
import { flatModels, groupModels, sameOption, thinkingBadge, thinkingChoices } from './model-picker/state.js'
import type { ModelPickerOption, ModelPickerProps } from './model-picker/types.js'

export type {
  ModelPickerOption,
  ModelPickerProps,
  ModelPickerSettings,
  ModelPickerState,
} from './model-picker/types.js'

/** 模型少时一眼能看完，搜索框只会多占一行。 */
const searchThreshold = 7
const NO_MOTION = { motionName: '' }
// Keep right-aligned panels inside narrow viewports.
const PANEL_ALIGN = { overflow: { shiftX: true, adjustX: true, adjustY: true } }

/**
 * Session model selector. The app keeps the confirmed model; this component owns only the
 * transient popover: search, the provider-grouped list and the current model's session settings.
 *
 * 选模型即切换并收起；思考强度与上下文窗口属于当前会话模型，改动经 `onSettingsChange`
 * 立即提交，没有「应用」按钮。
 */
export function ModelPickerControl(props: ModelPickerProps): ReactElement {
  const { state } = props
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const trigger = useRef<HTMLButtonElement>(null)
  const refocus = useRef(false)
  const disabled = state.disabled || state.pending || state.options.length === 0
  const badge = thinkingBadge(state.settings, tr)

  // 宿主在请求期间会禁用按钮；等它恢复可用再把焦点交回去，否则焦点落到 body 上。
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
      content={<ModelPanel {...props} close={close} onBusy={setBusy} />}
    >
      <Button
        ref={trigger}
        id="model"
        appearance="ghost"
        htmlType="button"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? 'model-listbox' : undefined}
        aria-label={state.accessibleName}
        aria-busy={state.pending || busy}
        title={state.accessibleName}
        disabled={disabled}
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
  close(returnFocus: boolean): void
  onBusy(busy: boolean): void
}

function ModelPanel({
  state,
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
  const groups = groupModels(state.options, query, tr('settings.modelPicker.configuredAccount'))
  const visible = flatModels(groups)
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
    thinking: tr('modelSettings.thinkingLabel'),
    context: tr('modelSettings.windowLabel'),
    auxiliary: tr('modelSettings.slots.title'),
  }
  const capacity = state.settings ? contextBudgetLabel(state.settings.capacity) : ''
  const followsDefaults =
    auxiliary &&
    (['fast', 'verifier'] as const).every(
      (slot) =>
        auxiliary[slot]?.route === auxiliary.defaults?.[slot]?.route &&
        auxiliary[slot]?.model === auxiliary.defaults?.[slot]?.model,
    )
  const settingsAddress = new URLSearchParams(window.location.search)
  settingsAddress.set('settings', 'auxiliary-models')
  const values = {
    thinking:
      thinkingChoices(state.settings, tr).find((choice) => choice.value === (state.settings?.thinking ?? ''))
        ?.label ??
      state.settings?.thinking ??
      tr('modelSettings.presetAuto'),
    context:
      state.settings?.contextWindow === undefined || state.settings.contextWindow === state.settings.capacity
        ? `${tr('modelSettings.presetAuto')} · ${capacity}`
        : contextBudgetLabel(state.settings.contextWindow),
    auxiliary: !auxiliaryAvailable
      ? tr('modelSettings.slots.follow')
      : auxiliaryFailed
        ? tr('modelSettings.slots.unavailable')
        : !auxiliary
          ? tr('modelSettings.slots.loading')
          : followsDefaults
            ? tr('modelSettings.slots.follow')
            : (['fast', 'verifier'] as const)
                .map((slot) => auxiliary[slot]?.model ?? tr('modelSettings.slots.unset'))
                .join(' · '),
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

  /** 一次只跑一个请求；面板在请求期间保持打开，失败时原地说明。 */
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
    // 当前模型的设置就在下面这一段里，点它不必再发一次同样的 setModel。
    // 没有设置可看时（模型没报容量）重选等于按默认值再确认一次，仍然提交。
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
    // 搜索框里 Home/End 与空格归光标和输入。
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
      aria-label={panel ? titles[panel] : tr('settings.modelPicker.aria')}
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
      <div hidden={!!panel}>
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
              placeholder={tr('settings.modelPicker.search')}
              aria-label={tr('settings.modelPicker.searchAria')}
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
            {tr('settings.modelPicker.help')}
          </p>
        )}
        <div
          ref={listbox}
          id="model-listbox"
          className="model-picker-list"
          role="listbox"
          tabIndex={-1}
          aria-label={tr('settings.modelPicker.listAria')}
          aria-busy={busy}
          aria-activedescendant={activeId}
          onKeyDown={(event) => listKeys(event, false)}
        >
          {groups.map((group) => (
            // biome-ignore lint/a11y/useSemanticElements: a listbox group is not a form fieldset.
            <div key={group.key} role="group" aria-label={group.label} className="model-picker-group">
              <p className="model-picker-group-title" aria-hidden="true">
                {group.label}
              </p>
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
                    {option.contextWindow ? (
                      <span className="model-picker-capacity">
                        {contextBudgetLabel(option.contextWindow)}
                      </span>
                    ) : null}
                    {selected ? <Icon name="check" className="model-picker-check" /> : null}
                  </div>
                )
              })}
            </div>
          ))}
        </div>
        {visible.length ? null : (
          <p className="model-picker-empty" role="status">
            {tr('settings.modelPicker.noMatch', { query: query.trim() })}
          </p>
        )}
        {(state.settings && onSettingsChange) || auxiliaryAvailable ? (
          <div className="model-picker-session">
            <p className="model-picker-group-title">{tr('modelSettings.session')}</p>
            {(['thinking', 'context', 'auxiliary'] as const).map((kind) => (
              <Button
                key={kind}
                id={`model-picker-${kind}`}
                appearance="ghost"
                className="model-picker-nav"
                title={values[kind]}
                disabled={
                  state.disabled ||
                  busy ||
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
                <Icon name="chevron-right" />
              </Button>
            ))}
          </div>
        ) : null}
      </div>
      {panel ? (
        <Button
          ref={back}
          appearance="ghost"
          className="model-picker-back"
          onClick={() => setPanel(undefined)}
        >
          <Icon name="chevron-left" />
          {titles[panel]}
        </Button>
      ) : null}
      {state.settings && onSettingsChange ? (
        <SessionModelSettings
          key={JSON.stringify([state.selected?.route, state.selected?.id, state.settings])}
          panel={panel}
          settings={state.settings}
          disabled={state.disabled || busy}
          commit={(next) => run('settings', () => onSettingsChange(next))}
          close={close}
        />
      ) : null}
      <p className="model-picker-error" role="alert">
        {failure
          ? tr(failure === 'select' ? 'settings.modelPicker.failed' : 'settings.modelPicker.settingsFailed')
          : ''}
      </p>
      {auxiliaryAvailable ? (
        <div hidden={panel !== 'auxiliary'}>
          {auxiliary && onAuxiliarySelect ? (
            <SessionAuxiliaryModels
              models={state.options}
              snapshot={auxiliary}
              save={onAuxiliarySelect}
              onSaved={(slot, target) => setAuxiliary((current) => ({ ...current, [slot]: target }))}
              disabled={state.disabled || busy}
              t={tr}
            />
          ) : (
            <p className="model-picker-hint" role={auxiliaryFailed ? 'alert' : 'status'}>
              {values.auxiliary}
            </p>
          )}
          <p className="model-picker-hint">{tr('modelSettings.slots.sessionHelp')}</p>
          <a className="model-picker-defaults-link" href={`?${settingsAddress}`}>
            {tr('modelSettings.slots.editDefaults')}
          </a>
        </div>
      ) : null}
    </section>
  )
}
