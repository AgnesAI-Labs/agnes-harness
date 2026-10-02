import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { CallContext, Outcome } from '@agnes/extension-api/runtime'
import type {
  AuthorityCheckpoint,
  AuthorityDirectoryCompareAndSwapRequest,
  AuthorityDirectoryCompareAndSwapResult,
  AuthorityDirectoryReadResult,
  AuthorityFence,
  AuthorityRoute,
  DataRef,
  JsonValue,
  MigrationRequest,
} from '@agnes/protocol/runtime'
import {
  createReferenceAnchor,
  createReferenceAuthorityDirectory,
} from '../../../../examples/runtime-reference/src/providers/authority-directory.ts'
import {
  type AuthorityDirectoryConformanceBinding,
  type AuthorityDirectoryScenarioEvidence,
  registerAuthorityDirectoryContract,
} from '../../../../packages/extension-api/testkit/runtime/contracts/authority-directory.ts'
import type { BuildIdentity } from '../../../../packages/extension-api/testkit/runtime/evidence.ts'
import type { ConformanceHarness } from '../../../../packages/extension-api/testkit/runtime/harness.ts'
import { documentDigest } from '../../../../packages/host/src/runtime/config/config-digest.ts'
import { inlineData } from '../../../../packages/host/src/runtime/maintenance/authority-publication.ts'
import {
  createAuthorityDirectoryProvider,
  createDirectoryAnchor,
} from '../../../../packages/host/src/runtime/providers/authority-directory.ts'

type Recipe = 'default' | 'reference'

const PRINCIPAL = 'maintainer'
const AUTHORITY = { authorityId: 'directory-authority', tenantId: 'tenant-a', authorityEpoch: 1 }
const STATE_BINDING = {
  bindingId: 'state-binding',
  contract: 'agh.state',
  logicalName: 'state',
  providerId: 'agh.default/state',
}
const COHORT = '11'.repeat(32)

interface DirectoryProvider {
  readonly providerId: string
  readonly features: readonly string[]
  readonly unsupported: readonly string[]
  seedRoute(route: AuthorityRoute, context: CallContext): Promise<Outcome<{ readonly revision: number }>>
  read(
    request: { readonly kind: 'authority'; readonly logicalAuthorityId: string },
    context: CallContext,
  ): Promise<Outcome<AuthorityDirectoryReadResult>>
  compareAndSwap(
    request: AuthorityDirectoryCompareAndSwapRequest,
    context: CallContext,
  ): Promise<Outcome<AuthorityDirectoryCompareAndSwapResult>>
  approveUpgrade(
    input: {
      readonly upgradeId: string
      readonly validationRef: DataRef
      readonly authorityIds: readonly string[]
    },
    context: CallContext,
  ): Promise<Outcome<{ readonly upgradeId: string }>>
  transfer(request: MigrationRequest, context: CallContext): Promise<Outcome<unknown>>
  dispose(): Promise<void>
}

function context(principal = PRINCIPAL, signal: AbortSignal = new AbortController().signal): CallContext {
  return {
    principalRef: principal,
    scope: { kind: 'installation', installationId: 'install-1' },
    bindingId: 'binding-1',
    invocationId: 'invoke-1',
    deadline: '2099-01-01T00:00:00.000Z',
    traceRef: 'trace-1',
    authorizationRef: 'authz-1',
    signal,
  }
}

function refusal(outcome: Outcome<unknown>): string {
  return outcome.ok ? 'ok' : `${outcome.error.code}/${outcome.error.detailCode}`
}

function must<T>(outcome: Outcome<T>, expected = 'ok'): T {
  assert.equal(refusal(outcome), expected)
  if (!outcome.ok) throw new Error(expected)
  return outcome.value
}

function checkpoint(authorityId: string, epoch: number): AuthorityCheckpoint {
  return {
    authorityId,
    authorityEpoch: epoch,
    checkpointId: `checkpoint-${authorityId}-${String(epoch)}`,
    snapshotDigest: '33'.repeat(32),
    recordCount: 1,
    bridgeWatermarks: [],
  }
}

function makeRoute(
  id: string,
  epoch: number,
  cutoverId: string,
  previous: AuthorityRoute['previous'],
): AuthorityRoute {
  return {
    logicalAuthorityId: id,
    tenantId: 'tenant-a',
    authorityEpoch: epoch,
    providerBinding: STATE_BINDING,
    locationRef: `loc-${id}-${String(epoch)}`,
    cohortDigest: COHORT,
    cutoverId,
    checkpoint: checkpoint(id, epoch),
    previous,
  }
}

