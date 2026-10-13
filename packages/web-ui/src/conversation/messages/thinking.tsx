import { type ReactNode, type RefObject, useLayoutEffect, useRef, useState } from 'react'
import { Button } from '../../ui/button.js'
import { Think } from '../../x/index.js'

/**
 * Reasoning disclosure. It opens while the model is only thinking, closes once when the answer
 * starts, and afterwards follows the reader: later stream updates never override a manual toggle.
 */
export function Thinking({
  disclosure,
  active,
  label,
  contentRef,
  children,
}: {
  /** Observed by the interaction snapshot that delays handover while this subtree is in use. */
  disclosure?: RefObject<HTMLDivElement>
  active: boolean
  label: string
  contentRef?: RefObject<HTMLDivElement> | undefined
  children: ReactNode
}) {
  const [expanded, setExpanded] = useState(active)
  const wasActive = useRef(active)
  useLayoutEffect(() => {
    if (wasActive.current !== active) setExpanded(active)
    wasActive.current = active
  }, [active])
  return (
    <div ref={disclosure} className="thinking" data-expanded={String(expanded)}>
      <Think
        // The status row toggles on click; the button gives that row a name, focus and keyboard.
        title={
          <Button
            htmlType="button"
            appearance="ghost"
            size="small"
            className="thinking-toggle"
            data-testid="thinking-toggle"
            aria-expanded={expanded}
          >
            {label}
          </Button>
        }
        loading={active}
        blink={active}
        expanded={expanded}
        onExpand={setExpanded}
      />
      {/* Think unmounts collapsed content. The reasoning stays mounted here instead, so a reader's
          selection or focus inside it survives collapsing and the handover between parents. */}
      <div ref={contentRef} className="thinking-content markdown" hidden={!expanded}>
        {children}
      </div>
    </div>
  )
}
