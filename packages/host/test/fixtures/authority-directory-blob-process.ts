import assert from 'node:assert/strict'
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type { CallContext, Outcome } from '@agnes/extension-api/runtime'
import type {
  AuthorityDirectoryCompareAndSwapRequest,
  AuthorityRoute,
  JsonValue,
} from '@agnes/protocol/runtime'
import { canonicalJsonDigest } from '@agnes/protocol/runtime'
import {
  createReferenceAnchor,
  createReferenceAuthorityDirectory,
} from '../../../../examples/runtime-reference/src/providers/authority-directory.js'
import type { TransferMaintenance } from '../../src/runtime/authority-transfer.js'
import { inlineData } from '../../src/runtime/maintenance/authority-publication.js'
import type { PublicationSourcePlan } from '../../src/runtime/maintenance/authority-publication-owner.js'
import {
  createAuthorityDirectoryProvider,
  createDirectoryAnchor,
} from '../../src/runtime/providers/authority-directory.js'
import { type BlobService, createBlobService } from '../../src/runtime/providers/blob.js'

const [mode, root, recipe, fault = 'none'] = process.argv.slice(2)
if (!root || !['prepare', 'recover'].includes(mode ?? '') || !['default', 'reference'].includes(recipe ?? ''))
  throw new Error('invalid fixture arguments')
const context: CallContext = {
  principalRef: 'maintainer',
  scope: { kind: 'installation', installationId: 'synthetic-install' },
  bindingId: 'maintenance',
  invocationId: 'migration',
  deadline: '2099-01-01T00:00:00Z',
  traceRef: 'synthetic-trace',
  authorizationRef: 'maintenance',
  signal: new AbortController().signal,
}
function must<T>(outcome: Outcome<T>): T {
  if (!outcome.ok) throw new Error(JSON.stringify(outcome.error))
  return JSON.parse(JSON.stringify(outcome.value)) as T
}
const digest = 'ab'.repeat(32)
const authority = { authorityId: 'directory', tenantId: 'tenant', authorityEpoch: 1 }
const binding = {
  bindingId: 'blob-source',
  contract: 'agh.blob',
  logicalName: 'default',
  providerId: 'agh.blob.default',
}
const directoryPath = join(root, 'directory')
const anchor = join(root, 'anchor')
if (mode === 'prepare') {
  const create = recipe === 'default' ? createDirectoryAnchor : createReferenceAnchor
  must(
    create(
      anchor,
      {
        directoryId: 'directory',
        providerLockRef: inlineData({ lock: 'synthetic' }, 'test/provider-lock@1'),
        endpointRef: directoryPath,
        epoch: 1,
        revision: 1,
        cutoverId: 'initial-directory',
      },
      'maintainer',
    ),
  )
}
let lockedPlan: PublicationSourcePlan | undefined
let raceRequest: AuthorityDirectoryCompareAndSwapRequest | undefined
const directory = (
  recipe === 'default' ? createAuthorityDirectoryProvider : createReferenceAuthorityDirectory
)({
  directory: directoryPath,
  anchor,
  authority,
  ...(mode === 'prepare'
    ? {
        publicationPlan: async () => {
          if (!lockedPlan) throw new Error('plan not locked')
          return { ok: true as const, value: lockedPlan }
        },
      }
    : {}),
})
let source: BlobService
const maintenance = (locationRef: string): TransferMaintenance => ({
  authorize: () => true,
  tenantId: 'tenant',
  locationRef,
  readRoute: async () => {
    const result = await directory.read({ kind: 'authority', logicalAuthorityId: 'blob' }, context)
    if (!result.ok) return result
    if (result.value.kind !== 'authority') throw new Error('wrong read kind')
    return { ok: true, value: { route: result.value.route, targetActivated: false } }
  },
  sourceBlobs: { openRead: (...args) => source.transferRead.openRead(...args) },
  planFingerprint: async () => ({ ok: true, value: digest }),
})
for (const name of ['source', 'target']) mkdirSync(join(root, name), { recursive: true })
source = createBlobService({
  dataDir: join(root, 'source'),
  authorityId: 'blob',
  binding,
  maintenance: maintenance('source'),
})
const target = createBlobService({
  dataDir: join(root, 'target'),
  authorityId: 'blob',
  binding: { ...binding, bindingId: 'blob-target' },
  maintenance: maintenance('target'),
  transferTarget: true,
})
const payloadPath = join(root, 'publication.json')
const validationPath = join(root, 'source-validation.json')
const same = (left: unknown, right: unknown) =>
  canonicalJsonDigest(JSON.parse(JSON.stringify(left))) ===
  canonicalJsonDigest(JSON.parse(JSON.stringify(right)))
