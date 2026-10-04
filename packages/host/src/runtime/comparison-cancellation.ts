import { canonicalJson, sha256Hex } from '@agnes/core'
import type { EventEnvelope, InboxItem, JsonValue } from '@agnes/protocol'

const object = (value: JsonValue | undefined) =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value : undefined
const hash = (value: unknown) => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)
const admissionKeys = [
  'version',
  'id',
  'commandId',
  'payloadDigest',
  'configurationDigest',
  'writerRunId',
  'sessionId',
  'lane',
  'runtime',
  'status',
  'approvalMode',
]

/** Exact backend-owned rows only. A durable cancel fence alone cannot settle a running input. */
export class ComparisonCancellationEvidence {
  private fence: EventEnvelope | undefined
  private admission: { event: EventEnvelope; data: Record<string, JsonValue> } | undefined
  private invalid = false
  private lane: string | undefined
  private runtime: JsonValue = { id: 'native', version: '1' }
  constructor(
    private readonly sessionId: string,
    private readonly inputId: string,
  ) {}
  consume(event: EventEnvelope): void {
    const data = object(event.data)
    if (event.seq === 1) {
      this.lane = event.lane
      this.runtime = data?.runtime ?? this.runtime
    }
    if (!['x/core/input-cancelled', 'x/core/configuration-admission'].includes(event.type)) return
    if (data?.commandId !== this.inputId) return
    if (
      event.origin !== 'system' ||
      event.trust !== 'trusted' ||
      event.ignorable !== true ||
      event.lane !== this.lane ||
      data.version !== 1 ||
      data.sessionId !== this.sessionId
    ) {
      this.invalid = true
      return
    }
    if (event.type === 'x/core/input-cancelled') {
      if (event.register !== undefined) {
        this.invalid = true
        return
      }
      if (Object.keys(data).some((key) => !['version', 'sessionId', 'commandId'].includes(key))) {
        this.invalid = true
        return
      }
      this.fence = event
      return
    }
    if (
      event.register !== 'execution.admission' ||
      Object.keys(data).some((key) => !admissionKeys.includes(key)) ||
      !hash(data.id) ||
      !hash(data.payloadDigest) ||
      !hash(data.configurationDigest) ||
      typeof data.writerRunId !== 'string' ||
      !data.writerRunId ||
      data.lane !== event.lane ||
      canonicalJson(data.runtime) !== canonicalJson(this.runtime) ||
      !['held', 'released'].includes(String(data.status)) ||
      (data.approvalMode !== undefined && !['manual', 'smart', 'off'].includes(String(data.approvalMode)))
    ) {
      this.invalid = true
      return
    }
    const prior = this.admission
    if (
      data.status === 'released' &&
      (!prior ||
        prior.data.status !== 'held' ||
        canonicalJson({ ...prior.data, status: 'released' }) !== canonicalJson(data))
    ) {
      this.invalid = true
      return
    }
    if (data.status === 'held' && (prior?.data.status === 'held' || this.fence !== undefined)) {
      this.invalid = true
      return
    }
    this.admission = { event, data }
  }
  acknowledged(input: {
    pending: boolean
    open: boolean
    settled: boolean | undefined
    item: InboxItem | undefined
  }): boolean {
    if (this.invalid || !this.fence || input.pending || input.open || this.admission?.data.status === 'held')
      return false
    if (
      input.item &&
      this.admission &&
      this.admission.data.payloadDigest !== sha256Hex(canonicalJson(input.item.content))
    )
      return false
    if (input.item && input.settled !== true)
      return this.admission?.data.status === 'released' && this.admission.event.seq > this.fence.seq
    return true
  }
}
