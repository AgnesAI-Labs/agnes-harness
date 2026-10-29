import type { ReactNode } from 'react'
import { useEffect, useRef, useState } from 'react'
import { usePageRequestsInFlight } from '../data/resource.js'
import { fallbackT } from '../locales/index.js'
import { Button } from './button.js'

/** How long a read may take before anything shows, and before the placeholder says it is slow. */
export const LOADABLE_DELAY_MS = 200
export const LOADABLE_SLOW_MS = 3000

/** The shape a placeholder takes until the content arrives. */
export type LoadableShape = 'lines' | 'rows' | 'cards'

function Placeholder({ shape, slow }: { shape: LoadableShape; slow: boolean }) {
  const count = shape === 'cards' ? 6 : shape === 'rows' ? 5 : 3
  return (
    <div className="agh-loadable-placeholder" data-shape={shape} data-testid="loadable-placeholder">
      <div className="agh-loadable-shapes" aria-hidden="true">
        {Array.from({ length: count }, (_, index) => (
          // The placeholder is fixed geometry; its blocks have no identity beyond their place.
          // biome-ignore lint/suspicious/noArrayIndexKey: decorative blocks never reorder.
          <span key={index} className="agh-loadable-shape" />
        ))}
      </div>
      {/* Screen readers hear one status; sighted readers see the words only once it is slow. */}
      <p className="agh-loadable-status" role="status" data-slow={slow || undefined}>
        {slow ? (
          fallbackT('ui.stillLoading')
        ) : (
          <span className="agh-visually-hidden">{fallbackT('ui.loading')}</span>
        )}
      </p>
    </div>
  )
}

/**
 * The one way a read shows: nothing for the first 200 ms, then a quiet placeholder (its shape is
 * optional), and 「Still reading…」 after 3 s. A failure shows its reason and Retry without removing what
 * was already there. Content arrives with a 160 ms fade (none under reduced motion).
 */
export function Loadable({
  loading,
  error,
  hasData,
  onRetry,
  shape = 'lines',
  errorText,
  children,
}: {
  loading: boolean
  error?: unknown
  /** Whether there is content to show (a cached or earlier value counts). */
  hasData: boolean
  onRetry?: () => void
  shape?: LoadableShape
  /** The failure in words; the error's own message when absent. */
  errorText?: ReactNode
  children?: ReactNode
}) {
  const waiting = loading && !hasData
  const [phase, setPhase] = useState<'hidden' | 'shown' | 'slow'>('hidden')
  useEffect(() => {
    if (!waiting) {
      setPhase('hidden')
      return
    }
    const show = setTimeout(() => setPhase('shown'), LOADABLE_DELAY_MS)
    const slow = setTimeout(() => setPhase('slow'), LOADABLE_SLOW_MS)
    return () => {
      clearTimeout(show)
      clearTimeout(slow)
    }
  }, [waiting])
  // Content that arrives after a wait fades in; content shown at once (from cache) does not.
  const waited = useRef(false)
  if (waiting) waited.current = true
  const fade = hasData && waited.current
  const failure = error && !loading
  const reason =
    errorText ?? (error instanceof Error && error.message ? error.message : fallbackT('ui.loadFailed'))
  return (
    <div className="agh-loadable" data-state={waiting ? 'loading' : failure ? 'error' : 'ready'}>
      {failure ? (
        <div className="agh-loadable-error" role="alert" data-testid="loadable-error">
          <span>{reason}</span>
          {onRetry && (
            <Button size="small" data-testid="loadable-retry" onClick={onRetry}>
              {fallbackT('ui.retry')}
            </Button>
          )}
        </div>
      ) : null}
      {hasData ? (
        <div className="agh-loadable-content" data-fade={fade || undefined}>
          {children}
        </div>
      ) : waiting && phase !== 'hidden' ? (
        <Placeholder shape={shape} slow={phase === 'slow'} />
      ) : null}
    </div>
  )
}

/** The 2px bar along the top of the window while any page-level request is in flight. */
export function TopProgress() {
  const active = usePageRequestsInFlight()
  return (
    <div
      className="agh-top-progress"
      data-testid="top-progress"
      data-active={active || undefined}
      role="progressbar"
      aria-hidden={!active}
      aria-label={fallbackT('ui.loading')}
    />
  )
}
