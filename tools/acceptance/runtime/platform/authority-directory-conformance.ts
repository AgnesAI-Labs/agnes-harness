import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { CallContext, Outcome, RuntimeError } from '@agnes/extension-api/runtime'
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
import { createReferenceAnchor } from '../../../../examples/runtime-reference/src/providers/authority-directory.ts'
import {
  type AuthorityDirectoryConformanceBinding,
  type AuthorityDirectoryScenarioEvidence,
  registerAuthorityDirectoryContract,
} from '../../../../packages/extension-api/testkit/runtime/contracts/authority-directory.ts'
import type { ConformanceHarness } from '../../../../packages/extension-api/testkit/runtime/harness.ts'
import { documentDigest } from '../../../../packages/host/src/runtime/config/config-digest.ts'
import { inlineData } from '../../../../packages/host/src/runtime/maintenance/authority-publication.ts'
import { createDirectoryAnchor } from '../../../../packages/host/src/runtime/providers/authority-directory.ts'
import { createHostScopedDependencies } from '../../../../packages/host/src/runtime/scoped-dependencies.ts'
import {
  createFixtureAuthorityDirectory as createAuthorityDirectoryProvider,
  createFixtureReferenceDirectory as createReferenceAuthorityDirectory,
} from '../../../../packages/host/test/fixtures/authority-directory-owner.js'
import { getConformanceBuildIdentity } from '../build-identity.js'

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
      readonly sourceFences?: readonly AuthorityFence[]
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

class DirectoryRefusal extends Error {
  constructor(readonly refusal: RuntimeError) {
    super(`${refusal.code}/${refusal.detailCode}`)
  }
}

function must<T>(outcome: Outcome<T>, expected = 'ok'): T {
  if (!outcome.ok && expected === 'ok') throw new DirectoryRefusal(outcome.error)
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
    checkpoint: {
      ...route.checkpoint,
      checkpointId: 'fresh-source-freeze',
      snapshotDigest: '44'.repeat(32),
      recordCount: route.checkpoint.recordCount + 1,
    },
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
    if (!created.ok) throw new DirectoryRefusal(created.error)
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
      unsupported: provider.features.includes('windows-file-flush')
        ? ['power-loss-directory-durability']
        : [],
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
  const root = mkdtempSync(join(tmpdir(), `authority-directory-${recipe}-`))
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
  const files =
    recipe === 'default'
      ? [
          'packages/host/src/runtime/providers/authority-directory.ts',
          'packages/host/src/runtime/maintenance/authority-publication.ts',
          'packages/host/src/runtime/maintenance/bootstrap-locator.ts',
          'packages/host/src/configuration-lock.ts',
        ]
      : ['examples/runtime-reference/src/providers/authority-directory.ts']
  const hash = createHash('sha256')
  for (const path of files)
    hash
      .update(path)
      .update('\0')
      .update(readFileSync(join(repoRoot(), path)))
      .update('\0')
  return hash.digest('hex')
}

function evidence(
  recipe: Recipe,
  configDigest: string,
  releaseSetDigest: string,
  detail: string,
): AuthorityDirectoryScenarioEvidence {
  const limitation = getConformanceBuildIdentity().platform.startsWith('win32-')
    ? '; Windows file FlushFileBuffers/SQLite FULL; no POSIX parent-directory fsync equivalence or power-loss directory guarantee'
    : ''
  return {
    passed: true,
    providerDigest: providerDigest(recipe),
    configDigest,
    releaseSetDigest,
    detail,
    ...(limitation ? { diagnostic: detail + limitation } : {}),
  }
}

function repoRoot(): string {
  return fileURLToPath(new URL('../../../../', import.meta.url))
}

