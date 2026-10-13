import { statSync } from 'node:fs'
import { dirname } from 'node:path'
import { defaultProcessIdentity } from '@agnes/host-infrastructure/adapters/process-identity-default'
import { type ProcessLiveness, RuntimeGenerationSnapshotStore } from '@agnes/package-manager'
import { mkdirDurablySync } from '@agnes/system-node'

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
