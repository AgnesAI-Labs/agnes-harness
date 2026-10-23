import { AutoReviewConfig, validateAgainst } from '@agnes/protocol'
import {
  Banner,
  Button,
  fallbackT,
  IconButton,
  reportSuccess,
  Segmented,
  SettingsBlock,
  SettingsChips,
  SettingsChipToggle,
  SettingsDrill,
  SettingsInput,
  SettingsItem,
  SettingsPickerSelect,
  SettingsPresetSelect,
  StateSwitch,
  secondPresets,
  trackPageRequest,
  useAutosave,
  useUiText,
} from '@agnes/web-ui'
import { useEffect, useState } from 'react'

export { reviewCatalog } from './auto-review-locale.js'

import { reviewCatalog } from './auto-review-locale.js'
import {
  type ModelSlotCatalog,
  type ModelSlotsState,
  modelSlotOptions,
  modelSlotsCatalog,
  modelSlotsSettings,
} from './model-slots.js'

export async function reviewSettings(
  config?: AutoReviewConfig,
  signal?: AbortSignal,
): Promise<AutoReviewConfig> {
  const response = await fetch('/admin/api/auto-review', {
    credentials: 'same-origin',
    cache: 'no-store',
    ...(signal ? { signal } : {}),
    ...(config
      ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(config) }
      : {}),
  })
  const value: unknown = await response.json()
  if (!response.ok || !validateAgainst(AutoReviewConfig, value).ok) throw new Error('Policy unavailable')
  return value as AutoReviewConfig
}
type Override = NonNullable<AutoReviewConfig['overrides']>[number]
const CATEGORIES = ['read', 'write', 'external'] as const
const TIMEOUT_SECONDS = [5, 10, 30, 60] as const
const sameConfig = (a: AutoReviewConfig, b: AutoReviewConfig) => JSON.stringify(a) === JSON.stringify(b)

/**
 * Approvals under Permissions and security: whether AI reviews low-risk actions first (one switch), the review rules as a
 * subpage (reviewer model, tools as chips, kinds of action as toggles, highest risk, per-session
 * limit, timeout in seconds), and the rules added from approvals as a subpage where each can be
 * removed or all cleared. Each change saves itself.
 */
