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

export type StageModelOption = {
  route: string
  id: string
  label?: string
  reasoning?: boolean
  thinkingLevelMap?: Record<string, string>
}
export type StageName = 'parameters' | 'arbitration' | 'answer'
export type StageBinding = { route: string; model: string; thinking?: ThinkingLevel | null }
export type StageBindings = Record<StageName, StageBinding | null>

const STAGES: ReadonlyArray<{ stage: StageName; label: string }> = [
  { stage: 'parameters', label: '补参' },
  { stage: 'arbitration', label: '仲裁' },
  { stage: 'answer', label: '回答' },
]

export type ModelSettingsDialogProps = {
  disabled: boolean
  settings: ModelSettings
  contextWindow: number
  thinkingLevelMap?: Record<string, string> | undefined
  /**
   * JevLoop only: per-stage model bindings. A null stage follows the session model. When present
   * the dialog shows the stage section and onApply receives the edited bindings as its second
   * argument; without it the dialog and its callback shape are unchanged.
   */
  stages?: { options: readonly StageModelOption[]; value: StageBindings } | undefined
  onApply(settings: ModelSettings, stages?: StageBindings): Promise<boolean>
}

const stageKey = (binding: StageBinding | null) => (binding ? `${binding.route}|${binding.model}` : '')

/** The dialog owns its draft; the backend-confirmed selection remains in the composer. */
export function ModelSettingsDialog({
  disabled,
  settings,
  contextWindow,
  thinkingLevelMap,
  stages,
  onApply,
}: ModelSettingsDialogProps) {
  const [open, setOpen] = useState(false)
  const [thinking, setThinking] = useState('')
  const [window, setWindow] = useState('')
  const [stageDraft, setStageDraft] = useState<StageBindings>({
    parameters: null,
    arbitration: null,
    answer: null,
  })
  const stageOption = (binding: StageBinding | null) =>
    binding
      ? stages?.options.find((option) => option.route === binding.route && option.id === binding.model)
      : undefined
  const bound = stages ? STAGES.filter(({ stage }) => stages.value[stage] !== null).length : 0
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
        aria-label={
          stages
            ? '配置本会话的思考强度、上下文预算和 JevLoop 分环节模型'
            : '配置本会话的思考强度和上下文预算'
        }
        title={stages && bound > 0 ? `已为 ${bound} 个环节单独指定模型` : undefined}
        onClick={() => {
          setThinking(settings.thinking ?? '')
          setWindow(String(settings.contextWindow ?? ''))
          if (stages) setStageDraft({ ...stages.value })
          setError('')
          setOpen(true)
        }}
      >
        {stages ? (bound > 0 ? `思考 · 环节 ${bound}/3` : '思考 · 环节') : '思考 · 上下文'}
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
            const next = {
              ...(thinking ? { thinking: thinking as ThinkingLevel } : {}),
              ...(tokens === undefined ? {} : { contextWindow: tokens }),
            }
            const accepted = stages ? await onApply(next, stageDraft) : await onApply(next)
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
        {stages && (
          <fieldset className="stage-models" disabled={pending || disabled}>
            <legend>JevLoop 分环节模型</legend>
            <p className="field-hint">
              未指定的环节跟随会话模型。分档后各环节的前缀缓存独立计费，仲裁占比高时可能更贵。
            </p>
            {STAGES.map(({ stage, label }) => {
              const binding = stageDraft[stage]
              const option = stageOption(binding)
              return (
                <div className="stage-model-row" key={stage} data-stage={stage}>
                  <label htmlFor={`stage-model-${stage}`}>{label}</label>
                  <select
                    id={`stage-model-${stage}`}
                    value={stageKey(binding)}
                    onChange={(event) => {
                      const value = event.target.value
                      const separator = value.indexOf('|')
                      setStageDraft((draft) => ({
                        ...draft,
                        [stage]:
                          value === ''
                            ? null
                            : { route: value.slice(0, separator), model: value.slice(separator + 1) },
                      }))
                    }}
                  >
                    <option value="">跟随会话模型</option>
                    {stages.options.map((entry) => (
                      <option key={`${entry.route}|${entry.id}`} value={`${entry.route}|${entry.id}`}>
                        {entry.label ? `${entry.label} · ${entry.id}` : entry.id}
                      </option>
                    ))}
                  </select>
                  <select
                    id={`stage-thinking-${stage}`}
                    aria-label={`${label}思考强度`}
                    value={binding?.thinking ?? ''}
                    disabled={!binding || !option?.reasoning}
                    onChange={(event) => {
                      const value = event.target.value
                      setStageDraft((draft) => {
                        const current = draft[stage]
                        if (!current) return draft
                        return {
                          ...draft,
                          [stage]: { ...current, thinking: value === '' ? null : (value as ThinkingLevel) },
                        }
                      })
                    }}
                  >
                    {modelThinkingOptions(option?.thinkingLevelMap).map((entry) => (
                      <option key={entry.value} value={entry.value}>
                        {entry.label}
                      </option>
                    ))}
                  </select>
                </div>
              )
            })}
          </fieldset>
        )}
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
