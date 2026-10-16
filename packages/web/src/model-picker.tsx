import type { ModelSettings } from '@agnes/protocol'
import { tr } from '@agnes/web-foundation/locale-bridge'
import {
  Button,
  contextBudgetLabel,
  Icon,
  Popover,
  Segmented,
  SessionAuxiliaryModels,
  SettingsInput,
} from '@agnes/web-ui'
import {
  type KeyboardEvent,
  type ReactElement,
  type ReactNode,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react'
import {
  budgetChoices,
  checkBudget,
  draftSettings,
  flatModels,
  groupModels,
  sameOption,
  thinkingBadge,
  thinkingChoices,
  unavailableThinking,
} from './model-picker/state.js'
import type { ModelPickerOption, ModelPickerProps, ModelPickerSettings } from './model-picker/types.js'

export type {
  ModelPickerOption,
  ModelPickerProps,
  ModelPickerSettings,
  ModelPickerState,
} from './model-picker/types.js'

/** 模型少时一眼能看完，搜索框只会多占一行。 */
const searchThreshold = 7
const NO_MOTION = { motionName: '' }

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
    <section id="model-picker-popover" className="model-picker" aria-label={tr('settings.modelPicker.aria')}>
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
      {state.settings && onSettingsChange ? (
        <SessionModelSettings
          // 换了模型或设置后草稿从新的会话现状重新开始。
          key={JSON.stringify([state.selected?.route, state.selected?.id, state.settings])}
          settings={state.settings}
          title={state.selected?.id}
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
      {state.auxiliaryAvailable && onAuxiliaryRead && onAuxiliarySelect ? (
        <div className="model-picker-auxiliary">
          <SessionAuxiliaryModels
            models={state.options}
            load={onAuxiliaryRead}
            save={onAuxiliarySelect}
            disabled={state.disabled || busy}
            t={tr}
          />
        </div>
      ) : null}
    </section>
  )
}

function Choices({
  id,
  label,
  options,
  selected,
  disabled,
  onChoose,
}: {
  id: string
  label: string
  options: ReadonlyArray<{ label: string; value: string }>
  selected: string | undefined
  disabled: boolean
  onChoose(value: string): void
}): ReactElement {
  return (
    <Segmented
      id={id}
      label={label}
      value={selected}
      options={options}
      disabled={disabled}
      onChange={onChoose}
    />
  )
}

function Row({ label, children }: { label: string; children: ReactNode }): ReactElement {
  return (
    <div className="model-picker-setting">
      <span className="model-picker-setting-label">{label}</span>
      {children}
    </div>
  )
}

function SessionModelSettings({
  settings,
  title,
  disabled,
  commit,
  close,
}: {
  settings: ModelPickerSettings
  title: string | undefined
  disabled: boolean
  commit(next: ModelSettings): Promise<void>
  close(returnFocus: boolean): void
}): ReactElement {
  const saved = settings.contextWindow === undefined ? '' : String(settings.contextWindow)
  const [budget, setBudget] = useState(saved)
  const levels = thinkingChoices(settings, tr)
  const stale = unavailableThinking(settings, tr)
  const thinking = stale ? undefined : (settings.thinking ?? '')
  const check = checkBudget(budget, settings.capacity)
  const capacity = settings.capacity.toLocaleString('en-US')

  /** 预算非法时错误已经显示在输入框下面，不按旧值悄悄提交。 */
  function apply(level: string, raw: string, dismissUnchanged: boolean): void {
    if (level === thinking && raw.trim() === saved) {
      if (dismissUnchanged) close(true)
      return
    }
    const next = draftSettings(level, raw, settings.capacity)
    if (next) void commit(next)
  }

  return (
    <section
      id="model-settings-popover"
      className="model-picker-settings"
      aria-label={tr('modelSettings.detailAria')}
    >
      {title ? (
        <p className="model-picker-settings-title" translate="no">
          {title}
        </p>
      ) : null}
      {levels.length > 1 ? (
        <Row label={tr('modelSettings.thinkingLabel')}>
          <Choices
            id="session-model-thinking"
            label={tr('modelSettings.thinkingLabel')}
            options={levels}
            selected={thinking}
            disabled={disabled}
            // 已保存的预算草稿一并提交，免得只改档位把预算重置。
            onChoose={(value) => apply(value, budget, true)}
          />
        </Row>
      ) : null}
      {stale ? (
        <p className="model-picker-notice">
          {tr('modelSettings.savedThinkingUnavailable', { value: stale })}
        </p>
      ) : null}
      <Row label={tr('modelSettings.windowLabel')}>
        <Choices
          id="session-model-budget"
          label={tr('modelSettings.windowLabel')}
          options={[
            { label: tr('modelSettings.presetAuto'), value: '' },
            ...budgetChoices(settings.capacity).map((tokens) => ({
              label: contextBudgetLabel(tokens),
              value: String(tokens),
            })),
          ]}
          selected={check.valid ? (check.tokens === undefined ? '' : String(check.tokens)) : undefined}
          disabled={disabled}
          onChoose={(value) => {
            setBudget(value)
            // 已保存的档位不可用时按空档提交，等于借这次改动把它归位到「自动」。
            apply(thinking ?? '', value, true)
          }}
        />
        <SettingsInput
          id="session-model-window"
          className="model-picker-budget"
          type="text"
          inputMode="numeric"
          maxLength={32}
          autoComplete="off"
          value={budget}
          disabled={disabled}
          placeholder={tr('modelSettings.windowPlaceholder', { tokens: capacity })}
          aria-label={tr('modelSettings.customAria')}
          aria-invalid={!check.valid}
          aria-describedby="session-model-window-hint session-model-settings-error"
          onChange={(event) => setBudget(event.currentTarget.value)}
          // 逐字符提交会让每次按键都发一次 setModel；回车或离开输入框才算一次确定输入。
          onBlur={(event) => {
            // 焦点在面板内的控件之间移动时交给那个控件处理，别在这里抢先发一次。
            const panel = event.currentTarget.closest('#model-picker-popover')
            if (panel?.contains(event.relatedTarget)) return
            apply(thinking ?? '', budget, false)
          }}
          onKeyDown={(event) => {
            if (event.key !== 'Enter' || event.nativeEvent.isComposing) return
            event.preventDefault()
            apply(thinking ?? '', budget, true)
          }}
        />
      </Row>
      <p id="session-model-window-hint" className="model-picker-hint">
        {tr('modelSettings.windowHint', { tokens: capacity })}
      </p>
      <p id="session-model-settings-error" className="model-picker-error" role="alert">
        {check.valid
          ? ''
          : tr('modelSettings.windowRange', {
              min: check.min.toLocaleString('en-US'),
              max: check.max.toLocaleString('en-US'),
            })}
      </p>
    </section>
  )
}
