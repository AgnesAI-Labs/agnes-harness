import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import type { CallContext, Outcome } from '@agnes/extension-api/runtime'
import type {
  AuthorityCheckpoint,
  AuthorityDirectoryCompareAndSwapRequest,
  AuthorityFence,
  AuthorityRoute,
  DataRef,
  DispatchAtomicDomain,
  JsonValue,
  MigrationRequest,
  StateAuthorityRef,
} from '@agnes/protocol/runtime'
import { canonicalJsonDigest } from '@agnes/protocol/runtime'
import { describe, expect, it } from 'vitest'
import { inlineData } from '../../src/runtime/maintenance/authority-publication.js'
import { openBootstrapAnchor, readStageZero } from '../../src/runtime/maintenance/bootstrap-locator.js'
import {
  type AuthorityDirectoryProvider,
  createAuthorityDirectoryProvider,
  createDirectoryAnchor,
  type DurabilityPhase,
} from '../../src/runtime/providers/authority-directory.js'

const PRINCIPAL = 'maintainer'
const AUTHORITY: StateAuthorityRef = {
  authorityId: 'directory-authority',
  tenantId: 'tenant-a',
  authorityEpoch: 1,
}
const STATE_BINDING = {
  bindingId: 'state-binding',
  contract: 'agh.state',
  logicalName: 'state',
  providerId: 'agh.default/state',
}
const BUDGET_BINDING = {
  bindingId: 'budget-binding',
  contract: 'agh.budget',
  logicalName: 'budget',
  providerId: 'agh.default/budget',
}
const COHORT = '11'.repeat(32)
const NEXT_COHORT = '22'.repeat(32)

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

