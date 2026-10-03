import type { CallContext } from '@agnes/extension-api/runtime'

export function callSignal(context: CallContext, lifetime: AbortSignal, prefix: string): AbortSignal {
  const left = Date.parse(context.deadline) - Date.now()
  if (!Number.isFinite(left) || left <= 0 || context.signal.aborted) throw new Error(`${prefix}_cancelled`)
  return AbortSignal.any([context.signal, lifetime, AbortSignal.timeout(Math.min(left, 2147483647))])
}
export async function during<T>(signal: AbortSignal, prefix: string, pending: Promise<T>): Promise<T> {
  let abort!: () => void
  const cancelled = new Promise<never>((_, reject) => {
    abort = () => reject(new Error(`${prefix}_cancelled`))
    signal.addEventListener('abort', abort, { once: true })
    if (signal.aborted) abort()
  })
  try {
    return await Promise.race([pending, cancelled])
  } finally {
    signal.removeEventListener('abort', abort)
  }
}
