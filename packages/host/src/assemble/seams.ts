import type { SeamImplementations, SeamName } from '@agnes/core'
import type { PlatformBackend } from '../adapters/platform.js'
import { HostError } from '../errors.js'
import type { Rollback } from '../lifecycle.js'
import type { ResolvedProfile } from '../profile/types.js'
import type { PackageModule, SeamInitContext } from './packages.js'

/**
 * Initialize the two build-time seams. Platform is Host-owned and sandbox remains selected when
 * the worker is assembled; the other eight seams are ordinary Cordis rows.
 *
 * `contextFor` answers the context plus a cleanup: the sandbox factory alone is handed a probe
 * exec and the path-policy service, and the probe is revoked the moment its factory settles -
 * inside the window it detects backends, outside it the handle is a refusal, not a kept raw
 * spawner.
 */
export async function initStaticSeams(
  profile: ResolvedProfile,
  modules: Map<string, PackageModule>,
  contextFor: (owner: string, seamName: SeamName) => { context: SeamInitContext; cleanup(): void },
  opts: { timeoutMs: number; platform: PlatformBackend; rollback: Rollback },
): Promise<Pick<SeamImplementations, 'sandbox' | 'platform'>> {
  const name = 'sandbox' as const
  const pkgId = profile.seams[name]
  const factory = modules.get(pkgId)?.seams?.[name]
  const failed = (reason: string, why: string): HostError =>
    new HostError('E_SEAM_INIT', `seam ${name} ${why}`, { detail: { seam: name, reason } })
  if (!factory)
    throw new HostError('E_SEAM_EXPORT_MISSING', `${pkgId} exports no factory for seam ${name}`, {
      detail: { seam: name, package: pkgId },
    })
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(failed('timeout', `timed out after ${opts.timeoutMs} ms`)),
      opts.timeoutMs,
    )
  })
  const { context, cleanup } = contextFor(pkgId, name)
  try {
    const value: unknown = await Promise.race([factory(context), timeout])
    if (typeof value !== 'object' || value === null) throw failed('shape', 'factory returned a non-object')
    const sandbox = value as SeamImplementations['sandbox'] & { close?: () => Promise<void> | void }
    if (typeof sandbox.close === 'function') opts.rollback.push('seam:sandbox', sandbox.close.bind(sandbox))
    return Object.freeze({ sandbox, platform: opts.platform })
  } catch (error) {
    if (error instanceof HostError) throw error
    throw failed('reject', `factory failed: ${error instanceof Error ? error.message : String(error)}`)
  } finally {
    clearTimeout(timer)
    cleanup()
  }
}
