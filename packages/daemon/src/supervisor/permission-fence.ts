import type { PermissionContext } from '@agnes/protocol'

type Lifetime = { closed: boolean; floors: Map<string, number> }

/** Supervisor-owned epoch floor. Query replies cannot restore revoked epochs.
 * A commit's synchronous assert and a revoke acknowledgement share this event loop. */
export class PermissionFence {
  private readonly sessions = new Map<string, Lifetime>()
  private alive = true

  private session(key: string): Lifetime {
    let lifetime = this.sessions.get(key)
    if (!lifetime) {
      lifetime = { closed: false, floors: new Map() }
      this.sessions.set(key, lifetime)
    }
    return lifetime
  }

  bind(context: PermissionContext): () => PermissionContext | undefined {
    const expected = structuredClone(context),
      lifetime = this.session(context.sessionKey)
    return () =>
      this.alive && !lifetime.closed && expected.epoch >= (lifetime.floors.get(expected.sessionId) ?? 0)
        ? expected
        : undefined
  }

  revoke(sessionKey: string, sessionId: string, epoch: number): void {
    if (!sessionId || !Number.isSafeInteger(epoch) || epoch < 0 || epoch >= Number.MAX_SAFE_INTEGER)
      throw new Error('Invalid permission revocation')
    const lifetime = this.session(sessionKey)
    lifetime.floors.set(sessionId, Math.max(lifetime.floors.get(sessionId) ?? 0, epoch + 1))
  }

  closeSession(key: string): void {
    this.session(key).closed = true
  }

  openSession(key: string): void {
    const previous = this.sessions.get(key)
    if (previous?.closed) this.sessions.delete(key)
  }

  close(): void {
    this.alive = false
    this.sessions.clear()
  }
}
