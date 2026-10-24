import { type ReactNode, type RefObject, useLayoutEffect, useRef, useState } from 'react'
import { ActivityIcon, ActivityRow } from './activity-row.js'

/**
 * Reasoning as one step of the process: Thinking · the line it is on. It opens while the model is only
 * thinking, closes once when the answer starts, and afterwards follows the reader: later stream
 * updates never override a manual toggle.
 */
export function Thinking({
  disclosure,
  active,
  label,
  line,
  autoOpen = true,
  contentRef,
  children,
}: {
  /** Observed by the interaction snapshot that delays handover while this subtree is in use. */
  disclosure?: RefObject<HTMLDivElement>
  active: boolean
  label: string
  /** The thought in one line; the full text is the detail. */
  line?: string | undefined
  /** Inside a group the row stays one line until the reader opens it. */
  autoOpen?: boolean
  contentRef?: RefObject<HTMLDivElement> | undefined
  children: ReactNode
}) {
  const [expanded, setExpanded] = useState(autoOpen && active)
  const wasActive = useRef(active)
  useLayoutEffect(() => {
    if (autoOpen && wasActive.current !== active) setExpanded(active)
    wasActive.current = active
  }, [active, autoOpen])
  return (
    <div ref={disclosure} className="thinking" data-expanded={String(expanded)}>
      <ActivityRow
        className="thinking-toggle"
        testId="thinking-toggle"
        icon={<ActivityIcon name="thinking" />}
        verb={label}
        target={line}
        state={active ? 'running' : undefined}
        expanded={expanded}
        onToggle={() => setExpanded((open) => !open)}
      />
      {/* The reasoning stays mounted while collapsed, so a reader's selection or focus inside it
          survives collapsing. */}
      <div ref={contentRef} className="thinking-content markdown" hidden={!expanded}>
        {children}
      </div>
    </div>
  )
}
