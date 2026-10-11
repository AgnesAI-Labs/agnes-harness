import type { HTMLAttributes, ReactNode } from 'react'
import { fallbackT } from '../locales/index.js'
import { Icon } from './icon.js'
import { IconButton } from './icon-button.js'

export type BannerProps = HTMLAttributes<HTMLDivElement> & {
  tone?: 'info' | 'warning' | 'error'
  action?: ReactNode
  /** Informational notices alone can be dismissed. */
  onDismiss?: () => void
  dismissLabel?: string
}
export function Banner({
  tone = 'info',
  action,
  onDismiss,
  dismissLabel,
  children,
  className,
  ...props
}: BannerProps) {
  return (
    <div
      {...props}
      className={['agh-banner', className].filter(Boolean).join(' ')}
      data-tone={tone}
      role={props.role ?? (tone === 'error' ? 'alert' : 'status')}
    >
      <Icon
        name={tone === 'error' ? 'circle-alert' : tone === 'warning' ? 'triangle-alert' : 'info'}
        size={18}
      />
      <div className="agh-banner-copy">{children}</div>
      {action && <div className="agh-banner-action">{action}</div>}
      {tone === 'info' && onDismiss && (
        <IconButton name="x" label={dismissLabel ?? fallbackT('ui.dismiss')} onClick={onDismiss} />
      )}
    </div>
  )
}
