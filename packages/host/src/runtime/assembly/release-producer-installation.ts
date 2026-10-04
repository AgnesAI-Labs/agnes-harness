import { createHash } from 'node:crypto'
import type { CallContext, ProviderFactory, ProviderLifecycle } from '@agnes/extension-api/runtime'
import { jcs } from '@agnes/protocol'
import type {
  BindingRef,
  MaintenanceStoreCommitRequest,
  MaintenanceStoreCommitResult,
  PackageSourceFetchResult,
  PackageSourceResolveMetadataResult,
  ScopeRef,
} from '@agnes/protocol/runtime'
import { maintenanceOutcome } from './maintenance-journal.js'
import { equal, freeze, readWire, requireRelease } from './primitives.js'
import {
  createReleaseProducer,
  publicationRequest,
  type ReleaseProducerCommitPort,
} from './release-producer.js'
import { captureReleaseProducerContents } from './release-producer-contents.js'
import {
  captureResolvedProducerSource,
  type ReleaseProducerFacts,
  readProducerDeployment,
  releaseResolvedProducerSource,
  resolveProducerSource,
} from './release-producer-source.js'

declare const installationBrand: unique symbol
declare const occurrenceBrand: unique symbol
export interface ReleaseProducerInstallation {
  readonly [installationBrand]: never
}
export interface ReleaseProducerOccurrence {
  readonly [occurrenceBrand]: never
}

/** Injection ABI only. The original native installer must supply and authenticate this issuer. */
export interface InstalledPublicationIssuer {
  prepare(
    originalRequest: MaintenanceStoreCommitRequest,
    originalContext: CallContext,
    originalProducerOccurrence: ReleaseProducerOccurrence,
  ): unknown
  acceptOriginalReceipt(originalResult: MaintenanceStoreCommitResult, originalContext: CallContext): unknown
}
interface Selection {
  readonly deploymentDirectory: string
  readonly originalFactory: ProviderFactory<ProviderLifecycle>
  readonly originalBinding: BindingRef
  readonly originalScope: ScopeRef
  readonly originalContext: CallContext
  readonly originalVerifiedPackage: Readonly<{
    metadata: PackageSourceResolveMetadataResult
    snapshot: PackageSourceFetchResult
    code: Uint8Array
  }>
  /** Original C14 capture object, authenticated by the native installer, never a boolean claim. */
  readonly originalContextEvidence: object
  readonly identityExpiresAt: string
  readonly port: ReleaseProducerCommitPort
}
type Capture = ReturnType<typeof captureReleaseProducerContents>
const installations = new WeakMap<
  ReleaseProducerInstallation,
  {
    selection: Selection
    factoryCreate: ProviderFactory<ProviderLifecycle>['create']
    descriptorJson: string
    fixedContext: object
    fixedContextJson: string
    packageJson: string
    codeDigest: string
    bindingJson: string
    scopeJson: string
    occurrenceIssued: boolean
    methods: { object: object; key: string; value: unknown }[]
    facts: ReleaseProducerFacts
    handedOff: boolean
    closed: boolean
  }
>()
const installedHandles = new WeakSet<InstalledReleaseProducer>()
const occurrences = new WeakMap<
  ReleaseProducerOccurrence,
  {
    installation: ReleaseProducerInstallation
    request: MaintenanceStoreCommitRequest
    context: CallContext
    captured: Capture
    used: boolean
  }
>()
export interface InstalledReleaseProducer {
  readonly installation: ReleaseProducerInstallation
  readonly issuer: InstalledPublicationIssuer
  readonly identityExpiresAt: string
  readonly initialFacts: ReleaseProducerFacts
  readonly initialContext: CallContext
  prepareOriginal(): {
    request: MaintenanceStoreCommitRequest
    captured: Capture
    occurrence: ReleaseProducerOccurrence
    prepared: unknown
  }
}

