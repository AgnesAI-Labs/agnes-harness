import type { ReactNode } from 'react'
import { Button } from '../../ui/button.js'

export type ActivityState = 'running' | 'failed' | 'attention' | 'cancelled' | undefined

const ICONS = {
  command: ['M12 19h8', 'm4 17 6-6-6-6'],
  thinking: [
    'M12 3a6 6 0 0 0-3.6 10.8c.5.4.9 1 1 1.7l.1.5h5l.1-.5c.1-.7.5-1.3 1-1.7A6 6 0 0 0 12 3Z',
    'M9.5 19h5M10.5 22h3',
  ],
  approval: ['M12 3 5 6v5c0 4.5 2.9 8.3 7 10 4.1-1.7 7-5.5 7-10V6Z', 'm9 12 2 2 4-4'],
  chevron: ['m9 6 6 6-6 6'],
  step: ['M4 6h16', 'M4 12h10', 'M4 18h7', 'm15 17 2 2 4-4'],
} as const

export function ActivityIcon({ name }: { name: keyof typeof ICONS }) {
  return (
    <svg className="icon activity-icon" viewBox="0 0 24 24" aria-hidden="true">
      {ICONS[name].map((path) => (
        <path key={path} d={path} />
      ))}
    </svg>
  )
}

/**
 * One line of a turn's process: icon · verb · target. The whole line is the button that opens
 * what it stands for (a group's steps, a step's detail), so it carries the name, focus and keys.
 */
export function ActivityRow({
  className,
  icon,
  verb,
  target,
  tooltip,
  state,
  note,
  expanded,
  onToggle,
  testId,
  label,
  mono = false,
  chevron = false,
}: {
  className?: string
  icon?: ReactNode
  verb: ReactNode
  target?: ReactNode
  /** Full text of a truncated target. */
  tooltip?: string | undefined
  state?: ActivityState
  /** Short reason beside a failed or waiting step, e.g. exit code 1. */
  note?: string | undefined
  expanded: boolean
  onToggle: () => void
  testId?: string
  label?: string | undefined
  /** The target is a command, path or pattern. */
  mono?: boolean
  /** A group shows which way it opens; a step opens in place and needs no arrow. */
  chevron?: boolean
}) {
  return (
    <Button
      htmlType="button"
      appearance="ghost"
      size="small"
      className={['activity-row', className].filter(Boolean).join(' ')}
      data-state={state}
      data-testid={testId}
      aria-expanded={expanded}
      aria-label={label}
      title={tooltip || undefined}
      onClick={onToggle}
    >
      {/* One wrapper owns the line, whatever the button does with its own children. */}
      <span className="activity-line">
        <span className="activity-glyph">{icon}</span>
        <span className="activity-verb">{verb}</span>
        {target ? (
          <span className="activity-dot" aria-hidden="true">
            ·
          </span>
        ) : null}
        {target ? (
          // A mono target is a literal path or command: browser translation leaves it alone.
          <span
            className="activity-target"
            data-mono={mono ? 'true' : undefined}
            {...(mono ? { translate: 'no' as const } : {})}
          >
            {target}
          </span>
        ) : null}
        {note ? <span className="activity-note tool-status">{note}</span> : null}
        {chevron ? (
          <span className="activity-chevron">
            <ActivityIcon name="chevron" />
          </span>
        ) : null}
      </span>
    </Button>
  )
}
