import type { JsonValue } from '@agnes/protocol/gen/intelligent-ui'
import { decodeSafeImage, type SafeImageLimits } from '@agnes/protocol-validation'
import { type ReactNode, useEffect, useState } from 'react'
import { Badge } from '../ui/badge.js'
import type { StateTone } from '../ui/state-lights.js'
import { Tabs } from '../ui/tabs.js'
import { useUiText } from '../ui-locale.js'
import { INTELLIGENT_UI_NAMESPACE, intelligentUiCatalog } from './locales.js'
import { uiObject } from './validate.js'

const PRESET_IMAGE_LIMITS: SafeImageLimits = {
  maxBytesPerImage: 12288,
  maxPixelsPerImage: 1_048_576,
  maxAggregateBytes: 12288,
  maxAggregatePixels: 1_048_576,
}
const STEP_TONE: Record<string, StateTone> = { done: 'ok', active: 'warn', error: 'bad', pending: 'off' }
const STEP_TEXT: Record<string, string> = {
  pending: 'ui.stepPending',
  active: 'ui.stepActive',
  done: 'ui.stepDone',
  error: 'ui.stepError',
}

/** Display-only. Currency symbols and time zones are never inferred from the model. */
export function formatFieldValue(
  value: JsonValue | undefined,
  format: string | undefined,
  locale: string,
): string {
  if ((format === 'number' || format === 'currency') && typeof value === 'number')
    return new Intl.NumberFormat(locale).format(value)
  if (format === 'date' && typeof value === 'string') {
    const formatted = formatUtcDate(value, locale)
    if (formatted) return formatted
  }
  return typeof value === 'object' ? JSON.stringify(value) : String(value ?? '')
}
function formatUtcDate(value: string, locale: string): string | undefined {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value)
  if (!match) return undefined
  const year = Number(match[1])
  const month = Number(match[2])
  const day = Number(match[3])
  const date = new Date(Date.UTC(year, month - 1, day))
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day)
    return undefined
  return new Intl.DateTimeFormat(locale, {
    timeZone: 'UTC',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(date)
}

export function DetailCard({
  id,
  fields,
  data,
  statusKey,
  secondaryKey,
}: {
  id: string
  fields: readonly { key: string; label: string; format?: string }[]
  data: JsonValue | undefined
  statusKey?: string
  secondaryKey?: string
}) {
  const { locale } = useUiText(INTELLIGENT_UI_NAMESPACE, intelligentUiCatalog)
  const record = uiObject(data) ? data : {}
  const status = statusKey ? record[statusKey] : undefined
  const secondary = secondaryKey ? record[secondaryKey] : undefined
  return (
    <div data-testid={`ui-detail-${id}`}>
      {typeof status === 'string' && (
        <div data-testid={`ui-detail-status-${id}`}>
          <Badge tone="off">{status}</Badge>
        </div>
      )}
      <dl className="agnes-intelligent-detail">
        {fields.map((field) => (
          <div key={field.key} data-testid={`ui-detail-field-${id}-${field.key}`}>
            <dt>{field.label}</dt>
            <dd>{formatFieldValue(record[field.key], field.format, locale)}</dd>
          </div>
        ))}
      </dl>
      {typeof secondary === 'string' && <p data-testid={`ui-detail-secondary-${id}`}>{secondary}</p>}
    </div>
  )
}

export function PresetTabs({
  id,
  tabs,
  label,
  renderChild,
}: {
  id: string
  tabs: readonly { id: string; label: string; componentIds: readonly string[] }[]
  label: string
  renderChild(componentId: string): ReactNode
}) {
  const [active, setActive] = useState(tabs[0]?.id ?? '')
  if (tabs.length === 0) return null
  return (
    <div data-testid={`ui-tabs-${id}`} aria-label={label}>
      <Tabs
        activeKey={active}
        onChange={setActive}
        items={tabs.map((tab) => ({
          key: tab.id,
          label: <span data-testid={`ui-tab-${id}-${tab.id}`}>{tab.label}</span>,
          children: (
            <div
              role="tabpanel"
              id={`ui-tabpanel-${id}-${tab.id}`}
              data-testid={`ui-tabpanel-${id}-${tab.id}`}
            >
              {tab.componentIds.map((componentId) => (
                <div key={componentId}>{renderChild(componentId)}</div>
              ))}
            </div>
          ),
        }))}
      />
    </div>
  )
}

export function StepsView({ id, data }: { id: string; data: JsonValue | undefined }) {
  const { t } = useUiText(INTELLIGENT_UI_NAMESPACE, intelligentUiCatalog)
  const steps = Array.isArray(data) ? data.filter(uiObject) : []
  return (
    <ol className="agnes-intelligent-steps" data-testid={`ui-steps-${id}`}>
      {steps.map((step) => {
        const stepId = String(step.id ?? '')
        const state = typeof step.state === 'string' ? step.state : ''
        return (
          <li
            key={stepId}
            data-testid={`ui-step-${id}-${stepId}`}
            aria-current={state === 'active' ? 'step' : undefined}
          >
            <span>{String(step.label ?? '')}</span>
            <Badge tone={STEP_TONE[state] ?? 'off'}>{t(STEP_TEXT[state] ?? state)}</Badge>
            {typeof step.description === 'string' && <p>{step.description}</p>}
          </li>
        )
      })}
    </ol>
  )
}

export function displayPercent(value: number, total: number): number {
  if (!Number.isFinite(value) || !Number.isFinite(total) || total <= 0) return 0
  return Math.min(100, Math.max(0, Math.round((value / total) * 100)))
}

export function ProgressView({ id, data }: { id: string; data: JsonValue | undefined }) {
  const { t } = useUiText(INTELLIGENT_UI_NAMESPACE, intelligentUiCatalog)
  if (
    !uiObject(data) ||
    typeof data.label !== 'string' ||
    typeof data.value !== 'number' ||
    typeof data.total !== 'number'
  )
    return null
  const percent = displayPercent(data.value, data.total)
  const text = t('ui.progressValue', { label: data.label, value: data.value, total: data.total, percent })
  return (
    <div className="agnes-intelligent-progress" data-testid={`ui-progress-${id}`}>
      <div
        role="progressbar"
        tabIndex={0}
        aria-valuemin={0}
        aria-valuemax={data.total}
        aria-valuenow={data.value}
        aria-valuetext={text}
        data-percent={percent}
      >
        <div className="agnes-intelligent-progress-track">
          <div className="agnes-intelligent-progress-fill" style={{ width: `${percent}%` }} />
        </div>
      </div>
      <p>{text}</p>
    </div>
  )
}

export function ImageView({ id, alt, data }: { id: string; alt: string; data: JsonValue | undefined }) {
  const { t } = useUiText(INTELLIGENT_UI_NAMESPACE, intelligentUiCatalog)
  const source = uiObject(data) && uiObject(data.source) ? data.source : undefined
  const dataUrl =
    source?.kind === 'data-url' && typeof source.dataUrl === 'string' ? source.dataUrl : undefined
  const [src, setSrc] = useState<string>()
  const [failed, setFailed] = useState(false)
  useEffect(() => {
    if (!dataUrl) {
      setSrc(undefined)
      setFailed(false)
      return
    }
    const match = /^data:(image\/(?:png|jpeg));base64,([A-Za-z0-9+/]+={0,2})$/.exec(dataUrl)
    if (!match?.[1] || !match[2]) {
      setFailed(true)
      return
    }
    let url: string | undefined
    try {
      const decoded = decodeSafeImage({ data: match[2], mimeType: match[1] }, PRESET_IMAGE_LIMITS)
      const copy = new ArrayBuffer(decoded.bytes.byteLength)
      new Uint8Array(copy).set(decoded.bytes)
      url = URL.createObjectURL(new Blob([copy], { type: decoded.mime }))
      setSrc(url)
      setFailed(false)
    } catch {
      setFailed(true)
      return
    }
    return () => {
      if (url) URL.revokeObjectURL(url)
    }
  }, [dataUrl])
  const identity =
    source?.kind === 'artifact' && typeof source.sha256 === 'string'
      ? t('ui.imageArtifact', {
          sha256: source.sha256,
          size: typeof source.size === 'number' ? source.size : 0,
          mime: typeof source.mime === 'string' ? source.mime : '',
        })
      : source?.kind === 'attachment' && typeof source.uri === 'string'
        ? t('ui.imageAttachment', { uri: source.uri })
        : undefined
  return (
    <figure className="agnes-intelligent-image" data-testid={`ui-image-${id}`}>
      <figcaption>{alt}</figcaption>
      {src && !failed ? (
        <img data-testid={`ui-image-img-${id}`} src={src} alt={alt} />
      ) : (
        identity && <p>{identity}</p>
      )}
      {failed && <p role="status">{t('ui.imageUnavailable')}</p>}
    </figure>
  )
}
