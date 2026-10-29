import { SettingsDetails } from '@agnes/web-ui'
import { type ReactNode, useLayoutEffect, useRef, useState } from 'react'

/** Keep contributed controls mounted so disclosure never discards a plugin's draft. */
export function ComposerExtras({ children, label }: { children?: ReactNode; label: string }) {
  const host = useRef<HTMLDivElement>(null)
  const [overflow, setOverflow] = useState(false)
  const [open, setOpen] = useState(false)
  useLayoutEffect(() => {
    const element = host.current
    if (!element) return
    const read = () =>
      setOverflow(
        [...element.querySelectorAll('button, input, select, [role="button"]')].filter(
          (node) => !node.closest('[hidden]'),
        ).length > 2,
      )
    read()
    const observer = new MutationObserver(read)
    observer.observe(element, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['hidden'],
    })
    return () => observer.disconnect()
  }, [])
  return (
    <div ref={host} className="composer-extras" data-overflow={overflow}>
      <SettingsDetails
        compact
        title={label}
        data-testid="composer-extra-controls"
        open={!overflow || open}
        onOpenChange={(next) => {
          if (overflow) setOpen(next)
        }}
      >
        {children}
      </SettingsDetails>
    </div>
  )
}
