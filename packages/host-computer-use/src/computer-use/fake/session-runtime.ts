import { randomBytes } from 'node:crypto'
import { connectFakeComputerUseDriver } from './connection.js'
import { captureFakeObserveConnection } from './observe.js'
import type {
  ComputerUseDriverPermissionMode,
  ComputerUseResetReason,
  ComputerUseSessionRef,
  DriverCloseEvent,
  FakeComputerUseDriverConnection,
  FakeComputerUseSessionRuntime,
  FakeDriverCommand,
} from './types.js'

export {
  type FakeObserveArtifactSink,
  type FakeObserveToolName,
  type NormalizedFakeObserveResult,
  normalizeFakeObserveResult,
} from './observe.js'
export type {
  ComputerUseDriverCommand,
  ComputerUseDriverConnection,
  ComputerUseDriverPermissionMode,
  ComputerUseResetReason,
  ComputerUseSessionRef,
  DriverCallResult,
  DriverCloseEvent,
  DriverCloseReason,
  DriverContent,
  DriverToolContract,
  FakeCaptureRequest,
  FakeCaptureTarget,
  FakeComputerUseDriverConnection,
  FakeComputerUseSessionRuntime,
  FakeDriverCommand,
} from './types.js'

type Managed = {
  connection: FakeComputerUseDriverConnection & {
    closeForReset(reason: ComputerUseResetReason | undefined): Promise<void>
    cancelFromSession(): Promise<void>
  }
  removeAbort(): void
  observeBusy: boolean
}

type Opening = {
  done: Promise<void>
  finish(error?: unknown): void
  intent?: Readonly<{ kind: 'close'; reason: ComputerUseResetReason }> | Readonly<{ kind: 'dispose' }>
  cancel: AbortController
}

function reserveOpening(): Opening {
  let finish: ((error?: unknown) => void) | undefined
  const done = new Promise<void>((resolve, reject) => {
    finish = (error) => (error === undefined ? resolve() : reject(error))
  })
  // A plain failed open has no close/dispose waiter. Mark the reservation handled while preserving
  // its rejection for a concurrent lifecycle waiter that does await it.
  void done.catch(() => undefined)
  return {
    done,
    finish: (error) => finish?.(error),
    cancel: new AbortController(),
  }
}

type RuntimeConnection = FakeComputerUseDriverConnection & {
  closeForReset(reason: ComputerUseResetReason | undefined): Promise<void>
  cancelFromSession(): Promise<void>
}

export type FakeComputerUseRuntimeDeps = Readonly<{
  connect?: (
    command: FakeDriverCommand,
    generation: number,
    sessionToken: string,
    signal: AbortSignal,
  ) => Promise<RuntimeConnection>
}>

export type ComputerUseRuntimeDeps = FakeComputerUseRuntimeDeps

export type ComputerUseSessionRuntimeOptions = Readonly<{
  /** Default is the driver-owned standard mode. */
  initialMode?: ComputerUseDriverPermissionMode
  /** Production callers use this to bind each mode to its reviewed launch arguments/manifest. */
  commandForMode?: (mode: ComputerUseDriverPermissionMode, base: FakeDriverCommand) => FakeDriverCommand
}>

function sessionKey(session: ComputerUseSessionRef): string {
  if (!session.key || !session.lane)
    throw new TypeError('fake Computer Use session key and lane are required')
  return `${session.key.length}:${session.key}${session.lane.length}:${session.lane}`
}

function sessionToken(): string {
  return randomBytes(24).toString('hex')
}

function cancelled(): DOMException {
  return new DOMException('fake Computer Use open cancelled', 'AbortError')
}

class ClosedWhileOpening extends DOMException {
  constructor() {
    super('fake Computer Use session closed while opening', 'AbortError')
  }
}

class DisposedWhileOpening extends Error {
  constructor() {
    super('fake Computer Use session runtime is disposed')
  }
}

