/**
 * Page-level recovery after the daemon has closed the connection for good (for example a
 * restart announced with `shutting_down`) or the first connection failed. The page never
 * navigates while the server is unreachable: a reload that lands on a browser error page would
 * kill this script and every later attempt with it. Instead a cheap probe runs from inside the
 * live page with capped backoff, and the page reloads exactly once, after the probe says a
 * reload would reach a different daemon, to pick up that daemon's bootstrap.
 */
export type ReconnectPhase = 'idle' | 'waiting' | 'stalled' | 'recovering'

export type ReconnectController = Readonly<{
  start(): void
  /** Manual retry: probes at once, accepts any served page, and opens a fresh window. */
  retry(): void
  /** Automatic restart of a stalled controller, for example when the tab is shown again. */
  resume(): void
  cancel(): void
  reset(): void
  phase(): ReconnectPhase
}>

type ReconnectOptions = {
  /** Resolves true only when a reload is worth doing; `manual` marks a user-requested attempt. */
  probe: (signal: AbortSignal, manual: boolean) => Promise<boolean>
  reload: () => void
  onPhase?: (phase: ReconnectPhase) => void
  now?: () => number
}

const delays = [500, 1000, 2000, 3000]
const PROBE_TIMEOUT_MS = 3000
/** How long automatic probing lasts before the page waits for a manual retry. */
export const RECONNECT_WINDOW_MS = 60_000

export function createReconnectController(options: ReconnectOptions): ReconnectController {
  const now = options.now ?? (() => Date.now())
  let phase: ReconnectPhase = 'idle'
  let timer: ReturnType<typeof setTimeout> | undefined
  let inFlight: AbortController | undefined
  let cancelled = false
  let attempt = 0
  let startedAt = 0
  let manual = false

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
    // Only the attempt the user asked for is manual; its follow-ups are ordinary probes.
    const byUser = manual
    manual = false
    let up = false
    try {
      up = await options.probe(abort.signal, byUser)
    } catch {
      up = false
    }
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
  const begin = (firstDelay: number, byUser: boolean): void => {
    stop()
    manual = byUser
    attempt = 0
    startedAt = now()
    enter('waiting')
    if (firstDelay > 0) schedule(firstDelay)
    else void probeOnce()
  }

  return {
    start() {
      if (cancelled || phase !== 'idle') return
      begin(delays[0] ?? 0, false)
    },
    retry() {
      if (cancelled || phase === 'recovering' || inFlight) return
      begin(0, true)
    },
    resume() {
      if (!cancelled && phase === 'stalled') begin(0, false)
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

type Fetcher = (input: string, init?: RequestInit) => Promise<Response>

/** The WebSocket address the same-origin Web page currently serves, or undefined when it is not served. */
export async function probeBootstrap(fetcher: Fetcher, signal: AbortSignal): Promise<string | undefined> {
  try {
    const response = await fetcher('/', { cache: 'no-store', credentials: 'same-origin', signal })
    if (!response.ok) return undefined
    const page = new DOMParser().parseFromString(await response.text(), 'text/html')
    return page.getElementById('agnes-config')?.dataset.ws || undefined
  } catch {
    return undefined
  }
}

/**
 * A reload only helps once the Web server hands out a different daemon address: a Web process
 * that outlived the daemon keeps serving the old one, and reloading into it leaves a dead page.
 * A manual retry accepts any served page, for the rare restart that reuses the same port.
 */
export function bootstrapProbe(fetcher: Fetcher, currentWs: string) {
  return async (signal: AbortSignal, manual: boolean): Promise<boolean> => {
    const served = await probeBootstrap(fetcher, signal)
    return served !== undefined && (manual || served !== currentWs)
  }
}
