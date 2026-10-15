import { createHash } from 'node:crypto'
import { type Json, MhsError, object } from '@agnes/mhs-device'

export interface ClipSpec {
  id: string
  rate: number
  channels: number
  bytes: number
  sha256: string
}
export function clipSpec(input: Json): ClipSpec {
  const spec = object(input)
  if (
    typeof spec.id !== 'string' ||
    !spec.id.length ||
    spec.id.length > 256 ||
    !Number.isInteger(spec.rate) ||
    Number(spec.rate) < 1 ||
    Number(spec.rate) > 384000 ||
    !Number.isInteger(spec.channels) ||
    Number(spec.channels) < 1 ||
    Number(spec.channels) > 8 ||
    !Number.isInteger(spec.bytes) ||
    Number(spec.bytes) < 1 ||
    Number(spec.bytes) > 1 << 20 ||
    Number(spec.bytes) % (Number(spec.channels) * 2) !== 0 ||
    typeof spec.sha256 !== 'string' ||
    !/^[a-f0-9]{64}$/.test(spec.sha256)
  )
    throw new MhsError('invalid-clip')
  return {
    id: spec.id,
    rate: Number(spec.rate),
    channels: Number(spec.channels),
    bytes: Number(spec.bytes),
    sha256: spec.sha256,
  }
}
/** One approved clip, one connection, one immutable payload. No replay after an uncertain send. */
export class Clips {
  private readonly grants = new Map<
    string,
    {
      device: string
      revision: string
      until: number
      spec: ClipSpec
      chunks?: Uint8Array[]
      received?: number
    }
  >()
  constructor(private readonly now: () => number) {}
  grant(operationId: string, device: string, revision: string, spec: ClipSpec, until: number) {
    for (const [id, grant] of this.grants) if (grant.until <= this.now()) this.grants.delete(id)
    if (this.grants.size >= 8) throw new MhsError('clip-capacity')
    this.grants.set(operationId, { device, revision, spec, until })
  }
  append(operationId: string, device: string, revision: string, bytes: Uint8Array): Uint8Array | undefined {
    const grant = this.grants.get(operationId)
    if (!grant || grant.device !== device || grant.revision !== revision || grant.until <= this.now())
      throw new MhsError('clip-grant-required')
    const received = (grant.received ?? 0) + bytes.length
    if (!bytes.length || bytes.length > 2048 || received > grant.spec.bytes) {
      this.grants.delete(operationId)
      throw new MhsError('invalid-clip-chunk')
    }
    grant.chunks ??= []
    grant.chunks.push(bytes.slice())
    grant.received = received
    if (received < grant.spec.bytes) return undefined
    const pcm = new Uint8Array(received)
    let offset = 0
    for (const chunk of grant.chunks) {
      pcm.set(chunk, offset)
      offset += chunk.length
    }
    return pcm
  }
  consume(operationId: string, device: string, revision: string, bytes: Uint8Array): ClipSpec {
    const grant = this.grants.get(operationId)
    if (!grant || grant.device !== device || grant.revision !== revision || grant.until <= this.now())
      throw new MhsError('clip-grant-required')
    // A failed attempt consumes this capability too.
    this.grants.delete(operationId)
    if (
      bytes.length !== grant.spec.bytes ||
      createHash('sha256').update(bytes).digest('hex') !== grant.spec.sha256
    )
      throw new MhsError('clip-payload-mismatch')
    return grant.spec
  }
  revoke(device?: string, leaseId?: string) {
    for (const [id, grant] of this.grants)
      if ((!device || grant.device === device) && (!leaseId || id === leaseId)) this.grants.delete(id)
  }
}