function combinedOpeningSignal(
  caller: AbortSignal,
  opening: AbortSignal,
): Readonly<{ signal: AbortSignal; close(): void }> {
  const controller = new AbortController()
  const abort = () => controller.abort()
  const close = (): void => {
    try {
      caller.removeEventListener('abort', abort)
    } catch {
      // A malformed caller signal must not strand the opening reservation during cleanup.
    }
    try {
      opening.removeEventListener('abort', abort)
    } catch {
      // The opening signal is Host-owned, but cleanup remains best-effort on every terminal path.
    }
  }
  try {
    caller.addEventListener('abort', abort, { once: true })
    opening.addEventListener('abort', abort, { once: true })
    if (caller.aborted || opening.aborted) abort()
    return Object.freeze({ signal: controller.signal, close })
  } catch (error) {
    close()
    throw error
  }
}

function beginOpeningIntent(reservation: Opening, intent: NonNullable<Opening['intent']>): void {
  if (reservation.intent) return
  reservation.intent = intent
  reservation.cancel.abort()
}

function isAbortError(error: unknown): boolean {
  if (!(error instanceof Error)) return false
  if (error.name === 'AbortError') return true
  return 'code' in error && error.code === 'ABORT_ERR'
}

function controlledOpeningCancellation(error: unknown, reservation: Opening): Error | undefined {
  // Node's Windows child-process path reports AbortSignal cancellation as a regular Error with
  // code=ABORT_ERR, while the POSIX path and browser-shaped callers use DOMException AbortError.
  // Both describe the same Host-controlled cancellation and must resolve to the lifecycle intent.
  if (!isAbortError(error)) return undefined
  if (reservation.intent?.kind === 'close') return new ClosedWhileOpening()
  if (reservation.intent?.kind === 'dispose') return new DisposedWhileOpening()
  return undefined
}

