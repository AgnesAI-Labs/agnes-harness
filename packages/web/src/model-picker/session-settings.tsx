import type { ModelSettings } from '@agnes/protocol'
import { Button, contextBudgetLabel, Icon, SettingsInput, type Translate } from '@agnes/web-ui'
import { type ReactNode, useState } from 'react'
import { budgetChoices, checkBudget, draftSettings, thinkingChoices, unavailableThinking } from './state.js'
import type { ModelPickerSettings } from './types.js'

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
  options: ReadonlyArray<{ label: string; value: string; description?: ReactNode }>
  selected: string | undefined
  disabled: boolean
  onChoose(value: string): void
}) {
  return (
    <div
      id={id}
      role="radiogroup"
      aria-label={label}
      onKeyDown={(event) => {
        if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return
        event.preventDefault()
        const buttons = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')]
        const current = buttons.indexOf(document.activeElement as HTMLButtonElement)
        const index =
          event.key === 'Home'
            ? 0
            : event.key === 'End'
              ? buttons.length - 1
              : (current + (event.key === 'ArrowUp' ? -1 : 1) + buttons.length) % buttons.length
        buttons[index]?.focus()
      }}
    >
      {options.map((option) => (
        <Button
          key={option.value}
          appearance="ghost"
          className="model-picker-choice"
          role="radio"
          aria-checked={selected === option.value}
          disabled={disabled}
          onClick={() => onChoose(option.value)}
        >
          <span>
            {option.label}
            {option.description ? <small>{option.description}</small> : null}
          </span>
          {selected === option.value ? <Icon name="check" /> : null}
        </Button>
      ))}
    </div>
  )
}

export function SessionModelSettings({
  t,
  settings,
  panel,
  disabled,
  commit,
  close,
}: {
  settings: ModelPickerSettings
  t: Translate
  panel: 'thinking' | 'context' | 'auxiliary' | undefined
  disabled: boolean
  commit(next: ModelSettings): Promise<void>
  close(returnFocus: boolean): void
}) {
  const saved = settings.contextWindow === undefined ? '' : String(settings.contextWindow)
  const [budget, setBudget] = useState(saved)
  const available = budgetChoices(settings.capacity).filter((tokens) => tokens < settings.capacity)
  const common = available.filter((tokens) => tokens === 128000 || tokens === 256000)
  const presets = common.length ? common : available.slice(-2)
  const [custom, setCustom] = useState(
    !!saved && Number(saved) !== settings.capacity && !presets.includes(Number(saved)),
  )
  const levels = thinkingChoices(settings, t)
  const stale = unavailableThinking(settings, t)
  const thinking = stale ? undefined : (settings.thinking ?? '')
  const check = checkBudget(budget, settings.capacity)
  const capacity = contextBudgetLabel(settings.capacity)
  function apply(level: string, raw: string, dismissUnchanged: boolean) {
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
      hidden={panel !== 'thinking' && panel !== 'context'}
      aria-label={t('modelSettings.detailAria')}
    >
      <div hidden={panel !== 'thinking'}>
        <Choices
          id="session-model-thinking"
          label={t('modelSettings.thinkingLabel')}
          options={levels.length ? levels : [{ value: '', label: t('modelSettings.presetAuto') }]}
          selected={thinking}
          disabled={disabled}
          onChoose={(value) => apply(value, budget, true)}
        />
        {stale ? (
          <p className="model-picker-notice">
            {t('modelSettings.savedThinkingUnavailable', { value: stale })}
          </p>
        ) : null}
      </div>
      <div hidden={panel !== 'context'}>
        <Choices
          id="session-model-budget"
          label={t('modelSettings.windowLabel')}
          options={[
            {
              label: t('modelSettings.presetAuto'),
              value: '',
              description: t('modelSettings.usingCapacity', { capacity }),
            },
            ...presets.map((tokens) => ({ label: contextBudgetLabel(tokens), value: String(tokens) })),
            { label: t('modelSettings.custom'), value: 'custom' },
          ]}
          selected={
            custom
              ? 'custom'
              : check.valid
                ? check.tokens === undefined || check.tokens === settings.capacity
                  ? ''
                  : String(check.tokens)
                : undefined
          }
          disabled={disabled}
          onChoose={(value) => {
            if (value === 'custom') {
              setCustom(true)
              return
            }
            setCustom(false)
            setBudget(value)
            apply(thinking ?? '', value, true)
          }}
        />
        {custom ? (
          <div className="model-picker-custom">
            <SettingsInput
              id="session-model-window"
              className="model-picker-budget"
              type="text"
              inputMode="decimal"
              maxLength={32}
              autoComplete="off"
              value={budget.endsWith('K') ? budget.slice(0, -1) : budget ? String(Number(budget) / 1000) : ''}
              disabled={disabled}
              aria-label={t('modelSettings.customKAria')}
              aria-invalid={!check.valid}
              aria-describedby="session-model-window-hint session-model-settings-error"
              onChange={(event) =>
                setBudget(event.currentTarget.value.trim() ? `${event.currentTarget.value}K` : '')
              }
              onBlur={(event) => {
                if (event.currentTarget.closest('#model-picker-popover')?.contains(event.relatedTarget))
                  return
                apply(thinking ?? '', budget, false)
              }}
              onKeyDown={(event) => {
                if (event.key !== 'Enter' || event.nativeEvent.isComposing) return
                event.preventDefault()
                apply(thinking ?? '', budget, true)
              }}
            />
            <span aria-hidden="true">{t('modelSettings.kUnit')}</span>
          </div>
        ) : null}
        <p id="session-model-window-hint" className="model-picker-hint">
          {t('modelSettings.compactHint', { capacity })}
        </p>
        <p id="session-model-settings-error" className="model-picker-error" role="alert">
          {check.valid
            ? ''
            : t('modelSettings.windowRangeK', {
                min: (check.min / 1000).toLocaleString('en-US', { maximumFractionDigits: 3 }),
                max: (check.max / 1000).toLocaleString('en-US', { maximumFractionDigits: 3 }),
              })}
        </p>
      </div>
    </section>
  )
}
