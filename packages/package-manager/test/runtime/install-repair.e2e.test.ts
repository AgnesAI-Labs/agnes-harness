import { execFileSync, fork } from 'node:child_process'
import { once } from 'node:events'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Outcome } from '@agnes/extension-api/runtime'
import { FixedCordisAssembly } from '@agnes/plugin-runtime/host'
import type { RuntimeWireTypes as W } from '@agnes/protocol/runtime'
import { describe, expect, it } from 'vitest'
import {
  createPackageMaintenanceController,
  type InstallRecord,
} from '../../src/runtime/providers/package-installer.js'
import {
  bindInstallerFixtureOperation,
  coldInstallerStatus,
  createReferenceFixtureController,
  inlineInstallerRef,
  installerFixtureRequest,
  installerProcessFixture,
  openInstallerFixture,
} from './fixtures/installer.js'
import { openInstallerApplyFixture } from './fixtures/installer-apply.js'
import { buildQualified } from './fixtures/installer-apply-build.js'

function noBuildEffects(f: Awaited<ReturnType<typeof openInstallerApplyFixture>>, proposalId: string) {
  const observation = f.buildObservation
  if (!observation) throw new Error('Missing build observation')
  expect(observation.starts).toEqual([])
  expect(observation.stagedFiles).toEqual([])
  for (const directory of observation.directories) expect(existsSync(directory)).toBe(false)
  expect(f.journal.read(proposalId).applyCheckpoint?.buildEvidence ?? []).toEqual([])
  expect(
    f.assembly
      .snapshot()
      .records.some((row) => row.recordId === 'release-route:fixture-route' && row.revision > 0),
  ).toBe(false)
  expect(
    f.assembly.snapshot().records.find((row) => row.recordId === `pin:${f.input.plan.requiredPins[0]}`)
      ?.payload,
  ).toMatchObject({ data: { status: 'active', ownerId: f.input.plan.upgradeId } })
}

