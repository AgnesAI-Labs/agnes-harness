import type { PluginGenerationStatus } from '@agnes/protocol'
import type { WorkerLink } from './worker-link.js'

/** Package inventory can decorate its verified rows with a live status, but cannot start a runtime. */
export async function readRunningGenerationStatus(
  pool: { businessWorker(): { link: Pick<WorkerLink, 'alive' | 'command'> } | undefined },
  timeoutMs: number,
): Promise<PluginGenerationStatus> {
  const worker = pool.businessWorker()?.link
  if (!worker?.alive) throw new Error('Plugin generation status is unavailable without a running worker')
  return (await worker.command('pluginGenerations.status', {}, { timeoutMs })) as PluginGenerationStatus
}
