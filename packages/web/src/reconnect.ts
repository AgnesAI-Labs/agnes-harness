/**
 * Page-level recovery after the daemon has closed the connection for good (for example a
 * restart announced with `shutting_down`). The page never navigates while the server is
 * unreachable: a reload that lands on a browser error page would kill this script and every
 * later attempt with it. Instead a cheap probe runs from inside the live page with capped
 * backoff, and the page reloads exactly once, after the server has answered, to pick up the
 * new daemon's bootstrap.
 */
export type ReconnectPhase = 'idle' | 'waiting' | 'stalled' | 'recovering'

export type ReconnectController = Readonly<{
  start(): void
  /** Manual retry: probes at once and opens a fresh automatic window. */
  retry(): void
  cancel(): void
  reset(): void
  phase(): ReconnectPhase
}>

type ReconnectOptions = {
  /** Resolves true only when the server is reachable again. */
  probe: (signal: AbortSignal) => Promise<boolean>
  reload: () => void
  onPhase?: (phase: ReconnectPhase) => void
  now?: () => number
}

const delays = [500, 1000, 2000, 3000]
const PROBE_TIMEOUT_MS = 3000
/** How long automatic probing lasts before the page waits for a manual retry. */
export const RECONNECT_WINDOW_MS = 60_000

export function createReconnectController(options: ReconnectOptions): ReconnectController {
  const now = options.now ?? Date.now
  let phase: ReconnectPhase = 'idle'
  let timer: ReturnType<typeof setTimeout> | undefined
  let inFlight: AbortController | undefined
  let cancelled = false
  let attempt = 0
  let startedAt = 0

  const enter = (next: ReconnectPhase): void => {
    if (phase === next) return
    phase = next
    options.onPhase?.(next)
  }
  const stop = (): void => {
    if (timer) clearTimeout(timer)
    timer = undefined
    inFlight?.abort()
    inFlight = undefined
  }
  const schedule = (delay: number): void => {
    timer = setTimeout(() => {
      timer = undefined
      void probeOnce()
    }, delay)
  }
  const probeOnce = async (): Promise<void> => {
    const abort = new AbortController()
    inFlight = abort
    const deadline = setTimeout(() => abort.abort(new Error('probe timed out')), PROBE_TIMEOUT_MS)
    const up = await options.probe(abort.signal).catch(() => false)
    clearTimeout(deadline)
    if (inFlight !== abort || cancelled || phase !== 'waiting') return
    inFlight = undefined
    if (up) {
      enter('recovering')
      options.reload()
      return
    }
    attempt += 1
    if (now() - startedAt >= RECONNECT_WINDOW_MS) enter('stalled')
    else schedule(delays[Math.min(attempt, delays.length - 1)] ?? 0)
  }
  const begin = (firstDelay: number): void => {
    stop()
    attempt = 0
    startedAt = now()
    enter('waiting')
    if (firstDelay > 0) schedule(firstDelay)
    else void probeOnce()
  }

  return {
    start() {
      if (cancelled || phase !== 'idle') return
      begin(delays[0] ?? 0)
    },
    retry() {
      if (cancelled || phase === 'recovering' || inFlight) return
      begin(0)
    },
    cancel() {
      cancelled = true
      stop()
    },
    reset() {
      stop()
      cancelled = false
      enter('idle')
    },
    phase: () => phase,
  }
}

/** True when the same-origin Web page, the one carrying the connection config, is served again. */
export async function probeBootstrap(
  fetcher: (input: string, init?: RequestInit) => Promise<Response>,
  signal: AbortSignal,
): Promise<boolean> {
  try {
    const response = await fetcher('/', { cache: 'no-store', credentials: 'same-origin', signal })
    return response.ok && (await response.text()).includes('id="agnes-config"')
  } catch {
    return false
  }
}