function contextSlots(context: CallContext) {
  const slots: Record<string, unknown> = {}
  for (const key of [
    'principalRef',
    'scope',
    'bindingId',
    'invocationId',
    'deadline',
    'traceRef',
    'authorizationRef',
    'signal',
  ]) {
    const descriptor = Object.getOwnPropertyDescriptor(context, key)
    requireRelease(
      descriptor && Object.hasOwn(descriptor, 'value'),
      'producer_context_mismatch',
      '/publication/context',
    )
    slots[key] = descriptor.value
  }
  readWire('CallContextWire', Object.fromEntries(Object.entries(slots).filter(([key]) => key !== 'signal')))
  return Object.freeze(slots)
}
function ownValue(object: object, key: string): unknown {
  const slot = Object.getOwnPropertyDescriptor(object, key)
  requireRelease(slot && Object.hasOwn(slot, 'value'), 'producer_original_slot_changed', '/publication/slots')
  return slot.value
}
const codeDigest = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')
function contextJson(context: CallContext): string {
  const slots = contextSlots(context)
  return jcs(
    readWire(
      'CallContextWire',
      Object.fromEntries(Object.entries(slots).filter(([key]) => key !== 'signal')),
    ),
  )
}
export function assertOriginalInstalledReleaseProducer(installed: InstalledReleaseProducer): void {
  requireRelease(
    installedHandles.has(installed),
    'producer_installation_missing',
    '/publication/installation',
  )
  originalInstallation(installed.installation)
}

function originalInstallation(installation: ReleaseProducerInstallation) {
  const original = installations.get(installation)
  requireRelease(original && !original.closed, 'producer_installation_missing', '/publication/installation')
  const { selection } = original
  requireRelease(
    ownValue(selection.originalFactory, 'create') === original.factoryCreate &&
      JSON.stringify(ownValue(selection.originalFactory, 'descriptor')) === original.descriptorJson,
    'producer_factory_changed',
    '/publication/factory',
  )
  requireRelease(
    contextJson(selection.originalContext) === original.fixedContextJson &&
      jcs(selection.originalBinding) === original.bindingJson &&
      jcs(selection.originalScope) === original.scopeJson &&
      jcs([selection.originalVerifiedPackage.metadata, selection.originalVerifiedPackage.snapshot]) ===
        original.packageJson &&
      codeDigest(selection.originalVerifiedPackage.code) === original.codeDigest &&
      original.methods.every((row) => ownValue(row.object, row.key) === row.value),
    'producer_original_selection_mismatch',
    '/publication/installation',
  )
  const current = contextSlots(selection.originalContext)
  requireRelease(
    Object.entries(original.fixedContext).every(([key, value]) =>
      Object.is((current as Record<string, unknown>)[key], value),
    ),
    'producer_context_mismatch',
    '/publication/context',
  )
  requireRelease(!selection.originalContext.signal.aborted, 'producer_cancelled', '/publication')
  return original
}

/** A one-time handoff of original factory, services and Context evidence to the original installer. */
export function captureReleaseProducerInstallation(
  installation: ReleaseProducerInstallation,
  originalFactory: ProviderFactory<ProviderLifecycle>,
) {
  const original = originalInstallation(installation)
  requireRelease(
    original.selection.originalFactory === originalFactory && !original.handedOff,
    'producer_installation_already_consumed',
    '/publication/installation',
  )
  const resolved = captureResolvedProducerSource(original.facts)
  original.handedOff = true
  return Object.freeze({
    factory: originalFactory,
    descriptor: originalFactory.descriptor,
    binding: original.selection.originalBinding,
    scope: original.selection.originalScope,
    verifiedPackage: original.selection.originalVerifiedPackage,
    config: resolved.config,
    packageSource: resolved.packageSource,
    packageResolver: resolved.resolver,
    configurationRequest: resolved.source.configRequest,
    configurationResult: resolved.configurationResult,
    packageRequest: resolved.source.packageRequest,
    packageResult: resolved.packageResult,
    verified: resolved.verified,
    context: original.selection.originalContext,
    contextEvidence: original.selection.originalContextEvidence,
    identityExpiresAt: original.selection.identityExpiresAt,
  })
}

