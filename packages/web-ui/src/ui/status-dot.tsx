export type StatusDotTone = 'accent' | 'success' | 'warning' | 'danger' | 'info' | 'neutral'

export type StatusDotProps = {
  tone?: StatusDotTone
  /** Breathe while work is in progress; static under reduced motion. */
  running?: boolean
  /** Accessible name. Omit when adjacent text already states the status. */
  label?: string
  className?: string
}

/** A 6px state mark. Colour is never the only signal: pair it with text or pass `label`. */
export function StatusDot({ tone = 'accent', running = false, label, className }: StatusDotProps) {
  return (
    <span
      className={['agh-status-dot', className].filter(Boolean).join(' ')}
      data-tone={tone}
      data-running={running || undefined}
      {...(label ? { role: 'img', 'aria-label': label } : { 'aria-hidden': true })}
    />
  )
}
