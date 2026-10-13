import { defaultProcessIdentity } from '@agnes/host-infrastructure/adapters/process-identity-default'
import { type ProcessLiveness, RuntimeGenerationSnapshotStore } from '@agnes/package-manager'

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
  return new RuntimeGenerationSnapshotStore(profileDirectory, { liveness: await createProcessLiveness() })
}
