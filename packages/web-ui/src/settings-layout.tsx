import type {
  HTMLAttributes,
  InputHTMLAttributes,
  ReactNode,
  SelectHTMLAttributes,
  TextareaHTMLAttributes,
} from 'react'
import { forwardRef } from 'react'

/** Shared settings composition, matching the model/account pane and its card spacing. */
export function SettingsPage({
  title,
  description,
  actions,
  children,
  ...props
}: Omit<HTMLAttributes<HTMLElement>, 'title'> & {
  title: ReactNode
  description?: ReactNode
  actions?: ReactNode
}) {
  return (
    <section {...props} className={['agnes-settings-page', props.className].filter(Boolean).join(' ')}>
      <header className="config-heading agnes-settings-page-heading">
        <div>
          <h2>{title}</h2>
          {description && <p>{description}</p>}
        </div>
        {actions && <div className="agnes-settings-actions">{actions}</div>}
      </header>
      <div className="agnes-settings-stack">{children}</div>
    </section>
  )
}
export function SettingsCard({
  title,
  description,
  actions,
  children,
  ...props
}: Omit<HTMLAttributes<HTMLElement>, 'title'> & {
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
    >
      {children}
    </div>
  )
}
export const SettingsInput = forwardRef<
  HTMLInputElement,
  InputHTMLAttributes<HTMLInputElement> & { surface?: 'page' | 'surface' }
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
  TextareaHTMLAttributes<HTMLTextAreaElement> & { presentation?: 'field' | 'plain' }
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
export const SettingsSelect = forwardRef<HTMLSelectElement, SelectHTMLAttributes<HTMLSelectElement>>(
  function SettingsSelect(props, ref) {
    return (
      <select
        {...props}
        ref={ref}
        className={['agnes-settings-input', props.className].filter(Boolean).join(' ')}
      />
    )
  },
)

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
}: Omit<HTMLAttributes<HTMLElement>, 'title'> & {
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
export function SettingsToolbar(props: HTMLAttributes<HTMLDivElement>) {
  return <div {...props} className={['agnes-settings-toolbar', props.className].filter(Boolean).join(' ')} />
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
  return (
    <label className="appearance-option">
      <SettingsInput {...props} />
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
