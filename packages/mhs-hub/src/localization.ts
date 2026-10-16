import { type Json, object, type Registration, type Source } from '@agnes/mhs-device'
import type { Position } from './maps.js'

type Fix = {
  at: number
  position: Position
  trust: 'trusted' | 'uncertain'
  reason?: string
  odom?: { x: number; y: number }
}
export class Localization {
  private fix: Fix | undefined
  private odom: { x: number; y: number } | undefined
  constructor(
    private readonly registration: Registration,
    private readonly now: () => number,
  ) {}
  observe(source: Source, data: Json) {
    if (source.kind === 'odometry') {
      const odom = object(data)
      this.odom = { x: Number(odom.x), y: Number(odom.y) }
    }
    if (source.kind !== 'pose') return
    const pose = object(data),
      previous = this.fix
    const position = { map: String(pose.map), x: Number(pose.x), y: Number(pose.y), yaw: Number(pose.yaw) }
    const cov = Array.isArray(pose.cov) ? pose.cov : []
    const error = Math.sqrt(Math.max(Number(cov[0] ?? 0), Number(cov[4] ?? 0), 0))
    let reason: string | undefined
    if (pose.ok !== true) reason = 'device-untrusted'
    else if (error > (source.max_error_m ?? 0.5)) reason = 'position-error'
    else if (previous?.odom && this.odom && previous.position.map === position.map) {
      const jump = Math.hypot(position.x - previous.position.x, position.y - previous.position.y)
      const moved = Math.hypot(this.odom.x - previous.odom.x, this.odom.y - previous.odom.y)
      if (jump > moved + 1) reason = 'odometry-disagreement'
    }
    this.fix = {
      at: this.now(),
      position,
      trust: reason ? 'uncertain' : 'trusted',
      ...(reason ? { reason } : {}),
      ...(this.odom ? { odom: { ...this.odom } } : {}),
    }
  }
  /** Age of the last received fix, for presentation only. */
  age(): number | undefined {
    return this.fix ? Math.max(0, this.now() - this.fix.at) : undefined
  }
  project(available: boolean): {
    trust: 'trusted' | 'uncertain' | 'lost'
    position?: Position
    positionReason?: string
    fixed?: boolean
  } {
    if (this.registration.localization === 'fixed' && this.registration.placement)
      return {
        trust: available ? 'trusted' : 'lost',
        position: { ...this.registration.placement },
        fixed: true,
      }
    if (!this.fix) return { trust: 'lost', positionReason: 'no-position' }
    const age = this.now() - this.fix.at
    return {
      position: { ...this.fix.position },
      trust: !available || age > 10_000 ? 'lost' : age > 3000 ? 'uncertain' : this.fix.trust,
      ...(!available || age > 3000
        ? { positionReason: 'stale-position' }
        : this.fix.reason
          ? { positionReason: this.fix.reason }
          : {}),
    }
  }
}