describe.each(['default', 'reference'])('installer journal process recovery: %s', (providerId) => {
  it.each(['planning', 'applying', 'applied'])(
    'kills an open journal writer at %s and reopens the same durable identity',
    async (phase) => {
      const dir = mkdtempSync(join(tmpdir(), 'installer-kill-'))
      writeFileSync(join(dir, 'request.json'), JSON.stringify(installerFixtureRequest()))
      const child = fork(installerProcessFixture, [], {
        execArgv: ['--import', 'tsx'],
        env: {
          ...process.env,
          INSTALLER_FIXTURE_DIRECTORY: dir,
          INSTALLER_FIXTURE_PROVIDER: providerId,
          INSTALLER_FIXTURE_WRITE: '1',
          INSTALLER_FIXTURE_PHASE: phase,
        },
        stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
      })
      try {
        const [ready] = (await once(child, 'message', { signal: AbortSignal.timeout(30000) })) as [
          { proposalId: string },
        ]
        const exited = once(child, 'exit')
        child.kill('SIGKILL')
        await exited
        const read = coldInstallerStatus(providerId, dir, ready.proposalId)
        expect(read).toMatchObject({
          ok: true,
          value: {
            status: phase === 'applying' ? 'unknown' : phase,
            revision: phase === 'planning' ? 1 : phase === 'applying' ? 4 : 5,
            requestId: 'fixture-request',
          },
        })
        const reopened = openInstallerFixture(providerId, dir)
        try {
          expect(
            reopened.journal.accept(installerFixtureRequest(), 'fixture-owner').proposal.proposalId,
          ).toBe(ready.proposalId)
          expect(() =>
            reopened.journal.accept({ ...installerFixtureRequest(), reason: 'different' }, 'fixture-owner'),
          ).toThrow('request_input_conflict')
        } finally {
          reopened.close()
        }
      } finally {
        child.kill('SIGKILL')
        rmSync(dir, { recursive: true, force: true })
      }
    },
  )

  it('cold-probes the original operation after a lost response and keeps unknown without replay or writes', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'installer-operation-reopen-'))
    const f = openInstallerFixture(providerId, dir)
    const id = f.journal.accept(installerFixtureRequest(), 'fixture-owner').proposal.proposalId
    const record = bindInstallerFixtureOperation(f.journal, id)
    const original = {
      operationId: record.operation?.operationId,
      planDigest: record.proposal.planDigest,
      state: 'published',
      heads: { kind: 'release', routeId: 'fixture-route', routeRevision: 2, releaseSetId: 'fixture-release' },
      checkpoint: {
        key: 'published',
        inputDigest: record.inputDigest,
        evidence: [inlineInstallerRef({ original: true })],
        completedAt: '2026-10-03T00:00:00Z',
      },
      receipt: { authorityId: 'fixture-maintenance', receiptId: 'original-receipt', digest: '4'.repeat(64) },
    }
    // Separate durable authority evidence, never a second publication owned by the installer.
    writeFileSync(join(dir, 'original-operation.json'), JSON.stringify(original), { flush: true })
    f.close()
    try {
      const journalBefore = readFileSync(join(dir, 'journal.sqlite'))
      const status = coldInstallerStatus(providerId, dir, id)
      expect(status).toMatchObject({
        ok: true,
        value: { status: 'applied', resultRef: { receiptId: 'original-receipt' }, revision: 4 },
      })
      expect(readFileSync(join(dir, 'journal.sqlite'))).toEqual(journalBefore)
      writeFileSync(
        join(dir, 'original-operation.json'),
        JSON.stringify({ ...original, state: 'unknown', receipt: null }),
        { flush: true },
      )
      expect(coldInstallerStatus(providerId, dir, id)).toMatchObject({
        ok: true,
        value: { status: 'unknown', resultRef: null },
      })
      expect(readFileSync(join(dir, 'journal.sqlite'))).toEqual(journalBefore)
      const again = openInstallerFixture(providerId, dir)
      try {
        expect(again.journal.accept(installerFixtureRequest(), 'fixture-owner')).toEqual(record)
        expect(again.journal.read(id).operation?.operationId).toBe('original-upgrade')
        again.journal.compareAndSwap(id, record.proposal.revision, {
          ...record,
          proposal: {
            ...record.proposal,
            revision: record.proposal.revision + 1,
            status: 'applied',
            resultRef: original.receipt,
          },
        })
      } finally {
        again.close()
      }
      // Unknown is not evidence against a previously persisted publication receipt.
      expect(coldInstallerStatus(providerId, dir, id)).toMatchObject({
        ok: true,
        value: { status: 'applied', resultRef: original.receipt },
      })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

// Durable publication and full wire validation exceed 15s on hosted Linux runners.
// Bound the harness uniformly; approval expiry and execution deadlines remain unchanged.
const applyTimeout = { timeout: 30_000 }
describe.each(['default', 'reference'] as const)('approved installer apply: %s', applyTimeout, (kind) => {
  async function using(
    operation: 'install' | 'disable' | 'repair' | 'resource',
    run: (f: Awaited<ReturnType<typeof openInstallerApplyFixture>>) => Promise<void>,
  ) {
    const directory = mkdtempSync(join(tmpdir(), 'installer-apply-'))
    const f = await openInstallerApplyFixture(kind, directory, operation)
    try {
      await run(f)
    } finally {
      await f.close()
      rmSync(directory, { recursive: true, force: true })
    }
  }
  it.each(['install', 'disable', 'repair', 'resource'] as const)(
    'executes the fixed %s operation through an independent maintenance root',
    (operation) =>
      using(operation, async (f) => {
        const business = new FixedCordisAssembly()
        let mounted = false
        await expect(
          business.prepare({
            generationId: 'broken-business',
            providers: [
              {
                providerId: 'broken-clock',
                contract: 'agh.clock',
                major: 1,
                logicalName: 'default',
                scope: 'runtime',
                features: [],
                packageDigest: '0'.repeat(64),
                capabilities: [],
                requires: [],
                create() {
                  mounted = true
                  throw new Error('broken business root')
                },
              },
            ],
          }),
        ).rejects.toThrow('broken business root')
        expect(mounted).toBe(true)
        const proposal = await f.approved()
        expect('apply' in f.subject).toBe(false)
        const applied = await f.controller.apply(proposal.proposalId, proposal.revision, f.call)
        expect(applied).toMatchObject({
          ok: true,
          value: {
            status: 'applied',
            resultRef: {
              receiptId:
                operation === 'resource' ? 'fixture-resource-command' : `publish:${f.input.plan.upgradeId}`,
            },
          },
        })
        const saved = f.journal.read(proposal.proposalId)
        expect(saved.applyCheckpoint?.phase).toBe('done')
        expect(saved.applyCheckpoint?.binding.owner).toEqual({
          runId: 'fixture-helper-run',
          actionId: 'fixture-new-approval-action',
        })
        expect(saved.applyCheckpoint?.binding.planRevision).toBe(2)
        expect(saved.applyCheckpoint?.binding.request.intentDigest).not.toBe(saved.proposal.planDigest)
        const binding = saved.applyCheckpoint?.binding
        if (!binding) throw new Error('missing original approval binding')
        expect(f.approvals.decode(binding.input)).toMatchObject({
          proposalId: saved.proposal.proposalId,
          planRevision: 2,
          planDigest: saved.proposal.planDigest,
          planRef: binding.planRef,
          targetScope: saved.proposal.scope,
        })
        expect(
          await f.controller.responseStatus(proposal.proposalId, 'fixture-response', {
            ...f.call,
            invocationId: 'different-connection',
          }),
        ).toMatchObject({
          ok: true,
          value: { interactionId: 'fixture-interaction', responseId: 'fixture-response' },
        })
        const before = f.assembly.snapshot()
        expect(await f.controller.apply(proposal.proposalId, saved.proposal.revision, f.call)).toEqual(
          applied,
        )
        expect(f.assembly.snapshot()).toEqual(before)
      }),
  )
  it.each([
    'pending',
    'deny',
    'digest',
    'expiry',
    'revoked',
    'cancelled',
    'timed-out',
    'no-identity',
    'no-approval',
    'no-audit',
    'no-executor',
  ])('refuses %s without starting installation', (mode) =>
    using('install', async (f) => {
      const proposal = await f.approved()
      if (mode === 'pending') f.patchApproval({ status: 'pending' })
      if (mode === 'deny') f.patchApproval({ decision: 'deny' })
      if (mode === 'digest') f.patchApproval({ intentDigest: '9'.repeat(64) })
      if (mode === 'expiry') f.patchApproval({ expiresAt: f.input.fixture.now })
      if (mode === 'timed-out') f.patchApproval({ status: 'expired' })
      if (mode === 'revoked') f.control.authorized = false
      let revision = proposal.revision
      if (mode === 'cancelled') {
        const cancelled = await f.subject.cancelProposal(
          { proposalId: proposal.proposalId, expectedRevision: revision, reason: 'stop installation' },
          f.call,
        )
        if (!cancelled.ok) throw new Error(cancelled.error.detailCode)
        revision = cancelled.value.revision
      }
      const create =
        kind === 'default' ? createPackageMaintenanceController : createReferenceFixtureController
      const controller =
        mode === 'no-identity'
          ? create({ ...f.ports, deploymentIdentity: null })
          : mode === 'no-audit'
            ? create({ ...f.ports, deploymentAudit: null })
            : mode === 'no-approval'
              ? create({ ...f.ports, deploymentApproval: null })
              : mode === 'no-executor'
                ? create({ ...f.ports, executionInputs: null })
                : f.controller
      const before = f.assembly.snapshot()
      const result = await controller.apply(proposal.proposalId, revision, f.call)
      expect(result.ok).toBe(false)
      expect(f.journal.read(proposal.proposalId).operation).toBeNull()
      expect(f.assembly.snapshot()).toEqual(before)
      if (controller !== f.controller) controller.dispose()
    }),
  )
  it('retains the old route and original owner pins on a failed candidate and probes a lost publication response', () =>
    using('disable', async (f) => {
      const proposal = await f.approved(),
        old = f.input.plan.sourceReleaseSetId
      f.control.failCandidate = true
      expect(await f.controller.apply(proposal.proposalId, proposal.revision, f.call)).toMatchObject({
        ok: false,
        error: { detailCode: 'fixture_candidate_failed' },
      })
      const record = f.journal.read(proposal.proposalId)
      const snapshot = f.assembly.snapshot()
      expect(
        snapshot.records.find((row) => row.recordId === `release-route:${f.input.plan.routeId}`)?.payload,
      ).toMatchObject({ data: { activeReleaseSetId: old } })
      expect(
        snapshot.records.find((row) => row.recordId === `pin:${f.input.plan.requiredPins[0]}`)?.payload,
      ).toMatchObject({ data: { status: 'active', ownerId: record.operation?.operationId } })
      expect(await f.controller.apply(proposal.proposalId, record.proposal.revision, f.call)).toMatchObject({
        ok: false,
        error: { code: 'unknown_effect' },
      })
      expect(f.assembly.snapshot()).toEqual(snapshot)
    }))
  it('recovers the original receipt after publication response loss without another publish', () =>
    using('install', async (f) => {
      const proposal = await f.approved()
      f.control.losePublishResponse = true
      expect(await f.controller.apply(proposal.proposalId, proposal.revision, f.call)).toMatchObject({
        ok: false,
      })
      const record = f.journal.read(proposal.proposalId),
        before = f.assembly.snapshot()
      const recovered = await f.controller.apply(proposal.proposalId, record.proposal.revision, f.call)
      expect(recovered).toMatchObject({
        ok: true,
        value: { status: 'applied', resultRef: { receiptId: `publish:${f.input.plan.upgradeId}` } },
      })
      expect(f.assembly.snapshot()).toEqual(before)
    }))
  it.each(['revoked', 'cancelled', 'expired'] as const)(
    'stops publication when authority becomes %s after preparation',
    async (mode) => {
      const directory = mkdtempSync(join(tmpdir(), 'installer-late-deny-'))
      const f = await openInstallerApplyFixture(kind, directory, 'disable', async (phase) => {
        if (phase !== 'prepared') return
        if (mode === 'revoked') f.control.authorized = false
        if (mode === 'expired') f.patchApproval({ expiresAt: f.assembly.control.now })
        if (mode === 'cancelled') {
          const current = f.journal.read(proposal.proposalId).proposal
          const cancelled = await f.subject.cancelProposal(
            {
              proposalId: current.proposalId,
              expectedRevision: current.revision,
              reason: 'cancel prepared replacement',
            },
            f.call,
          )
          expect(cancelled.ok).toBe(true)
        }
      })
      const proposal = await f.approved()
      try {
        expect(await f.controller.apply(proposal.proposalId, proposal.revision, f.call)).toMatchObject({
          ok: false,
        })
        const rows = f.assembly.snapshot().records
        expect(
          rows.find((row) => row.recordId === `release-route:${f.input.plan.routeId}`)?.payload,
        ).toMatchObject({ data: { activeReleaseSetId: f.input.plan.sourceReleaseSetId } })
        expect(
          rows.find((row) => row.recordId === `pin:${f.input.plan.requiredPins[0]}`)?.payload,
        ).toMatchObject({ data: { status: 'active', ownerId: f.input.plan.upgradeId } })
      } finally {
        await f.close()
        rmSync(directory, { recursive: true, force: true })
      }
    },
  )
  it('uses the native disable and resource DTOs only with their matching fixed proposal', async () => {
    await using('disable', async (f) => {
      const proposal = await f.approved()
      const before = f.assembly.snapshot()
      expect(
        await f.controller.disable({ contributionId: 'wrong-contribution', reason: 'disable' }, f.call),
      ).toMatchObject({ ok: false, error: { detailCode: 'plan_input_conflict' } })
      expect(f.assembly.snapshot()).toEqual(before)
      const contributionId = f.input.plan.affectedContributions[0]
      expect(contributionId).toBeDefined()
      expect(
        await f.controller.disable({ contributionId, reason: 'disable broken contribution' }, f.call),
      ).toEqual({ ok: true, value: { disabledId: contributionId } })
      expect(f.journal.read(proposal.proposalId).proposal.status).toBe('applied')
    })
    await using('resource', async (f) => {
      const proposal = await f.approved()
      if (proposal.plan?.kind !== 'resource') throw new Error('resource plan missing')
      const dto = {
        proposalId: proposal.proposalId,
        plan: proposal.plan.value,
        expectedProposalRevision: proposal.revision,
        approvalRef: 'fixture-interaction',
      }
      expect(
        await f.controller.applyResourceChange({ ...dto, approvalRef: 'wrong-interaction' }, f.call),
      ).toMatchObject({ ok: false, error: { detailCode: 'plan_input_conflict' } })
      expect(f.journal.read(proposal.proposalId).operation).toBeNull()
      expect(await f.controller.applyResourceChange(dto, f.call)).toMatchObject({
        ok: true,
        value: { proposal: { status: 'applied' }, receipt: { receiptId: 'fixture-resource-command' } },
      })
    })
  })
  it.each(['carrier', 'action', 'authorization', 'host'] as const)(
    'refuses missing native %s capability before linking an approval',
    async (missing) =>
      using('install', async (f) => {
        const c = f.approvals.control
        if (missing === 'carrier') {
          c.helperRunEligible = false
          c.admissionAvailable = false
        }
        if (missing === 'action') c.stateActionAvailable = false
        if (missing === 'authorization') c.stateAuthorizationAvailable = false
        if (missing === 'host') c.hostApprovalAvailable = false
        const accepted = await f.subject.requestChange(f.request, f.call)
        if (!accepted.ok) throw new Error(accepted.error.detailCode)
        const planned = await f.controller.plan(accepted.value.proposalId, accepted.value.revision, f.call)
        if (!planned.ok) throw new Error(planned.error.detailCode)
        expect(
          await f.controller.requestApproval(planned.value.proposalId, planned.value.revision, f.call),
        ).toMatchObject({ ok: false, error: { code: 'denied' } })
        expect(f.journal.read(planned.value.proposalId).applyCheckpoint).toBeUndefined()
        expect(f.journal.read(planned.value.proposalId).operation).toBeNull()
      }),
  )
  it('uses an admitted management carrier when the helper Run is unavailable', () =>
    using('resource', async (f) => {
      f.approvals.control.helperRunEligible = false
      const p = await f.approved()
      expect(f.journal.read(p.proposalId).applyCheckpoint?.binding.owner.runId).toBe('fixture-management-run')
      expect(await f.controller.apply(p.proposalId, p.revision, f.call)).toMatchObject({ ok: true })
    }))
  it.each(['sourceChanged', 'scopeChanged'] as const)(
    'cancels a pending approval on %s and refuses historical approval reuse',
    (field) =>
      using('disable', async (f) => {
        const proposal = await f.approved()
        f.patchApproval({ status: 'pending' })
        f.approvals.control[field] = true
        expect(await f.controller.apply(proposal.proposalId, proposal.revision, f.call)).toMatchObject({
          ok: false,
          error: { detailCode: 'deployment_source_changed' },
        })
        expect(f.approvals.read().status).toBe('cancelled')
        expect(f.journal.read(proposal.proposalId).operation).toBeNull()
        expect(f.journal.read(proposal.proposalId).applyCheckpoint?.binding.planRevision).toBe(2)
      }),
  )
  it('supersedes a pending approval with a fresh immutable proposal and Action', () =>
    using('resource', async (f) => {
      const old = await f.approved()
      f.patchApproval({ status: 'pending' })
      const accepted = await f.subject.requestChange(
        { ...f.request, requestId: 'replacement-request', reason: 'changed deployment input' },
        f.call,
      )
      if (!accepted.ok) throw new Error(accepted.error.detailCode)
      const planned = await f.controller.plan(accepted.value.proposalId, accepted.value.revision, f.call)
      if (!planned.ok) throw new Error(planned.error.detailCode)
      const renewed = await f.controller.supersedeApproval(
        old.proposalId,
        old.revision,
        planned.value.proposalId,
        planned.value.revision,
        f.call,
      )
      expect(renewed).toMatchObject({ ok: true, value: { status: 'awaiting-approval' } })
      expect(f.journal.read(old.proposalId).proposal.status).toBe('cancelled')
      const oldNative = await f.ports.deploymentApproval?.read(
        { proposalId: old.proposalId, interactionId: 'fixture-interaction' },
        f.call,
      )
      expect(oldNative).toMatchObject({ ok: true, value: { status: 'cancelled' } })
      const fresh = f.journal.read(planned.value.proposalId)
      expect(fresh.applyCheckpoint?.binding.owner.actionId).not.toBe(
        f.journal.read(old.proposalId).applyCheckpoint?.binding.owner.actionId,
      )
      expect(fresh.applyCheckpoint?.interactionId).not.toBe('fixture-interaction')
      expect(
        await f.controller.apply(old.proposalId, f.journal.read(old.proposalId).proposal.revision, f.call),
      ).toMatchObject({ ok: false, error: { code: 'cancelled' } })
      expect(
        await f.controller.apply(fresh.proposal.proposalId, fresh.proposal.revision, f.call),
      ).toMatchObject({ ok: true, value: { status: 'applied' } })
    }))
  it.each([
    'approval-carrier-opened',
    'approval-action-prepared',
    'approval-authorization-prepared',
    'approval-requested',
    'approval-linked',
    'approval-checked',
    'operation-linked',
    'candidate-linked',
    'retained',
    'preparing',
    'prepared',
    'publishing',
    'published',
    'done',
    'build-checkpointed',
    'build-created-0',
    'build-executed-0',
    'build-created-1',
    'build-executed-1',
    'resource-started',
    'resource-committed',
  ])(
    'kills and cold-reopens at %s without replay',
    async (phase) => {
      if (phase.startsWith('build-') && !(await buildQualified(kind))) {
        const directory = mkdtempSync(join(tmpdir(), 'unqualified-build-'))
        const f = await openInstallerApplyFixture(kind, directory, 'install', undefined, {})
        try {
          const approved = await f.approved()
          expect(await f.controller.apply(approved.proposalId, approved.revision, f.call)).toMatchObject({
            ok: false,
            error: { code: 'incompatible', detailCode: 'build_mechanism_unqualified' },
          })
          noBuildEffects(f, approved.proposalId)
          expect(f.buildObservation?.directories).toHaveLength(1)
          expect(existsSync(join(directory, 'build-owner.json'))).toBe(false)
        } finally {
          await f.close()
          rmSync(directory, { recursive: true, force: true })
        }
        return
      }
      const directory = mkdtempSync(join(tmpdir(), 'installer-apply-kill-'))
      const script = fileURLToPath(new URL('./fixtures/installer-apply-process.ts', import.meta.url))
      const environment = {
        ...process.env,
        INSTALLER_APPLY_DIRECTORY: directory,
        INSTALLER_APPLY_KIND: kind,
        INSTALLER_APPLY_BUILD: phase.startsWith('build-') ? '1' : '0',
        INSTALLER_APPLY_OPERATION: phase.startsWith('resource') ? 'resource' : 'install',
      }
      const child = fork(script, [], {
        execArgv: ['--import', 'tsx'],
        env: { ...environment, INSTALLER_APPLY_PAUSE: phase },
        stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
      })
      let stderr = ''
      child.stderr?.on('data', (chunk) => {
        stderr += String(chunk)
      })
      try {
        await Promise.race([
          once(child, 'message', { signal: AbortSignal.timeout(30000) }),
          once(child, 'exit').then(() => {
            throw new Error(stderr)
          }),
        ])
        const exited = once(child, 'exit')
        child.kill('SIGKILL')
        await exited
        const reopened = JSON.parse(
          execFileSync(process.execPath, ['--import', 'tsx', script], {
            env: { ...environment, INSTALLER_APPLY_READ: '1' },
            encoding: 'utf8',
            timeout: 30000,
          }),
        ) as { status: Outcome<W['ChangeProposal']>; record: InstallRecord }
        const committed = ['published', 'done', 'resource-committed'].includes(phase)
        expect(reopened.status).toMatchObject({
          ok: true,
          value: {
            status: committed
              ? 'applied'
              : phase === 'approval-checked'
                ? 'approved'
                : phase.startsWith('approval')
                  ? 'awaiting-approval'
                  : 'unknown',
          },
        })
        if (!phase.startsWith('approval'))
          expect(reopened.record.operation?.operationId).toBe(
            phase.startsWith('resource') ? 'fixture-resource-command' : 'fixture-upgrade',
          )
        if (committed) expect(reopened.status.ok && reopened.status.value.resultRef).not.toBeNull()
        if (phase.startsWith('build-')) {
          const owner = JSON.parse(readFileSync(join(directory, 'build-owner.json'), 'utf8'))
          expect(owner.operationId).toBe(reopened.record.operation?.operationId)
          expect(reopened.record.applyCheckpoint?.phase).toBe(
            phase === 'build-checkpointed' ? 'built' : 'started',
          )
        }
      } finally {
        child.kill('SIGKILL')
        if (phase.startsWith('build-')) {
          try {
            const owner = JSON.parse(readFileSync(join(directory, 'build-owner.json'), 'utf8'))
            rmSync(owner.directory, { recursive: true, force: true })
          } catch {
            /* Fixture never reached sandbox creation. */
          }
        }
        rmSync(directory, { recursive: true, force: true })
      }
    },
    65000,
  )
})

describe.each(['default', 'reference'] as const)('installer isolated build composition: %s', (kind) => {
  it.each(['local', 'npm', 'git'] as const)(
    'builds locked %s content before publication',
    async (sourceKind) => {
      const directory = mkdtempSync(join(tmpdir(), 'installer-build-apply-'))
      const f = await openInstallerApplyFixture(kind, directory, 'install', undefined, { sourceKind })
      try {
        const proposal = await f.approved()
        const result = await f.controller.apply(proposal.proposalId, proposal.revision, f.call)
        if (await buildQualified(kind)) {
          expect(result).toMatchObject({ ok: true, value: { status: 'applied' } })
          const saved = f.journal.read(proposal.proposalId)
          expect(saved.applyCheckpoint?.buildEvidence).toHaveLength(1)
          expect(saved.applyCheckpoint?.buildEvidence[0]).toMatchObject({
            kind: 'inline',
            value: { reproducibility: { verified: true }, audit: expect.any(Array) },
          })
        } else {
          expect(result).toMatchObject({
            ok: false,
            error: { code: 'incompatible', detailCode: 'build_mechanism_unqualified' },
          })
          noBuildEffects(f, proposal.proposalId)
          expect(f.buildObservation?.directories).toHaveLength(1)
        }
      } finally {
        await f.close()
        rmSync(directory, { recursive: true, force: true })
      }
    },
    45000,
  )
  it.each(['secret', 'failure'] as const)(
    'refuses %s builds and retains original owner pins',
    async (fault) => {
      const directory = mkdtempSync(join(tmpdir(), 'installer-build-deny-'))
      const f = await openInstallerApplyFixture(kind, directory, 'install', undefined, { fault })
      try {
        const proposal = await f.approved()
        const result = await f.controller.apply(proposal.proposalId, proposal.revision, f.call)
        expect(result).toMatchObject({
          ok: false,
          error: {
            detailCode:
              fault === 'secret'
                ? 'secret_consumer_unavailable'
                : (await buildQualified(kind))
                  ? 'build_execution_failed'
                  : 'build_mechanism_unqualified',
          },
        })
        if (!(await buildQualified(kind))) noBuildEffects(f, proposal.proposalId)
        expect(
          f.assembly
            .snapshot()
            .records.some((row) => row.recordId === 'release-route:fixture-route' && row.revision > 0),
        ).toBe(false)
        expect(
          f.assembly.snapshot().records.find((row) => row.recordId === `pin:${f.input.plan.requiredPins[0]}`)
            ?.payload,
        ).toMatchObject({ data: { status: 'active', ownerId: f.input.plan.upgradeId } })
      } finally {
        await f.close()
        rmSync(directory, { recursive: true, force: true })
      }
    },
    45000,
  )
})

it('agrees across independent apply implementations on results, checkpoints and refusal codes', async () => {
  const dirs = ['default', 'reference'].map((id) =>
    mkdtempSync(join(tmpdir(), `installer-apply-cross-${id}-`)),
  )
  const fixtures = await Promise.all(
    dirs.map((dir, i) => openInstallerApplyFixture(i === 0 ? 'default' : 'reference', dir, 'resource')),
  )
  try {
    const results = await Promise.all(
      fixtures.map(async (f) => {
        const proposal = await f.approved()
        f.patchApproval({ decision: 'deny' })
        const denied = await f.controller.apply(proposal.proposalId, proposal.revision, f.call)
        f.patchApproval({ decision: 'approve' })
        const applied = await f.controller.apply(proposal.proposalId, proposal.revision, f.call)
        const saved = f.journal.read(proposal.proposalId)
        f.controller.dispose()
        const disposed = await f.controller.plan(proposal.proposalId, saved.proposal.revision, f.call)
        return { denied, applied, saved, disposed }
      }),
    )
    expect(results[0]).toEqual(results[1])
    expect(results[0]?.disposed).toMatchObject({ ok: false, error: { detailCode: 'provider_disposed' } })
  } finally {
    await Promise.all(fixtures.map((f) => f.close()))
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
  }
})
