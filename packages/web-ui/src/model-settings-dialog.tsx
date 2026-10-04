import { type ModelSettings, minimumContextBudget, type ThinkingLevel } from '@agnes/protocol'
import { useState } from 'react'
import { fallbackT, type Translate } from './locales/index.js'
import { Button } from './ui/button.js'
import { Dialog } from './ui/dialog.js'
import { Field } from './ui/field.js'

const THINKING_LABEL_KEYS: Record<ThinkingLevel, string> = {
  off: 'modelSettings.thinking.off',
  minimal: 'modelSettings.thinking.minimal',
  low: 'modelSettings.thinking.low',
  medium: 'modelSettings.thinking.medium',
  high: 'modelSettings.thinking.high',
  xhigh: 'modelSettings.thinking.xhigh',
  max: 'modelSettings.thinking.max',
}

export function modelThinkingOptions(map?: Record<string, string>, t: Translate = fallbackT) {
  return [
    { label: t('modelSettings.thinking.auto'), value: '' },
    ...Object.entries(THINKING_LABEL_KEYS)
      .filter(([level]) => map && Object.hasOwn(map, level))
      .map(([value, key]) => ({ value, label: `${t(key)} · ${value}` })),
  ]
}

/** Suffixes are explicit: 100 is 100 tokens, while 100K is 100,000 tokens. */
export function parseContextBudget(value: string): number | undefined {
  const match = /^(\d+(?:\.\d+)?)\s*([km]?)$/i.exec(value.trim())
  if (!match) return undefined
  const tokens = Number(match[1]) * (match[2]?.toLowerCase() === 'm' ? 1e6 : match[2] ? 1000 : 1)
  return Number.isSafeInteger(tokens) && tokens > 0 ? tokens : undefined
}

export type ModelSettingsDialogProps = {
  disabled: boolean
  settings: ModelSettings
  contextWindow: number
  thinkingLevelMap?: Record<string, string> | undefined
  onApply(settings: ModelSettings): Promise<boolean>
  /** Locale-bound translate injected by the host; render-time lookup only. */
  t?: Translate | undefined
}

/** The dialog owns its draft; the backend-confirmed selection remains in the composer. */
export function ModelSettingsDialog({
  disabled,
  settings,
  contextWindow,
  thinkingLevelMap,
  onApply,
  t = fallbackT,
}: ModelSettingsDialogProps) {
  const [open, setOpen] = useState(false)
  const [thinking, setThinking] = useState('')
  const [window, setWindow] = useState('')
  const [pending, setPending] = useState(false)
  const [error, setError] = useState('')
  const tokens = parseContextBudget(window)
  const minimum = minimumContextBudget(contextWindow)
  const validWindow =
    window.trim() === '' || (tokens !== undefined && tokens >= minimum && tokens <= contextWindow)
  const validThinking =
    thinking === '' || modelThinkingOptions(thinkingLevelMap, t).some((option) => option.value === thinking)
  return (
    <>
      <Button
        id="composer-model-settings"
        type="text"
        htmlType="button"
        disabled={disabled}
        aria-haspopup="dialog"
        aria-label={t('modelSettings.triggerAria')}
        onClick={() => {
          setThinking(settings.thinking ?? '')
          setWindow(String(settings.contextWindow ?? ''))
          setError('')
          setOpen(true)
        }}
      >
        {t('modelSettings.trigger')}
      </Button>
      <Dialog
        title={t('modelSettings.title')}
        open={open}
        onCancel={() => setOpen(false)}
        okText={t('modelSettings.ok')}
        cancelText={t('modelSettings.cancel')}
        confirmLoading={pending}
        okButtonProps={{ disabled: disabled || !validWindow || !validThinking }}
        onOk={async () => {
          if (disabled || pending || !validWindow || !validThinking) return
          setPending(true)
          setError('')
          try {
            const accepted = await onApply({
              ...(thinking ? { thinking: thinking as ThinkingLevel } : {}),
              ...(tokens === undefined ? {} : { contextWindow: tokens }),
            })
            if (accepted) setOpen(false)
            else setError(t('modelSettings.saveFailed'))
          } catch (failure) {
            setError(failure instanceof Error ? failure.message : t('modelSettings.saveError'))
          } finally {
            setPending(false)
          }
        }}
      >
        <p>{t('modelSettings.intro')}</p>
        <Field
          className="form-field"
          label={t('modelSettings.thinkingLabel')}
          htmlFor="session-model-thinking"
        >
          <select
            id="session-model-thinking"
            value={thinking}
            disabled={pending || disabled}
            aria-invalid={!validThinking}
            aria-describedby="session-model-settings-error"
            onChange={(event) => setThinking(event.target.value)}
          >
            {modelThinkingOptions(thinkingLevelMap, t).map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
            {!validThinking && (
              <option value={thinking}>
                {t('modelSettings.savedThinkingUnavailable', { value: thinking })}
              </option>
            )}
          </select>
        </Field>
        <Field className="form-field" label={t('modelSettings.windowLabel')} htmlFor="session-model-window">
          <input
            id="session-model-window"
            type="text"
            maxLength={32}
            value={window}
            placeholder={t('modelSettings.windowPlaceholder', {
              tokens: contextWindow.toLocaleString(),
            })}
            disabled={pending || disabled}
            aria-invalid={!validWindow}
            aria-describedby="session-model-window-hint session-model-settings-error"
            onChange={(event) => setWindow(event.target.value)}
          />
        </Field>
        <p id="session-model-window-hint" className="field-hint">
          {t('modelSettings.windowHint', { tokens: contextWindow.toLocaleString() })}
        </p>
        <p id="session-model-settings-error" role="alert">
          {!validWindow
            ? t('modelSettings.windowRange', {
                min: minimum.toLocaleString(),
                max: contextWindow.toLocaleString(),
              })
            : !validThinking
              ? t('modelSettings.thinkingUnsupported')
              : error}
        </p>
      </Dialog>
    </>
  )
}
