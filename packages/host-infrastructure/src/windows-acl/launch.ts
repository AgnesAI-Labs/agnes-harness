import { sealWindowsConfinement, type WindowsConfinement } from '@agnes/system-node/process-spawn'
import { claimWindowsLaunchPermit, type WindowsAclLaunchPermit } from './leases.js'

/** One redeemed launch permit: the sealed confinement and the settlement of its process. */
export type WindowsLaunch = Readonly<{
  confinement: WindowsConfinement
  /** TEMP and TMP of the lease's private temp; applied after the caller's environment. */
  env: Readonly<Record<string, string>>
  /** The restricted process was created; the lease keeps its temp until it exits. */
  started(exited: PromiseLike<unknown>): void
  /** No process was created; the permit is settled and the lease may close. */
  abandoned(): void
}>

/**
 * Redeems a permit right before the restricted launch. A permit that cannot be redeemed throws
 * before anything starts; one whose confinement cannot be sealed is settled as abandoned.
 */
export function windowsLaunch(permit: WindowsAclLaunchPermit): WindowsLaunch {
  const claim = claimWindowsLaunchPermit(permit)
  let confinement: WindowsConfinement
  try {
    confinement = sealWindowsConfinement({
      mode: claim.mode,
      root: claim.root,
      writeSids: [...claim.writeSids],
      ...(claim.tempRoot === undefined ? {} : { tempRoot: claim.tempRoot }),
    })
  } catch (error) {
    claim.abandoned()
    throw error
  }
  let settled = false
  const settle = (action: () => void) => {
    if (settled) return
    settled = true
    action()
  }
  return Object.freeze({
    confinement,
    env: Object.freeze(claim.tempRoot === undefined ? {} : { TEMP: claim.tempRoot, TMP: claim.tempRoot }),
    started: (exited: PromiseLike<unknown>) => settle(() => claim.started(exited)),
    abandoned: () => settle(() => claim.abandoned()),
  })
}

/** Settles a permit that reached a path which cannot apply it; that path then refuses the launch. */
export function abandonWindowsLaunch(permit: WindowsAclLaunchPermit): void {
  try {
    claimWindowsLaunchPermit(permit).abandoned()
  } catch {
    // A permit that cannot be redeemed was never usable; the refusal stands either way.
  }
}
