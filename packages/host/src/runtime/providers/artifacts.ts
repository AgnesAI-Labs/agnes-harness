import type {
  ArtifactAccessPort,
  CallContext,
  Outcome,
  ScopedDependencies,
} from '@agnes/extension-api/runtime'
import { jcs } from '@agnes/protocol'
import type * as Wire from '@agnes/protocol/runtime'
import { type ArtifactAccessOptions, createArtifactAccess } from '../artifacts/access.js'
import {
  type ArtifactEvent,
  ArtifactsRefusal,
  artifactsError,
  fail,
  grant,
  type OwnerAction,
  openArtifactsStore,
  parse,
  pendingEvents,
  publish,
  reserve,
  revoke,
  revokeGrant,
  type SelectedBlobActions,
} from '../artifacts/publication.js'
import { defaultServiceDescriptor, type ServiceDescriptorInput } from './blob.js'

export type { ArtifactAccessOptions } from '../artifacts/access.js'
export type { ArtifactEvent, OwnerAction, SelectedBlobActions } from '../artifacts/publication.js'

export const ARTIFACTS_CONTRACT = 'agh.artifacts'
export const ARTIFACTS_MAJOR = 1

/** Ticket downloads are refused without a ticket key, so only a configured key offers their feature. */
export function artifactsFeatures(options: Pick<ArtifactAccessOptions, 'ticketKey'>): string[] {
  return [
    'artifact-publication.v1',
    'artifact-access.v1',
    ...(options.ticketKey ? ['artifact-ticket.v1'] : []),
  ]
}

/** The fixed requirement on the selected blob service. */
export const BLOB_REQUIREMENT: Wire.ServiceRequirement = {
  contract: 'agh.blob',
  major: 1,
  logicalName: 'default',
  features: ['blob-read.v1'],
  scope: 'runtime',
  optional: false,
}

/** Every artifacts action returns its first result again for the same input. */
export function artifactsProviderDescriptor(
  input: ServiceDescriptorInput & Pick<ArtifactAccessOptions, 'ticketKey'>,
): Wire.ProviderDescriptor {
  return defaultServiceDescriptor(
    ARTIFACTS_CONTRACT,
    input,
    artifactsFeatures(input),
    [BLOB_REQUIREMENT],
    ['reserve', 'publish', 'fail', 'revoke', 'grant', 'revokeGrant'],
  )
}

export type ArtifactsServiceOptions = ArtifactAccessOptions &
  Readonly<{
    dataDir: string
    authorityId: Wire.Id
    dependencies: ScopedDependencies
    /** Action methods of the blob service the container selects; their binding must match it. */
    blobActions: SelectedBlobActions
    now?: () => number
  }>

type Owned = { request: unknown; owner: OwnerAction }

/** The default agh.artifacts service. Callers pass the committed owner facts the Host resolved. */
export type ArtifactsService = Readonly<{
  reserve(input: Owned, context: CallContext): Promise<Outcome<Wire.ArtifactReservation>>
  publish(input: Owned, context: CallContext): Promise<Outcome<Wire.ArtifactReservation>>
  fail(
    input: Owned & { receipt: Wire.ReceiptRef },
    context: CallContext,
  ): Promise<Outcome<Wire.ArtifactReservation>>
  revoke(request: unknown, context: CallContext): Promise<Outcome<Wire.ArtifactReservation>>
  grant(
    input: Owned & { sourceAuthorizationRef: Wire.Id },
    context: CallContext,
  ): Promise<Outcome<Wire.ArtifactAccessGrantValue>>
  revokeGrant(input: Owned, context: CallContext): Promise<Outcome<Wire.ArtifactAccessGrantValue>>
  query(request: unknown, context: CallContext): Promise<Outcome<Wire.ArtifactViewRef>>
  artifactAccess: ArtifactAccessPort
  pendingEvents(): readonly ArtifactEvent[]
  close(): void
}>

async function run<T>(context: CallContext, body: () => T | Promise<T>): Promise<Outcome<T>> {
  if (context.signal.aborted) return { ok: false, error: artifactsError('cancelled', 'call was cancelled') }
  try {
    return { ok: true, value: await body() }
  } catch (caught) {
    if (caught instanceof ArtifactsRefusal) return { ok: false, error: caught.error }
    return { ok: false, error: artifactsError('internal_error', 'artifacts service failed') }
  }
}

/**
 * Assembles the default artifacts service over the blob service the container selects. A selection
 * without a read port, or action methods from another binding, refuses assembly instead of falling
 * back to a local store.
 */
export function createArtifactsService(options: ArtifactsServiceOptions): Outcome<ArtifactsService> {
  const selected = options.dependencies.get(BLOB_REQUIREMENT)
  if (!selected.ok) return selected
  const blobRead = selected.value.blobRead
  if (!blobRead)
    return {
      ok: false,
      error: artifactsError('operation_not_supported', 'selected blob service has no read port'),
    }
  if (jcs(selected.value.binding) !== jcs(options.blobActions.binding))
    return {
      ok: false,
      error: artifactsError('blocked', 'blob actions do not belong to the selected blob service'),
    }
  const store = openArtifactsStore(options)
  const artifactAccess = createArtifactAccess(store, blobRead, options)
  return {
    ok: true,
    value: Object.freeze({
      reserve: (input, context) => run(context, () => reserve(store, input, context)),
      publish: (input, context) => run(context, () => publish(store, options.blobActions, input, context)),
      fail: (input, context) => run(context, () => fail(store, input)),
      revoke: (request, context) => run(context, () => revoke(store, request)),
      grant: (input, context) => run(context, () => grant(store, input, context)),
      revokeGrant: (input, context) => run(context, () => revokeGrant(store, input)),
      query: async (request, context) => {
        const parsed = await run(context, () => parse('ArtifactsQueryRequest', request))
        return parsed.ok ? artifactAccess.describe(parsed.value.artifactRef, context) : parsed
      },
      artifactAccess,
      pendingEvents: () => pendingEvents(store),
      close: () => store.close(),
    }),
  }
}
