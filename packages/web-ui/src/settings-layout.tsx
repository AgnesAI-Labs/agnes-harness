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
      className="agnes-settings-state"
      data-tone={tone}
      role={tone === 'error' ? 'alert' : 'status'}
      aria-live="polite"
    >
      {children}
    </div>
  )
}
export const SettingsInput = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(
  function SettingsInput(props, ref) {
    return (
      <input
        {...props}
        ref={ref}
        className={['agnes-settings-input', props.className].filter(Boolean).join(' ')}
      />
    )
  },
)
export const SettingsTextArea = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement>>(
  function SettingsTextArea(props, ref) {
    return (
      <textarea
        {...props}
        ref={ref}
        className={['agnes-settings-input', props.className].filter(Boolean).join(' ')}
      />
    )
  },
)
/** Native select preserves form semantics, following SettingsOptionSelect's account-dialog pattern. */
export function SettingsSelect(props: SelectHTMLAttributes<HTMLSelectElement>) {
  return <select {...props} className={['agnes-settings-input', props.className].filter(Boolean).join(' ')} />
}
