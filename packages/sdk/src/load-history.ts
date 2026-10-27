import type { SessionLoadingParams } from '@agnes/protocol'
import { validateMethod } from '@agnes/protocol'
import { RequestTimeout } from './errors.js'

/** A long open is bounded by genuine forward progress and an independent hard deadline. */
export async function loadHistory<T>(options: {
  sessionId: string
  idleMs: number
  hardMs: number
  subscribe(fn: (method: string, params: unknown) => void): () => void
  request(signal: AbortSignal): Promise<T>
  signal?: AbortSignal
  onProgress?: (progress: SessionLoadingParams) => void
}): Promise<T> {
  if (![options.idleMs, options.hardMs].every((ms) => Number.isSafeInteger(ms) && ms > 0))
    throw new RangeError('load timeouts must be positive safe integers')
  const controller = new AbortController()
  const signal = options.signal ? AbortSignal.any([controller.signal, options.signal]) : controller.signal
  let idle: ReturnType<typeof setTimeout> | undefined
  const reset = () => {
    clearTimeout(idle)
    idle = setTimeout(
      () => controller.abort(new RequestTimeout('session/load (idle)', options.idleMs)),
      options.idleMs,
    )
  }
  reset()
  const hard = setTimeout(
    () => controller.abort(new RequestTimeout('session/load (hard)', options.hardMs)),
    options.hardMs,
  )
  let active = true
  let previous = -1
  let phase = 'verifying'
  const off = options.subscribe((method, params) => {
    if (!active || signal.aborted || method !== '_agnes/v1/session.loading') return
    const checked = validateMethod(method, 'params', params)
    if (!checked.ok) return
    const value = params as SessionLoadingParams
    if (value.sessionId !== options.sessionId || value.verifiedSeq > value.lastSeq) return
    if (phase === 'replaying' && value.phase === 'verifying') return
    const moved = value.phase !== phase || value.verifiedSeq > previous
    if (!moved) return
    previous = value.verifiedSeq
    phase = value.phase
    reset()
    try {
      options.onProgress?.(value)
    } catch {
      /* Progress observers cannot change load admission. */
    }
  })
  try {
    signal.throwIfAborted()
    return await options.request(signal)
  } finally {
    active = false
    clearTimeout(idle)
    clearTimeout(hard)
    off()
  }
}
