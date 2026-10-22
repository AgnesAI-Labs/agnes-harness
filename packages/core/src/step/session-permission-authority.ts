import { CoreError, type Seq } from '@agnes/core-common/types'
import {
  type Actor,
  type EventEnvelope,
  inspectJsonData,
  type PermissionContext,
  validateActor,
} from '@agnes/protocol'
import { sysEvent } from './events.js'
import type { SessionImpl } from './session.js'

/** Backend lifetime and actor snapshot. Author-facing ports only receive detached views. */
export class SessionPermissionAuthority {
  private readonly id = crypto.randomUUID()
  private epoch = 0
  private readonly changes = new Set<() => void>()
  private readonly barriers = new Set<() => Promise<void>>()
  private readonly snapshot: Actor
  private selection: { enabled: boolean; operator: Actor } | undefined
  private parent: (() => Pick<PermissionContext, 'policy' | 'actor'>) | null | undefined
  private releaseParent: (() => void) | undefined
  private releaseParentBarrier: (() => void) | undefined
  private closed = false

  constructor(actor: Actor) {
    this.snapshot = structuredClone(actor)
  }

  get actor(): Actor {
    return structuredClone(this.snapshot)
  }

  context(sessionKey: string, policy: string): PermissionContext {
    const inherited = this.parent?.()
    const selected = this.selection
    const effective = selected?.enabled ? 'full-access' : policy
    return {
      sessionKey,
      sessionId: this.id,
      epoch: this.epoch,
      policy:
        this.closed || this.parent === null
          ? ''
          : policy === 'read-only'
            ? policy
            : (inherited?.policy ?? effective),
      actor: inherited?.actor ?? (selected?.enabled ? structuredClone(selected.operator) : this.actor),
    }
  }

  /** Called only after the backend validates and persists an owner-bound switch. */
  select(enabled: boolean, operator: Actor): void {
    this.selection = { enabled, operator: structuredClone(operator) }
    this.revoke()
  }

  /** v1 could be synthesized from a package policy, so it cannot attest a user's full-access choice.
   * Only a complete v2 owner-bound backend row restores the new permission authority. */
  restore(
    row: Pick<EventEnvelope, 'origin' | 'trust' | 'lane' | 'actor' | 'data'> | undefined,
    binding: { key: string; lane: string; profileHash: string | null; owner: Actor },
  ): boolean {
    if (!row) return false
    this.select(false, binding.owner)
    if (row.origin !== 'system' || row.trust !== 'trusted' || row.lane !== binding.lane) return false
    const inspectedActor = inspectJsonData(row.actor, 16 * 1024)
    if (!inspectedActor.ok) return false
    const actor = validateActor(inspectedActor.value)
    if (!actor.ok) return false
    const inspected = inspectJsonData(row.data, 16 * 1024)
    if (!inspected.ok || !inspected.value || Array.isArray(inspected.value)) return false
    const data = inspected.value as Record<string, unknown>
    if (
      Reflect.ownKeys(data).length !== 7 ||
      data.version !== 2 ||
      typeof data.to !== 'boolean' ||
      data.sessionKey !== binding.key ||
      data.lane !== binding.lane ||
      data.profileHash !== binding.profileHash ||
      data.operatorId !== actor.value.id
    )
      return false
    const owner = data.sessionOwner
    if (
      !owner ||
      typeof owner !== 'object' ||
      Array.isArray(owner) ||
      Reflect.ownKeys(owner).length !== 2 ||
      (owner as Record<string, unknown>).id !== binding.owner.id ||
      (owner as Record<string, unknown>).org !== binding.owner.org
    )
      return false
    this.select(data.to, actor.value)
    return data.to
  }

  /** A descendant never acquires more authority than its live parent. */
  inherit(
    parent: (() => PermissionContext) | undefined,
    subscribe?: (listener: () => void) => () => void,
    before?: (listener: () => Promise<void>) => () => void,
  ): void {
    this.releaseParent?.()
    this.releaseParentBarrier?.()
    this.parent = parent ?? null
    this.releaseParent = subscribe?.(() => this.revoke())
    this.releaseParentBarrier = before?.(() => this.prepare())
    this.revoke()
  }

  detach(): void {
    this.closed = true
    this.revoke()
    this.releaseParent?.()
    this.releaseParentBarrier?.()
    this.releaseParent = undefined
    this.releaseParentBarrier = undefined
    this.parent = undefined
  }

  subscribe(listener: () => void): () => void {
    this.changes.add(listener)
    return () => {
      this.changes.delete(listener)
    }
  }

  /** Backend effect owners must fence the current epoch before a downgrade can commit. */
  beforeChange(listener: () => Promise<void>): () => void {
    this.barriers.add(listener)
    return () => {
      this.barriers.delete(listener)
    }
  }

  async prepare(): Promise<void> {
    await Promise.all([...this.barriers].map((listener) => listener()))
  }

  revoke(): void {
    this.epoch++
    for (const listener of this.changes) listener()
  }
}

/** Validate without invoking author accessors before persisting a permission switch. */
export function permissionOperator(operator: Actor): Actor {
  const inspected = inspectJsonData(operator, 16 * 1024)
  if (!inspected.ok) throw new CoreError('E_ENVELOPE', 'invalid yolo operator')
  const checked = validateActor(inspected.value)
  if (!checked.ok) throw new CoreError('E_ENVELOPE', 'invalid yolo operator')
  return checked.value
}

/** The caller owns the validated actor before queuing this operation under the projection gate. */
export async function setSessionYolo(
  session: SessionImpl,
  authority: SessionPermissionAuthority,
  enabled: boolean,
  actor: Actor,
): Promise<Seq> {
  await session.preparePermissionRevocation()
  const result = await session.d.log.append([
    sysEvent(
      { actor, lane: session.lane },
      'x/core/yolo-switch',
      {
        version: 2,
        to: enabled,
        operatorId: actor.id,
        sessionKey: session.key,
        lane: session.lane,
        profileHash: session.d.resolvedProfileHash,
        sessionOwner: { id: session.d.actor.id, org: session.d.actor.org },
      },
      { ignorable: true },
    ),
  ])
  authority.select(enabled, actor)
  const invalidations = session.decisions.revokedAutomaticEvents()
  if (invalidations.length) await session.d.log.append(invalidations)
  return result.firstSeq
}
