import { Button, Icon } from '@agnes/web-ui'
import { type ReactNode, useEffect, useRef, useState } from 'react'

/** The overview stays in flow so turning the leaf never resizes the original hero. */
export function MhsBook({
  hidden,
  workflow,
  onTurn,
  overviewLabel,
  workflowLabel,
  children,
}: {
  hidden: boolean
  workflow: boolean
  onTurn: () => void
  overviewLabel: string
  workflowLabel: string
  children: readonly [ReactNode, ReactNode]
}) {
  const [turn, setTurn] = useState(0)
  const previousWorkflow = useRef(workflow)
  const overview = useRef<HTMLDivElement>(null)
  const corner = useRef<HTMLButtonElement>(null)
  useEffect(() => {
    if (previousWorkflow.current !== workflow) {
      previousWorkflow.current = workflow
      setTurn((value) => value + 1)
    }
    if (workflow && overview.current?.contains(document.activeElement)) {
      corner.current?.focus({ preventScroll: true })
    }
  }, [workflow])
  return (
    <div
      id="explore-slide-0"
      className={`mhs-book${workflow ? ' mhs-book-show-workflow' : ''}`}
      hidden={hidden}
    >
      <div ref={overview} className="mhs-book-overview" aria-hidden={workflow}>
        {children[0]}
      </div>
      <div className="mhs-book-workflow" hidden={!workflow}>
        {children[1]}
      </div>
      <Button
        ref={corner}
        appearance="ghost"
        htmlType="button"
        className={`mhs-book-corner${workflow ? ' mhs-book-corner-back' : ''}`}
        aria-label={workflow ? overviewLabel : workflowLabel}
        aria-controls={workflow ? 'mhs-overview' : 'mhs-workflow'}
        onClick={onTurn}
      >
        <span className="mhs-book-corner-label">
          {workflow ? overviewLabel : workflowLabel}
          <Icon name={workflow ? 'chevron-left' : 'chevron-right'} />
        </span>
        <span className="mhs-book-fold" aria-hidden="true" />
      </Button>
      {turn > 0 && <div key={turn} className="mhs-book-turn" aria-hidden="true" />}
    </div>
  )
}