function validation(): DataRef {
  return inlineData({ accepted: true } as JsonValue, 'agh.maintenance/validation@1')
}

function lockRef(): DataRef {
  return inlineData({ lock: 'directory' } as JsonValue, 'agh.maintenance/provider-lock@1')
}

function fenceFor(route: AuthorityRoute, upgradeId: string, cutoverId: string): AuthorityFence {
  return {
    upgradeId,
    source: {
      authorityId: route.logicalAuthorityId,
      tenantId: route.tenantId,
      authorityEpoch: route.authorityEpoch,
    },
    fenceId: `fence-${cutoverId}-${route.logicalAuthorityId}`,
    fenceEpoch: route.authorityEpoch,
    checkpoint: route.checkpoint,
    writerCredentialsRevoked: true,
  }
}

function requestFor(
  route: AuthorityRoute,
  expectedRevision: number,
  proof: DataRef,
): AuthorityDirectoryCompareAndSwapRequest {
  const cutoverId = 'cutover-1'
  const next = makeRoute(route.logicalAuthorityId, route.authorityEpoch + 1, cutoverId, {
    authorityEpoch: route.authorityEpoch,
    locationRef: route.locationRef,
    cutoverId: route.cutoverId,
  })
  return {
    transactionId: cutoverId,
    authority: AUTHORITY,
    expectedWriterEpoch: 1,
    publication: {
      upgradeId: 'upgrade-1',
      cutoverId,
      changes: [{ expectedRevision, previous: route, next }],
      sourceFences: [fenceFor(route, 'upgrade-1', cutoverId)],
      validationRef: proof,
      jointDispatchMappings: [],
    },
  }
}

function paths(root: string): { directory: string; anchor: string } {
  return { directory: join(root, 'dir'), anchor: join(root, 'anchor') }
}

function openAt(
  recipe: Recipe,
  root: string,
  filesystem?: 'unsupported',
  existing = false,
): DirectoryProvider {
  const { directory, anchor } = paths(root)
  const locator = {
    directoryId: 'directory-1',
    providerLockRef: lockRef(),
    endpointRef: directory,
    epoch: 1,
    revision: 1,
    cutoverId: 'locator-1',
  }
  if (filesystem !== 'unsupported' && !existing) {
    const created =
      recipe === 'default'
        ? createDirectoryAnchor(anchor, locator, PRINCIPAL)
        : createReferenceAnchor(anchor, locator, PRINCIPAL)
    if (!created.ok) throw new Error(refusal(created))
  }
  if (recipe === 'default') {
    const provider = createAuthorityDirectoryProvider({
      directory,
      anchor,
      authority: AUTHORITY,
      filesystem,
    })
    return {
      providerId: provider.providerId,
      features: provider.features,
      unsupported: [],
      seedRoute: (route, call) => provider.seedRoute(route, call),
      read: (request, call) => provider.read(request, call),
      compareAndSwap: (request, call) => provider.compareAndSwap(request, call),
      approveUpgrade: (input, call) => provider.approveUpgrade(input, call),
      transfer: (request, call) => provider.transfer(request, call),
      dispose: () => provider.dispose(),
    }
  }
  const provider = createReferenceAuthorityDirectory({
    directory,
    anchor,
    authority: AUTHORITY,
    filesystem,
  })
  return {
    providerId: provider.providerId,
    features: provider.features,
    unsupported: provider.unsupported,
    seedRoute: (route, call) => provider.seedRoute(route, call),
    read: (request, call) => provider.read(request, call),
    compareAndSwap: (request, call) => provider.compareAndSwap(request, call),
    approveUpgrade: (input, call) => provider.approveUpgrade(input, call),
    transfer: (request, call) => provider.transfer(request, call),
    dispose: () => provider.dispose(),
  }
}

async function withProvider<T>(
  recipe: Recipe,
  filesystem: 'unsupported' | undefined,
  run: (provider: DirectoryProvider) => Promise<T>,
): Promise<T> {
  const root = mkdtempSync(`/tmp/p04-${recipe}-`)
  let provider: DirectoryProvider | null = null
  try {
    provider = openAt(recipe, root, filesystem)
    return await run(provider)
  } finally {
    await provider?.dispose()
    rmSync(root, { recursive: true, force: true })
  }
}

