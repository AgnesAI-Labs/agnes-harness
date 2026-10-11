import type {
  HTMLAttributes,
  InputHTMLAttributes,
  ReactNode,
  SelectHTMLAttributes,
  TextareaHTMLAttributes,
} from 'react'
import { forwardRef, useEffect, useId, useState } from 'react'

import { fallbackT } from './locales/index.js'
import { Button } from './ui/button.js'
import { Icon } from './ui/icon.js'
import { Skeleton } from './ui/skeleton.js'

type DataAttributes = { [name: `data-${string}`]: string | number | boolean | undefined }

/** Shared settings composition, matching the model/account pane and its card spacing. */
export function SettingsPage({
  title,
  description,
  actions,
  headingId,
  bodyClassName,
  banner,
  toolbar,
  saveBar,
  variant = 'form',
  children,
  ...props
}: Omit<HTMLAttributes<HTMLElement>, 'title'> &
  DataAttributes & {
    title: ReactNode
    description?: ReactNode
    actions?: ReactNode
    headingId?: string
    bodyClassName?: string
    banner?: ReactNode
    toolbar?: ReactNode
    saveBar?: ReactNode
    variant?: 'form' | 'list'
  }) {
  return (
    <section
      {...props}
      data-layout={variant}
      className={['agnes-settings-page', props.className].filter(Boolean).join(' ')}
    >
      <SettingsPageHeader title={title} description={description} actions={actions} headingId={headingId} />
      {banner}
      {toolbar}
      <div className={['agnes-settings-stack', bodyClassName].filter(Boolean).join(' ')}>{children}</div>
      {saveBar}
    </section>
  )
}
export function SettingsCard({
  title,
  description,
  actions,
  children,
  ...props
}: Omit<HTMLAttributes<HTMLElement>, 'title'> &
  DataAttributes & {
    title?: ReactNode
    description?: ReactNode
    actions?: ReactNode
  }) {
  return (
    <section
      {...props}
      className={['config-card', 'agnes-settings-card', props.className].filter(Boolean).join(' ')}
    >
      {(title || description || actions) && (
        <div className="config-accounts-heading">
          <div>
            {title && <h3>{title}</h3>}
            {description && <p>{description}</p>}
          </div>
          {actions}
        </div>
      )}
      {children}
    </section>
  )
}
export function SettingsState({
  tone = 'empty',
  children,
  ...props
}: HTMLAttributes<HTMLDivElement> & { tone?: 'empty' | 'loading' | 'error' | 'success' }) {
  return (
    <div
      {...props}
      className={['agnes-settings-state', props.className].filter(Boolean).join(' ')}
      data-tone={tone}
      role={props.role ?? (tone === 'error' ? 'alert' : 'status')}
      aria-live={props['aria-live'] ?? 'polite'}
      aria-busy={props['aria-busy'] ?? (tone === 'loading' || undefined)}
    >
      {tone === 'loading' && <Skeleton />}
      {children}
    </div>
  )
}
export const SettingsInput = forwardRef<
  HTMLInputElement,
  InputHTMLAttributes<HTMLInputElement> & DataAttributes & { surface?: 'page' | 'surface' }
>(function SettingsInput({ surface = 'page', ...props }, ref) {
  return (
    <input
      {...props}
      ref={ref}
      className={[
        'agnes-settings-input',
        surface === 'surface' && 'agnes-settings-input-surface',
        props.className,
      ]
        .filter(Boolean)
        .join(' ')}
    />
  )
})
export const SettingsTextArea = forwardRef<
  HTMLTextAreaElement,
  TextareaHTMLAttributes<HTMLTextAreaElement> & DataAttributes & { presentation?: 'field' | 'plain' }
>(function SettingsTextArea({ presentation = 'field', ...props }, ref) {
  return (
    <textarea
      {...props}
      ref={ref}
      className={[presentation === 'field' ? 'agnes-settings-input' : 'agnes-ui-textarea', props.className]
        .filter(Boolean)
        .join(' ')}
    />
  )
})
/** Native select preserves form semantics, following SettingsOptionSelect's account-dialog pattern. */
export const SettingsSelect = forwardRef<
  HTMLSelectElement,
  SelectHTMLAttributes<HTMLSelectElement> & DataAttributes
>(function SettingsSelect(props, ref) {
  return (
    <select
      {...props}
      ref={ref}
      className={['agnes-settings-input', props.className].filter(Boolean).join(' ')}
    />
  )
})

