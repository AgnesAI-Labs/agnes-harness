import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import type { CallContext, Outcome } from '@agnes/extension-api/runtime'
import type * as Wire from '@agnes/protocol/runtime'
import type { TransferMaintenance } from '../../../src/runtime/authority-transfer.js'
import { blobError } from '../../../src/runtime/blob/uploads.js'
import { type BlobService, createBlobService } from '../../../src/runtime/providers/blob.js'
import { BLOB_BINDING, ctx } from './artifact-world.js'

/**
 * A default blob store moving to a candidate at another location, on persistent files under one
 * root: the source at `<root>/source`, the candidate at `<root>/target`. The test and the child it
 * kills open the same stores; the directory route both read is passed between them as a value.
 */

export const START = Date.parse('2026-10-01T00:00:00.000Z')
export const UPGRADE = 'upgrade-1'
export const MAINTAINER = ctx({ authorizationRef: 'maintenance' })
/** Manifest parts an import has committed when a kill at a part boundary stops it. */
export const PARTS_KEPT = 4

export type Step = 'fence' | 'export' | 'import' | 'verify' | 'activate' | 'abort'
export type Directory = { route?: Wire.AuthorityRoute }
export type World = Readonly<{ source: BlobService; target: BlobService; close(): void }>

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

export function openWorld(root: string, directory: Directory): World {
  const open = (name: string, assembly: TransferMaintenance, transferTarget: boolean) => {
    const dataDir = join(root, name)
    mkdirSync(dataDir, { recursive: true, mode: 0o700 })
    return createBlobService({
      dataDir,
      authorityId: 'blob-authority',
      binding: BLOB_BINDING,
      now: () => START,
      authorizeRead: (context) => context.authorizationRef === 'auth-ok',
      maintenance: assembly,
      transferTarget,
    })
  }
  const source = open('source', maintenance(directory, 'location-1'), false)
  try {
    const target = open('target', maintenance(directory, 'location-2', source.transferRead), true)
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

/** The source fences, exports and aborts; the target imports, verifies and activates. */
export function call(world: World, step: Step, request: unknown): Promise<Outcome<unknown>> {
  const side = step === 'fence' || step === 'export' || step === 'abort' ? world.source : world.target
  const method = side.transfer[step] as (request: unknown, context: CallContext) => Promise<Outcome<unknown>>
  return method(request, MAINTAINER)
}