async function select(recipe: Recipe): Promise<AuthorityDirectoryScenarioEvidence> {
  return withProvider(recipe, undefined, async (provider) => {
    assert.equal(provider.providerId.endsWith('/authority-directory'), true)
    if (recipe === 'default') assert.equal(provider.features.includes('local-fs-rename'), true)
    if (recipe === 'reference') {
      assert.equal(provider.features.includes('sqlite-immediate'), true)
      assert.equal(provider.unsupported.includes('local-fs-rename'), true)
    }
    const host = createHostScopedDependencies([])
    const binding = {
      bindingId: 'directory-binding',
      contract: 'agh.authority-directory',
      logicalName: 'directory',
      providerId: provider.providerId,
    }
    const digest = providerDigest(recipe)
    const selected = await host.publish({
      generationId: 'directory-selection',
      providers: [
        {
          binding,
          major: 1,
          scope: 'installation',
          features: ['read', 'compareAndSwap', ...provider.features],
          packageDigest: digest,
          ownerId: provider.providerId,
          permissions: [],
          close: () => provider.dispose(),
        },
      ],
    })
    assert.equal(selected.bindings[0]?.providerId, provider.providerId)
    assert.equal(selected.bindings[0]?.packageDigest, digest)
    const service = must(
      host.dependencies.get({
        contract: binding.contract,
        major: 1,
        logicalName: binding.logicalName,
        scope: 'installation',
        features: ['read', 'compareAndSwap'],
        optional: false,
      }),
    )
    assert.deepEqual(service.binding, binding)
    const missing = host.dependencies.get({
      contract: binding.contract,
      major: 1,
      logicalName: binding.logicalName,
      scope: 'installation',
      features: ['distributed-multiwriter'],
      optional: false,
    })
    assert.equal(refusal(missing), 'incompatible/feature_missing')
    await seeded(provider)
    const read = must(await provider.read({ kind: 'authority', logicalAuthorityId: 'state-auth' }, context()))
    assert.equal(read.kind, 'authority')
    if (read.kind !== 'authority') throw new Error('authority read')
    assert.equal(read.revision, 1)
    await host.close('directory-selection')
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
        {
          upgradeId: 'upgrade-1',
          validationRef: proof,
          authorityIds: ['state-auth'],
          sourceFences: requestFor(route, 1, proof).publication.sourceFences,
        },
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
  const root = mkdtempSync(join(tmpdir(), `authority-directory-${recipe}-recover-`))
  const first = openAt(recipe, root)
  try {
    const route = await seeded(first)
    const proof = validation()
    must(
      await first.approveUpgrade(
        {
          upgradeId: 'upgrade-1',
          validationRef: proof,
          authorityIds: ['state-auth'],
          sourceFences: requestFor(route, 1, proof).publication.sourceFences,
        },
        context(),
      ),
    )
    const request = requestFor(route, 1, proof)
    const published = must(await first.compareAndSwap(request, context()))
    await first.dispose()
    const payload = join(root, 'recover.json')
    writeFileSync(
      payload,
      JSON.stringify({
        implementation: recipe,
        authority: AUTHORITY,
        principalRef: PRINCIPAL,
        phase: null,
        request,
      }),
    )
    const recovered = JSON.parse(
      execFileSync(
        process.execPath,
        [
          '--import',
          'tsx',
          fileURLToPath(new URL('../fixtures/authority-directory-process.ts', import.meta.url)),
          'recover',
          join(root, 'dir'),
          join(root, 'anchor'),
          payload,
        ],
        { cwd: repoRoot(), encoding: 'utf8', timeout: 30_000 },
      ),
    ) as Outcome<AuthorityDirectoryCompareAndSwapResult>
    const replay = must(recovered)
    assert.deepEqual(replay, published)
    return evidence(
      recipe,
      documentDigest({ revision: replay.routes[0]?.revision ?? 0 }),
      documentDigest({ recipe, scenario: 'recover' }),
      'fresh-process replay revision 2',
    )
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

async function dispose(recipe: Recipe): Promise<AuthorityDirectoryScenarioEvidence> {
  const leftRoot = mkdtempSync(join(tmpdir(), `authority-directory-${recipe}-dispose-`))
  const rightRoot = mkdtempSync(join(tmpdir(), `authority-directory-${recipe}-sibling-`))
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
  filesystem?: 'unsupported',
): Promise<void> {
  assert.notEqual(command, '')
  const build = getConformanceBuildIdentity()
  for (const providerId of providers) {
    const recipe = recipeOf(providerId)
    // Probe the implementation on the same temporary filesystem before running its scenarios.
    let support: Promise<AuthorityRoute> | undefined
    const run = async (
      scenario: (recipe: Recipe) => Promise<AuthorityDirectoryScenarioEvidence>,
    ): Promise<AuthorityDirectoryScenarioEvidence> => {
      try {
        support ??= withProvider(recipe, filesystem, seeded)
        await support
      } catch (error) {
        if (
          !(error instanceof DirectoryRefusal) ||
          error.refusal.code !== 'incompatible' ||
          error.refusal.detailCode !== 'filesystem_unsupported'
        )
          throw error
        return {
          passed: false,
          status: 'skipped',
          providerDigest: providerDigest(recipe),
          configDigest: 'unavailable',
          releaseSetDigest: 'unavailable',
          detail: `${error.message} on ${build.platform}`,
        }
      }
      return scenario(recipe)
    }
    const binding: AuthorityDirectoryConformanceBinding = {
      command,
      build,
      providerId,
      port: {
        recipe,
        select: () => run(select),
        normal: () => run(normal),
        deny: () => run(deny),
        cancel: () => run(cancel),
        recover: () => run(recover),
        dispose: () => run(dispose),
      },
    }
    registerAuthorityDirectoryContract(harness, binding)
  }
}

export async function bindConformance(
  harness: ConformanceHarness,
  request: {
    readonly command: string
    readonly contracts: readonly string[] | 'all'
    readonly providers: readonly string[]
  },
): Promise<{ readonly contracts: readonly string[]; readonly providers: readonly string[] }> {
  const contract = 'agh.authority-directory'
  if (request.contracts !== 'all' && !request.contracts.includes(contract)) {
    return { contracts: [], providers: [] }
  }
  const providers = request.providers.filter((id) =>
    ['default', 'reference', 'agh.default/authority-directory', 'agh.reference/authority-directory'].includes(
      id,
    ),
  )
  if (providers.length > 0) await bindAuthorityDirectoryContracts(harness, request.command, providers)
  return { contracts: [contract], providers }
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
        {
          upgradeId: 'upgrade-1',
          validationRef: proof,
          authorityIds: ['state-auth'],
          sourceFences: requestFor(route, 1, proof).publication.sourceFences,
        },
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
        {
          upgradeId: 'upgrade-1',
          validationRef: proof,
          authorityIds: ['state-auth'],
          sourceFences: requestFor(route, 1, proof).publication.sourceFences,
        },
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
