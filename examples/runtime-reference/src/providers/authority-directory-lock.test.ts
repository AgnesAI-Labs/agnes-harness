import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { CallContext, Outcome } from '@agnes/extension-api/runtime'
import type {
  AuthorityCheckpoint,
  AuthorityDirectoryCompareAndSwapRequest,
  AuthorityDirectoryReadRequest,
  AuthorityRoute,
  DataRef,
  DispatchAtomicDomain,
  JsonValue,
  MigrationRequest,
} from '@agnes/protocol/runtime'
import { describe, expect, it } from 'vitest'
import { inlineData } from '../../../../packages/host/src/runtime/maintenance/authority-publication.js'
import { openBootstrapAnchor } from '../../../../packages/host/src/runtime/maintenance/bootstrap-locator.js'
import {
  createAuthorityDirectoryProvider,
  createDirectoryAnchor,
} from '../../../../packages/host/src/runtime/providers/authority-directory.js'
import {
  createReferenceAnchor,
  createReferenceAuthorityDirectory,
  openReferenceAnchor,
} from './authority-directory.ts'

const PRINCIPAL = 'maintainer'
const AUTHORITY = { authorityId: 'directory-authority', tenantId: 'tenant-a', authorityEpoch: 1 }
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

function code(outcome: Outcome<unknown>): string {
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

function proof(): DataRef {
  return inlineData({ accepted: true } as JsonValue, 'agh.maintenance/validation@1')
}

function lockRef(): DataRef {
  return inlineData({ lock: 'directory' } as JsonValue, 'agh.maintenance/provider-lock@1')
}

function advance(route: AuthorityRoute, cutoverId: string, expectedRevision: number, cohort = COHORT) {
  const next = makeRoute(
    route.logicalAuthorityId,
    route.authorityEpoch + 1,
    cutoverId,
    { authorityEpoch: route.authorityEpoch, locationRef: route.locationRef, cutoverId: route.cutoverId },
    cohort,
  )
  return { expectedRevision, previous: route, next }
}

function publication(
  changes: AuthorityDirectoryCompareAndSwapRequest['publication']['changes'],
  upgradeId: string,
  cutoverId: string,
  validationRef: DataRef,
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
      sourceFences: changes.map((change) => ({
        upgradeId,
        source: {
          authorityId: change.previous.logicalAuthorityId,
          tenantId: change.previous.tenantId,
          authorityEpoch: change.previous.authorityEpoch,
        },
        fenceId: `fence-${cutoverId}-${change.previous.logicalAuthorityId}`,
        fenceEpoch: change.previous.authorityEpoch,
        checkpoint: change.previous.checkpoint,
        writerCredentialsRevoked: true,
      })),
      validationRef,
      jointDispatchMappings: mappings,
    },
  }
}

function collapsed(source: string): Set<string> {
  const lines = new Set<string>()
  for (const line of source.split('\n')) {
    const text = line.replace(/\s+/g, '')
    if (text !== '') lines.add(text)
  }
  return lines
}

function sharedFraction(left: Set<string>, right: Set<string>): number {
  const smaller = Math.min(left.size, right.size)
  if (smaller === 0) return 1
  let shared = 0
  for (const line of left) if (right.has(line)) shared += 1
  return shared / smaller
}

interface Driver {
  readonly provider: {
    seedRoute(route: AuthorityRoute, context: CallContext): Promise<Outcome<{ revision: number }>>
    approveUpgrade(
      input: { upgradeId: string; validationRef: DataRef; authorityIds: readonly string[] },
      context: CallContext,
    ): Promise<Outcome<{ upgradeId: string }>>
    compareAndSwap(
      request: AuthorityDirectoryCompareAndSwapRequest,
      context: CallContext,
    ): Promise<Outcome<unknown>>
    read(request: AuthorityDirectoryReadRequest, context: CallContext): Promise<Outcome<unknown>>
    transfer(request: MigrationRequest, context: CallContext): Promise<Outcome<unknown>>
    recordActivation(
      input: { logicalAuthorityId: string; authorityEpoch: number; cutoverId: string },
      context: CallContext,
    ): Promise<Outcome<unknown>>
    freeze(context: CallContext): Promise<Outcome<unknown>>
    releaseFreeze(context: CallContext): Promise<Outcome<unknown>>
    probeCutover(id: string, context: CallContext): Promise<Outcome<unknown>>
    dispose(): Promise<void>
  }
  readonly directory: string
  readonly anchor: string
  readonly root: string
  bump(): Outcome<unknown>
}

