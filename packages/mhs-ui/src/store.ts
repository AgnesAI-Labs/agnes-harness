import type { MhsClient } from './client.js'
import { type Device, record, type ToolRecord, toolsFrom } from './model.js'

export type Snapshot = {
  status: 'loading' | 'ready' | 'failed' | 'disabled'
  devices: Device[]
  maps: Record<string, unknown>[]
  calls: ToolRecord[]
  sessionId: string | undefined
  error?: string | undefined
  streamError?: string | undefined
}
export class MhsStore {
  private snapshot: Snapshot = { status: 'loading', devices: [], maps: [], calls: [], sessionId: undefined }
  private listeners = new Set<() => void>()
  private sessionEpoch = 0
  private refreshEpoch = 0
  private refreshPending = false
  private stopped = false
  private timer: ReturnType<typeof setTimeout> | undefined
  constructor(readonly client: MhsClient) {}
  read = () => this.snapshot
  subscribe = (listener: () => void) => {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }
  private update(patch: Partial<Snapshot>) {
    if (this.stopped) return
    this.snapshot = { ...this.snapshot, ...patch }
    for (const listener of this.listeners) listener()
  }
  async refresh() {
    const epoch = ++this.refreshEpoch
    try {
      const [devices, maps] = await Promise.all([this.client.devices(), this.client.query('maps')])
      if (this.stopped || epoch !== this.refreshEpoch) return
      if (!Array.isArray(maps)) throw new Error('invalid-map-projection')
      this.update({ status: 'ready', devices, maps: maps.map(record), error: undefined })
    } catch {
      if (!this.stopped && epoch === this.refreshEpoch) this.update({ status: 'failed', error: 'failed' })
    }
  }
  private queueRefresh = () => {
    if (this.stopped || this.refreshPending) return
    this.refreshPending = true
    // Coalesce high-frequency telemetry without retaining an unbounded event queue.
    this.timer = setTimeout(() => {
      this.refreshPending = false
      void this.refresh()
    }, 100)
  }
  private sessionChanged = () => {
    const sessionId = this.client.ports.session.getSnapshot()
    ++this.sessionEpoch
    this.update({ sessionId, calls: [] })
    void this.readSession()
  }
  private readSession = async () => {
    const epoch = ++this.sessionEpoch,
      sessionId = this.client.ports.session.getSnapshot()
    if (!sessionId) return
    try {
      const projection = record(await this.client.ports.session.projection.read())
      if (this.stopped || epoch !== this.sessionEpoch || this.snapshot.sessionId !== sessionId) return
      this.update({ calls: projection.status === 'available' ? toolsFrom(projection.value) : [] })
    } catch {
      if (epoch === this.sessionEpoch) this.update({ calls: [] })
    }
  }
  start(): () => void {
    this.sessionChanged()
    const offSession = this.client.ports.session.subscribe(this.sessionChanged)
    const offProjection = this.client.ports.session.projection.subscribe(() => {
      void this.readSession()
    })
    void this.refresh()
    void this.client
      .stream('events', {}, this.queueRefresh)
      .then(({ stream }) => {
        stream.onDisconnect(() => this.update({ streamError: 'disconnected' }))
        stream.onDrop(() => {
          this.update({ streamError: 'backpressure' })
          this.queueRefresh()
        })
      })
      .catch(() => this.update({ streamError: 'unavailable' }))
    return () => {
      if (this.stopped) return
      ++this.sessionEpoch
      ++this.refreshEpoch
      clearTimeout(this.timer)
      offSession()
      offProjection()
      this.client.dispose()
      this.update({ status: 'disabled', devices: [], maps: [], calls: [], sessionId: undefined })
      this.stopped = true
      this.listeners.clear()
    }
  }
}
// Session list tools may name devices only in their results, including a read without an explicit ID.
export function usedDeviceIds(calls: readonly ToolRecord[]): Set<string> {
  const ids = new Set<string>()
  for (const call of calls) {
    if (call.device) ids.add(call.device)
    const result = record(call.result)
    const device = record(result.device)
    if (typeof device.id === 'string') ids.add(device.id)
    // Listing devices is discovery, not evidence that each device has been used.
  }
  return ids
}