export function createFakeComputerUseSessionRuntime(
  command: FakeDriverCommand,
  deps: FakeComputerUseRuntimeDeps = {},
  options: ComputerUseSessionRuntimeOptions = {},
): FakeComputerUseSessionRuntime {
  const active = new Map<string, Managed>()
  const opening = new Map<string, Opening>()
  const generations = new Map<string, number>()
  const modes = new Map<string, ComputerUseDriverPermissionMode>()
  let disposed = false
  let disposeTask: Promise<void> | undefined
  const connect = deps.connect ?? connectFakeComputerUseDriver
  const initialMode = options.initialMode ?? 'standard'
  if (!['standard', 'bounded', 'unrestricted'].includes(initialMode))
    throw new TypeError('Computer Use permission mode is invalid')

  const remove = (key: string, connection: FakeComputerUseDriverConnection): void => {
    const current = active.get(key)
    if (current?.connection !== connection) return
    current.removeAbort()
    active.delete(key)
  }

  return {
    async open(session, signal) {
      if (disposed) throw new Error('fake Computer Use session runtime is disposed')
      if (signal.aborted) throw cancelled()
      const key = sessionKey(session)
      if (active.has(key) || opening.has(key)) throw new Error('session already has an open fake runtime')
      const reservation = reserveOpening()
      opening.set(key, reservation)
      const generation = (generations.get(key) ?? 0) + 1
      // A generation names a transport attempt, not only a successful open. Reusing a failed
      // generation would let stale capability/snapshot state alias its replacement.
      generations.set(key, generation)
      let openingError: unknown
      let openingSignal: ReturnType<typeof combinedOpeningSignal> | undefined
      try {
        openingSignal = combinedOpeningSignal(signal, reservation.cancel.signal)
        const mode = modes.get(key) ?? initialMode
        const selectedCommand = options.commandForMode?.(mode, command) ?? command
        const connection = await connect(selectedCommand, generation, sessionToken(), openingSignal.signal)
        const intent = reservation.intent
        if (intent?.kind === 'close') {
          await connection.closeForReset(intent.reason)
          throw new ClosedWhileOpening()
        }
        if (intent?.kind === 'dispose' || disposed) {
          await connection.closeForReset(undefined)
          throw new DisposedWhileOpening()
        }
        const onAbort = () => {
          void connection.cancelFromSession()
        }
        signal.addEventListener('abort', onAbort, { once: true })
        const managed: Managed = {
          connection,
          removeAbort: () => signal.removeEventListener('abort', onAbort),
          observeBusy: false,
        }
        active.set(key, managed)
        connection.onClose((_event: DriverCloseEvent) => remove(key, connection))
        if (signal.aborted) {
          await connection.cancelFromSession()
          remove(key, connection)
          throw cancelled()
        }
        return connection
      } catch (error) {
        const controlled = controlledOpeningCancellation(error, reservation)
        openingError = controlled ?? error
        throw openingError
      } finally {
        openingSignal?.close()
        if (opening.get(key) === reservation) opening.delete(key)
        reservation.finish(openingError)
      }
    },

    async captureObserve(session, request, options) {
      if (disposed) throw new Error('fake Computer Use session runtime is disposed')
      const key = sessionKey(session)
      const managed = active.get(key)
      if (!managed) throw new Error('session has no open fake runtime')
      if (managed.observeBusy) throw new Error('session already has a fake observe call in progress')
      managed.observeBusy = true
      try {
        return await captureFakeObserveConnection(managed.connection, request, options, async () => {
          const current = active.get(key)
          if (current?.connection !== managed.connection) return
          await managed.connection.closeForReset('transport_suspect')
          remove(key, managed.connection)
        })
      } finally {
        managed.observeBusy = false
      }
    },

    async close(session, reason) {
      const key = sessionKey(session)
      const reservation = opening.get(key)
      if (reservation) beginOpeningIntent(reservation, { kind: 'close', reason })
      try {
        await reservation?.done
      } catch (error) {
        // Every lifecycle waiter shares the first close/dispose intent and its cleanup outcome.
        // Controlled opening cancellation is success for close; real cleanup failures propagate.
        if (!(error instanceof ClosedWhileOpening || error instanceof DisposedWhileOpening)) throw error
      }
      const managed = active.get(key)
      if (!managed) return
      await managed.connection.closeForReset(reason)
      remove(key, managed.connection)
    },

    async setPermissionMode(session, mode) {
      if (!['standard', 'bounded', 'unrestricted'].includes(mode))
        throw new TypeError('Computer Use permission mode is invalid')
      if (disposed) throw new Error('fake Computer Use session runtime is disposed')
      const key = sessionKey(session)
      const current = modes.get(key) ?? initialMode
      if (current === mode) return
      // Record the new mode before cancellation so a racing re-open can never launch the old mode.
      modes.set(key, mode)
      generations.set(key, (generations.get(key) ?? 0) + 1)
      const reservation = opening.get(key)
      if (reservation) beginOpeningIntent(reservation, { kind: 'close', reason: 'mode_change' })
      try {
        await reservation?.done
      } catch (error) {
        if (!(error instanceof ClosedWhileOpening || error instanceof DisposedWhileOpening)) throw error
      }
      const managed = active.get(key)
      if (!managed) return
      await managed.connection.closeForReset('mode_change')
      remove(key, managed.connection)
    },

    permissionMode(session) {
      return modes.get(sessionKey(session)) ?? initialMode
    },

    dispose() {
      if (disposeTask) return disposeTask
      disposed = true
      const reservations = [...opening.values()]
      for (const reservation of reservations) beginOpeningIntent(reservation, { kind: 'dispose' })
      disposeTask = (async () => {
        const openingOutcomes = await Promise.allSettled(reservations.map((reservation) => reservation.done))
        const closing = [...active.entries()].map(async ([key, managed]) => {
          await managed.connection.closeForReset(undefined)
          remove(key, managed.connection)
        })
        const outcomes = await Promise.allSettled(closing)
        const failures = [...openingOutcomes, ...outcomes].flatMap((outcome) => {
          if (
            outcome.status !== 'rejected' ||
            outcome.reason instanceof DisposedWhileOpening ||
            outcome.reason instanceof ClosedWhileOpening
          )
            return []
          return [outcome.reason]
        })
        if (failures.length) throw new AggregateError(failures, 'fake Computer Use disposal failed')
        modes.clear()
      })()
      return disposeTask
    },
  }
}

/** Production-neutral entry point. The same runtime owns both fake and locked driver processes. */
export const createComputerUseSessionRuntime = createFakeComputerUseSessionRuntime
