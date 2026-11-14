import { existsSync } from 'node:fs'
import type { ProfileActivations } from '@agnes/host-extensions/profile/activation'
import { capabilityHash, lockPath, readLock } from '@agnes/package-manager'

/** Current profile authority is independent of a session's retained executable generation. */
export function createSessionWorkAuthority(input: {
  activations: ProfileActivations
  owner: string
  packageId: string
  integrity: string
  mountIdentity: string
  profileDir: string
  profile: string
  agnesVersion: string
}) {
  const controller = new AbortController()
  let epoch: string | undefined
  const current = () => {
    if (controller.signal.aborted) return false
    try {
      if (existsSync(lockPath(input.profileDir))) {
        const entry = readLock(input.profileDir, { profile: input.profile, agnesVersion: input.agnesVersion })
          .packages[input.packageId]
        if (
          !entry?.state.enabled ||
          entry.state.trusted === null ||
          entry.integrity !== input.integrity ||
          entry.trustDecision?.integrity !== entry.integrity ||
          entry.trustDecision.capabilityHash !== capabilityHash(entry)
        )
          return false
      }
      epoch = input.activations.require(
        `session-work:${input.owner}`,
        input.integrity,
        epoch,
        input.mountIdentity,
      )
      return true
    } catch {
      return false
    }
  }
  const check = () => {
    const allowed = current()
    if (!allowed) controller.abort()
    return allowed
  }
  // Candidate rows register before publication. Bind their epoch only once that exact code is current.
  current()
  const off = input.activations.subscribe(() => {
    if (epoch === undefined) current()
    else check()
  })
  return {
    check,
    signal: controller.signal,
    dispose() {
      off()
      controller.abort()
    },
  }
}
