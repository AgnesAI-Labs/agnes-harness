import { type ActivationLinkPool, notifyLiveSessionWorkers } from '@agnes/resource-control-runtime'

/**
 * Wires the daemon's one hook for "a resource-control mutation durably committed"
 * (`ResourceControlStore.setSuccessfulSnapshotHandler`, called only after a successful effect's
 * latest worker snapshot and terminal operation commit - resource-control-store/src/control-store.ts)
 * to a lightweight in-place notice, with a narrow heavyweight fallback:
 *  - `notifyLiveSessionWorkers` (@agnes/resource-control-runtime): tells every still-alive
 *    session/service worker (excluding the resource-lifecycle worker itself - see
 *    WorkerPool.activationLinks()) to refresh its own MCP/Skills snapshot before its next turn,
 *    in-process, without being killed. Fire-and-forget from this handler's own caller (the store) never waits on it. Resolves
 *    with the session keys whose notice did *not* deliver.
 *  - `registry.noteResourceSnapshotCommitted()`: called on every commit, synchronously and
 *    unconditionally, to advance the registry's resource epoch. That epoch fences out a worker caught
 *    mid-`acquire()` by this commit (registry.ts's `openFresh`) - a worker with no activation link
 *    yet, which therefore appears in neither the delivered nor the failed list below and cannot be
 *    covered by any retirement decision. Keeping the bump here, rather than as a side effect of
 *    retiring somebody, is what decouples "a snapshot changed" from "some session needs replacing".
 *  - `registry.retireSessions(failedKeys, 'resource-notify-failed')`: called only for those failed
 *    keys, as the fallback for a session the lightweight notice could not reach. A session whose
 *    notice delivered successfully is left alone: unconditionally retiring it too provides no
 *    coverage the lightweight path lacks and only pays an
 *    unnecessary process kill/respawn + MCP reconnect cost. `retireForResourceSnapshot()` itself is
 *    unchanged and still available as a general "retire every live session" capability; this handler
 *    simply no longer calls it.
 *
 * Resource-control-runtime's manager-level `apply`/`activate` callbacks cannot send this notice: `apply` runs
 * inside whichever worker process is bootstrapping (packages/resource-control-worker/src/
 * runtime-bootstrap.ts), including the resource-lifecycle worker itself, with no in-memory reference
 * to this daemon's WorkerPool. This function is the real "a resource actually changed" chokepoint that
 * *does* have one.
 *
 * Exported standalone (not inlined into `startSupervisor`) so this wiring is directly testable without
 * booting a full supervisor - see daemon/test/resource-snapshot-notify.test.ts.
 */
export function wireResourceSnapshotNotifications(o: {
  localResourceStore: {
    setSuccessfulSnapshotHandler(
      handler: (profile: string, change?: { skillControlRevision: string }) => void,
    ): void
  }
  registry: {
    noteResourceSnapshotCommitted(): void
    retireSessions(keys: readonly string[], reason: string): void
  }
  pool: ActivationLinkPool
  log?: Pick<Console, 'warn'>
}): void {
  o.localResourceStore.setSuccessfulSnapshotHandler((_profile, change) => {
    // Synchronously, before any notice goes out and regardless of how that notice fares: this is a
    // global fence, not a per-session outcome. A worker that is mid-`acquire()` right now has already
    // read the superseded snapshot and is in no notification list at all, so the bump has to happen at
    // the commit itself - and as early as possible, since any worker that reaches hello between the
    // commit and the bump would otherwise pass the fence holding old resources.
    o.registry.noteResourceSnapshotCommitted()
    void notifyLiveSessionWorkers(o.pool, o.log, change).then((failedKeys) => {
      if (failedKeys.length > 0) o.registry.retireSessions(failedKeys, 'resource-notify-failed')
    })
  })
}
