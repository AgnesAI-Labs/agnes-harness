import { statSync } from 'node:fs'
import { dirname } from 'node:path'
import { defaultProcessIdentity } from '@agnes/host-infrastructure/adapters/process-identity-default'
import {
  type GenerationReuseInputs,
  type PluginGenerationSnapshot,
  type ProcessLiveness,
  RuntimeGenerationSnapshotStore,
} from '@agnes/package-manager'
import { mkdirDurablySync } from '@agnes/system-node'

/**
 * The generations each open generation Host in this process runs. A publication never reuses one of
 * them: two containers with one generation identity would each count the other's session pins as
 * bound to itself, and fork where it would have published in place.
 */
const runningInProcess = new Set<ReadonlyMap<string, unknown>>()

/** Counts the generations of one generation Host as running until the returned release is called. */
export function trackRunningGenerations(generations: ReadonlyMap<string, unknown>): () => void {
  runningInProcess.add(generations)
  return () => void runningInProcess.delete(generations)
}

/**
 * A recorded generation a new snapshot from `expected` can take over. Workers of one composition share
 * a recorded head instead of each snapshotting the same target. A publication (`identical`) takes a
 * generation recorded from the same inputs that no Host in this process runs and the caller never saw
 * fail.
 */
export function reusableSnapshot(
  store: RuntimeGenerationSnapshotStore,
  compositionKey: string,
  expected: GenerationReuseInputs,
  reuse: boolean | 'identical',
  failed: Iterable<string>,
): PluginGenerationSnapshot | undefined {
  if (reuse !== 'identical') return reuse ? store.reusableHead(compositionKey, expected) : undefined
  const running = [...runningInProcess].flatMap((generations) => [...generations.keys()])
  return store.reusableGeneration(compositionKey, expected, new Set([...running, ...failed]))
}

/**
 * This process's start identity, so generation holders are recognised by pid and start together.
 * Where the platform cannot identify processes, undefined: the store then compares bare pids, which
 * only ever keeps a generation longer.
 */
async function createProcessLiveness(): Promise<ProcessLiveness | undefined> {
  const self = await defaultProcessIdentity(process.pid)
  if (self.state !== 'alive') return undefined
  return {
    startId: self.startId,
    async isRunning(pid, startId) {
      const identity = await defaultProcessIdentity(pid)
      return identity.state === 'dead' ? false : identity.state === 'unknown' || identity.startId === startId
    },
  }
}

/** The generation store of one profile, identifying this worker by pid and process start. */
export async function openGenerationStore(profileDirectory: string): Promise<RuntimeGenerationSnapshotStore> {
  // Bootstrap a fresh profile's parent before the store anchors to it. Later store operations still
  // refuse a removed anchor; they must never recreate a directory a live store was already using.
  const parent = dirname(profileDirectory)
  let anchor = dirname(parent)
  for (;;) {
    try {
      statSync(anchor)
      break
    } catch (error) {
      const next = dirname(anchor)
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || next === anchor) throw error
      anchor = next
    }
  }
  mkdirDurablySync(parent, anchor)
  return new RuntimeGenerationSnapshotStore(profileDirectory, { liveness: await createProcessLiveness() })
}