function openDefault(label: string, filesystem?: 'unsupported'): Driver {
  const root = mkdtempSync(join(tmpdir(), `${label}-`))
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
  if (!created.ok) throw new Error(code(created))
  const provider = createAuthorityDirectoryProvider({ directory, anchor, authority: AUTHORITY, filesystem })
  return {
    provider,
    directory,
    anchor,
    root,
    bump() {
      const handle = openBootstrapAnchor(anchor)
      if (!handle.ok) return handle
      const view = handle.value.read()
      if (!view.ok) return view
      return handle.value.compareAndSwap(view.value.locator.revision, {
        ...view.value.locator,
        epoch: view.value.locator.epoch + 1,
        revision: view.value.locator.revision + 1,
        cutoverId: 'locator-gap',
      })
    },
  }
}

function openReference(label: string, filesystem?: 'unsupported'): Driver {
  const root = mkdtempSync(join(tmpdir(), `${label}-`))
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
  const created = createReferenceAnchor(anchor, locator, PRINCIPAL)
  if (!created.ok) throw new Error(code(created))
  const provider = createReferenceAuthorityDirectory({ directory, anchor, authority: AUTHORITY, filesystem })
  return {
    provider,
    directory,
    anchor,
    root,
    bump() {
      const handle = openReferenceAnchor(anchor)
      if (!handle.ok) return handle
      const view = handle.value.read()
      if (!view.ok) return view
      return handle.value.compareAndSwap(view.value.locator.revision, {
        ...view.value.locator,
        epoch: view.value.locator.epoch + 1,
        revision: view.value.locator.revision + 1,
        cutoverId: 'locator-gap',
      })
    },
  }
}

async function same(
  left: Driver,
  right: Driver,
  label: string,
  run: (driver: Driver) => Promise<Outcome<unknown>>,
) {
  const first = await run(left)
  const second = await run(right)
  expect(code(second), label).toBe(code(first))
  if (first.ok && second.ok) expect(second.value, label).toEqual(first.value)
  return first
}

