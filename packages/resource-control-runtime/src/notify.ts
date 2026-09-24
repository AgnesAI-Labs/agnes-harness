/**
 * Cross-worker notification for resource live reload. Deliberately kept separate from mcp.ts/skills.ts: the daemon
 * is the only process that ever has a real `pool` to enumerate (see this function's own doc comment
 * below for why), so this file exports a small, independently testable piece rather than baking pool
 * access into either resource kind's own module.
 */

/** The minimal shape this package needs from the daemon's WorkerPool: enumerate currently-live,
 *  non-resource-lifecycle worker connections. A structural type (not an import of `@agnes/daemon`) --
 *  this package is a dependency of the daemon, never the other way around. */
export type ActivationLinkPool = Readonly<{
  activationLinks(): readonly Readonly<{
    sessionKey: string
    generation: number
    link: Readonly<{
      command(method: string, params: Record<string, unknown>, o?: { timeoutMs?: number }): Promise<unknown>
    }>
  }>[]
}>

// A no-payload command over an already-open socket to a worker that is, by construction, already
// alive (activationLinks() only returns live links) -- there is no real work on the other end beyond
// setting one in-memory flag (worker-runtime/src/commands.ts's `case 'resource.stale':`), so a
// generous timeout would only delay noticing a genuinely wedged worker. 2s leaves ample margin over
// realistic local IPC latency while still failing fast.
const RESOURCE_STALE_NOTIFY_TIMEOUT_MS = 2_000

/**
 * Tells every currently-live, non-resource-lifecycle session/service worker on this profile that its
 * MCP/Skills resource snapshot is stale and should be refreshed before its next turn. This is the
 * production implementation the resource-live-reload plan's `apply`/`activate` callbacks were meant
 * to become (see resource-control-runtime/src/mcp.ts's `McpApply` and skills.ts's `activate`) -- but
 * see packages/resource-control-worker/src/runtime-bootstrap.ts's own comment on why those two
 * callbacks stay no-ops in production and this function is instead wired directly into the daemon's
 * own resource-control success hook (packages/daemon/src/supervisor/supervisor.ts).
 *
 * A worker that fails to acknowledge the notice is logged and skipped, never thrown: one unreachable
 * or slow worker must not fail the resource-control operation that triggered this notification, and
 * must not block the notice from reaching every other live worker. A worker that misses the notice
 * entirely (crashed, or the notify raced its own startup) simply keeps its previous resource
 * generation until its own next reload/restart -- no different from any other missed live-update.
 *
 * Returns the session keys whose notification did *not* deliver (empty when every live worker
 * acknowledged). resource-live-reload Task 7: the daemon's wiring
 * (packages/daemon/src/supervisor/supervisor.ts's `wireResourceSnapshotNotifications`) uses this list
 * to fall back to killing/respawning only those specific sessions, instead of unconditionally retiring
 * every live session regardless of whether its lightweight notice actually got through.
 */
export async function notifyLiveSessionWorkers(
  pool: ActivationLinkPool,
  log?: Pick<Console, 'warn'>,
): Promise<readonly string[]> {
  const failedSessionKeys: string[] = []
  for (const target of pool.activationLinks()) {
    await target.link
      .command('resource.stale', {}, { timeoutMs: RESOURCE_STALE_NOTIFY_TIMEOUT_MS })
      .catch((error: unknown) => {
        failedSessionKeys.push(target.sessionKey)
        log?.warn?.('failed to notify a session worker of a stale resource snapshot', {
          sessionKey: target.sessionKey,
          generation: target.generation,
          error,
        })
      })
  }
  return failedSessionKeys
}