function detail(outcome: Outcome<unknown>): string {
  return outcome.ok ? 'ok' : `${outcome.error.code}/${outcome.error.detailCode}`
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
  cohort = COHORT,
): AuthorityRoute {
  return {
    logicalAuthorityId: id,
    tenantId: 'tenant-a',
    authorityEpoch: epoch,
    providerBinding: id.startsWith('budget') ? BUDGET_BINDING : STATE_BINDING,
    locationRef: `loc-${id}-${String(epoch)}`,
    cohortDigest: cohort,
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

function openAt(
  root: string,
  phase?: DurabilityPhase,
): { directory: string; anchor: string; provider: AuthorityDirectoryProvider } {
  const directory = join(root, 'dir')
  const anchor = join(root, 'anchor')
  const locator = {
    directoryId: 'directory-1',
    providerLockRef: lockRef(),
    endpointRef: directory,
    epoch: 1,
    revision: 1,
    cutoverId: 'locator-1',
  }
  const created = createDirectoryAnchor(anchor, locator, PRINCIPAL)
  if (!created.ok) throw new Error(detail(created))
  const provider = createAuthorityDirectoryProvider({
    directory,
    anchor,
    authority: AUTHORITY,
    ...(phase === undefined
      ? {}
      : {
          onPhase: (current: DurabilityPhase) => {
            if (current === phase) throw new Error(`stop ${current}`)
          },
        }),
  })
  return { directory, anchor, provider }
}

function fresh(label: string, phase?: DurabilityPhase) {
  const root = mkdtempSync(`/tmp/${label}-`)
  return { root, ...openAt(root, phase) }
}

async function seed(provider: AuthorityDirectoryProvider, id: string): Promise<AuthorityRoute> {
  const route = makeRoute(id, 1, `seed-${id}`, null)
  const seeded = await provider.seedRoute(route, context())
  expect(detail(seeded)).toBe('ok')
  return route
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

function advance(
  route: AuthorityRoute,
  cutoverId: string,
  expectedRevision: number,
  cohort = COHORT,
): AuthorityDirectoryCompareAndSwapRequest['publication']['changes'][number] {
  const next = makeRoute(
    route.logicalAuthorityId,
    route.authorityEpoch + 1,
    cutoverId,
    { authorityEpoch: route.authorityEpoch, locationRef: route.locationRef, cutoverId: route.cutoverId },
    cohort,
  )
  return { expectedRevision, previous: route, next }
}

function requestFor(
  changes: AuthorityDirectoryCompareAndSwapRequest['publication']['changes'],
  upgradeId: string,
  cutoverId: string,
  proof: DataRef,
  mappings: AuthorityDirectoryCompareAndSwapRequest['publication']['jointDispatchMappings'] = [],
): AuthorityDirectoryCompareAndSwapRequest {
  return {
    transactionId: cutoverId,
    authority: AUTHORITY,
    expectedWriterEpoch: 1,
    publication: {
      upgradeId,
      cutoverId,
      changes,
      sourceFences: changes.map((change) => fenceFor(change.previous, upgradeId, cutoverId)),
      validationRef: proof,
      jointDispatchMappings: mappings,
    },
  }
}

async function approve(
  provider: AuthorityDirectoryProvider,
  upgradeId: string,
  proof: DataRef,
  authorityIds: readonly string[],
) {
  const approved = await provider.approveUpgrade({ upgradeId, validationRef: proof, authorityIds }, context())
  expect(detail(approved)).toBe('ok')
}

describe('authority directory', () => {
  it('seeds, publishes one revision, and replays the original result after a later publication', async () => {
    const opened = fresh('p04-replay')
    try {
      const route = await seed(opened.provider, 'state-auth')
      const proof = validation()
      await approve(opened.provider, 'upgrade-1', proof, ['state-auth'])
      const first = requestFor([advance(route, 'cutover-1', 1)], 'upgrade-1', 'cutover-1', proof)
      const published = await opened.provider.compareAndSwap(first, context())
      expect(detail(published)).toBe('ok')
      if (!published.ok) return
      expect(published.value.routes).toEqual([
        { logicalAuthorityId: 'state-auth', revision: 2, authorityEpoch: 2 },
      ])
      const read = await opened.provider.read(
        { kind: 'authority', logicalAuthorityId: 'state-auth' },
        context(),
      )
      expect(read.ok && read.value.kind === 'authority' && read.value.route.providerBinding).toEqual(
        STATE_BINDING,
      )
      expect(read.ok && read.value.kind === 'authority' && read.value.route.locationRef).toBe(
        'loc-state-auth-2',
      )

      const secondRoute = read.ok && read.value.kind === 'authority' ? read.value.route : route
      const secondProof = validation()
      await approve(opened.provider, 'upgrade-2', secondProof, ['state-auth'])
      const second = requestFor(
        [advance(secondRoute, 'cutover-2', 2, NEXT_COHORT)],
        'upgrade-2',
        'cutover-2',
        secondProof,
      )
      expect(detail(await opened.provider.compareAndSwap(second, context()))).toBe('ok')
      const replay = await opened.provider.compareAndSwap(first, context())
      expect(replay).toEqual(published)
      const stale = {
        ...first,
        publication: {
          ...first.publication,
          validationRef: inlineData({ accepted: false } as JsonValue, 'agh.maintenance/validation@1'),
        },
      }
      expect(detail(await opened.provider.compareAndSwap(stale, context()))).toBe(
        'conflict/cutover_identity_conflict',
      )
    } finally {
      rmSync(opened.root, { recursive: true, force: true })
    }
  })

  it('publishes nothing when a second member revision does not match', async () => {
    const opened = fresh('p04-zero')
    try {
      const state = await seed(opened.provider, 'state-auth')
      const budget = await seed(opened.provider, 'budget-auth')
      const proof = validation()
      await approve(opened.provider, 'upgrade-1', proof, ['state-auth', 'budget-auth'])
      const request = requestFor(
        [advance(state, 'cutover-1', 1), advance(budget, 'cutover-1', 9)],
        'upgrade-1',
        'cutover-1',
        proof,
      )
      expect(detail(await opened.provider.compareAndSwap(request, context()))).toBe(
        'conflict/revision_mismatch',
      )
      const left = await opened.provider.read(
        { kind: 'authority', logicalAuthorityId: 'state-auth' },
        context(),
      )
      const right = await opened.provider.read(
        { kind: 'authority', logicalAuthorityId: 'budget-auth' },
        context(),
      )
      expect(left.ok && left.value.kind === 'authority' && left.value.revision).toBe(1)
      expect(right.ok && right.value.kind === 'authority' && right.value.revision).toBe(1)
      expect(detail(await opened.provider.probeCutover('cutover-1', context()))).toBe('ok')
      const probe = await opened.provider.probeCutover('cutover-1', context())
      expect(probe.ok && probe.value).toEqual({ state: 'absent' })
    } finally {
      rmSync(opened.root, { recursive: true, force: true })
    }
  })

  it('lets exactly one of two cutovers win the same revision', async () => {
    const opened = fresh('p04-race')
    try {
      const route = await seed(opened.provider, 'state-auth')
      const proof = validation()
      await approve(opened.provider, 'upgrade-1', proof, ['state-auth'])
      const left = requestFor([advance(route, 'cutover-a', 1)], 'upgrade-1', 'cutover-a', proof)
      const right = requestFor([advance(route, 'cutover-b', 1, NEXT_COHORT)], 'upgrade-1', 'cutover-b', proof)
      const [first, second] = await Promise.all([
        opened.provider.compareAndSwap(left, context()),
        opened.provider.compareAndSwap(right, context()),
      ])
      const winners = [first, second].filter((item) => item.ok)
      expect(winners).toHaveLength(1)
      const loser = first.ok ? right : left
      expect(detail(first.ok ? second : first)).toBe('conflict/revision_mismatch')
      const swapped = { ...loser, transactionId: winners[0] && first.ok ? 'cutover-a' : 'cutover-b' }
      expect(detail(await opened.provider.compareAndSwap(swapped, context()))).toBe(
        'invalid_input/cutover_transaction_mismatch',
      )
    } finally {
      rmSync(opened.root, { recursive: true, force: true })
    }
  })

  it('refuses a bad principal, a cancelled call, a disposed handle, and an unsupported filesystem', async () => {
    const opened = fresh('p04-refuse')
    const unsupportedRoot = mkdtempSync('/tmp/p04-nfs-')
    try {
      const route = makeRoute('state-auth', 1, 'seed-state-auth', null)
      expect(detail(await opened.provider.seedRoute(route, context('other-principal')))).toBe(
        'denied/maintenance_principal',
      )
      const controller = new AbortController()
      controller.abort()
      expect(detail(await opened.provider.seedRoute(route, context(PRINCIPAL, controller.signal)))).toBe(
        'cancelled/directory_cancelled',
      )
      expect(readFileSync.bind(null, join(opened.directory, 'current'))).toThrow()
      await opened.provider.dispose()
      expect(detail(await opened.provider.seedRoute(route, context()))).toBe('denied/directory_disposed')
      const sibling = openAt(mkdtempSync('/tmp/p04-sibling-'))
      expect(detail(await sibling.provider.seedRoute(route, context()))).toBe('ok')
      rmSync(join(sibling.directory, '..'), { recursive: true, force: true })

      const directory = join(unsupportedRoot, 'dir')
      const anchor = join(unsupportedRoot, 'anchor')
      const created = createDirectoryAnchor(
        anchor,
        {
          directoryId: 'directory-1',
          providerLockRef: lockRef(),
          endpointRef: directory,
          epoch: 1,
          revision: 1,
          cutoverId: 'locator-1',
        },
        PRINCIPAL,
      )
      expect(created.ok).toBe(true)
      const provider = createAuthorityDirectoryProvider({
        directory,
        anchor,
        authority: AUTHORITY,
        filesystem: 'unsupported',
      })
      expect(provider.features).not.toContain('local-fs-rename')
      expect(detail(await provider.seedRoute(route, context()))).toBe('incompatible/filesystem_unsupported')
    } finally {
      rmSync(opened.root, { recursive: true, force: true })
      rmSync(unsupportedRoot, { recursive: true, force: true })
    }
  })

  it('stops control writes when the locator epoch is uncertain and still diagnoses from the anchor', async () => {
    const opened = fresh('p04-anchor')
    try {
      const route = await seed(opened.provider, 'state-auth')
      const diagnosed = readStageZero(opened.anchor)
      expect(diagnosed.ok && diagnosed.value?.locator.endpointRef).toBe(opened.directory)
      rmSync(opened.directory, { recursive: true, force: true })
      expect(readStageZero(opened.anchor).ok).toBe(true)
      const restored = createAuthorityDirectoryProvider({
        directory: opened.directory,
        anchor: opened.anchor,
        authority: AUTHORITY,
      })
      expect(
        detail(await restored.read({ kind: 'authority', logicalAuthorityId: 'state-auth' }, context())),
      ).toBe('incompatible/route_absent')
      await seed(restored, 'state-auth')
      const handle = openBootstrapAnchor(opened.anchor)
      expect(handle.ok).toBe(true)
      if (!handle.ok || !diagnosed.ok || !diagnosed.value) return
      const moved = handle.value.compareAndSwap(diagnosed.value.locator.revision, {
        ...diagnosed.value.locator,
        epoch: diagnosed.value.locator.epoch + 1,
        revision: diagnosed.value.locator.revision + 1,
        cutoverId: 'locator-gap',
      })
      expect(moved.ok).toBe(true)
      const proof = validation()
      expect(
        detail(
          await restored.approveUpgrade(
            { upgradeId: 'upgrade-1', validationRef: proof, authorityIds: ['state-auth'] },
            context(),
          ),
        ),
      ).toBe('conflict/locator_uncertain')
      expect(
        detail(
          await restored.compareAndSwap(
            requestFor([advance(route, 'cutover-1', 1)], 'upgrade-1', 'cutover-1', proof),
            context(),
          ),
        ),
      ).toBe('conflict/locator_uncertain')
    } finally {
      rmSync(opened.root, { recursive: true, force: true })
    }
  })

  it('keeps the previous route when a pre-commit phase fails and the new route when commit or notify fails', async () => {
    for (const phase of ['temp', 'fsync', 'rename'] as const) {
      const opened = fresh(`p04-${phase}`)
      try {
        const route = await seed(opened.provider, 'state-auth')
        const proof = validation()
        await approve(opened.provider, 'upgrade-1', proof, ['state-auth'])
        const crashing = createAuthorityDirectoryProvider({
          directory: opened.directory,
          anchor: opened.anchor,
          authority: AUTHORITY,
          onPhase: (current) => {
            if (current === phase) throw new Error(`stop ${current}`)
          },
        })
        const request = requestFor([advance(route, 'cutover-1', 1)], 'upgrade-1', 'cutover-1', proof)
        expect(detail(await crashing.compareAndSwap(request, context()))).toBe('retryable/durability_failed')
        const reread = createAuthorityDirectoryProvider({
          directory: opened.directory,
          anchor: opened.anchor,
          authority: AUTHORITY,
        })
        const read = await reread.read({ kind: 'authority', logicalAuthorityId: 'state-auth' }, context())
        expect(read.ok && read.value.kind === 'authority' && read.value.revision).toBe(1)
        expect(detail(await reread.compareAndSwap(request, context()))).toBe('ok')
      } finally {
        rmSync(opened.root, { recursive: true, force: true })
      }
    }
    for (const phase of ['commit', 'notify'] as const) {
      const opened = fresh(`p04-${phase}`)
      try {
        const route = await seed(opened.provider, 'state-auth')
        const proof = validation()
        await approve(opened.provider, 'upgrade-1', proof, ['state-auth'])
        const crashing = createAuthorityDirectoryProvider({
          directory: opened.directory,
          anchor: opened.anchor,
          authority: AUTHORITY,
          onPhase: (current) => {
            if (current === phase) throw new Error(`stop ${current}`)
          },
        })
        const request = requestFor([advance(route, 'cutover-1', 1)], 'upgrade-1', 'cutover-1', proof)
        await expect(crashing.compareAndSwap(request, context())).rejects.toThrow(`durability phase ${phase}`)
        const reread = createAuthorityDirectoryProvider({
          directory: opened.directory,
          anchor: opened.anchor,
          authority: AUTHORITY,
        })
        const read = await reread.read({ kind: 'authority', logicalAuthorityId: 'state-auth' }, context())
        expect(read.ok && read.value.kind === 'authority' && read.value.revision).toBe(2)
        const replay = await reread.compareAndSwap(request, context())
        expect(replay.ok && replay.value.routes[0]?.revision).toBe(2)
      } finally {
        rmSync(opened.root, { recursive: true, force: true })
      }
    }
  })

  it('maps a joint cohort only after both members are activated', async () => {
    const opened = fresh('p04-joint')
    try {
      const state = await seed(opened.provider, 'state-auth')
      const budget = await seed(opened.provider, 'budget-auth')
      const proof = validation()
      await approve(opened.provider, 'upgrade-1', proof, ['state-auth', 'budget-auth'])
      const stateChange = advance(state, 'cutover-1', 1, NEXT_COHORT)
      const budgetChange = advance(budget, 'cutover-1', 1, NEXT_COHORT)
      const from: DispatchAtomicDomain = {
        domainId: 'domain-1',
        revision: 1,
        stateAuthority: { authorityId: 'state-auth', tenantId: 'tenant-a', authorityEpoch: 1 },
        budgetAuthority: { authorityId: 'budget-auth', tenantId: 'tenant-a', authorityEpoch: 1 },
        stateBinding: STATE_BINDING,
        budgetBinding: BUDGET_BINDING,
      }
      const to: DispatchAtomicDomain = {
        domainId: 'domain-1',
        revision: 2,
        stateAuthority: { authorityId: 'state-auth', tenantId: 'tenant-a', authorityEpoch: 2 },
        budgetAuthority: { authorityId: 'budget-auth', tenantId: 'tenant-a', authorityEpoch: 2 },
        stateBinding: STATE_BINDING,
        budgetBinding: BUDGET_BINDING,
      }
      const request = requestFor([budgetChange, stateChange], 'upgrade-1', 'cutover-1', proof, [
        { domainId: 'domain-1', from, to, cohortDigest: NEXT_COHORT, validationRef: proof },
      ])
      const published = await opened.provider.compareAndSwap(request, context())
      expect(detail(published)).toBe('ok')
      if (!published.ok) return
      expect(published.value.routes.map((item) => item.logicalAuthorityId)).toEqual([
        'budget-auth',
        'state-auth',
      ])
      const unmapped = await opened.provider.read(
        { kind: 'joint-dispatch', domainId: 'missing-domain', from: { ...from, domainId: 'missing-domain' } },
        context(),
      )
      expect(unmapped.ok && unmapped.value.kind === 'joint-dispatch' && unmapped.value.resolution.state).toBe(
        'unmapped',
      )
      const inactive = await opened.provider.read(
        { kind: 'joint-dispatch', domainId: 'domain-1', from },
        context(),
      )
      expect(detail(inactive)).toBe('incompatible/joint_member_inactive')
      expect(
        detail(
          await opened.provider.recordActivation(
            { logicalAuthorityId: 'state-auth', authorityEpoch: 2, cutoverId: 'cutover-1' },
            context(),
          ),
        ),
      ).toBe('ok')
      expect(
        detail(await opened.provider.read({ kind: 'joint-dispatch', domainId: 'domain-1', from }, context())),
      ).toBe('incompatible/joint_member_inactive')
      expect(
        detail(
          await opened.provider.recordActivation(
            { logicalAuthorityId: 'budget-auth', authorityEpoch: 2, cutoverId: 'cutover-1' },
            context(),
          ),
        ),
      ).toBe('ok')
      const mapped = await opened.provider.read(
        { kind: 'joint-dispatch', domainId: 'domain-1', from },
        context(),
      )
      expect(mapped.ok && mapped.value.kind === 'joint-dispatch' && mapped.value.resolution.state).toBe(
        'mapped',
      )
      const stranger = { ...from, revision: 9 }
      expect(
        detail(
          await opened.provider.read(
            { kind: 'joint-dispatch', domainId: 'domain-1', from: stranger },
            context(),
          ),
        ),
      ).toBe('incompatible/joint_chain_broken')
    } finally {
      rmSync(opened.root, { recursive: true, force: true })
    }
  })

  it('moves the directory onto the external anchor and adopts that route after a lost activation', async () => {
    const opened = fresh('p04-move')
    try {
      await seed(opened.provider, 'state-auth')
      const proof = lockRef()
      const request: MigrationRequest = {
        upgradeId: 'move-1',
        target: {
          kind: 'directory',
          sourceLocatorRevision: 1,
          targetProviderLock: proof,
          targetLocationRef: 'next',
          externalJournalRef: 'journal-1',
        },
        policyRef: 'policy-1',
        reason: 'relocate',
        mode: 'explicit',
      }
      const moved = await opened.provider.transfer(request, context())
      expect(detail(moved)).toBe('ok')
      if (!moved.ok) return
      expect(moved.value.state).toBe('committed')
      const standby = join(opened.root, 'standby', 'next')
      const relocated = createAuthorityDirectoryProvider({
        directory: standby,
        anchor: opened.anchor,
        authority: AUTHORITY,
      })
      const read = await relocated.read({ kind: 'authority', logicalAuthorityId: 'state-auth' }, context())
      expect(read.ok && read.value.kind === 'authority' && read.value.revision).toBe(1)
      expect(
        detail(
          await opened.provider.read({ kind: 'authority', logicalAuthorityId: 'state-auth' }, context()),
        ),
      ).toBe('conflict/locator_uncertain')
      expect(
        detail(
          await opened.provider.transfer(
            {
              ...request,
              target: {
                kind: 'run-state',
                runId: 'run-1',
                sourceBindingId: 'binding-1',
                targetBindingId: 'binding-2',
              },
            },
            context(),
          ),
        ),
      ).toBe('incompatible/transfer_kind_unsupported')
    } finally {
      rmSync(opened.root, { recursive: true, force: true })
    }
  })

  it('adopts the copied directory when the locator moves before the new store is activated', async () => {
    const opened = fresh('p04-adopt')
    try {
      await seed(opened.provider, 'state-auth')
      expect(detail(await opened.provider.freeze(context()))).toBe('ok')
      const currentId = readFileSync(join(opened.directory, 'current'), 'utf8').trim()
      const document = JSON.parse(
        readFileSync(join(opened.directory, 'generations', canonicalJsonDigest(currentId)), 'utf8'),
      ) as { head: JsonValue }
      const standby = join(opened.root, 'standby', 'held')
      mkdirSync(standby, { recursive: true })
      for (const name of ['current', 'generations', 'seals']) {
        cpSync(join(opened.directory, name), join(standby, name), { recursive: true })
      }
      const handle = openBootstrapAnchor(opened.anchor)
      expect(handle.ok).toBe(true)
      if (!handle.ok) return
      const view = handle.value.read()
      expect(view.ok).toBe(true)
      if (!view.ok) return
      expect(
        handle.value.writeJournal('move-2', {
          upgradeId: 'move-2',
          toEndpoint: standby,
          toEpoch: view.value.locator.epoch + 1,
          headDigest: canonicalJsonDigest(document.head),
        }).ok,
      ).toBe(true)
      expect(
        handle.value.compareAndSwap(view.value.locator.revision, {
          ...view.value.locator,
          endpointRef: standby,
          epoch: view.value.locator.epoch + 1,
          revision: view.value.locator.revision + 1,
          cutoverId: 'move-2',
        }).ok,
      ).toBe(true)
      const relocated = createAuthorityDirectoryProvider({
        directory: standby,
        anchor: opened.anchor,
        authority: AUTHORITY,
      })
      const read = await relocated.read({ kind: 'authority', logicalAuthorityId: 'state-auth' }, context())
      expect(detail(read)).toBe('ok')
      expect(read.ok && read.value.kind === 'authority' && read.value.revision).toBe(1)
    } finally {
      rmSync(opened.root, { recursive: true, force: true })
    }
  })
})
