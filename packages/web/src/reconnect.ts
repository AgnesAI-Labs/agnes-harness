export const RECONNECT_ATTEMPT_KEY = 'agnes-web-reconnect-attempt'
export const RECONNECT_STARTED_KEY = 'agnes-web-reconnect-started-at'

export type ReconnectController = Readonly<{
  start(): void
  cancel(): void
  reset(): void
  attempts(): number
}>

type ReconnectOptions = {
  reload: () => void
  storage?: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>
  now?: () => number
}

const delays = [1000, 2000, 4000]

export function createReconnectController(options: ReconnectOptions): ReconnectController {
  const storage = options.storage ?? sessionStorage
  const now = options.now ?? Date.now
  let timer: ReturnType<typeof setTimeout> | undefined
  let cancelled = false
  let count = Number.parseInt(storage.getItem(RECONNECT_ATTEMPT_KEY) ?? '0', 10) || 0

  const reset = (): void => {
    if (timer) clearTimeout(timer)
    timer = undefined
    count = 0
    cancelled = false
    storage.removeItem(RECONNECT_ATTEMPT_KEY)
    storage.removeItem(RECONNECT_STARTED_KEY)
  }
  const cancel = (): void => {
    cancelled = true
    if (timer) clearTimeout(timer)
    timer = undefined
  }
  const start = (): void => {
    if (cancelled || timer || count >= delays.length) return
    const started = Number.parseInt(storage.getItem(RECONNECT_STARTED_KEY) ?? '', 10)
    if (started && now() - started > 60_000) return
    if (!started) storage.setItem(RECONNECT_STARTED_KEY, String(now()))
    const attempt = count
    count += 1
    storage.setItem(RECONNECT_ATTEMPT_KEY, String(count))
    timer = setTimeout(
      () => {
        timer = undefined
        if (!cancelled) options.reload()
      },
      delays[attempt] ?? delays.at(-1) ?? 0,
    )
  }
  return { start, cancel, reset, attempts: () => count }
}