export function issueReleaseProducerOccurrence(
  installed: InstalledReleaseProducer,
  facts: ReleaseProducerFacts,
  request: MaintenanceStoreCommitRequest,
  context: CallContext,
  captured: Capture,
): ReleaseProducerOccurrence {
  const original = originalInstallation(installed.installation)
  requireRelease(
    !original.occurrenceIssued &&
      original.handedOff &&
      original.facts === facts &&
      original.selection.originalContext === context &&
      equal(captured.selected.descriptor, original.selection.originalFactory.descriptor) &&
      equal(captured.verified.metadata, original.selection.originalVerifiedPackage.metadata) &&
      equal(captured.verified.snapshot, original.selection.originalVerifiedPackage.snapshot) &&
      Buffer.from(original.selection.originalVerifiedPackage.code).equals(
        Buffer.from(
          captured.contents.find((row) => row.kind === 'bytes' && row.digest === captured.code.digest)
            ?.body ?? [],
        ),
      ),
    'producer_original_selection_mismatch',
    '/publication/occurrence',
  )
  requireRelease(!original.occurrenceIssued, 'producer_occurrence_already_issued', '/publication')
  original.occurrenceIssued = true
  const occurrence = Object.freeze({}) as ReleaseProducerOccurrence
  occurrences.set(occurrence, {
    installation: installed.installation,
    request,
    context,
    captured,
    used: false,
  })
  return occurrence
}

/** Consumes one original occurrence for the native prepare call; no clone or fresh Context is accepted. */
export function captureReleaseProducerOccurrence(
  installation: ReleaseProducerInstallation,
  originalFactory: ProviderFactory<ProviderLifecycle>,
  request: MaintenanceStoreCommitRequest,
  context: CallContext,
  occurrence: ReleaseProducerOccurrence,
) {
  const original = originalInstallation(installation)
  const row = occurrences.get(occurrence)
  requireRelease(
    original.selection.originalFactory === originalFactory &&
      row &&
      row.installation === installation &&
      row.request === request &&
      row.context === context &&
      !row.used,
    'producer_original_occurrence_missing',
    '/publication/occurrence',
  )
  captureResolvedProducerSource(original.facts)
  requireRelease(
    equal(request.authority, original.selection.port.authority) &&
      Date.parse(original.selection.port.now()) < Date.parse(row.captured.payload.qualifiedUntil),
    'producer_qualification_expired',
    '/publication',
  )
  row.used = true
  return Object.freeze({
    installation,
    factory: originalFactory,
    contextEvidence: original.selection.originalContextEvidence,
    payload: structuredClone(row.captured.payload),
    qualifiedUntil: row.captured.payload.qualifiedUntil,
    contents: row.captured.contents.map((item) => ({ ...item, body: Buffer.from(item.body) })),
    originals: row.captured.original,
  })
}

