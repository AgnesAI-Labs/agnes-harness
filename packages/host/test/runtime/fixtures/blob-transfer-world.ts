import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import type { AuthorityTransferControl, CallContext, Outcome } from '@agnes/extension-api/runtime'
import type * as Wire from '@agnes/protocol/runtime'
import type { TransferMaintenance } from '../../../src/runtime/authority-transfer.js'
import { blobError } from '../../../src/runtime/blob/uploads.js'
import { type BlobService, createBlobService } from '../../../src/runtime/providers/blob.js'
import { BLOB_BINDING, ctx, openServices, type Services } from './artifact-world.js'

/**
 * A default blob store moving to a candidate at another location, on persistent files under one
 * root: the source at `<root>/source`, the candidate at `<root>/target`. The test and the child it
 * kills open the same stores; the directory route both read is passed between them as a value. A
 * cohort adds the default artifacts service over each blob store, whose export lives in that store.
 */

export const START = Date.parse('2026-10-01T00:00:00.000Z')
export const UPGRADE = 'upgrade-1'
export const MAINTAINER = ctx({ authorizationRef: 'maintenance' })
/** Manifest parts an import has committed when a kill at a part boundary stops it. */
export const PARTS_KEPT = 4

export type Service = 'blob' | 'artifacts'
export type Step = 'fence' | 'export' | 'import' | 'verify' | 'activate' | 'abort'
export type Directory = { route?: Wire.AuthorityRoute }
/** The two stores of one service whose transfer steps a test takes. */
export type Sides = Readonly<Record<'source' | 'target', { transfer: AuthorityTransferControl }>>
export type World = Readonly<{ source: BlobService; target: BlobService; close(): void }>
export type Cohort = Readonly<{ source: Services; target: Services; close(): void }>

const unavailable = (message: string) => ({ ok: false as const, error: blobError('not_found', message) })

function maintenance(
  directory: Directory,
  locationRef: string,
  sourceBlobs: TransferMaintenance['sourceBlobs'] = {
    openRead: async () => unavailable('this store imports from no source'),
  },
): TransferMaintenance {
  return {
    authorize: (context) => context.authorizationRef === 'maintenance',
    tenantId: 'tenant-1',
    locationRef,
    // A world that aborts never activates its target.
    readRoute: async ({ logicalAuthorityId }) =>
      directory.route?.logicalAuthorityId === logicalAuthorityId
        ? { ok: true, value: { route: directory.route, targetActivated: false } }
        : unavailable('no published route'),
    sourceBlobs,
    planFingerprint: async () => ({ ok: true, value: 'f'.repeat(64) }),
  }
}

/** Opens the source, then the target that reads the source's bytes through its blob store. */
function openPair<T extends { close(): void }>(
  root: string,
  directory: Directory,
  open: (dataDir: string, assembly: TransferMaintenance, transferTarget: boolean) => T,
  lender: (source: T) => TransferMaintenance['sourceBlobs'],
): Readonly<{ source: T; target: T; close(): void }> {
  const at = (name: string) => {
    const dataDir = join(root, name)
    mkdirSync(dataDir, { recursive: true, mode: 0o700 })
    return dataDir
  }
  const source = open(at('source'), maintenance(directory, 'location-1'), false)
  try {
    const target = open(at('target'), maintenance(directory, 'location-2', lender(source)), true)
    return {
      source,
      target,
      close() {
        target.close()
        source.close()
      },
    }
  } catch (error) {
    source.close()
    throw error
  }
}

export function openWorld(root: string, directory: Directory): World {
  return openPair(
    root,
    directory,
    (dataDir, assembly, transferTarget) =>
      createBlobService({
        dataDir,
        authorityId: 'blob-authority',
        binding: BLOB_BINDING,
        now: () => START,
        authorizeRead: (context) => context.authorizationRef === 'auth-ok',
        maintenance: assembly,
        transferTarget,
      }),
    (source) => source.transferRead,
  )
}

/** Both services at each location, under the same maintenance assembly. */
export function openCohort(root: string, directory: Directory): Cohort {
  return openPair(
    root,
    directory,
    (dataDir, assembly, target) =>
      openServices(dataDir, { now: () => START, transfer: { maintenance: assembly, target } }),
    (source) => source.blob.transferRead,
  )
}

/** One service's stores of a cohort. */
export const sides = (cohort: Cohort, service: Service): Sides => ({
  source: cohort.source[service],
  target: cohort.target[service],
})

/** The source fences, exports and aborts; the target imports, verifies and activates. */
export function call(world: Sides, step: Step, request: unknown): Promise<Outcome<unknown>> {
  const side = step === 'fence' || step === 'export' || step === 'abort' ? world.source : world.target
  const method = side.transfer[step] as (request: unknown, context: CallContext) => Promise<Outcome<unknown>>
  return method(request, MAINTAINER)
}
