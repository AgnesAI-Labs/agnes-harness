import { resolve } from 'node:path'
import type { CallContext, Outcome } from '@agnes/extension-api/runtime'
import type { JsonValue, MigrationReceipt, MigrationRequest } from '@agnes/protocol/runtime'
import { canonicalJsonDigest, validateRuntime } from '@agnes/protocol/runtime'
import { withConfigurationLockSync } from '../../configuration-lock.js'
import {
  type BootstrapAnchor,
  type BootstrapLocator,
  openBootstrapAnchor,
} from '../maintenance/bootstrap-locator.js'
import type { AuthorityDirectoryProvider } from '../providers/authority-directory.js'

export interface DirectoryTransferPorts {
  readonly anchorDirectory: string
  /** Selects the locked directory provider at the external locator; does not mount the business root. */
  openDirectory(locator: BootstrapLocator): Pick<AuthorityDirectoryProvider, 'transfer' | 'dispose'>
}
interface Checkpoint {
  version: 1
  upgradeId: string
  fingerprint: string
  source: BootstrapLocator
  request: MigrationRequest
}
function fail(
  code: 'conflict' | 'incompatible' | 'invalid_input' | 'retryable' | 'denied' | 'cancelled',
  detailCode: string,
): Outcome<never> {
  return {
    ok: false,
    error: {
      code,
      detailCode,
      message: 'Directory transfer refused',
      diagnosticId: 'directory-transfer',
      retryAdvice: { kind: code === 'retryable' ? 'retry_same_action' : 'never' },
    },
  }
}
const json = (value: unknown): JsonValue => JSON.parse(JSON.stringify(value)) as JsonValue
const fingerprint = (request: MigrationRequest): string => canonicalJsonDigest(json(request))
const checkpointId = (id: string): string => `migration-adapter-${canonicalJsonDigest(id)}`

