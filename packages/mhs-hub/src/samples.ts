import { type Json, MhsError, type Source } from '@agnes/mhs-device'
import type { Sample } from './reads.js'

export type SampleBudget = { binary: number; json: number }
/** Latest media plus two minutes of values at 1 Hz, bounded across the whole Hub. */
export class Samples {
  private readonly latest = new Map<string, Sample>()
  private readonly histories = new Map<string, Sample[]>()
  constructor(
    private readonly budget: SampleBudget,
    private readonly now: () => number,
  ) {}
  get(source: string): Sample[] {
    const latest = this.latest.get(source)
    return latest ? [latest] : []
  }
  history(source: string): Sample[] {
    return this.histories.get(source) ?? []
  }
  private size(sample: Sample) {
    return Buffer.byteLength(JSON.stringify(sample.data))
  }
  put(source: Source, data: Json, bytes?: Uint8Array, mime?: string): Sample | undefined {
    const size = Buffer.byteLength(JSON.stringify(data))
    if (size > 65536) throw new MhsError('oversize-data')
    const previous = this.latest.get(source.id)
    if (previous) {
      this.budget.binary -= previous.bytes?.length ?? 0
      this.budget.json -= this.size(previous)
    }
    this.latest.delete(source.id)
    const history = this.histories.get(source.id) ?? []
    while (
      history.length &&
      (history.length >= 120 || (history[0]?.at ?? Infinity) <= this.now() - 120_000)
    ) {
      const removed = history.shift()
      if (removed) this.budget.json -= this.size(removed)
    }
    if (this.budget.binary + (bytes?.length ?? 0) > 16 << 20 || this.budget.json + size > 8 << 20)
      return undefined
    const sample = {
      at: this.now(),
      data: structuredClone(data),
      ...(bytes ? { bytes: bytes.slice() } : {}),
      ...(mime ? { mime } : {}),
    }
    this.latest.set(source.id, sample)
    this.budget.binary += bytes?.length ?? 0
    this.budget.json += size
    if (
      source.kind === 'values' &&
      sample.at - (history.at(-1)?.at ?? -Infinity) >= 1000 &&
      this.budget.json + size <= 8 << 20
    ) {
      history.push({ at: sample.at, data: sample.data })
      this.budget.json += size
    }
    this.histories.set(source.id, history)
    return sample
  }
  close() {
    for (const sample of this.latest.values()) {
      this.budget.binary -= sample.bytes?.length ?? 0
      this.budget.json -= this.size(sample)
    }
    for (const history of this.histories.values())
      for (const sample of history) this.budget.json -= this.size(sample)
    this.latest.clear()
    this.histories.clear()
  }
}
