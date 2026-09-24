import { type OwnedPipe, WindowsPipeStream } from './windows-pipe-stream.js'

export interface PipeAccept {
  ready: Promise<void>
  result: Promise<{ open(): OwnedPipe }>
  cancel(): void
}
export interface PipeReservation {
  accept(): PipeAccept
  close(): void
}

/** Internal controller; native readiness and peer authentication precede public listener wiring. */
export function createWindowsPipeListener(
  reservation: PipeReservation,
  capacity: number,
  onConnection: (stream: WindowsPipeStream) => void,
): { stopAccepting(): Promise<void>; close(): Promise<void>; failed: Promise<Error>; ready: Promise<void> } {
  if (!Number.isSafeInteger(capacity) || capacity < 1 || capacity > 253) {
    reservation.close()
    throw new RangeError('invalid Windows pipe capacity')
  }
  const active = new Map<WindowsPipeStream, Promise<void>>()
  let pending: PipeAccept | undefined
  let task: Promise<void> | undefined
  let stopping = false
  let stopped: Promise<void> | undefined
  let closed: Promise<void> | undefined
  let report!: (error: Error) => void
  const failed = new Promise<Error>((resolve) => {
    report = resolve
  })
  let resolveReady!: () => void
  let rejectReady!: (error: unknown) => void
  const ready = new Promise<void>((resolve, reject) => {
    resolveReady = resolve
    rejectReady = reject
  })
  // A caller may stop without awaiting readiness; retain the rejected result without an unhandled rejection.
  void ready.catch(() => {})
  const fault = (error: unknown) => {
    rejectReady(error)
    report(error instanceof Error ? error : new Error('Windows pipe listener failed', { cause: error }))
    void close().catch((closeError: unknown) => {
      report(closeError instanceof Error ? closeError : new Error('Windows pipe cleanup failed'))
    })
  }
  const pump = () => {
    if (stopping || pending || active.size >= capacity) return
    pending = reservation.accept()
    void pending.ready.then(() => {
      if (!stopping) resolveReady()
    }, fault)
    task = pending.result
      .then(
        async (lease) => {
          const owner = lease.open()
          if (stopping) {
            await owner.close()
            return
          }
          const stream = new WindowsPipeStream(owner)
          const released = new Promise<void>((resolve) => {
            stream.once('close', () => {
              active.delete(stream)
              resolve()
              try {
                pump()
              } catch (error) {
                fault(error)
              }
            })
          })
          active.set(stream, released)
          stream.on('error', () => stream.destroy())
          try {
            onConnection(stream)
            stream.resume()
          } catch {
            stream.destroy()
          }
        },
        async (error: unknown) => {
          if (stopping) return
          if (error instanceof Error && (error as NodeJS.ErrnoException).code === 'E_PIPE_PEER_REJECTED') {
            // Native has already closed the unauthenticated handle. Bound rejection churn and yield to close.
            await new Promise((resolve) => setTimeout(resolve, 10))
          } else fault(error)
        },
      )
      .catch(fault)
      .finally(() => {
        pending = undefined
        task = undefined
        try {
          pump()
        } catch (error) {
          fault(error)
        }
      })
  }
  const stopAccepting = (): Promise<void> => {
    stopping = true
    rejectReady(new Error('Windows pipe stopped before ready'))
    stopped ??= (async () => {
      try {
        pending?.cancel()
        await task
      } finally {
        reservation.close()
      }
    })()
    return stopped
  }
  const close = (): Promise<void> => {
    closed ??= (async () => {
      try {
        await stopAccepting()
      } finally {
        const waits = [...active.values()]
        for (const stream of active.keys()) stream.destroy()
        await Promise.all(waits)
      }
    })()
    return closed
  }
  try {
    pump()
  } catch (error) {
    reservation.close()
    throw error
  }
  return { stopAccepting, close, failed, ready }
}
