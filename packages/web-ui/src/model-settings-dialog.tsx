import { type ModelSettings, minimumContextBudget, type ThinkingLevel } from '@agnes/protocol'
import { useState } from 'react'
import { Button } from './ui/button.js'
import { Dialog } from './ui/dialog.js'
import { Field } from './ui/field.js'

const labels: Record<ThinkingLevel, string> = {
  off: '关闭',
  minimal: '最低',
  low: '低',
  medium: '中',
  high: '高',
  xhigh: '更高',
  max: '最高',
}

export function modelThinkingOptions(map?: Record<string, string>) {
  return [
    { label: '自动（Provider 默认）', value: '' },
    ...Object.entries(labels)
      .filter(([level]) => map && Object.hasOwn(map, level))
      .map(([value, label]) => ({ value, label: `${label} · ${value}` })),
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
}

/** The dialog owns its draft; the backend-confirmed selection remains in the composer. */
export function ModelSettingsDialog({
  disabled,
  settings,
  contextWindow,
  thinkingLevelMap,
  onApply,
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
    thinking === '' || modelThinkingOptions(thinkingLevelMap).some((option) => option.value === thinking)
  return (
    <>
      <Button
        id="composer-model-settings"
        type="text"
        htmlType="button"
        disabled={disabled}
        aria-haspopup="dialog"
        aria-label="配置本会话的思考强度和上下文预算"
        onClick={() => {
          setThinking(settings.thinking ?? '')
          setWindow(String(settings.contextWindow ?? ''))
          setError('')
          setOpen(true)
        }}
      >
        思考 · 上下文
      </Button>
      <Dialog
        title="本会话模型配置"
        open={open}
        onCancel={() => setOpen(false)}
        okText="应用到本会话"
        cancelText="取消"
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
            else setError('配置未保存，请检查连接或重试。')
          } catch (failure) {
            setError(failure instanceof Error ? failure.message : '配置保存失败')
          } finally {
            setPending(false)
          }
        }}
      >
        <p>仅影响本会话的后续请求，重新打开会话后仍会保留。</p>
        <Field className="form-field" label="思考强度" htmlFor="session-model-thinking">
          <select
            id="session-model-thinking"
            value={thinking}
            disabled={pending || disabled}
            aria-invalid={!validThinking}
            aria-describedby="session-model-settings-error"
            onChange={(event) => setThinking(event.target.value)}
          >
            {modelThinkingOptions(thinkingLevelMap).map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
            {!validThinking && <option value={thinking}>已保存的档位当前不可用：{thinking}</option>}
          </select>
        </Field>
        <Field className="form-field" label="本会话上下文预算（Token）" htmlFor="session-model-window">
          <input
            id="session-model-window"
            type="text"
            maxLength={32}
            value={window}
            placeholder={`自动 · ${contextWindow.toLocaleString()}`}
            disabled={pending || disabled}
            aria-invalid={!validWindow}
            aria-describedby="session-model-window-hint session-model-settings-error"
            onChange={(event) => setWindow(event.target.value)}
          />
        </Field>
        <p id="session-model-window-hint" className="field-hint">
          模型容量 {contextWindow.toLocaleString()} Token。可输入 100K（100,000
          Token）或完整数量；留空恢复自动。较小预算会提前整理上下文。
        </p>
        <p id="session-model-settings-error" role="alert">
          {!validWindow
            ? `请输入 ${minimum.toLocaleString()} 至 ${contextWindow.toLocaleString()} 之间的正整数 Token，可使用 K/M 单位。`
            : !validThinking
              ? '该模型当前不支持已保存的思考强度，请重新选择。'
              : error}
        </p>
      </Dialog>
    </>
  )
}
