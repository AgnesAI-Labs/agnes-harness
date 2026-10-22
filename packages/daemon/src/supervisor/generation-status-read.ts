import type { PluginGenerationStatus } from '@agnes/protocol'
import type { WorkerLink } from './worker-link.js'

/**
 * The package list is read while the worker may be busy applying a change. The live status only
 * decorates its rows, so waiting for a busy worker for the full startup budget would stall the whole
 * list (and the page that shows it) for as long as the change takes.
 */
export const GENERATION_STATUS_READ_MS = 3_000

/** Package inventory can decorate its verified rows with a live status, but cannot start a runtime. */
export async function readRunningGenerationStatus(
  pool: { businessWorker(): { link: Pick<WorkerLink, 'alive' | 'command'> } | undefined },
  timeoutMs: number,
): Promise<PluginGenerationStatus> {
  const worker = pool.businessWorker()?.link
  if (!worker?.alive) throw new Error('Plugin generation status is unavailable without a running worker')
  return (await worker.command(
    'pluginGenerations.status',
    {},
    {
      timeoutMs: Math.min(timeoutMs, GENERATION_STATUS_READ_MS),
    },
  )) as PluginGenerationStatus
}