async function seeded(provider: DirectoryProvider): Promise<AuthorityRoute> {
  const route = makeRoute('state-auth', 1, 'seed-state-auth', null)
  must(await provider.seedRoute(route, context()))
  return route
}

function providerDigest(recipe: Recipe): string {
  return documentDigest({
    providerId:
      recipe === 'default' ? 'agh.default/authority-directory' : 'agh.reference/authority-directory',
    contract: 'agh.authority-directory',
  })
}

function evidence(
  recipe: Recipe,
  configDigest: string,
  releaseSetDigest: string,
  detail: string,
): AuthorityDirectoryScenarioEvidence {
  return { passed: true, providerDigest: providerDigest(recipe), configDigest, releaseSetDigest, detail }
}

function repoRoot(): string {
  return fileURLToPath(new URL('../../../../', import.meta.url))
}

function createBuild(): BuildIdentity {
  const root = repoRoot()
  const lockDigest = createHash('sha256')
    .update(readFileSync(join(root, 'pnpm-lock.yaml')))
    .digest('hex')
  const sdk = JSON.parse(readFileSync(join(root, 'packages/extension-api/package.json'), 'utf8')) as {
    name: string
    version: string
  }
  const codeSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim()
  const specVersion = 'runtime-services-1'
  return {
    codeSha,
    buildDigest: documentDigest({ codeSha, specVersion }),
    lockDigest,
    specVersion,
    sdkVersion: sdk.version,
    sdkDigest: documentDigest({ name: sdk.name, version: sdk.version }),
    platform: `${process.platform}-${process.arch}`, // guards-allow-platform: evidence only, no branch
  }
}

async function select(recipe: Recipe): Promise<AuthorityDirectoryScenarioEvidence> {
  return withProvider(recipe, undefined, async (provider) => {
    assert.equal(provider.providerId.endsWith('/authority-directory'), true)
    if (recipe === 'default') assert.equal(provider.features.includes('local-fs-rename'), true)
    if (recipe === 'reference') {
      assert.equal(provider.features.includes('sqlite-immediate'), true)
      assert.equal(provider.unsupported.includes('local-fs-rename'), true)
    }
    await seeded(provider)
    const read = must(await provider.read({ kind: 'authority', logicalAuthorityId: 'state-auth' }, context()))
    assert.equal(read.kind, 'authority')
    if (read.kind !== 'authority') throw new Error('authority read')
    assert.equal(read.revision, 1)
    return evidence(
      recipe,
      documentDigest({ revision: read.revision }),
      documentDigest({ recipe, scenario: 'select' }),
      `selected ${provider.providerId}`,
    )
  })
}

async function normal(recipe: Recipe): Promise<AuthorityDirectoryScenarioEvidence> {
  return withProvider(recipe, undefined, async (provider) => {
    const route = await seeded(provider)
    const proof = validation()
    must(
      await provider.approveUpgrade(
        { upgradeId: 'upgrade-1', validationRef: proof, authorityIds: ['state-auth'] },
        context(),
      ),
    )
    const published = must(await provider.compareAndSwap(requestFor(route, 1, proof), context()))
    assert.equal(published.routes[0]?.revision, 2)
    const read = must(await provider.read({ kind: 'authority', logicalAuthorityId: 'state-auth' }, context()))
    assert.equal(read.kind, 'authority')
    if (read.kind !== 'authority') throw new Error('authority read')
    assert.equal(read.revision, 2)
    const unsupported = recipe === 'reference' ? `; unsupported ${provider.unsupported.join(',')}` : ''
    return evidence(
      recipe,
      documentDigest({ revision: read.revision, epoch: read.epoch }),
      documentDigest({ recipe, scenario: 'normal' }),
      `published revision ${String(read.revision)}${unsupported}`,
    )
  })
}

async function deny(recipe: Recipe): Promise<AuthorityDirectoryScenarioEvidence> {
  return withProvider(recipe, undefined, async (provider) => {
    const denied = await provider.read(
      { kind: 'authority', logicalAuthorityId: 'state-auth' },
      context('other-principal'),
    )
    assert.equal(refusal(denied), 'denied/maintenance_principal')
    return evidence(
      recipe,
      documentDigest({ code: 'denied', detailCode: 'maintenance_principal' }),
      documentDigest({ recipe, scenario: 'deny' }),
      'denied/maintenance_principal',
    )
  })
}

