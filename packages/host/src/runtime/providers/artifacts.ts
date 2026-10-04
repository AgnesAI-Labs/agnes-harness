import type {
  ArtifactAccessPort,
  AuthorityTransferControl,
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
  type BlobTransfer,
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
import type { TransferMaintenance } from '../authority-transfer.js'
import { BlobRefusal } from '../blob/uploads.js'
import { defaultServiceDescriptor, type ServiceDescriptorInput, TRANSFER_STEPS } from './blob.js'

export type { ArtifactAccessOptions } from '../artifacts/access.js'
export type {
  ArtifactEvent,
  BlobTransfer,
  OwnerAction,
  SelectedBlobActions,
} from '../artifacts/publication.js'

export const ARTIFACTS_CONTRACT = 'agh.artifacts'
export const ARTIFACTS_MAJOR = 1

type Offered = Pick<ArtifactsServiceOptions, 'ticketKeys' | 'maintenance' | 'blobTransfer'>

/**
 * Ticket downloads are refused without a ticket key broker, so only a supplied one offers their feature.
 * A transfer needs the maintenance assembly and the selected default blob service's transfer entry,
 * which holds this store's export.
 */
export function artifactsFeatures(options: Offered): string[] {
  return [
    'artifact-publication.v1',
    'artifact-access.v1',
    ...(options.ticketKeys ? ['artifact-ticket.v1'] : []),
    ...(options.maintenance && options.blobTransfer ? ['authority-transfer.v1'] : []),
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

/** Every artifacts action and transfer step returns its first result again for the same input. */
export function artifactsProviderDescriptor(
  input: ServiceDescriptorInput & Offered,
): Wire.ProviderDescriptor {
  return defaultServiceDescriptor(
    ARTIFACTS_CONTRACT,
    input,
    artifactsFeatures(input),
    [BLOB_REQUIREMENT],
    ['reserve', 'publish', 'fail', 'revoke', 'grant', 'revokeGrant', ...TRANSFER_STEPS],
    ['authorityProbe'],
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
    /** The Host's maintenance assembly. Without it, every transfer call is refused as not supported. */
    maintenance?: TransferMaintenance
    /**
     * The transfer entry of the selected blob service, which only the default blob service has. Without
     * it, export, import, verify and activate are refused as not supported.
     */
    blobTransfer?: BlobTransfer
    /** Opens a new store at a transfer target, refusing business writes until a transfer activates it. */
    transferTarget?: boolean
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
  /** Both sides of an authority transfer; offered only with maintenance and the blob transfer entry. */
  transfer: AuthorityTransferControl
  close(): void
}>

async function run<T>(context: CallContext, body: () => T | Promise<T>): Promise<Outcome<T>> {
  if (context.signal.aborted) return { ok: false, error: artifactsError('cancelled', 'call was cancelled') }
  try {
    return { ok: true, value: await body() }
  } catch (caught) {
    // A transfer step that writes through the selected blob service keeps that service's refusal.
    if (caught instanceof ArtifactsRefusal || caught instanceof BlobRefusal)
      return { ok: false, error: caught.error }
    return { ok: false, error: artifactsError('internal_error', 'artifacts service failed') }
  }
}

/**
 * Assembles the default artifacts service over the blob service the container selects. A selection
 * without a read port, or action methods or a transfer entry from another binding, refuses assembly
 * instead of falling back to a local store.
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
  const ports = [options.blobActions, options.blobTransfer]
  if (ports.some((port) => port && jcs(port.binding) !== jcs(selected.value.binding)))
    return {
      ok: false,
      error: artifactsError('blocked', 'blob ports do not belong to the selected blob service'),
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
      transfer: {
        fence: (request, context) => run(context, () => store.fence(request, context)),
        export: (request, context) => run(context, () => store.export(request, context)),
        exportPage: (request, context) => run(context, () => store.exportPage(request, context)),
        import: (request, context) => run(context, () => store.import(request, context)),
        verify: (request, context) => run(context, () => store.verify(request, context)),
        activate: (request, context) => run(context, () => store.activate(request, context)),
        abort: (request, context) => run(context, () => store.abort(request, context)),
        probe: (request, context) => run(context, () => store.probe(request, context)),
      },
      close: () => store.close(),
    }),
  }
}