describe('reference authority directory', () => {
  it('does not import the host implementation and stays under half line overlap', () => {
    const reference = readFileSync(new URL('./authority-directory.ts', import.meta.url), 'utf8')
    expect(reference).not.toContain('@agnes/host')
    expect(reference).not.toContain('packages/host')
    const defaults = ['authority-directory.ts', 'authority-publication.ts', 'bootstrap-locator.ts']
      .map((name) =>
        readFileSync(
          new URL(
            name === 'authority-directory.ts'
              ? '../../../../packages/host/src/runtime/providers/authority-directory.ts'
              : `../../../../packages/host/src/runtime/maintenance/${name}`,
            import.meta.url,
          ),
          'utf8',
        ),
      )
      .join('\n')
    const refLines = collapsed(reference)
    expect(sharedFraction(refLines, collapsed(defaults))).toBeLessThanOrEqual(0.5)
    for (const file of [
      '../../../../packages/host/src/runtime/providers/authority-directory.ts',
      '../../../../packages/host/src/runtime/maintenance/authority-publication.ts',
      '../../../../packages/host/src/runtime/maintenance/bootstrap-locator.ts',
    ])
      expect(
        sharedFraction(refLines, collapsed(readFileSync(new URL(file, import.meta.url), 'utf8'))),
      ).toBeLessThanOrEqual(0.5)
  })

  it('agrees with the default directory on publish, refusal, replay, and relocation', async () => {
    const left = openDefault('authority-directory-default')
    const right = openReference('authority-directory-reference')
    try {
      const route = makeRoute('state-auth', 1, 'seed-state-auth', null)
      await same(left, right, 'deny', (driver) =>
        driver.provider.seedRoute(route, context('other-principal')),
      )
      const controller = new AbortController()
      controller.abort()
      await same(left, right, 'cancel', (driver) =>
        driver.provider.seedRoute(route, context(PRINCIPAL, controller.signal)),
      )
      await same(left, right, 'seed', (driver) => driver.provider.seedRoute(route, context()))
      for (const logicalAuthorityId of ['toString', 'constructor', '__proto__']) {
        const absent = await same(left, right, 'reserved-looking ID absent', (driver) =>
          driver.provider.read({ kind: 'authority', logicalAuthorityId }, context()),
        )
        expect(code(absent)).toBe('incompatible/route_absent')
        const specialRoute = makeRoute(logicalAuthorityId, 1, `seed-${logicalAuthorityId}`, null)
        const seeded = await same(left, right, 'reserved-looking ID seed', (driver) =>
          driver.provider.seedRoute(specialRoute, context()),
        )
        expect(code(seeded)).toBe('ok')
        const readSpecial = await same(left, right, 'reserved-looking ID read', (driver) =>
          driver.provider.read({ kind: 'authority', logicalAuthorityId }, context()),
        )
        expect(readSpecial.ok && (readSpecial.value as { route: AuthorityRoute }).route).toEqual(specialRoute)
      }
      const validation = proof()
      await same(left, right, 'approve', (driver) =>
        driver.provider.approveUpgrade(
          { upgradeId: 'upgrade-1', validationRef: validation, authorityIds: ['state-auth'] },
          context(),
        ),
      )
      const first = publication([advance(route, 'cutover-1', 1)], 'upgrade-1', 'cutover-1', validation)
      const invalid: readonly [string, AuthorityDirectoryCompareAndSwapRequest][] = [
        ['invalid_input/cutover_transaction_mismatch', { ...first, transactionId: 'different' }],
        ['conflict/writer_epoch', { ...first, expectedWriterEpoch: 9 }],
        ['conflict/directory_authority', { ...first, authority: { ...first.authority, authorityEpoch: 9 } }],
        [
          'invalid_input/duplicate_authority',
          {
            ...first,
            publication: {
              ...first.publication,
              changes: [...first.publication.changes, ...first.publication.changes],
            },
          },
        ],
        [
          'incompatible/fence_incomplete',
          { ...first, publication: { ...first.publication, sourceFences: [] } },
        ],
        [
          'incompatible/fence_open',
          {
            ...first,
            publication: {
              ...first.publication,
              sourceFences: first.publication.sourceFences.map((fence) => ({
                ...fence,
                writerCredentialsRevoked: false,
              })),
            },
          },
        ],
        [
          'incompatible/fence_checkpoint',
          {
            ...first,
            publication: {
              ...first.publication,
              sourceFences: first.publication.sourceFences.map((fence) => ({
                ...fence,
                checkpoint: { ...fence.checkpoint, snapshotDigest: '99'.repeat(32) },
              })),
            },
          },
        ],
        [
          'incompatible/validation_mismatch',
          {
            ...first,
            publication: {
              ...first.publication,
              validationRef: { ...validation, bytes: validation.bytes + 1 },
            },
          },
        ],
      ]
      for (const [expected, candidate] of invalid) {
        const refused = await same(left, right, expected, (driver) =>
          driver.provider.compareAndSwap(candidate, context()),
        )
        expect(code(refused)).toBe(expected)
        const unchanged = await same(left, right, 'unchanged', (driver) =>
          driver.provider.read({ kind: 'authority', logicalAuthorityId: 'state-auth' }, context()),
        )
        expect(unchanged.ok && (unchanged.value as { revision: number }).revision).toBe(1)
        const absent = await same(left, right, 'absent', (driver) =>
          driver.provider.probeCutover('cutover-1', context()),
        )
        expect(absent.ok && absent.value).toEqual({ state: 'absent' })
      }
      await same(left, right, 'freeze', (driver) => driver.provider.freeze(context()))
      const frozen = await same(left, right, 'frozen publish', (driver) =>
        driver.provider.compareAndSwap(first, context()),
      )
      expect(code(frozen)).toBe('conflict/directory_fenced')
      const frozenSeed = await same(left, right, 'frozen seed', (driver) =>
        driver.provider.seedRoute(makeRoute('new-authority', 1, 'seed-new', null), context()),
      )
      expect(code(frozenSeed)).toBe('conflict/directory_fenced')
      const frozenApproval = await same(left, right, 'frozen approval', (driver) =>
        driver.provider.approveUpgrade(
          { upgradeId: 'new-upgrade', validationRef: validation, authorityIds: ['state-auth'] },
          context(),
        ),
      )
      expect(code(frozenApproval)).toBe('conflict/directory_fenced')
      await same(left, right, 'release freeze', (driver) => driver.provider.releaseFreeze(context()))
      const published = await same(left, right, 'publish', (driver) =>
        driver.provider.compareAndSwap(first, context()),
      )
      expect(published.ok).toBe(true)
      const read = await same(left, right, 'read', (driver) =>
        driver.provider.read({ kind: 'authority', logicalAuthorityId: 'state-auth' }, context()),
      )
      expect(read.ok).toBe(true)
      const current = read.ok ? (read.value as { route: AuthorityRoute }).route : route
      const secondProof = inlineData({ accepted: false } as JsonValue, 'agh.maintenance/validation@1')
      await same(left, right, 'approve-2', (driver) =>
        driver.provider.approveUpgrade(
          { upgradeId: 'upgrade-2', validationRef: secondProof, authorityIds: ['state-auth'] },
          context(),
        ),
      )
      const second = publication(
        [advance(current, 'cutover-2', 2, NEXT_COHORT)],
        'upgrade-2',
        'cutover-2',
        secondProof,
      )
      await same(left, right, 'second', (driver) => driver.provider.compareAndSwap(second, context()))
      const replay = await same(left, right, 'replay', (driver) =>
        driver.provider.compareAndSwap(first, context()),
      )
      expect(replay).toEqual(published)
      const unauthorizedReplay = await same(left, right, 'unauthorized replay', (driver) =>
        driver.provider.compareAndSwap(first, context('other-principal')),
      )
      expect(code(unauthorizedReplay)).toBe('denied/maintenance_principal')
      const stale = { ...first, publication: { ...first.publication, validationRef: secondProof } }
      await same(left, right, 'identity', (driver) => driver.provider.compareAndSwap(stale, context()))
      const mismatched = publication(
        [
          advance(route, 'cutover-x', 1),
          advance(makeRoute('budget-auth', 1, 'seed-budget', null), 'cutover-x', 4),
        ],
        'upgrade-1',
        'cutover-x',
        validation,
      )
      await same(left, right, 'zero', (driver) => driver.provider.compareAndSwap(mismatched, context()))
      await same(left, right, 'epoch', async (driver) => {
        const bumped = driver.bump()
        expect(bumped.ok).toBe(true)
        return driver.provider.compareAndSwap(second, context())
      })
      const moved: MigrationRequest = {
        upgradeId: 'move-1',
        target: {
          kind: 'directory',
          sourceLocatorRevision: 1,
          targetProviderLock: lockRef(),
          targetLocationRef: 'nested/one/two/next',
          externalJournalRef: 'journal-1',
        },
        policyRef: 'policy-1',
        reason: 'relocate',
        mode: 'explicit',
      }
      const relocating = {
        left: openDefault('authority-directory-move-default'),
        right: openReference('authority-directory-move-reference'),
      }
      try {
        await same(relocating.left, relocating.right, 'move-seed', (driver) =>
          driver.provider.seedRoute(route, context()),
        )
        const receipt = await same(relocating.left, relocating.right, 'move', (driver) =>
          driver.provider.transfer(moved, context()),
        )
        expect(receipt.ok).toBe(true)
        const standbyLeft = createAuthorityDirectoryProvider({
          directory: join(relocating.left.root, 'standby', 'nested/one/two/next'),
          anchor: relocating.left.anchor,
          authority: AUTHORITY,
        })
        const standbyRight = createReferenceAuthorityDirectory({
          directory: join(relocating.right.root, 'standby', 'nested/one/two/next'),
          anchor: relocating.right.anchor,
          authority: AUTHORITY,
        })
        const seenLeft = await standbyLeft.read(
          { kind: 'authority', logicalAuthorityId: 'state-auth' },
          context(),
        )
        const seenRight = await standbyRight.read(
          { kind: 'authority', logicalAuthorityId: 'state-auth' },
          context(),
        )
        expect(code(seenRight)).toBe(code(seenLeft))
        if (seenLeft.ok && seenRight.ok) expect(seenRight.value).toEqual(seenLeft.value)
      } finally {
        rmSync(relocating.left.root, { recursive: true, force: true })
        rmSync(relocating.right.root, { recursive: true, force: true })
      }
    } finally {
      rmSync(left.root, { recursive: true, force: true })
      rmSync(right.root, { recursive: true, force: true })
    }
  })

  it('agrees on a joint cohort and on an unsupported filesystem', async () => {
    const left = openDefault('authority-directory-joint-default')
    const right = openReference('authority-directory-joint-reference')
    const blockedLeft = openDefault('authority-directory-fs-default', 'unsupported')
    const blockedRight = openReference('authority-directory-fs-reference', 'unsupported')
    try {
      const state = makeRoute('state-auth', 1, 'seed-state-auth', null)
      const budget = makeRoute('budget-auth', 1, 'seed-budget-auth', null)
      await same(left, right, 'state', (driver) => driver.provider.seedRoute(state, context()))
      await same(left, right, 'budget', (driver) => driver.provider.seedRoute(budget, context()))
      const validation = proof()
      await same(left, right, 'journal', (driver) =>
        driver.provider.approveUpgrade(
          { upgradeId: 'upgrade-1', validationRef: validation, authorityIds: ['state-auth', 'budget-auth'] },
          context(),
        ),
      )
      const from: DispatchAtomicDomain = {
        domainId: 'domain-1',
        revision: 1,
        stateAuthority: { authorityId: 'state-auth', tenantId: 'tenant-a', authorityEpoch: 1 },
        budgetAuthority: { authorityId: 'budget-auth', tenantId: 'tenant-a', authorityEpoch: 1 },
        stateBinding: STATE_BINDING,
        budgetBinding: BUDGET_BINDING,
      }
      const to: DispatchAtomicDomain = {
        ...from,
        revision: 2,
        stateAuthority: { ...from.stateAuthority, authorityEpoch: 2 },
        budgetAuthority: { ...from.budgetAuthority, authorityEpoch: 2 },
      }
      const request = publication(
        [advance(budget, 'cutover-1', 1, NEXT_COHORT), advance(state, 'cutover-1', 1, NEXT_COHORT)],
        'upgrade-1',
        'cutover-1',
        validation,
        [{ domainId: 'domain-1', from, to, cohortDigest: NEXT_COHORT, validationRef: validation }],
      )
      await same(left, right, 'joint', (driver) => driver.provider.compareAndSwap(request, context()))
      const inactive = await same(left, right, 'joint inactive', (driver) =>
        driver.provider.read({ kind: 'joint-dispatch', domainId: from.domainId, from }, context()),
      )
      expect(code(inactive)).toBe('incompatible/joint_member_inactive')
      let previousState = request.publication.changes.find(
        (change) => change.next.logicalAuthorityId === 'state-auth',
      )!.next
      let previousBudget = request.publication.changes.find(
        (change) => change.next.logicalAuthorityId === 'budget-auth',
      )!.next
      let previousDomain = to
      for (let epoch = 2; epoch <= 5; epoch += 1) {
        const cutoverId = epoch === 2 ? 'cutover-1' : `cutover-${epoch}`
        if (epoch > 2) {
          const upgradeId = `upgrade-${epoch}`
          await same(left, right, 'joint journal', (driver) =>
            driver.provider.approveUpgrade(
              { upgradeId, validationRef: validation, authorityIds: ['state-auth', 'budget-auth'] },
              context(),
            ),
          )
          const stateChange = advance(previousState, cutoverId, epoch - 1, NEXT_COHORT)
          const budgetChange = advance(previousBudget, cutoverId, epoch - 1, NEXT_COHORT)
          const nextDomain = {
            ...previousDomain,
            revision: epoch,
            stateAuthority: { ...previousDomain.stateAuthority, authorityEpoch: epoch },
            budgetAuthority: { ...previousDomain.budgetAuthority, authorityEpoch: epoch },
          }
          const nextPublication = publication([stateChange, budgetChange], upgradeId, cutoverId, validation, [
            {
              domainId: from.domainId,
              from: previousDomain,
              to: nextDomain,
              cohortDigest: NEXT_COHORT,
              validationRef: validation,
            },
          ])
          const published = await same(left, right, 'joint advance', (driver) =>
            driver.provider.compareAndSwap(nextPublication, context()),
          )
          expect(code(published)).toBe('ok')
          previousState = stateChange.next
          previousBudget = budgetChange.next
          previousDomain = nextDomain
        }
        for (const logicalAuthorityId of ['state-auth', 'budget-auth'])
          await same(left, right, 'activation', (driver) =>
            driver.provider.recordActivation(
              { logicalAuthorityId, authorityEpoch: epoch, cutoverId },
              context(),
            ),
          )
        const resolved = await same(left, right, 'original qualification', (driver) =>
          driver.provider.read({ kind: 'joint-dispatch', domainId: from.domainId, from }, context()),
        )
        expect(
          resolved.ok &&
            (resolved.value as { resolution: { qualification: DispatchAtomicDomain } }).resolution
              .qualification,
        ).toEqual(previousDomain)
      }
      const originalResult = await same(left, right, 'historical joint replay', (driver) =>
        driver.provider.compareAndSwap(request, context()),
      )
      expect(
        originalResult.ok &&
          (originalResult.value as { routes: { revision: number }[] }).routes.every(
            (item) => item.revision === 2,
          ),
      ).toBe(true)
      await same(blockedLeft, blockedRight, 'filesystem', (driver) =>
        driver.provider.seedRoute(state, context()),
      )
      await left.provider.dispose()
      await right.provider.dispose()
      await same(left, right, 'disposed', (driver) =>
        driver.provider.read({ kind: 'authority', logicalAuthorityId: 'state-auth' }, context()),
      )
    } finally {
      for (const driver of [left, right, blockedLeft, blockedRight])
        rmSync(driver.root, { recursive: true, force: true })
    }
  })
})
