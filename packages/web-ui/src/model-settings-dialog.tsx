import type { ModelSettings, ThinkingLevel } from '@agnes/protocol'
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
  const validWindow =
    window === '' ||
    (Number.isSafeInteger(Number(window)) && Number(window) > 0 && Number(window) <= contextWindow)
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
        aria-label="配置本会话的思考强度和上下文窗口"
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
              ...(window ? { contextWindow: Number(window) } : {}),
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
        <Field className="form-field" label="上下文窗口（tokens）" htmlFor="session-model-window">
          <input
            id="session-model-window"
            type="number"
            min={1}
            max={contextWindow}
            step={1}
            value={window}
            placeholder={`自动 · ${contextWindow.toLocaleString()}`}
            disabled={pending || disabled}
            aria-invalid={!validWindow}
            aria-describedby="session-model-window-hint session-model-settings-error"
            onChange={(event) => setWindow(event.target.value)}
          />
        </Field>
        <p id="session-model-window-hint" className="field-hint">
          留空恢复模型目录默认值。最大 {contextWindow.toLocaleString()} tokens；此值控制上下文压缩预算。
        </p>
        <p id="session-model-settings-error" role="alert">
          {!validWindow
            ? '请输入模型容量以内的正整数。'
            : !validThinking
              ? '该模型当前不支持已保存的思考强度，请重新选择。'
              : error}
        </p>
      </Dialog>
    </>
  )
}
