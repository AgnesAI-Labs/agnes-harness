import { AutoReviewConfig, validateAgainst } from '@agnes/protocol'
import {
  Button,
  Field,
  SettingsCard,
  SettingsCheckbox,
  SettingsInput,
  SettingsSelect,
  SettingsState,
  useUiText,
} from '@agnes/web-ui'
import { useEffect, useState } from 'react'

export const reviewCatalog = {
  en: {
    title: 'Auto review',
    help: 'A reviewer handles calls that need approval. Hard limits remain enforced. Invalid results and exhausted budgets go to you. Changes apply to future calls; nothing is learned silently.',
    enabled: 'Use model review',
    modelSlot: 'Reviewer model profile',
    fast: 'Fast (lower cost)',
    verifier: 'Verifier',
    tools: 'Eligible tools (comma separated; empty means all)',
    categories: 'Eligible categories (read, write, external; empty means all)',
    maxRisk: 'Maximum risk allowed automatically',
    low: 'Low only',
    medium: 'Low and medium',
    budget: 'Reviews per session',
    timeout: 'Review timeout (milliseconds)',
    save: 'Save policy',
    saved: 'Policy saved',
    failed: 'Policy unavailable or save failed',
    profileHelp: 'Configure the selected profile in model settings. A missing profile asks you instead.',
    overrides: 'Explicit future rules',
    clear: 'Clear future rules',
  },
  'zh-CN': {
    title: '自动审查',
    help: '审查模型处理原本需要批准的调用。硬限制仍然有效。无效结果或预算耗尽会转交你决定。修改只影响未来调用，不会静默学习。',
    enabled: '使用模型审查',
    modelSlot: '审查模型档位',
    fast: '快速（低成本）',
    verifier: '验证器',
    tools: '可审查工具（逗号分隔；留空代表全部）',
    categories: '可审查类别（read、write、external；留空代表全部）',
    maxRisk: '可自动放行的最高风险',
    low: '仅低风险',
    medium: '低风险和中风险',
    budget: '每个会话的审查次数',
    timeout: '审查超时（毫秒）',
    save: '保存策略',
    saved: '策略已保存',
    failed: '策略不可用或保存失败',
    profileHelp: '在模型设置中配置所选档位。档位未配置时会转交你决定。',
    overrides: '显式未来规则',
    clear: '清除未来规则',
  },
}
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
      <p>{t('profileHelp')}</p>
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
      {message && (
        <SettingsState role={message === 'failed' ? 'alert' : 'status'} data-testid="auto-review-status">
          {t(message)}
        </SettingsState>
      )}
    </SettingsCard>
  )
}