async function cancel(recipe: Recipe): Promise<AuthorityDirectoryScenarioEvidence> {
  return withProvider(recipe, undefined, async (provider) => {
    const controller = new AbortController()
    controller.abort()
    const route = makeRoute('state-auth', 1, 'seed-state-auth', null)
    const cancelled = await provider.seedRoute(route, context(PRINCIPAL, controller.signal))
    assert.equal(refusal(cancelled), 'cancelled/directory_cancelled')
    const read = await provider.read({ kind: 'authority', logicalAuthorityId: 'state-auth' }, context())
    assert.equal(refusal(read), 'incompatible/route_absent')
    return evidence(
      recipe,
      documentDigest({ code: 'cancelled', detailCode: 'directory_cancelled' }),
      documentDigest({ recipe, scenario: 'cancel' }),
      'cancelled/directory_cancelled',
    )
  })
}

async function recover(recipe: Recipe): Promise<AuthorityDirectoryScenarioEvidence> {
  const root = mkdtempSync(`/tmp/p04-${recipe}-recover-`)
  const first = openAt(recipe, root)
  try {
    const route = await seeded(first)
    const proof = validation()
    must(
      await first.approveUpgrade(
        { upgradeId: 'upgrade-1', validationRef: proof, authorityIds: ['state-auth'] },
        context(),
      ),
    )
    const request = requestFor(route, 1, proof)
    const published = must(await first.compareAndSwap(request, context()))
    await first.dispose()
    const second = openAt(recipe, root, undefined, true)
    try {
      const replay = must(await second.compareAndSwap(request, context()))
      assert.deepEqual(replay, published)
      return evidence(
        recipe,
        documentDigest({ revision: replay.routes[0]?.revision ?? 0 }),
        documentDigest({ recipe, scenario: 'recover' }),
        'replay revision 2',
      )
    } finally {
      await second.dispose()
    }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

async function dispose(recipe: Recipe): Promise<AuthorityDirectoryScenarioEvidence> {
  const leftRoot = mkdtempSync(`/tmp/p04-${recipe}-dispose-`)
  const rightRoot = mkdtempSync(`/tmp/p04-${recipe}-sibling-`)
  let left: DirectoryProvider | null = null
  let right: DirectoryProvider | null = null
  try {
    left = openAt(recipe, leftRoot)
    right = openAt(recipe, rightRoot)
    await left.dispose()
    const read = await left.read({ kind: 'authority', logicalAuthorityId: 'state-auth' }, context())
    assert.equal(refusal(read), 'denied/directory_disposed')
    must(await right.seedRoute(makeRoute('state-auth', 1, 'seed-state-auth', null), context()))
    return evidence(
      recipe,
      documentDigest({ code: 'denied', detailCode: 'directory_disposed' }),
      documentDigest({ recipe, scenario: 'dispose' }),
      'disposed',
    )
  } finally {
    await right?.dispose()
    rmSync(leftRoot, { recursive: true, force: true })
    rmSync(rightRoot, { recursive: true, force: true })
  }
}

function recipeOf(providerId: string): Recipe {
  if (providerId === 'default' || providerId === 'agh.default/authority-directory') return 'default'
  if (providerId === 'reference' || providerId === 'agh.reference/authority-directory') return 'reference'
  throw new Error(`authority directory provider ${providerId} is not registered`)
}

export async function bindAuthorityDirectoryContracts(
  harness: ConformanceHarness,
  command: string,
  providers: readonly string[],
): Promise<void> {
  assert.notEqual(command, '')
  const build = createBuild()
  for (const providerId of providers) {
    const recipe = recipeOf(providerId)
    const binding: AuthorityDirectoryConformanceBinding = {
      command,
      build,
      providerId,
      port: {
        recipe,
        select: () => select(recipe),
        normal: () => normal(recipe),
        deny: () => deny(recipe),
        cancel: () => cancel(recipe),
        recover: () => recover(recipe),
        dispose: () => dispose(recipe),
      },
    }
    registerAuthorityDirectoryContract(harness, binding)
  }
}

async function both<T>(
  run: (provider: DirectoryProvider) => Promise<T>,
  filesystem?: 'unsupported',
): Promise<{ readonly default: T; readonly reference: T }> {
  return {
    default: await withProvider('default', filesystem, run),
    reference: await withProvider('reference', filesystem, run),
  }
}

export async function proveDirectoryAgreement(): Promise<{
  readonly publishedRevision: number
  readonly denial: string
  readonly mismatch: string
  readonly identity: string
  readonly filesystem: string
  readonly transferKind: string
  readonly transferMode: string
  readonly referenceUnsupported: readonly string[]
}> {
  const published = await both(async (provider) => {
    const route = await seeded(provider)
    const proof = validation()
    must(
      await provider.approveUpgrade(
        { upgradeId: 'upgrade-1', validationRef: proof, authorityIds: ['state-auth'] },
        context(),
      ),
    )
    const request = requestFor(route, 1, proof)
    const result = must(await provider.compareAndSwap(request, context()))
    const replay = must(await provider.compareAndSwap(request, context()))
    assert.deepEqual(replay, result)
    const stale = {
      ...request,
      publication: {
        ...request.publication,
        validationRef: inlineData({ accepted: false } as JsonValue, 'agh.maintenance/validation@1'),
      },
    }
    const identity = refusal(await provider.compareAndSwap(stale, context()))
    const read = must(await provider.read({ kind: 'authority', logicalAuthorityId: 'state-auth' }, context()))
    return { result, read, identity, unsupported: provider.unsupported }
  })
  assert.deepEqual(published.reference.result, published.default.result)
  assert.deepEqual(published.reference.read, published.default.read)
  assert.equal(published.default.identity, 'conflict/cutover_identity_conflict')
  assert.equal(published.reference.identity, published.default.identity)
  assert.equal(published.default.result.routes[0]?.revision, 2)

  const denied = await both(async (provider) =>
    refusal(
      await provider.read(
        { kind: 'authority', logicalAuthorityId: 'state-auth' },
        context('other-principal'),
      ),
    ),
  )
  assert.equal(denied.default, 'denied/maintenance_principal')
  assert.equal(denied.reference, denied.default)

  const mismatch = await both(async (provider) => {
    const route = await seeded(provider)
    const proof = validation()
    must(
      await provider.approveUpgrade(
        { upgradeId: 'upgrade-1', validationRef: proof, authorityIds: ['state-auth'] },
        context(),
      ),
    )
    const refused = refusal(await provider.compareAndSwap(requestFor(route, 9, proof), context()))
    const read = must(await provider.read({ kind: 'authority', logicalAuthorityId: 'state-auth' }, context()))
    assert.equal(read.kind, 'authority')
    if (read.kind !== 'authority') throw new Error('authority read')
    assert.equal(read.revision, 1)
    return refused
  })
  assert.equal(mismatch.default, 'conflict/revision_mismatch')
  assert.equal(mismatch.reference, mismatch.default)

  const filesystem = await both(
    async (provider) =>
      refusal(await provider.seedRoute(makeRoute('state-auth', 1, 'seed-state-auth', null), context())),
    'unsupported',
  )
  assert.equal(filesystem.default, 'incompatible/filesystem_unsupported')
  assert.equal(filesystem.reference, filesystem.default)

  const proof = lockRef()
  const transferred = await both(async (provider) => {
    const kind = refusal(
      await provider.transfer(
        {
          upgradeId: 'move-kind',
          target: {
            kind: 'run-state',
            runId: 'run-1',
            sourceBindingId: 'binding-1',
            targetBindingId: 'binding-2',
          },
          policyRef: 'policy-1',
          reason: 'relocate',
          mode: 'explicit',
        },
        context(),
      ),
    )
    const mode = refusal(
      await provider.transfer(
        {
          upgradeId: 'move-mode',
          target: {
            kind: 'directory',
            sourceLocatorRevision: 1,
            targetProviderLock: proof,
            targetLocationRef: 'next',
            externalJournalRef: 'journal-1',
          },
          policyRef: 'policy-1',
          reason: 'relocate',
          mode: 'auto-compatible',
        },
        context(),
      ),
    )
    return { kind, mode }
  })
  assert.equal(transferred.default.kind, 'incompatible/transfer_kind_unsupported')
  assert.equal(transferred.reference.kind, transferred.default.kind)
  assert.equal(transferred.default.mode, 'incompatible/transfer_mode_unsupported')
  assert.equal(transferred.reference.mode, transferred.default.mode)

  return {
    publishedRevision: 2,
    denial: denied.default,
    mismatch: mismatch.default,
    identity: published.default.identity,
    filesystem: filesystem.default,
    transferKind: transferred.default.kind,
    transferMode: transferred.default.mode,
    referenceUnsupported: published.reference.unsupported,
  }
}
