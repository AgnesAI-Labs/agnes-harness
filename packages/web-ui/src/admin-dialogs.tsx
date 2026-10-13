import type { JSX, ReactNode } from 'react'
import { ADMIN_DIALOGS_LOCALE_NAMESPACE, adminDialogsLocaleCatalog } from './locales/admin-dialogs.js'
import { SettingsInput, SettingsSelect } from './settings-layout.js'
import { Button } from './ui/button.js'
import { Field } from './ui/field.js'
import { useUiText } from './ui-locale.js'

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
  const { t } = useUiText(ADMIN_DIALOGS_LOCALE_NAMESPACE, adminDialogsLocaleCatalog)
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
          <p className="dialog-kicker">{t('source.kicker')}</p>
          <h2 id="source-dialog-title">{title}</h2>
        </div>
      </div>
      <p className="dialog-intro">{intro}</p>
      <Field className="form-field" htmlFor="source-type" label={t('source.type')}>
        <SettingsSelect
          id="source-type"
          value={type}
          onChange={(event) => onTypeChange(event.currentTarget.value)}
        >
          {typeOptions.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </SettingsSelect>
      </Field>
      <Field className="form-field" htmlFor="source-ref" label={t('source.reference')}>
        <SettingsInput
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
      </Field>
      <p id="source-error" className="plugin-form-error" role="alert">
        {error}
      </p>
      <div className="dialog-actions">
        <Button id="source-cancel" htmlType="button" appearance="secondary" onClick={onCancel}>
          {t('cancel')}
        </Button>
        <Button htmlType="button" appearance="primary" disabled={busy} onClick={onSubmit}>
          {busy ? t('source.checking') : t('source.check')}
        </Button>
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
  danger = false,
  secondaryLabel,
  onAction,
  onCancel,
}: {
  title: string
  description: string
  facts: ReactNode | undefined
  actionLabel: string
  actionDisabled: boolean
  /** The action removes or revokes: the button says so in colour as well as words. */
  danger?: boolean | undefined
  /** An optional second path, shown apart from Cancel and the main action. */
  secondaryLabel?: string | undefined
  /** `secondary` is true when the second path was chosen. */
  onAction(secondary?: boolean): void
  onCancel(): void
}): JSX.Element {
  const { t } = useUiText(ADMIN_DIALOGS_LOCALE_NAMESPACE, adminDialogsLocaleCatalog)
  return (
    <div className="plugin-dialog-form">
      <div className="dialog-heading">
        <div>
          <p className="dialog-kicker">{t('confirmation.kicker')}</p>
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
        {secondaryLabel && (
          <Button
            id="plugin-confirm-secondary"
            className="dialog-action-aside"
            htmlType="button"
            appearance="ghost"
            disabled={actionDisabled}
            onClick={() => onAction(true)}
          >
            {secondaryLabel}
          </Button>
        )}
        <Button id="plugin-confirm-cancel" htmlType="button" appearance="secondary" onClick={onCancel}>
          {t('cancel')}
        </Button>
        <Button
          id="plugin-confirm-action"
          htmlType="button"
          appearance={danger ? 'danger' : 'primary'}
          dangerFilled={danger}
          disabled={actionDisabled}
          onClick={() => onAction()}
        >
          {actionLabel}
        </Button>
      </div>
    </div>
  )
}
