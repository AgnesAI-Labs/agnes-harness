import { StatusDot } from '@agnes/web-ui'
import type { WorkbenchText } from './workbench-locale.js'
import type { CloudConnectionStatus } from './workbench-state.js'

const labels = {
  unconfigured: 'statusUnconfigured',
  connecting: 'statusConnecting',
  ready: 'statusReady',
  disconnected: 'statusDisconnected',
  error: 'statusError',
} as const

export function CloudConnectionIndicator({
  status,
  t,
  compact = false,
}: {
  status: CloudConnectionStatus
  t: WorkbenchText
  compact?: boolean
}) {
  const label = t(labels[status])
  return (
    <span
      className="backend-connection-indicator"
      role="status"
      aria-live="polite"
      aria-label={label}
      title={label}
      data-testid="cloud-connection-status"
      data-state={status}
    >
      <StatusDot
        tone={
          status === 'ready'
            ? 'success'
            : status === 'error' || status === 'disconnected'
              ? 'danger'
              : status === 'connecting'
                ? 'warning'
                : 'neutral'
        }
        running={status === 'connecting'}
        {...(compact ? { label } : {})}
      />
      {!compact && <span>{label}</span>}
    </span>
  )
}