export function AutoReviewPanel({ canSave }: { canSave: boolean }) {
  const { t } = useUiText('@agnes/web/auto-review', reviewCatalog)
  const [slots, setSlots] = useState<ModelSlotsState>()
  const [catalog, setCatalog] = useState<ModelSlotCatalog>()
  const [optionsState, setOptionsState] = useState<'loading' | 'failed' | 'ready'>('loading')
  const [optionsReads, setOptionsReads] = useState(0)
  const [slotsFailed, setSlotsFailed] = useState(false)
  const [stored, setStored] = useState<AutoReviewConfig>()
  const [readFailed, setReadFailed] = useState(false)
  const [reads, setReads] = useState(0)
  // biome-ignore lint/correctness/useExhaustiveDependencies: reads is an explicit retry.
  useEffect(() => {
    const controller = new AbortController()
    setReadFailed(false)
    void trackPageRequest(reviewSettings(undefined, controller.signal))
      .then((value) => {
        if (!controller.signal.aborted) setStored(value)
      })
      .catch(() => {
        if (!controller.signal.aborted) setReadFailed(true)
      })
    return () => controller.abort()
  }, [reads])
  // biome-ignore lint/correctness/useExhaustiveDependencies: optionsReads is an explicit catalog retry.
  useEffect(() => {
    const controller = new AbortController()
    let epoch = 0
    const refresh = () => {
      const request = ++epoch
      setOptionsState('loading')
      void modelSlotsCatalog(controller.signal)
        .then((value) => {
          if (!controller.signal.aborted && request === epoch) {
            setCatalog(value)
            setOptionsState('ready')
          }
        })
        .catch(() => {
          if (!controller.signal.aborted && request === epoch) setOptionsState('failed')
        })
    }
    refresh()
    window.addEventListener('agnes:model-slots-changed', refresh)
    return () => {
      controller.abort()
      window.removeEventListener('agnes:model-slots-changed', refresh)
    }
  }, [optionsReads])
  useEffect(() => {
    const controller = new AbortController()
    let epoch = 0
    const refresh = () => {
      const request = ++epoch
      void modelSlotsSettings(undefined, controller.signal)
        .then((value) => {
          if (!controller.signal.aborted && request === epoch) {
            setSlots(value)
            setSlotsFailed(false)
          }
        })
        .catch(() => {
          if (!controller.signal.aborted && request === epoch) setSlotsFailed(true)
        })
    }
    refresh()
    window.addEventListener('agnes:model-slots-changed', refresh)
    return () => {
      controller.abort()
      window.removeEventListener('agnes:model-slots-changed', refresh)
    }
  }, [])
  const config = useAutosave<AutoReviewConfig>({
    resourceKey: 'settings:auto-review',
    onSaved: () => reportSuccess('settings:auto-review', fallbackT('ui.settingsSaved')),
    stored,
    equal: sameConfig,
    save: async (next) => {
      const value = await reviewSettings(next)
      setStored(value)
    },
  })
  const value = config.value ?? {}
  const locked = !canSave || !stored
  const edit = (
    patch: { [Key in keyof AutoReviewConfig]?: AutoReviewConfig[Key] | undefined },
    when: 'now' | 'idle' = 'now',
  ) => {
    const next = { ...value, ...patch } as Record<string, unknown>
    for (const key of Object.keys(patch))
      if (patch[key as keyof AutoReviewConfig] === undefined) delete next[key]
    config.set(next as AutoReviewConfig, when)
  }
  const slot = value.modelSlot ?? 'fast'
  const models = optionsState === 'ready' && catalog ? modelSlotOptions(catalog) : []
  /**
   * The reviewer by the name of its account and model, never its route. An unset fast slot
   * (undefined) follows the default account and the backend says which model that is (`auto.fast`);
   * null means the slot is off. A saved model keeps its id while availability is checked.
   */
  const modelName = (name: 'fast' | 'verifier') => {
    const chosen = slots?.slots[name]
    const automatic = name === 'fast' && chosen === undefined ? slots?.auto?.fast : undefined
    const target = chosen ?? automatic
    if (!target || !slots) return undefined
    if (optionsState !== 'ready') {
      const model = `${target.model} · ${t(optionsState === 'loading' ? 'checkingAvailability' : 'availabilityUnknown')}`
      return automatic ? t('autoModel', { model }) : model
    }
    const option = models.find((entry) => entry.route === target.route && entry.id === target.model)
    if (automatic) return t('autoModel', { model: option ? (option.name ?? option.id) : target.model })
    return option ? `${option.label} · ${option.name ?? option.id}` : `${target.model} · ${t('unavailable')}`
  }
  const reviewer = modelName(slot)
  const chosen = slots?.slots[slot]
  const reviewerUnavailable =
    optionsState === 'ready' &&
    !!chosen &&
    !models.some((option) => option.route === chosen.route && option.id === chosen.model)
  const overrides = value.overrides ?? []
  const summary = [
    t(slot),
    t(value.maxRisk ?? 'low'),
    t('budgetSummary', { count: value.maxReviews ?? 20 }),
  ].join(' · ')
  return (
    <SettingsBlock
      label={t('title')}
      data-testid="auto-review-settings"
      aria-busy={config.busy}
      failed={config.failed}
      onRetry={config.retry}
      state={readFailed ? 'error' : !stored ? 'loading' : undefined}
      onReload={() => setReads((count) => count + 1)}
    >
      {stored && (
        <>
          <SettingsItem label={t('enabledLabel')} info={t('enabledHelp')}>
            <StateSwitch
              id="auto-review-enabled"
              testId="auto-review-enabled"
              label={t('enabledLabel')}
              checked={value.enabled ?? false}
              disabled={locked}
              onToggle={(enabled) => edit({ enabled })}
            />
          </SettingsItem>
          <SettingsDrill
            id="auto-review"
            data-testid="auto-review-customize"
            label={t('customize')}
            value={summary}
            description={t('customizeHelp')}
          >
            <SettingsBlock>
              <SettingsItem label={t('modelSlot')} info={t('profileHelp')}>
                <SettingsPickerSelect
                  id="auto-review-model"
                  data-testid="auto-review-model"
                  label={t('modelSlot')}
                  aria-label={t('modelSlot')}
                  value={slot}
                  disabled={locked}
                  onChange={(event) => edit({ modelSlot: event.target.value as 'fast' | 'verifier' })}
                >
                  {(['fast', 'verifier'] as const).map((name) => (
                    <option key={name} value={name}>
                      {modelName(name) ? `${t(name)} · ${modelName(name)}` : t(name)}
                    </option>
                  ))}
                </SettingsPickerSelect>
              </SettingsItem>
            </SettingsBlock>
            {reviewer && optionsState !== 'ready' && (
              <Banner
                tone={optionsState === 'failed' ? 'warning' : 'info'}
                data-testid={
                  optionsState === 'failed' ? 'auto-review-options-error' : 'auto-review-options-loading'
                }
                action={
                  optionsState === 'failed' ? (
                    <Button size="small" onClick={() => setOptionsReads((count) => count + 1)}>
                      {t('retryOptions')}
                    </Button>
                  ) : undefined
                }
              >
                {t(optionsState === 'loading' ? 'checkingAvailability' : 'availabilityUnknown')}
              </Banner>
            )}
            {(slotsFailed || (slots && (!reviewer || reviewerUnavailable))) && (
              <Banner
                tone="warning"
                data-testid="auto-review-slot-status"
                action={
                  <Button
                    size="small"
                    href="?settings=model#auxiliary-models"
                    data-testid="auto-review-model-link"
                  >
                    {t('modelLink')}
                  </Button>
                }
              >
                {t(slotsFailed ? 'slotFailed' : reviewerUnavailable ? 'slotUnavailable' : 'slotUnset')}
              </Banner>
            )}
            <SettingsBlock label={t('scope')}>
              <SettingsItem label={t('tools')} description={t('allWhenEmpty')}>
                <SettingsChips
                  data-testid="auto-review-tools"
                  label={t('tools')}
                  placeholder={t('addTool')}
                  disabled={locked}
                  values={value.eligibleTools ?? []}
                  onChange={(next) => edit({ eligibleTools: next.length ? next : undefined })}
                />
              </SettingsItem>
              <SettingsItem label={t('categories')} description={t('allWhenEmpty')}>
                <SettingsChipToggle<(typeof CATEGORIES)[number]>
                  data-testid="auto-review-categories"
                  label={t('categories')}
                  disabled={locked}
                  options={CATEGORIES.map((category) => ({
                    value: category,
                    label: t(`category.${category}`),
                  }))}
                  values={value.eligibleCategories ?? []}
                  onChange={(next) => edit({ eligibleCategories: next.length ? next : undefined })}
                />
              </SettingsItem>
              <SettingsItem label={t('maxRisk')}>
                <Segmented<'low' | 'medium'>
                  label={t('maxRisk')}
                  testId="auto-review-risk"
                  value={value.maxRisk ?? 'low'}
                  disabled={locked}
                  options={[
                    { value: 'low', label: t('low') },
                    { value: 'medium', label: t('medium') },
                  ]}
                  onChange={(maxRisk) => edit({ maxRisk })}
                />
              </SettingsItem>
            </SettingsBlock>
            <SettingsBlock label={t('limits')}>
              <SettingsItem label={t('budget')}>
                <span className="agnes-settings-value">
                  <SettingsInput
                    id="auto-review-maxReviews"
                    data-testid="auto-review-maxReviews"
                    type="number"
                    min={0}
                    max={1000}
                    className="agnes-settings-number"
                    aria-label={t('budget')}
                    disabled={locked}
                    value={value.maxReviews ?? 20}
                    onChange={(event) => {
                      const next = Number(event.target.value)
                      if (Number.isInteger(next) && next >= 0 && next <= 1000)
                        edit({ maxReviews: next }, 'idle')
                    }}
                    onBlur={config.flush}
                  />
                  {t('times')}
                </span>
              </SettingsItem>
              <SettingsItem label={t('timeout')}>
                <SettingsPresetSelect
                  id="auto-review-timeoutMs"
                  data-testid="auto-review-timeoutMs"
                  label={t('timeout')}
                  defaultLabel={t('timeoutDefault')}
                  disabled={locked}
                  value={value.timeoutMs}
                  presets={secondPresets(TIMEOUT_SECONDS, (count) => t('seconds', { count }))}
                  unit={t('secondUnit')}
                  scale={1000}
                  onChange={(timeoutMs) => edit({ timeoutMs })}
                />
              </SettingsItem>
            </SettingsBlock>
          </SettingsDrill>
          <SettingsDrill
            id="approval-rules"
            data-testid="auto-review-overrides"
            label={t('overrides')}
            value={t('overridesCount', { count: overrides.length })}
            description={t('overridesHelp')}
            actions={
              <Button
                appearance="danger"
                size="small"
                data-testid="auto-review-clear-overrides"
                disabled={locked || !overrides.length}
                onClick={() => edit({ overrides: [] })}
              >
                {t('clear')}
              </Button>
            }
          >
            <SettingsBlock data-testid="auto-review-override-list">
              {!overrides.length && <SettingsItem label={t('noOverrides')} />}
              {overrides.map((rule: Override, index) => (
                <SettingsItem
                  key={`${rule.tool}:${rule.scopeHash}`}
                  label={rule.tool}
                  description={`${t(`decision.${rule.decision}`)} · ${t(`risk.${rule.risk}`)}`}
                >
                  <IconButton
                    name="trash-2"
                    label={t('removeRule', { tool: rule.tool })}
                    data-testid="auto-review-remove-override"
                    disabled={locked}
                    onClick={() => edit({ overrides: overrides.filter((_, at) => at !== index) })}
                  />
                </SettingsItem>
              ))}
            </SettingsBlock>
          </SettingsDrill>
        </>
      )}
    </SettingsBlock>
  )
}
