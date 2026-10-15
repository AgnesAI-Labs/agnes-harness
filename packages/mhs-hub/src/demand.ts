import { type Json, MhsError, object } from '@agnes/mhs-device'
import type { DeviceLink } from './ports.js'

/** Per-connection demand. Explicit off wins over every automatic consumer. */
export class SourceDemand {
  private readonly consumers = new Map<symbol, { source: string; hz: number }>()
  private readonly manual = new Map<string, Record<string, Json>>()
  private applied = ''
  private pending: Promise<unknown> = Promise.resolve()
  private closed = false
  constructor(
    private readonly link: DeviceLink,
    private readonly changed: (states: Record<string, boolean | null>) => void,
  ) {}
  acquire(source: string, hz?: number): () => void {
    const declaration = this.link.registration.sources?.find((s) => s.id === source)
    if (!declaration) throw new MhsError('unknown-source')
    const rate = hz ?? (declaration.kind === 'video' ? 20 : declaration.kind === 'image' ? 1 : 2)
    if (!Number.isFinite(rate) || rate <= 0 || rate > 1000) throw new MhsError('invalid-rate')
    const token = Symbol()
    this.consumers.set(token, { source, hz: Math.min(rate, declaration.hz ?? rate) })
    void this.sync().catch(() => {})
    return () => {
      if (!this.consumers.delete(token)) return
      void this.sync().catch(() => {})
    }
  }
  async configure(sources: Record<string, unknown>): Promise<unknown> {
    for (const [source, options] of Object.entries(sources)) {
      if (!this.link.registration.sources?.some((s) => s.id === source)) throw new MhsError('unknown-source')
      const settings = object(options)
      if (typeof settings.on !== 'boolean') throw new MhsError('invalid-configure')
      this.manual.set(source, settings as Record<string, Json>)
    }
    return this.sync(true)
  }
  sync(force = false): Promise<unknown> {
    const run = this.pending
      .catch(() => {})
      .then(async () => {
        if (this.closed || !this.link.available) return {}
        const sources: Record<string, Json> = {}
        for (const source of this.link.registration.sources ?? []) {
          let hz = source.kind === 'pose' ? Math.min(1, source.hz ?? 1) : 0
          for (const demand of this.consumers.values())
            if (demand.source === source.id) hz = Math.max(hz, demand.hz)
          const manual = this.manual.get(source.id)
          sources[source.id] =
            manual?.on === false
              ? { on: false }
              : {
                  ...manual,
                  on: hz > 0 || manual?.on === true,
                  ...(hz > 0
                    ? { hz: Math.min(Math.max(hz, Number(manual?.hz ?? 0)), source.hz ?? 1000) }
                    : {}),
                }
        }
        const signature = JSON.stringify(sources)
        if (!force && signature === this.applied) return { sources }
        try {
          const result = await this.link.request('mhs/configure', { sources })
          if (!this.closed) {
            this.applied = signature
            const applied = object(object(result).sources ?? {})
            this.changed(
              Object.fromEntries(
                Object.keys(sources).map((id) => {
                  const value = applied[id] ? object(applied[id]).on : undefined
                  return [id, typeof value === 'boolean' ? value : null]
                }),
              ),
            )
          }
          return result
        } catch (error) {
          this.changed(Object.fromEntries(Object.keys(sources).map((id) => [id, null])))
          throw error
        }
      })
    this.pending = run
    return run
  }
  close() {
    this.closed = true
    this.consumers.clear()
  }
}
