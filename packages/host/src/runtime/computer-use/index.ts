import { lstatSync } from 'node:fs'
import { join } from 'node:path'
import type { HostToolDispatchPort } from '@agnes/core'
import type { AttachmentRootSnapshot, Logger } from '@agnes/extension-api'
import {
  type ComputerUseArtifactGcRuntime,
  createComputerUseArtifactGcRuntime,
} from '@agnes/host-artifacts/computer-use-artifact-gc'
import { createStoredObjectGc } from '@agnes/host-artifacts/object-gc'
import { createPrivateArtifactStore } from '@agnes/host-artifacts/private-artifact-store'
import type { ResolvedProfile } from '@agnes/host-common/profile/types'
import { createComputerUseHostDispatchPort } from '@agnes/host-computer-use/computer-use/host-dispatch'
import { createLazyComputerUseRuntime } from '@agnes/host-computer-use/computer-use/lazy-runtime'
import type { HostComputerUseStatusSource } from '@agnes/host-computer-use/computer-use/status'
import type { ComputerUseBackendProvider } from '@agnes/host-computer-use/computer-use/windows-driver-backend'
import type { SeamInitContext } from '@agnes/host-extensions/assemble/packages'
import type { HostCapabilityGrant } from '@agnes/package-manager'
import { privateArtifactDeleteAvailable } from '@agnes/system-node'
import type { Rollback } from '../lifecycle/lifecycle.js'
import type { ComputerUseArtifactSink, ComputerUsePlatform } from './platform.js'
import { computerUsePlatformAdmitted, initializeComputerUse } from './runtime.js'

/**
 * Computer Use, as the Host wires it: the one module that knows how to install a driver, collect
 * its screenshots and hand a provider to the Kernel and to the extension rows that hold the
 * grant. `assemble()` calls `inspectComputerUseArtifacts` while it builds seam contexts and
 * `mountComputerUse` once the seams exist; nothing else in the assembly names an OS backend.
 *
 * Scope: host lifetime. Nothing here is per session or per tree, but each assembly (each
 * generation container) still mounts its own copy today.
 */

type HostPlatform = Readonly<{ os: string; snapshot(): { arch: string } }>

/** Where Computer Use leaves private screenshot artifacts, and whether they still need collecting. */
export type ComputerUseArtifactRetention = Readonly<{
  /** True when the feature is on or screenshots have ever been written, so the writer and collector are kept. */
  required: boolean
  contextFor(
    grant: HostCapabilityGrant,
  ): Pick<SeamInitContext, 'privateArtifactStore'> | Record<string, never>
  /** Starts the screenshot collector on a platform whose private artifact delete is enforced. */
  startCollector(
    pendingAttachments?: () => Promise<AttachmentRootSnapshot>,
  ): ComputerUseArtifactGcRuntime | undefined
}>

const retentionPlatform = (
  platform: HostPlatform,
  nativePlatform: string,
): ComputerUsePlatform | undefined =>
  (platform.os === 'win32' || platform.os === 'darwin' || platform.os === 'linux') &&
  platform.os === nativePlatform &&
  privateArtifactDeleteAvailable()
    ? platform.os
    : undefined

