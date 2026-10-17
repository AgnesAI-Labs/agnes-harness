import { forwardRef, useEffect, useRef, useState } from 'react'
import { reportSuccess, StatusMessage } from '../feedback.js'
import { fallbackT } from '../locales/index.js'
import { IconButton, type IconButtonProps } from './icon-button.js'

export type CopyButtonProps = Omit<IconButtonProps, 'name' | 'label' | 'onClick' | 'onCopy'> & {
  label: string
  /** Name while the confirmation is showing, for example "Copied". */
  copiedLabel: string
  /** Text for the system clipboard. Use `onCopy` instead when the caller owns the write. */
  text?: string
  /** Caller-owned copy; resolve `false` or reject when nothing was copied. */
  onCopy?: () => boolean | undefined | Promise<boolean | undefined>
  /** Reports the outcome so the caller can surface a failure; the button only confirms success. */
  onCopied?: (copied: boolean) => void
}

const CONFIRMATION_MS = 1600

/** Copy action whose icon turns into a check on success, then returns to the copy icon. */
export const CopyButton = forwardRef<HTMLButtonElement, CopyButtonProps>(function CopyButton(
  { label, copiedLabel, text, onCopy, onCopied, className, ...props },
  ref,
) {
  const [copied, setCopied] = useState(false)
  const [failed, setFailed] = useState(false)
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const mounted = useRef(true)
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
      clearTimeout(timer.current)
    }
  }, [])
  const settle = (ok: boolean) => {
    if (ok) reportSuccess('clipboard', fallbackT('ui.copiedNotice'))
    setFailed(!ok)
    onCopied?.(ok)
    if (!mounted.current) return
    clearTimeout(timer.current)
    setCopied(ok)
    if (ok) timer.current = setTimeout(() => setCopied(false), CONFIRMATION_MS)
  }
  const copy = async () => {
    try {
      if (onCopy) settle((await onCopy()) !== false)
      else {
        await navigator.clipboard.writeText(text ?? '')
        settle(true)
      }
    } catch {
      settle(false)
    }
  }
  return (
    <>
      <IconButton
        {...props}
        ref={ref}
        name={copied ? 'check' : 'copy'}
        label={copied ? copiedLabel : label}
        className={['agh-copy', className].filter(Boolean).join(' ')}
        data-copied={copied || undefined}
        onClick={() => void copy()}
      />
      {failed && (
        <StatusMessage kind="error" action={{ label, onSelect: () => void copy() }}>
          {fallbackT('ui.copyFailed')}
        </StatusMessage>
      )}
    </>
  )
})