/** This adapter adds no directory writer and never rewrites the provider journal or locator. */
export function createDirectoryTransferAdapter(ports: DirectoryTransferPorts) {
  function load(anchor: BootstrapAnchor, request: MigrationRequest): Outcome<Checkpoint | null> {
    const recorded = anchor.readJournal(checkpointId(request.upgradeId))
    if (!recorded.ok) return recorded
    if (recorded.value === null) return { ok: true, value: null }
    const value = recorded.value as unknown as Checkpoint
    if (
      value.version !== 1 ||
      value.upgradeId !== request.upgradeId ||
      !validateRuntime('MigrationRequest', value.request).ok ||
      value.fingerprint !== fingerprint(value.request) ||
      !value.source ||
      !validateRuntime('Id', value.source.directoryId).ok ||
      !validateRuntime('DataRef', value.source.providerLockRef).ok ||
      !validateRuntime('Id', value.source.cutoverId).ok ||
      !validateRuntime('UInt53', value.source.revision).ok ||
      !validateRuntime('UInt53', value.source.epoch).ok ||
      typeof value.source.endpointRef !== 'string'
    )
      return fail('incompatible', 'checkpoint_corrupt')
    if (value.fingerprint !== fingerprint(request)) return fail('conflict', 'operation_fingerprint')
    return { ok: true, value }
  }
  async function probeWith(
    anchor: BootstrapAnchor,
    request: MigrationRequest,
    context: CallContext,
  ): Promise<Outcome<MigrationReceipt>> {
    const current = anchor.read()
    if (!current.ok) return current
    if (context.signal.aborted) return fail('cancelled', 'call_cancelled')
    if (current.value.credential.principalRef !== context.principalRef)
      return fail('denied', 'maintenance_principal')
    const loaded = load(anchor, request)
    if (!loaded.ok) return loaded
    const locator = current.value.locator
    const record = loaded.value
    if (!record && locator.cutoverId === request.upgradeId) return fail('incompatible', 'checkpoint_missing')
    if (!record) return { ok: true, value: receipt(request.upgradeId, 'planned', locator.revision, null) }
    if (request.target.kind !== 'directory') return fail('invalid_input', 'transfer_kind')
    if (locator.cutoverId !== request.upgradeId) {
      if (canonicalJsonDigest(json(locator)) !== canonicalJsonDigest(json(record.source)))
        return fail('conflict', 'locator_changed')
      // The directory provider owns recovery before publication (including a partially copied standby).
      return { ok: true, value: receipt(request.upgradeId, 'planned', locator.revision, null) }
    }
    const journal = anchor.readJournal(request.upgradeId)
    if (!journal.ok) return journal
    if (!journal.value || typeof journal.value !== 'object' || Array.isArray(journal.value))
      return fail('incompatible', 'external_journal_missing')
    const move = journal.value as Record<string, JsonValue>
    if (
      move.upgradeId !== request.upgradeId ||
      move.journalRef !== request.target.externalJournalRef ||
      move.fromEndpoint !== record.source.endpointRef ||
      move.toEndpoint !== locator.endpointRef ||
      move.fromEpoch !== record.source.epoch ||
      move.toEpoch !== locator.epoch ||
      !validateRuntime('Digest', move.headDigest).ok ||
      locator.epoch !== record.source.epoch + 1 ||
      locator.revision !== record.source.revision + 1 ||
      locator.directoryId !== record.source.directoryId ||
      canonicalJsonDigest(json(locator.providerLockRef)) !==
        canonicalJsonDigest(json(request.target.targetProviderLock))
    )
      return fail('conflict', 'external_commit_mismatch')
    // An external CAS alone does not prove target activation. The directory provider reopens/adopts the exact frozen head.
    const provider = ports.openDirectory(locator)
    try {
      const adopted = await provider.transfer({ ...request, mode: 'inspect-only' }, context)
      if (!adopted.ok) return adopted
      if (adopted.value.state !== 'planned') return fail('retryable', 'target_not_ready')
      return { ok: true, value: receipt(request.upgradeId, 'committed', locator.revision, request.upgradeId) }
    } finally {
      await provider.dispose()
    }
  }
  return {
    async probe(request: MigrationRequest, context: CallContext): Promise<Outcome<MigrationReceipt>> {
      if (!validateRuntime('MigrationRequest', request).ok || request.target.kind !== 'directory')
        return fail('invalid_input', 'transfer_kind')
      const opened = openBootstrapAnchor(ports.anchorDirectory)
      return opened.ok ? probeWith(opened.value, request, context) : opened
    },
    async transfer(request: MigrationRequest, context: CallContext): Promise<Outcome<MigrationReceipt>> {
      if (!validateRuntime('MigrationRequest', request).ok || request.target.kind !== 'directory')
        return fail('invalid_input', 'transfer_kind')
      const opened = openBootstrapAnchor(ports.anchorDirectory)
      if (!opened.ok) return opened
      const anchor = opened.value
      const current = anchor.read()
      if (!current.ok) return current
      if (context.signal.aborted) return fail('cancelled', 'call_cancelled')
      if (current.value.credential.principalRef !== context.principalRef)
        return fail('denied', 'maintenance_principal')
      if (request.mode === 'inspect-only') {
        const provider = ports.openDirectory(current.value.locator)
        try {
          return await provider.transfer(request, context)
        } finally {
          await provider.dispose()
        }
      }
      if (request.mode !== 'explicit') return fail('incompatible', 'transfer_mode')
      try {
        const saved = withConfigurationLockSync(
          resolve(ports.anchorDirectory, 'migration-adapter-lock.sqlite'),
          () => {
            const prior = load(anchor, request)
            if (!prior.ok) return prior
            if (prior.value) return { ok: true as const, value: true }
            const live = anchor.read()
            if (!live.ok) return live
            if (live.value.credential.principalRef !== context.principalRef)
              return fail('denied', 'maintenance_principal')
            if (
              request.target.kind !== 'directory' ||
              live.value.locator.revision !== request.target.sourceLocatorRevision
            )
              return fail('conflict', 'locator_revision')
            const checkpoint: Checkpoint = {
              version: 1,
              upgradeId: request.upgradeId,
              fingerprint: fingerprint(request),
              source: live.value.locator,
              request,
            }
            return anchor.writeJournal(checkpointId(request.upgradeId), json(checkpoint))
          },
        )
        if (!saved.ok) return saved
      } catch {
        return fail('retryable', 'checkpoint_busy')
      }
      const probed = await probeWith(anchor, request, context)
      if (!probed.ok || probed.value.state === 'committed') return probed
      const provider = ports.openDirectory(current.value.locator)
      try {
        const transferred = await provider.transfer(request, context)
        if (!transferred.ok) return transferred
      } finally {
        await provider.dispose()
      }
      return probeWith(anchor, request, context)
    },
  }
}
function receipt(
  upgradeId: string,
  state: MigrationReceipt['state'],
  checkpointRevision: number,
  cutoverId: string | null,
): MigrationReceipt {
  return { upgradeId, state, checkpointRevision, cutoverId, commitRef: cutoverId, diagnosticIds: [] }
}
