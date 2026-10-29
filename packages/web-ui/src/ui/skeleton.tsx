import type { HTMLAttributes } from 'react'

/** Decorative loading geometry; pair it with a localized status announcement. */
export function Skeleton({ className, ...props }: Omit<HTMLAttributes<HTMLDivElement>, 'children'>) {
  return (
    <div {...props} className={['agh-skeleton', className].filter(Boolean).join(' ')} aria-hidden="true">
      <span />
      <span />
      <span />
    </div>
  )
}