/** Called by the original selected-factory installer, never inferred from a service-name DTO. */
export async function installReleaseProducer(
  input: Selection,
  installIssuer?: (originalInstallation: ReleaseProducerInstallation) => InstalledPublicationIssuer,
) {
  const selection = Object.freeze({ ...input })
  const fixedContext = contextSlots(selection.originalContext)
  requireRelease(
    selection.originalFactory.descriptor.contract === 'agh.assembly' &&
      equal(selection.originalBinding, selection.port.producer) &&
      equal(selection.originalScope, selection.port.scope) &&
      selection.originalContext.bindingId === selection.originalBinding.bindingId &&
      equal(selection.originalContext.scope, selection.originalScope) &&
      selection.originalContextEvidence !== null &&
      typeof selection.originalContextEvidence === 'object',
    'producer_installation_mismatch',
    '/publication/installation',
  )
  const source = readProducerDeployment(selection.deploymentDirectory)
  const facts = await resolveProducerSource(
    source,
    selection.port.stateAuthority,
    selection.port.now(),
    selection.originalContext.deadline,
    selection.originalBinding,
    selection.originalScope,
  )
  const selected = facts.release.bindings.find((row) => equal(row.binding, selection.originalBinding))
  const verified = captureResolvedProducerSource(facts).verified.find(
    (row) => row.metadata.digest === selected?.descriptor.packageDigest,
  )
  try {
    requireRelease(
      selected &&
        verified &&
        equal(selected.descriptor, ownValue(selection.originalFactory, 'descriptor')) &&
        equal(verified.metadata, selection.originalVerifiedPackage.metadata) &&
        equal(verified.snapshot, selection.originalVerifiedPackage.snapshot),
      'producer_original_selection_mismatch',
      '/publication/installation',
    )
    const capture = captureReleaseProducerContents(
      facts,
      null,
      selection.port,
      selection.identityExpiresAt,
      selection.originalContext.deadline,
    )
    requireRelease(
      codeDigest(selection.originalVerifiedPackage.code) === capture.code.digest,
      'producer_original_selection_mismatch',
      '/publication/installation',
    )
  } catch (error) {
    releaseResolvedProducerSource(facts)
    throw error
  }
  const installation = Object.freeze({}) as ReleaseProducerInstallation
  const resolved = captureResolvedProducerSource(facts)
  const methods = [
    [resolved.config, ['resolve', 'dispose']],
    [resolved.resolver, ['resolve', 'dispose']],
    [resolved.packageSource, ['resolveMetadata', 'fetch', 'refreshCatalog', 'dispose']],
  ] as const
  installations.set(installation, {
    selection,
    factoryCreate: selection.originalFactory.create,
    descriptorJson: JSON.stringify(selection.originalFactory.descriptor),
    fixedContext,
    fixedContextJson: contextJson(selection.originalContext),
    packageJson: jcs([
      selection.originalVerifiedPackage.metadata,
      selection.originalVerifiedPackage.snapshot,
    ]),
    codeDigest: codeDigest(selection.originalVerifiedPackage.code),
    bindingJson: jcs(selection.originalBinding),
    scopeJson: jcs(selection.originalScope),
    occurrenceIssued: false,
    methods: methods.flatMap(([object, keys]) =>
      keys.map((key) => ({ object, key, value: ownValue(object, key) })),
    ),
    facts,
    handedOff: false,
    closed: false,
  })
  try {
    requireRelease(installIssuer, 'producer_native_issuer_missing', '/publication/installation')
    const issuer = installIssuer(installation)
    const original = originalInstallation(installation)
    requireRelease(
      original.handedOff &&
        issuer &&
        typeof issuer.prepare === 'function' &&
        typeof issuer.acceptOriginalReceipt === 'function',
      'producer_native_issuer_missing',
      '/publication',
    )
    let prepared: ReturnType<InstalledReleaseProducer['prepareOriginal']> | undefined
    const installed: InstalledReleaseProducer = {
      installation,
      issuer,
      identityExpiresAt: readWire('Timestamp', selection.identityExpiresAt),
      initialFacts: facts,
      initialContext: selection.originalContext,
      prepareOriginal() {
        originalInstallation(installation)
        captureResolvedProducerSource(facts)
        if (prepared) return prepared
        const request = publicationRequest(facts, selection.port)
        const captured = captureReleaseProducerContents(
          facts,
          request,
          selection.port,
          selection.identityExpiresAt,
          selection.originalContext.deadline,
        )
        const occurrence = issueReleaseProducerOccurrence(
          installed,
          facts,
          request,
          selection.originalContext,
          captured,
        )
        const result = issuer.prepare(request, selection.originalContext, occurrence)
        prepared = { request, captured, occurrence, prepared: result }
        return prepared
      },
    }
    installedHandles.add(installed)
    const producer = createReleaseProducer(selection.deploymentDirectory, selection.port, installed)
    return {
      ...producer,
      captureOriginalContents(originalContext: CallContext) {
        return maintenanceOutcome(async () => {
          originalInstallation(installation)
          requireRelease(
            originalContext === selection.originalContext,
            'producer_context_mismatch',
            '/publication/context',
          )
          const captured = captureReleaseProducerContents(
            facts,
            null,
            selection.port,
            selection.identityExpiresAt,
            selection.originalContext.deadline,
          )
          return Object.freeze({
            mapping: freeze(captured.payload.content),
            contents: captured.contents.map((row) => ({ ...row, body: Buffer.from(row.body) })),
            originals: captured.original,
          })
        })
      },
      captureOriginalPublication() {
        return maintenanceOutcome(async () => {
          const result = installed.prepareOriginal()
          return Object.freeze({
            request: result.request,
            context: selection.originalContext,
            occurrence: result.occurrence,
            prepared: result.prepared,
          })
        })
      },
      async dispose() {
        await producer.dispose()
        original.closed = true
        releaseResolvedProducerSource(facts)
      },
    }
  } catch (error) {
    installations.delete(installation)
    releaseResolvedProducerSource(facts)
    throw error
  }
}
