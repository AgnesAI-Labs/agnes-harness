import type { Device } from '@agnes/mhs-device'
import { MarsSimulation } from './simulation.js'
import { DEVICE_IDS, type DeviceId } from './world.js'

export interface MarsConnection {
  /** Set by the reviewed transport only after registration and both channels are ready. */
  ready: Promise<void>
  closed: Promise<void>
  close(): Promise<void>
}
export interface MarsTransport {
  /** Must be bound to this example's profile and explicit parent service grant. */
  connect(device: Device, signal: AbortSignal): Promise<MarsConnection>
}
export type RuntimeStatus = 'stopped' | 'starting' | 'ready' | 'unavailable'
/** One instance per enabled profile module. Scene attachment never owns devices or clocks. */
export class MarsRuntime {
  readonly simulation: MarsSimulation
  private readonly listeners = new Set<() => void>()
  private readonly connections: MarsConnection[] = []
  private readonly online = new Set<DeviceId>()
  private abort: AbortController | undefined
  private startPromise: Promise<void> | undefined
  private stopPromise: Promise<void> | undefined
  private timer: ReturnType<typeof setInterval> | undefined
  private status: RuntimeStatus = 'stopped'
  private revision = 0
  constructor(
    private readonly transport: MarsTransport,
    video = false,
  ) {
    this.simulation = new MarsSimulation(video)
  }
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }
  getRevision = (): number => this.revision
  snapshot() {
    return { status: this.status, online: [...this.online], devices: this.simulation.snapshot() }
  }
  private changed(): void {
    this.revision++
    for (const listener of this.listeners) listener()
  }
  start(): Promise<void> {
    if (this.stopPromise) return this.stopPromise.then(() => this.start())
    if (this.startPromise) return this.startPromise
    this.status = 'starting'
    this.changed()
    const controller = new AbortController()
    this.abort = controller
    this.startPromise = this.open(controller).catch(async (error) => {
      if (this.abort === controller && !controller.signal.aborted) await this.shutdown('unavailable')
      throw error
    })
    return this.startPromise
  }
  private wait<T>(pending: Promise<T>, signal: AbortSignal, late?: (value: T) => void): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      let settled = false
      const finish = () => {
        settled = true
        clearTimeout(timer)
        signal.removeEventListener('abort', abort)
      }
      const abort = () => {
        finish()
        reject(new Error('connection-aborted'))
      }
      const timer = setTimeout(() => {
        finish()
        reject(new Error('connection-timeout'))
      }, 10_000)
      signal.addEventListener('abort', abort, { once: true })
      void pending.then(
        (value) => {
          if (settled) {
            late?.(value)
            return
          }
          finish()
          resolve(value)
        },
        (error) => {
          if (!settled) {
            finish()
            reject(error)
          }
        },
      )
      if (signal.aborted) abort()
    })
  }
  private async open(controller: AbortController): Promise<void> {
    await this.simulation.reset()
    // Sequential registration keeps shutdown ownership explicit even when a later device fails.
    for (const id of DEVICE_IDS) {
      controller.signal.throwIfAborted()
      const connection = await this.wait(
        this.transport.connect(this.simulation.device(id), controller.signal),
        controller.signal,
        (late) => {
          void late.close().catch(() => {})
        },
      )
      if (controller.signal.aborted) {
        await connection.close()
        controller.signal.throwIfAborted()
      }
      this.connections.push(connection)
      void connection.closed.then(
        () => {
          if (!controller.signal.aborted) void this.shutdown('unavailable').catch(() => {})
        },
        () => {
          if (!controller.signal.aborted) void this.shutdown('unavailable').catch(() => {})
        },
      )
      await this.wait(connection.ready, controller.signal)
      controller.signal.throwIfAborted()
      this.online.add(id)
      this.changed()
    }
    let last = performance.now()
    this.timer = setInterval(() => {
      const now = performance.now(),
        elapsed = (now - last) / 1000
      last = now
      if (elapsed > 0.25) {
        void this.shutdown('unavailable').catch(() => {})
        return
      }
      this.simulation.tick(elapsed)
      this.changed()
    }, 50)
    this.status = 'ready'
    this.changed()
  }
  stop(): Promise<void> {
    return this.shutdown('stopped')
  }
  private shutdown(status: 'stopped' | 'unavailable'): Promise<void> {
    if (this.stopPromise) return this.stopPromise
    this.status = status
    this.abort?.abort()
    clearInterval(this.timer)
    this.online.clear()
    this.changed()
    this.stopPromise = (async () => {
      await this.simulation.stop()
      const results = await Promise.allSettled(this.connections.splice(0).map((c) => c.close()))
      if (results.some((r) => r.status === 'rejected')) {
        this.status = 'unavailable'
        this.changed()
        throw new Error('shutdown-unconfirmed')
      }
    })().finally(() => {
      this.startPromise = undefined
      this.stopPromise = undefined
    })
    return this.stopPromise
  }
  /** Reset state without replacing registrations or borrowing parent authority. */
  async reset(): Promise<void> {
    if (this.status !== 'ready') throw new Error('example-unavailable')
    await this.simulation.reset()
    this.changed()
  }
}
