import { Button } from '@agnes/web-ui'
import { useEffect, useRef, useState } from 'react'
import type { Translate } from './locales/index.js'

/** Presentation data from the current projected turn; no independent run clock or backend state. */
export interface TopbarStatusDetails {
  accessibleLabel?: string | undefined
  startedAt?: string | undefined
  sessionId?: string | undefined
}

function elapsed(start: number, now: number): string {
  const seconds = Math.floor(Math.max(0, now - start) / 1000)
  const sec = String(seconds % 60).padStart(2, '0')
  const minutes = Math.floor(seconds / 60)
  return minutes < 60
    ? `${minutes}:${sec}`
    : `${Math.floor(minutes / 60)}:${String(minutes % 60).padStart(2, '0')}:${sec}`
}

export function RunStatus({
  text,
  state,
  details,
  onStop,
  translate: t,
}: {
  text: string
  state: string
  details?: TopbarStatusDetails | undefined
  onStop?: (() => void) | undefined
  translate: Translate
}) {
  const stoppable = state === 'running' || state === 'approval'
  const active = stoppable || state === 'parked'
  const start = Date.parse(details?.startedAt ?? '')
  const [now, setNow] = useState(Date.now)
  const [expanded, setExpanded] = useState(false)
  const [previous, setPrevious] = useState<string>()
  const last = useRef(text)
  const toggle = useRef<HTMLButtonElement>(null)
  const pointerFocus = useRef(false)
  const [reduce, setReduce] = useState(() => window.matchMedia('(prefers-reduced-motion: reduce)').matches)
  useEffect(() => {
    const media = window.matchMedia('(prefers-reduced-motion: reduce)')
    const update = () => setReduce(media.matches)
    media.addEventListener('change', update)
    update()
    return () => media.removeEventListener('change', update)
  }, [])
  useEffect(() => {
    if (!active || !Number.isFinite(start)) return
    setNow(Date.now())
    const clock = setInterval(() => {
      if (document.visibilityState !== 'hidden') setNow(Date.now())
    }, 1000)
    return () => clearInterval(clock)
  }, [active, start])
  useEffect(() => {
    const old = last.current
    last.current = text
    if (reduce || old === text) {
      setPrevious(undefined)
      return
    }
    setPrevious(old)
    const timer = setTimeout(() => setPrevious(undefined), 260)
    return () => clearTimeout(timer)
  }, [text, reduce])
  useEffect(() => {
    if (!stoppable) setExpanded(false)
  }, [stoppable])
  const label = details?.accessibleLabel ?? text
  const showTime = active && Number.isFinite(start)
  const canExpand = stoppable && onStop !== undefined
  return (
    // biome-ignore lint/a11y/useSemanticElements: This groups status controls, not form fields.
    <div
      role="group"
      aria-label={label}
      id="status"
      data-state={state}
      data-expanded={canExpand && expanded}
      className={active && !reduce ? 'run-status-breathe' : undefined}
      onMouseEnter={() => {
        if (window.matchMedia('(hover: hover) and (pointer: fine)').matches) setExpanded(true)
      }}
      onMouseLeave={(event) => {
        if (!event.currentTarget.contains(document.activeElement)) setExpanded(false)
      }}
      onFocus={() => {
        if (!pointerFocus.current) setExpanded(true)
      }}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) setExpanded(false)
        pointerFocus.current = false
      }}
      onKeyDown={(event) => {
        if (event.key !== 'Escape') return
        event.preventDefault()
        event.stopPropagation()
        toggle.current?.focus()
        setExpanded(false)
      }}
    >
      <span className="visually-hidden" role="status" aria-live="polite" aria-atomic="true">
        {label}
      </span>
      <Button
        ref={toggle}
        appearance="ghost"
        size="small"
        className="run-status-toggle"
        aria-label={label}
        aria-expanded={canExpand ? expanded : undefined}
        disabled={!canExpand}
        onPointerDown={() => {
          pointerFocus.current = true
        }}
        onClick={() => {
          setExpanded((value) => !value)
          pointerFocus.current = false
        }}
      >
        <span className="run-status-dot" aria-hidden="true" />
        <span className="run-status-phase" aria-hidden="true">
          {previous && !reduce && <span className="run-status-word run-status-out">{previous}</span>}
          <span
            key={text}
            className={previous && !reduce ? 'run-status-word run-status-in' : 'run-status-word'}
          >
            {text}
          </span>
        </span>
        {showTime && (
          <span className="run-status-time" aria-hidden="true">
            · {elapsed(start, now)}
          </span>
        )}
      </Button>
      {canExpand && (
        <div className="run-status-action" aria-hidden={!expanded}>
          <Button
            appearance="ghost"
            size="small"
            className="run-status-stop"
            aria-label={t('topbar.stop')}
            tabIndex={expanded ? 0 : -1}
            onClick={onStop}
          >
            <span className="run-status-square" aria-hidden="true" />
          </Button>
        </div>
      )}
    </div>
  )
}