/** Private CAS publication and collection share one lock, including installations without Computer Use. */
export function inspectComputerUseArtifacts(input: {
  profile: Pick<ResolvedProfile, 'computerUse'>
  dataDir: string
  platform: HostPlatform
  nativePlatform: string
  clock: () => number
  log: Logger
}): ComputerUseArtifactRetention & { metadataPresent: boolean } {
  const { profile, dataDir, platform, nativePlatform } = input
  let metadataPresent = false
  try {
    lstatSync(join(dataDir, 'artifacts', 'computer-use-meta'))
    metadataPresent = true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  const required = profile.computerUse.enabled || metadataPresent
  let collector: ComputerUseArtifactGcRuntime | undefined
  return {
    required,
    metadataPresent,
    contextFor: (grant) => {
      const os = retentionPlatform(platform, nativePlatform)
      return grant.privateArtifactStore && os
        ? { privateArtifactStore: createPrivateArtifactStore(dataDir, os) }
        : {}
    },
    startCollector: (pendingAttachments) => {
      if (!collector && retentionPlatform(platform, nativePlatform)) {
        const objectGc = createStoredObjectGc({
          dataDir,
          ...(pendingAttachments ? { pendingRoots: pendingAttachments } : {}),
          onError: (error) =>
            input.log.error('Artifact object GC failed closed', {
              message: error instanceof Error ? error.message : String(error),
            }),
        })
        const computerUseGc = createComputerUseArtifactGcRuntime({
          dataDir,
          retention: profile.computerUse.retention,
          ...(pendingAttachments ? { pendingAttachments } : {}),
          clock: input.clock,
          onError: (error) =>
            input.log.error('Computer Use artifact GC failed closed', {
              message: error instanceof Error ? error.message : String(error),
            }),
          onPressure: (pressure) =>
            input.log.warn('Computer Use artifact storage is above its cap', pressure),
        })
        collector = {
          trigger: async () => {
            await objectGc.trigger()
            return computerUseGc.trigger()
          },
          close: async () => {
            await objectGc.close()
            await computerUseGc.close()
          },
        }
      }
      return collector
    },
  }
}

export type ComputerUseHost = Readonly<{
  /** The provider sessions acquire from; absent when the profile does not enable Computer Use. */
  backend: ComputerUseBackendProvider | undefined
  status: HostComputerUseStatusSource
  /** The Kernel's dispatch port for Computer Use tool calls; absent exactly when `backend` is. */
  hostToolDispatch: HostToolDispatchPort | undefined
  /** Seam-context fields for an extension row that holds the Computer Use grant, or none. */
  extensionContext(grant: HostCapabilityGrant): Partial<SeamInitContext>
  /** The live collector, once one has been started. */
  artifactGc(): ComputerUseArtifactGcRuntime | undefined
}>

/** Mounts the lazy runtime. The driver is installed on first use; until then only the artifact collector may run. */
export function mountComputerUse(input: {
  profile: Pick<ResolvedProfile, 'computerUse' | 'hash'>
  dataDir: string
  platform: HostPlatform
  retention: ComputerUseArtifactRetention & { metadataPresent: boolean }
  artifacts: ComputerUseArtifactSink
  pendingAttachments?: () => Promise<AttachmentRootSnapshot>
  rollback: Rollback
}): ComputerUseHost {
  const { profile, retention } = input
  let collector: ComputerUseArtifactGcRuntime | undefined
  const startCollector = (): void => {
    collector = retention.startCollector(input.pendingAttachments)
  }
  // Stored originals and old screenshots retain their collectors independently of driver activation.
  if (retention.metadataPresent || input.pendingAttachments) startCollector()
  input.rollback.push('computer-use-artifact-gc', () => collector?.close())
  const lazy = createLazyComputerUseRuntime({
    ...(!profile.computerUse.enabled
      ? { unavailable: 'feature-disabled' as const }
      : !computerUsePlatformAdmitted(input.platform)
        ? { unavailable: 'platform-unsupported' as const }
        : {}),
    initialize: (signal) =>
      initializeComputerUse(
        {
          profile,
          dataDir: input.dataDir,
          platform: input.platform,
          artifacts: input.artifacts,
          startArtifactGc: startCollector,
        },
        signal,
      ),
  })
  const backend = profile.computerUse.enabled ? lazy.backend : undefined
  input.rollback.push('computer-use', () => lazy.dispose())
  return {
    backend,
    status: lazy.controls,
    hostToolDispatch: backend ? createComputerUseHostDispatchPort() : undefined,
    artifactGc: () => collector,
    extensionContext: (grant) =>
      grant.computerUse && backend
        ? {
            // Extension unload calls provider.dispose(). The lazy runtime's dispose closes the
            // host-lifetime driver, so a row reload would make later sessions fail closed.
            computerUseBackendProvider: {
              acquire: (...args) => backend.acquire(...args),
              release: (...args) => backend.release(...args),
              setPermissionMode: (...args) => backend.setPermissionMode(...args),
              status: () => backend.status(),
              dispose: async () => undefined,
            },
            computerUseOptions: {
              captureAfterMode: 'som' as const,
              autoCaptureAfterActions: true,
              maxImageDimension: profile.computerUse.capture.maxImageDimension,
              maxBytesPerImage: profile.computerUse.capture.maxBytesPerImage,
              maxCapturesPerHour: profile.computerUse.capture.maxCapturesPerHour,
              maxRecentPerSession: profile.computerUse.retention.maxRecentPerSession,
            },
          }
        : {},
  }
}
