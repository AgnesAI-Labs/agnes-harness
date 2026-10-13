import type { HTMLAttributes } from 'react'

export type KbdProps = HTMLAttributes<HTMLElement>
/** A quiet keyboard hint chip; the keys are read aloud by the owning control's shortcut text. */
export function Kbd({ className, children, ...props }: KbdProps) {
  return (
    <kbd {...props} className={['agh-kbd', className].filter(Boolean).join(' ')} translate="no">
      {children}
    </kbd>
  )
}