try {
  let request: AuthorityDirectoryCompareAndSwapRequest
  if (mode === 'prepare') {
    const previous: AuthorityRoute = {
      logicalAuthorityId: 'blob',
      tenantId: 'tenant',
      authorityEpoch: 1,
      providerBinding: binding,
      locationRef: 'source',
      cohortDigest: digest,
      cutoverId: 'initial',
      previous: null,
      checkpoint: {
        authorityId: 'blob',
        authorityEpoch: 1,
        checkpointId: 'approved-source-checkpoint',
        snapshotDigest: digest,
        recordCount: 0,
        bridgeWatermarks: [],
      },
    }
    must(await directory.seedRoute(previous, context))
    // A real source write after bootstrap makes its old route checkpoint stale.
    must(
      await source.stage(
        { uploadId: 'source-write', size: 1, mediaType: 'text/plain', expectedDigest: null },
        context,
      ),
    )
    const fence = must(
      await source.transfer.fence(
        {
          upgradeId: 'upgrade',
          expected: { authorityId: 'blob', tenantId: 'tenant', authorityEpoch: 1 },
          cohortDigest: digest,
        },
        context,
      ),
    )
    assert.notDeepEqual(fence.checkpoint, previous.checkpoint)
    const blockedWriter = await source.stage(
      { uploadId: 'stale-writer', size: 1, mediaType: 'text/plain', expectedDigest: null },
      context,
    )
    assert.equal(blockedWriter.ok, false)
    const exported = must(
      await source.transfer.export({ upgradeId: 'upgrade', fenceId: fence.fenceId }, context),
    )
    const imported = must(
      await target.transfer.import(
        { upgradeId: 'upgrade', source: exported, targetLocationRef: 'target' },
        context,
      ),
    )
    const validation = must(
      await target.transfer.verify(
        { upgradeId: 'upgrade', source: exported, candidateRef: imported.candidateRef },
        context,
      ),
    )
    assert.equal(validation.accepted, true)
    const validationRef = inlineData(validation as unknown as JsonValue, 'test/validation@1')
    const original = {
      upgradeId: 'upgrade',
      validationRef,
      sources: [{ previous, expectedRevision: 1, fence }],
    }
    lockedPlan = {
      ...original,
      sources: [
        {
          previous,
          expectedRevision: 1,
          fence,
          owner: {
            authority: fence.source,
            binding: source.binding,
            locationRef: 'source',
            transfer: source.transfer,
          },
        },
      ],
      verify: async (evidence, call) => {
        if (raceRequest) {
          const winner = raceRequest
          raceRequest = undefined
          must(await directory.compareAndSwap(winner, call))
        }
        const report = await target.transfer.verify(
          { upgradeId: 'upgrade', source: exported, candidateRef: imported.candidateRef },
          call,
        )
        return {
          ok: true,
          value:
            same(evidence, JSON.parse(readFileSync(validationPath, 'utf8')).evidence) &&
            report.ok &&
            report.value.accepted &&
            same(
              { ...report.value, checkedAt: validation.checkedAt },
              JSON.parse(readFileSync(validationPath, 'utf8')).report,
            ),
        }
      },
    }

    must(
      await directory.approveUpgrade(
        { upgradeId: 'upgrade', validationRef, authorityIds: ['blob'], sourceFences: [fence] },
        context,
      ),
    )
    const next = {
      ...previous,
      authorityEpoch: 2,
      providerBinding: target.binding,
      locationRef: 'target',
      cutoverId: 'cutover',
      previous: { authorityEpoch: 1, locationRef: 'source', cutoverId: 'initial' },
      checkpoint: { ...imported.targetCheckpoint, authorityEpoch: 2 },
    }
    request = {
      authority,
      expectedWriterEpoch: 1,
      transactionId: 'cutover',
      publication: {
        upgradeId: 'upgrade',
        cutoverId: 'cutover',
        changes: [{ expectedRevision: 1, previous, next }],
        sourceFences: [fence],
        validationRef,
        jointDispatchMappings: [],
      },
    }

    const owner = lockedPlan.sources[0]?.owner
    assert.ok(owner)
    if (fault === 'owner-location')
      lockedPlan = {
        ...lockedPlan,
        sources: lockedPlan.sources.map((item) => ({
          ...item,
          owner: { ...owner, locationRef: 'other-store' },
        })),
      }
    if (fault === 'owner-binding')
      lockedPlan = {
        ...lockedPlan,
        sources: lockedPlan.sources.map((item) => ({
          ...item,
          owner: { ...owner, binding: { ...owner.binding, bindingId: 'other-binding' } },
        })),
      }
    if (fault === 'owner-authority')
      lockedPlan = {
        ...lockedPlan,
        sources: lockedPlan.sources.map((item) => ({
          ...item,
          owner: { ...owner, authority: { ...owner.authority, tenantId: 'other-tenant' } },
        })),
      }
    // Same metadata and caller JSON, but a distinct real owner never fenced this upgrade.
    if (fault === 'lookalike-owner')
      lockedPlan = {
        ...lockedPlan,
        sources: lockedPlan.sources.map((item) => ({
          ...item,
          owner: { ...owner, transfer: target.transfer },
        })),
      }
    if (fault === 'missing-owner') lockedPlan = undefined
    if (fault.startsWith('validation-')) {
      const validatedSource = original.sources[0]
      assert.ok(validatedSource)
      if (fault === 'validation-previous')
        validatedSource.previous = { ...previous, checkpoint: fence.checkpoint }
      if (fault === 'validation-fence') validatedSource.fence = { ...fence, fenceId: 'other-fence' }
      if (fault === 'validation-upgrade') original.upgradeId = 'other-upgrade'
    }
    if (fault === 'wrong-tenant')
      request = {
        ...request,
        publication: {
          ...request.publication,
          sourceFences: [{ ...fence, source: { ...fence.source, tenantId: 'other-tenant' } }],
        },
      }
    if (fault === 'wrong-epoch')
      request = {
        ...request,
        publication: {
          ...request.publication,
          sourceFences: [
            {
              ...fence,
              source: { ...fence.source, authorityEpoch: 2 },
              checkpoint: { ...fence.checkpoint, authorityEpoch: 2 },
            },
          ],
        },
      }
    if (fault === 'wrong-upgrade')
      request = {
        ...request,
        publication: { ...request.publication, sourceFences: [{ ...fence, upgradeId: 'other-upgrade' }] },
      }
    if (fault === 'wrong-checkpoint')
      request = {
        ...request,
        publication: {
          ...request.publication,
          sourceFences: [{ ...fence, checkpoint: { ...fence.checkpoint, authorityEpoch: 2 } }],
        },
      }
    if (fault === 'route-race')
      raceRequest = {
        ...request,
        transactionId: 'winner',
        publication: {
          ...request.publication,
          cutoverId: 'winner',
          changes: request.publication.changes.map((change) => ({
            ...change,
            next: { ...change.next, cutoverId: 'winner' },
          })),
        },
      }
    writeFileSync(validationPath, JSON.stringify({ evidence: original, report: validation }))
    writeFileSync(payloadPath, JSON.stringify(request))
  } else {
    request = JSON.parse(readFileSync(payloadPath, 'utf8')) as AuthorityDirectoryCompareAndSwapRequest
  }
  const outcome = await directory.compareAndSwap(request, context)
  if (fault !== 'none') {
    assert.equal(outcome.ok, false)
    assert.deepEqual(must(await directory.probeCutover('cutover', context)), { state: 'absent' })
    const current = must(await directory.read({ kind: 'authority', logicalAuthorityId: 'blob' }, context))
    assert.equal(current.kind === 'authority' && current.revision, fault === 'route-race' ? 2 : 1)
    assert.equal(
      current.kind === 'authority' && current.route.cutoverId,
      fault === 'route-race' ? 'winner' : 'initial',
    )
    process.stdout.write(JSON.stringify({ outcome, current }))
  } else {
    const publication = must(outcome)
    let logged: { publication: unknown; sourceEvidence: unknown } | undefined
    if (recipe === 'default') {
      const generations = join(directoryPath, 'generations')
      const publication = readdirSync(generations)
        .map((name) => JSON.parse(readFileSync(join(generations, name), 'utf8')))
        .find((entry) => entry.id === 'publication:cutover')
      logged = publication
    } else {
      const db = new DatabaseSync(join(directoryPath, 'routes.sqlite'), { readOnly: true })
      try {
        const row = db
          .prepare('SELECT payload FROM route_freeze_points WHERE cutover_key = ?')
          .get('cutover') as { payload: string } | undefined
        logged = row && JSON.parse(row.payload)
      } finally {
        db.close()
      }
    }
    assert.deepEqual(logged?.publication, request.publication)
    assert.deepEqual(logged?.sourceEvidence, {
      upgradeId: request.publication.upgradeId,
      validationRef: request.publication.validationRef,
      sources: request.publication.changes.map(({ previous, expectedRevision }) => ({
        previous,
        expectedRevision,
        fence: request.publication.sourceFences.find(
          ({ source }) => source.authorityId === previous.logicalAuthorityId,
        ),
      })),
    })
    const next = request.publication.changes[0]?.next
    assert.ok(next)
    const activated = must(
      await target.transfer.activate(
        {
          upgradeId: 'upgrade',
          cutoverId: 'cutover',
          publishedRoute: inlineData(next as unknown as JsonValue, 'test/route@1'),
        },
        context,
      ),
    )
    assert.equal(activated.state, 'activated')
    assert.deepEqual(activated.state === 'activated' && activated.checkpoint, next.checkpoint)
    const sourceProbe = must(await source.transfer.probe({ upgradeId: 'upgrade' }, context))
    assert.equal(sourceProbe.state, 'fenced')
    assert.deepEqual(sourceProbe.state === 'fenced' && sourceProbe.fence, request.publication.sourceFences[0])
    assert.deepEqual(must(await target.transfer.probe({ upgradeId: 'upgrade' }, context)), activated)
    const read = must(await directory.read({ kind: 'authority', logicalAuthorityId: 'blob' }, context))
    assert.equal(read.kind, 'authority')
    assert.deepEqual(read.kind === 'authority' && read.route, next)
    process.stdout.write(JSON.stringify({ publication, activated, sourceProbe, read }))
  }
} finally {
  source.close()
  target.close()
  await directory.dispose()
}