/** Flat settings rows keep controls and diagnostics out of nested cards. */
export function SettingsList(props: HTMLAttributes<HTMLDivElement>) {
  return <div {...props} className={['agnes-settings-list', props.className].filter(Boolean).join(' ')} />
}
export function SettingsRow({
  title,
  description,
  actions,
  children,
  ...props
}: Omit<HTMLAttributes<HTMLElement>, 'title'> &
  DataAttributes & {
    title: ReactNode
    description?: ReactNode
    actions?: ReactNode
  }) {
  return (
    <article {...props} className={['agnes-settings-row', props.className].filter(Boolean).join(' ')}>
      <div className="agnes-settings-row-heading">
        <div>
          <h4>{title}</h4>
          {description && <p>{description}</p>}
        </div>
        {actions && <div className="agnes-settings-actions">{actions}</div>}
      </div>
      {children}
    </article>
  )
}
export function SettingsDetails({
  title,
  children,
  compact = false,
  ...props
}: Omit<import('react').DetailsHTMLAttributes<HTMLDetailsElement>, 'title'> & {
  title: ReactNode
  compact?: boolean
  'data-testid'?: string
}) {
  return (
    <details
      {...props}
      data-compact={compact || undefined}
      className={['agnes-settings-details', props.className].filter(Boolean).join(' ')}
    >
      <summary data-testid={props['data-testid'] ? `${props['data-testid']}-toggle` : undefined}>
        {title}
      </summary>
      <div>{children}</div>
    </details>
  )
}
export function SettingsToolbar({
  search,
  filters,
  controls,
  children,
  ...props
}: HTMLAttributes<HTMLDivElement> & {
  search?: ReactNode
  filters?: ReactNode
  controls?: ReactNode
}) {
  return (
    <div {...props} className={['agnes-settings-toolbar', props.className].filter(Boolean).join(' ')}>
      {search && <div className="agh-settings-toolbar-search">{search}</div>}
      {filters && <div className="agh-settings-toolbar-filters">{filters}</div>}
      {controls && <div className="agh-settings-toolbar-controls">{controls}</div>}
      {children}
    </div>
  )
}

/** Native checkbox with a shared compact label and field sizing. */
export function SettingsCheckbox({
  label,
  ...props
}: InputHTMLAttributes<HTMLInputElement> & { label: ReactNode }) {
  return (
    <label className="agnes-settings-checkbox">
      <input {...props} type="checkbox" /> <span>{label}</span>
    </label>
  )
}

/** A native choice keeps radio-group keyboard and form semantics in the shared layer. */
export function SettingsChoice({
  label,
  hint,
  ...props
}: InputHTMLAttributes<HTMLInputElement> & {
  type: 'radio' | 'checkbox'
  label: ReactNode
  hint?: ReactNode
}) {
  const generatedId = useId()
  const id = props.id ?? generatedId
  return (
    <label className="appearance-option" htmlFor={id}>
      <SettingsInput {...props} id={id} />
      <span className="appearance-option-copy">
        <span className="appearance-option-name">{label}</span>
        {hint && <span className="appearance-option-hint">{hint}</span>}
      </span>
    </label>
  )
}

/** Read-only code region remains keyboard scrollable when its content overflows. */
export function SettingsCode({ label, ...props }: HTMLAttributes<HTMLPreElement> & { label: string }) {
  return (
    <section aria-label={label}>
      {/* biome-ignore lint/a11y/noNoninteractiveTabindex: keyboard users need to scroll long prompt and JSON blocks. */}
      <pre {...props} tabIndex={0} />
    </section>
  )
}

export function SettingsPageHeader({
  title,
  description,
  actions,
  headingId,
  ...props
}: Omit<HTMLAttributes<HTMLElement>, 'title'> &
  DataAttributes & {
    title: ReactNode
    description?: ReactNode
    actions?: ReactNode
    headingId?: string | undefined
  }) {
  return (
    <header
      {...props}
      className={['config-heading', 'agnes-settings-page-heading', props.className].filter(Boolean).join(' ')}
    >
      <div>
        <h2 id={headingId}>{title}</h2>
        {description && <p>{description}</p>}
      </div>
      {actions && <div className="agnes-settings-actions">{actions}</div>}
    </header>
  )
}
export function SettingsSaveBar({
  dirty,
  busy = false,
  saved = false,
  onDiscard,
  onSave,
  message,
  discardLabel,
  saveLabel,
}: {
  dirty: boolean
  busy?: boolean
  saved?: boolean
  onDiscard(): void
  onSave(): void
  message?: string
  discardLabel?: string
  saveLabel?: string
}) {
  const [showSaved, setShowSaved] = useState(false)
  useEffect(() => {
    if (!saved) {
      setShowSaved(false)
      return
    }
    setShowSaved(true)
    const timer = setTimeout(() => setShowSaved(false), 2000)
    return () => clearTimeout(timer)
  }, [saved])
  if (!dirty)
    return showSaved ? (
      <div className="agh-settings-saved" role="status">
        <Icon name="check" />
        {fallbackT('ui.saved')}
      </div>
    ) : null
  return (
    <div
      className="agh-settings-save-bar"
      role="region"
      aria-label={fallbackT('ui.unsaved')}
      aria-busy={busy || undefined}
    >
      <span>{message ?? fallbackT('ui.unsaved')}</span>
      <div className="agnes-settings-actions">
        <Button onClick={onDiscard} disabled={busy} disabledReason={fallbackT('ui.saving')}>
          {discardLabel ?? fallbackT('ui.discard')}
        </Button>
        <Button appearance="primary" onClick={onSave} loading={busy}>
          {saveLabel ?? fallbackT('ui.save')}
        </Button>
      </div>
    </div>
  )
}
