import { AutoReviewConfig, validateAgainst } from '@agnes/protocol'
import {
  Button,
  Field,
  LabeledSwitch,
  MetaText,
  SettingsAdvanced,
  SettingsGroup,
  SettingsInput,
  SettingsItem,
  SettingsSaveBar,
  SettingsSection,
  SettingsSelect,
  SettingsState,
  useUiText,
} from '@agnes/web-ui'
import { useEffect, useRef, useState } from 'react'

export { reviewCatalog } from './auto-review-locale.js'

import { reviewCatalog } from './auto-review-locale.js'
import { type ModelSlotsState, modelSlotOptions, modelSlotsSettings } from './model-slots.js'

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
export function AutoReviewPanel({ canSave }: { canSave: boolean }) {
  const { t } = useUiText('@agnes/web/auto-review', reviewCatalog)
  const [slots, setSlots] = useState<ModelSlotsState>()
  const [slotsFailed, setSlotsFailed] = useState(false)
  const lifetime = useRef<AbortController>()
  const stored = useRef<AutoReviewConfig>({})
  const [dirty, setDirty] = useState(false)
  const [config, setConfig] = useState<AutoReviewConfig>({})
  const [tools, setTools] = useState('')
  const [categories, setCategories] = useState('')
  const [loaded, setLoaded] = useState(false)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  useEffect(() => {
    const controller = new AbortController()
    lifetime.current = controller
    void reviewSettings(undefined, controller.signal)
      .then((value) => {
        if (controller.signal.aborted) return
        stored.current = value
        setConfig(value)
        setTools(value.eligibleTools?.join(', ') ?? '')
        setCategories(value.eligibleCategories?.join(', ') ?? '')
        setLoaded(true)
      })
      .catch(() => {
        if (!controller.signal.aborted) setMessage('failed')
      })
    return () => controller.abort()
  }, [])
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
  const reviewer = slots?.slots[config.modelSlot ?? 'fast']
  const configured =
    !!reviewer &&
    !!slots &&
    modelSlotOptions(slots).some((model) => model.route === reviewer.route && model.id === reviewer.model)
  const update = (patch: Partial<AutoReviewConfig>) => {
    setConfig((value) => ({ ...value, ...patch }))
    setMessage('')
    setDirty(true)
  }
  async function save() {
    if (busy || !loaded || !canSave) return
    setBusy(true)
    try {
      const list = (text: string) =>
        text
          .split(',')
          .map((value) => value.trim())
          .filter(Boolean)
      const { eligibleTools: _tools, eligibleCategories: _categories, ...remaining } = config
      const eligibleCategories = list(categories).map((category) => {
        if (category !== 'read' && category !== 'write' && category !== 'external')
          throw new Error('Invalid eligible category')
        return category
      })
      const next = {
        ...remaining,
        ...(tools.trim() ? { eligibleTools: list(tools) } : {}),
        ...(eligibleCategories.length ? { eligibleCategories } : {}),
      }
      const value = await reviewSettings(next, lifetime.current?.signal)
      if (lifetime.current?.signal.aborted) return
      stored.current = value
      setConfig(value)
      setDirty(false)
      setMessage('saved')
    } catch {
      if (!lifetime.current?.signal.aborted) setMessage('failed')
    } finally {
      if (!lifetime.current?.signal.aborted) setBusy(false)
    }
  }
  return (
    <SettingsSection title={t('title')} data-testid="auto-review-settings">
      <SettingsGroup>
        <SettingsItem label={t('enabledLabel')} description={t('enabledHelp')}>
          <LabeledSwitch
            checked={stored.current.enabled ?? false}
            disabled={!canSave || !loaded || busy}
            testId="auto-review-enabled"
            label={t('enabled')}
            onLabel={t('on')}
            offLabel={t('off')}
            onToggle={(enabled) => {
              if (busy || !loaded || !canSave) return
              setBusy(true)
              void reviewSettings({ ...stored.current, enabled }, lifetime.current?.signal)
                .then((value) => {
                  if (lifetime.current?.signal.aborted) return
                  stored.current = value
                  setConfig((draft) => ({ ...draft, enabled: value.enabled ?? false }))
                  setMessage('saved')
                })
                .catch(() => {
                  if (!lifetime.current?.signal.aborted) setMessage('failed')
                })
                .finally(() => {
                  if (!lifetime.current?.signal.aborted) setBusy(false)
                })
            }}
          />
        </SettingsItem>
        <SettingsItem
          label={t('overrides')}
          description={t('overridesCount', { count: config.overrides?.length ?? 0 })}
        >
          <Button
            size="small"
            data-testid="auto-review-clear-overrides"
            disabled={!canSave || busy || !config.overrides?.length}
            onClick={() => update({ overrides: [] })}
          >
            {t('clear')}
          </Button>
        </SettingsItem>
      </SettingsGroup>
      <SettingsAdvanced
        title={t('customize')}
        data-testid="auto-review-customize"
        summary={`${t(config.modelSlot ?? 'fast')} · ${t(config.maxRisk ?? 'low')} · ${t('budgetSummary', { count: config.maxReviews ?? 20 })}`}
      >
        <Field label={t('modelSlot')} htmlFor="auto-review-model">
          <SettingsSelect
            id="auto-review-model"
            data-testid="auto-review-model"
            value={config.modelSlot ?? 'fast'}
            disabled={!canSave || !loaded || busy}
            onChange={(event) => update({ modelSlot: event.target.value as 'fast' | 'verifier' })}
          >
            {['fast', 'verifier'].map((value) => (
              <option key={value} value={value}>
                {t(value)}
              </option>
            ))}
          </SettingsSelect>
        </Field>
        <p>
          {t('profileHelp')}{' '}
          <Button href="?settings=model#auxiliary-models" data-testid="auto-review-model-link">
            {t('modelLink')}
          </Button>
        </p>
        <p className="model-slot-current" data-testid="auto-review-slot-status" role="status">
          <MetaText>
            {slotsFailed
              ? t('slotFailed')
              : !slots
                ? t('slotLoading')
                : configured
                  ? `${t('slotConfigured')}: ${reviewer?.route} / ${reviewer?.model}`
                  : t('slotUnset')}
          </MetaText>
        </p>
        <Field label={t('tools')} htmlFor="auto-review-tools">
          <SettingsInput
            id="auto-review-tools"
            data-testid="auto-review-tools"
            value={tools}
            disabled={!canSave || !loaded || busy}
            onChange={(event) => {
              setTools(event.target.value)
              setDirty(true)
              setMessage('')
            }}
          />
        </Field>
        <Field label={t('categories')} htmlFor="auto-review-categories">
          <SettingsInput
            id="auto-review-categories"
            data-testid="auto-review-categories"
            value={categories}
            disabled={!canSave || !loaded || busy}
            onChange={(event) => {
              setCategories(event.target.value)
              setDirty(true)
              setMessage('')
            }}
          />
        </Field>
        <Field label={t('maxRisk')} htmlFor="auto-review-risk">
          <SettingsSelect
            id="auto-review-risk"
            data-testid="auto-review-risk"
            value={config.maxRisk ?? 'low'}
            disabled={!canSave || !loaded || busy}
            onChange={(event) => update({ maxRisk: event.target.value as 'low' | 'medium' })}
          >
            {['low', 'medium'].map((value) => (
              <option key={value} value={value}>
                {t(value)}
              </option>
            ))}
          </SettingsSelect>
        </Field>
        {(['maxReviews', 'timeoutMs'] as const).map((name) => (
          <Field
            key={name}
            label={t(name === 'maxReviews' ? 'budget' : 'timeout')}
            htmlFor={`auto-review-${name}`}
          >
            <SettingsInput
              id={`auto-review-${name}`}
              data-testid={`auto-review-${name}`}
              type="number"
              min={name === 'maxReviews' ? 0 : 1}
              max={name === 'maxReviews' ? 1000 : 60000}
              value={config[name] ?? (name === 'maxReviews' ? 20 : 10000)}
              disabled={!canSave || !loaded || busy}
              onChange={(event) => update({ [name]: Number(event.target.value) })}
            />
          </Field>
        ))}
      </SettingsAdvanced>
      <div data-testid="auto-review-save">
        <SettingsSaveBar
          dirty={dirty && canSave && loaded}
          busy={busy}
          saved={message === 'saved'}
          onSave={() => void save()}
          onDiscard={() => {
            setConfig(stored.current)
            setTools(stored.current.eligibleTools?.join(', ') ?? '')
            setCategories(stored.current.eligibleCategories?.join(', ') ?? '')
            setDirty(false)
            setMessage('')
          }}
        />
      </div>
      {message && (
        <SettingsState
          tone={message === 'failed' ? 'error' : 'success'}
          role={message === 'failed' ? 'alert' : 'status'}
          data-testid="auto-review-status"
        >
          {t(message)}
        </SettingsState>
      )}
    </SettingsSection>
  )
}
