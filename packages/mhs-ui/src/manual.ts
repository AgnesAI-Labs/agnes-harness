import type { JsonValue } from '@agnes/protocol'
import type { ClientStream } from './ports.js'

export type Axis = { id: string; min: number; max: number; role?: string }
/** A local interaction deadman complements device safety; it never grants control. */
export class ManualController {
  private timer: ReturnType<typeof setInterval> | undefined
  private readonly values: Record<string, number> = {}
  private released = false
  constructor(
    readonly stream: ClientStream,
    readonly axes: readonly Axis[],
    readonly expiresAt: number,
    private readonly stop: () => Promise<unknown>,
    private readonly now = Date.now,
    rateHz = 30,
  ) {
    if (!Number.isFinite(expiresAt) || expiresAt <= now()) throw new Error('expired-lease')
    for (const axis of axes) this.values[axis.id] = 0
    this.timer = setInterval(
      () => {
        if (this.now() >= expiresAt) {
          void this.release().catch(() => {})
          return
        }
        // The controller sends while held, including zero between releases. No queued replay.
        if (this.stream.send({ type: 'manual', axes: { ...this.values } } as JsonValue) !== 'accepted')
          void this.release().catch(() => {})
      },
      Math.max(34, 1000 / Math.max(1, Math.min(30, rateHz))),
    )
  }
  set(id: string, normalized: number) {
    if (this.released || this.now() >= this.expiresAt) {
      void this.release().catch(() => {})
      return
    }
    const axis = this.axes.find((a) => a.id === id)
    if (!axis || !Number.isFinite(normalized)) return
    const n = Math.max(-1, Math.min(1, normalized))
    this.values[id] = n < 0 ? -n * Math.min(0, axis.min) : n * Math.max(0, axis.max)
  }
  zero() {
    for (const axis of this.axes) this.values[axis.id] = 0
    if (!this.released) this.stream.send({ type: 'manual', axes: { ...this.values } })
  }
  async release() {
    if (this.released) return
    this.zero()
    this.released = true
    clearInterval(this.timer)
    // Urgent stop is independent of the control/media stream and of lease expiration.
    try {
      await this.stop()
    } finally {
      this.stream.close('manual-release')
    }
  }
}
export const roleKeys: Readonly<Record<string, readonly [string, string]>> = {
  forward: ['w', 's'],
  turn: ['a', 'd'],
  up: ['r', 'f'],
  pitch: ['i', 'k'],
  yaw: ['j', 'l'],
}
