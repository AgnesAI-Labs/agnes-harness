import type { Actor, PermissionContext } from '@agnes/protocol'

/** Backend lifetime and actor snapshot. Author-facing ports only receive detached views. */
export class SessionPermissionAuthority {
  private readonly id = crypto.randomUUID()
  private epoch = 0
  private readonly changes = new Set<() => void>()
  private readonly snapshot: Actor

  constructor(actor: Actor) {
    this.snapshot = structuredClone(actor)
  }

  get actor(): Actor {
    return structuredClone(this.snapshot)
  }

  context(sessionKey: string, policy: string): PermissionContext {
    return { sessionKey, sessionId: this.id, epoch: this.epoch, policy, actor: this.actor }
  }

  subscribe(listener: () => void): () => void {
    this.changes.add(listener)
    return () => {
      this.changes.delete(listener)
    }
  }

  revoke(): void {
    this.epoch++
    for (const listener of this.changes) listener()
  }
}
