import { AutoReviewConfig, validateAgainst } from '@agnes/protocol'
import {
  Badge,
  Button,
  Field,
  SettingsCard,
  SettingsCheckbox,
  SettingsInput,
  SettingsSelect,
  SettingsState,
  SettingsToolbar,
  useUiText,
} from '@agnes/web-ui'
import { useEffect, useState } from 'react'

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
  const [config, setConfig] = useState<AutoReviewConfig>({})
  const [tools, setTools] = useState('')
  const [categories, setCategories] = useState('')
  const [loaded, setLoaded] = useState(false)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  useEffect(() => {
    const controller = new AbortController()
    void reviewSettings(undefined, controller.signal)
      .then((value) => {
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
  }
  async function save() {
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
      setConfig(await reviewSettings(next))
      setMessage('saved')
    } catch {
      setMessage('failed')
    } finally {
      setBusy(false)
    }
  }
  return (
    <SettingsCard title={t('title')} data-testid="auto-review-settings">
      <p>{t('help')}</p>
      <SettingsCheckbox
        checked={config.enabled ?? false}
        disabled={!canSave || !loaded || busy}
        onChange={(event) => update({ enabled: event.target.checked })}
        data-testid="auto-review-enabled"
        label={t('enabled')}
      />
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
        <a href="?settings=model#auxiliary-models" data-testid="auto-review-model-link">
          {t('modelLink')}
        </a>
      </p>
      <p className="model-slot-current" data-testid="auto-review-slot-status" role="status">
        <Badge tone={slotsFailed ? 'bad' : !slots ? 'unknown' : configured ? 'ok' : 'warn'}>
          {slotsFailed
            ? t('slotFailed')
            : !slots
              ? t('slotLoading')
              : configured
                ? `${t('slotConfigured')}: ${reviewer?.route} / ${reviewer?.model}`
                : t('slotUnset')}
        </Badge>
      </p>
      <Field label={t('tools')} htmlFor="auto-review-tools">
        <SettingsInput
          id="auto-review-tools"
          data-testid="auto-review-tools"
          value={tools}
          disabled={!canSave || !loaded || busy}
          onChange={(event) => {
            setTools(event.target.value)
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
      <p>
        {t('overrides')}: {config.overrides?.length ?? 0}
      </p>
      <SettingsToolbar>
        <Button
          data-testid="auto-review-clear-overrides"
          disabled={!canSave || busy || !config.overrides?.length}
          onClick={() => update({ overrides: [] })}
        >
          {t('clear')}
        </Button>
        <Button
          data-testid="auto-review-save"
          disabled={!canSave || !loaded || busy}
          loading={busy}
          onClick={() => void save()}
        >
          {t('save')}
        </Button>
      </SettingsToolbar>
      {message && (
        <SettingsState
          tone={message === 'failed' ? 'error' : 'success'}
          role={message === 'failed' ? 'alert' : 'status'}
          data-testid="auto-review-status"
        >
          {t(message)}
        </SettingsState>
      )}
    </SettingsCard>
  )
}
