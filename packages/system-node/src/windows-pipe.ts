import { setTimeout as delay } from 'node:timers/promises'
import { windowsConnectPipeSync, windowsReservePipeName } from './index.js'
import { createWindowsPipeListener } from './windows-pipe-listener.js'
import { WindowsPipeStream } from './windows-pipe-stream.js'

/** Identity must come from trusted discovery, not from the pipe name or an unverified peer. */
export async function connectWindowsPipe(options: {
  path: string
  pid: number
  /** Canonical FILETIME decimal or the existing discovery form win32:PID:FILETIME. */
  processStartId: string
  timeoutMs?: number
  signal?: AbortSignal
}): Promise<WindowsPipeStream> {
  const { path, pid, processStartId, signal, timeoutMs = 3000 } = options
  const identity = /^(?:win32:([1-9]\d{0,9}):)?([1-9]\d{0,19})$/.exec(processStartId)
  const start = identity?.[2]
  if (
    !start ||
    (identity?.[1] !== undefined && identity[1] !== String(pid)) ||
    BigInt(start) > 18446744073709551615n
  )
    throw Object.assign(new TypeError('invalid Windows pipe process identity'), { code: 'EINVAL' })
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 0 || timeoutMs > 2147483647)
    throw new RangeError('invalid Windows pipe connect timeout')
  const deadline = performance.now() + timeoutMs
  let first = true
  for (;;) {
    signal?.throwIfAborted()
    const remaining = deadline - performance.now()
    if (!first && remaining <= 0)
      throw Object.assign(new Error('Windows pipe connection timed out'), { code: 'ETIMEDOUT' })
    first = false
    try {
      const owner = windowsConnectPipeSync(path, pid, start)
      try {
        return new WindowsPipeStream(owner)
      } catch (error) {
        await owner.close()
        throw error
      }
    } catch (error) {
      if (typeof error !== 'object' || error === null || !('win32Code' in error) || error.win32Code !== 231)
        throw error
      const wait = Math.min(10, deadline - performance.now())
      if (wait <= 0)
        throw Object.assign(new Error('Windows pipe connection timed out'), {
          code: 'ETIMEDOUT',
          cause: error,
        })
      await delay(wait, undefined, { signal })
    }
  }
}

/** Resolves only after native readiness. The caller must monitor failed for later listener errors. */
export async function listenWindowsPipe(
  path: string,
  capacity: number,
  onConnection: (stream: WindowsPipeStream) => void,
): Promise<ReturnType<typeof createWindowsPipeListener>> {
  if (!Number.isSafeInteger(capacity) || capacity < 1 || capacity > 253)
    throw new RangeError('invalid Windows pipe capacity')
  const listener = createWindowsPipeListener(
    windowsReservePipeName(path, capacity + 1),
    capacity,
    onConnection,
  )
  try {
    await listener.ready
    return listener
  } catch (error) {
    await listener.close()
    throw error
  }
}
