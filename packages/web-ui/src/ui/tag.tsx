import type { HTMLAttributes, ReactNode } from 'react'

export type TagTone = 'warn' | 'bad' | 'info'
export type TagProps = HTMLAttributes<HTMLSpanElement> & { tone: TagTone; icon?: ReactNode }
/** Status tags describe actionable exceptions; descriptive metadata belongs in MetaText. */
export function Tag({ tone, icon, children, className, ...props }: TagProps) {
  return (
    <span {...props} className={['agh-tag', className].filter(Boolean).join(' ')} data-tone={tone}>
      {icon && <span aria-hidden="true">{icon}</span>}
      {children}
    </span>
  )
}
export function MetaText({ children, className, ...props }: HTMLAttributes<HTMLSpanElement>) {
  return (
    <span {...props} className={['agh-meta', className].filter(Boolean).join(' ')}>
      {children}
    </span>
  )
}
export function Count({
  value,
  label,
  className,
  ...props
}: Omit<HTMLAttributes<HTMLSpanElement>, 'children'> & {
  value: number
  label: string
}) {
  if (value <= 0) return null
  return (
    <span
      {...props}
      role="status"
      className={['agh-count', className].filter(Boolean).join(' ')}
      aria-label={label}
    >
      {value}
    </span>
  )
}
