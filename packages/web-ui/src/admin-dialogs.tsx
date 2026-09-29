import type { JSX, ReactNode } from 'react'

/**
 * 来源检查对话框的内容体。`<dialog>` 与 showModal/焦点归还留在壳里；字段受控，
 * 值与格式示例由壳提供，提交时把原始输入交回壳做格式校验。
 * 提交走显式按钮回调（happy-dom 的 requestSubmit 触达不了 React 的委托 onSubmit），
 * Enter 键在引用输入框上补齐表单提交语义。
 */
export function SourceDialogContent({
  title,
  intro,
  typeOptions,
  type,
  ref_,
  placeholder,
  error,
  busy,
  onTypeChange,
  onRefChange,
  onSubmit,
  onCancel,
}: {
  title: string
  intro: string
  typeOptions: readonly { value: string; label: string }[]
  type: string
  ref_: string
  placeholder: string
  error: string
  busy: boolean
  onTypeChange(type: string): void
  onRefChange(ref: string): void
  onSubmit(): void
  onCancel(): void
}): JSX.Element {
  return (
    <form
      id="source-form"
      className="plugin-dialog-form"
      onSubmit={(event) => {
        event.preventDefault()
      }}
    >
      <div className="dialog-heading">
        <div>
          <p className="dialog-kicker">来源</p>
          <h2 id="source-dialog-title">{title}</h2>
        </div>
      </div>
      <p className="dialog-intro">{intro}</p>
      <label className="form-field" htmlFor="source-type">
        来源类型
        <select id="source-type" value={type} onChange={(event) => onTypeChange(event.currentTarget.value)}>
          {typeOptions.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      </label>
      <label className="form-field" htmlFor="source-ref">
        来源引用
        <input
          id="source-ref"
          required
          autoComplete="off"
          spellCheck={false}
          placeholder={placeholder}
          value={ref_}
          onChange={(event) => onRefChange(event.currentTarget.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault()
              if (!busy) onSubmit()
            }
          }}
        />
      </label>
      <p id="source-error" className="plugin-form-error" role="alert">
        {error}
      </p>
      <div className="dialog-actions">
        <button id="source-cancel" type="button" className="secondary-button" onClick={onCancel}>
          取消
        </button>
        <button type="button" className="primary-button" disabled={busy} onClick={onSubmit}>
          {busy ? '正在检查…' : '检查来源'}
        </button>
      </div>
    </form>
  )
}

/**
 * 通用确认对话框的内容体。facts 由壳传入 React 节点（对应原 renderFacts 机制），
 * 确认按钮的置灰与恢复由壳在运行确认流程时控制。
 */
export function ConfirmDialogContent({
  title,
  description,
  facts,
  actionLabel,
  actionDisabled,
  onAction,
  onCancel,
}: {
  title: string
  description: string
  facts: ReactNode | undefined
  actionLabel: string
  actionDisabled: boolean
  onAction(): void
  onCancel(): void
}): JSX.Element {
  return (
    <div className="plugin-dialog-form">
      <div className="dialog-heading">
        <div>
          <p className="dialog-kicker">确认</p>
          <h2 id="plugin-confirm-title">{title}</h2>
        </div>
      </div>
      <p id="plugin-confirm-description" className="dialog-intro">
        {description}
      </p>
      {facts && (
        <div id="plugin-confirm-preview" className="confirm-facts">
          {facts}
        </div>
      )}
      <div className="dialog-actions">
        <button id="plugin-confirm-cancel" type="button" className="secondary-button" onClick={onCancel}>
          取消
        </button>
        <button
          id="plugin-confirm-action"
          type="button"
          className="primary-button"
          disabled={actionDisabled}
          onClick={onAction}
        >
          {actionLabel}
        </button>
      </div>
    </div>
  )
}
