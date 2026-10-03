import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Outcome } from '@agnes/extension-api/runtime'
import type { RuntimeWireTypes as W } from '@agnes/protocol/runtime'
import { describe, expect, it } from 'vitest'
import { installerDigest } from '../../src/runtime/install-journal.js'
import {
  createInstallRepairPlan,
  createPackageMaintenanceController,
  type InstallOperationObservation,
  installRepairPlanRef,
} from '../../src/runtime/providers/package-installer.js'
import {
  bindInstallerFixtureOperation,
  createReferenceFixtureController,
  createReferenceFixtureRepairPlan,
  inlineInstallerRef,
  installerContext,
  installerFixtureRequest,
  installerReleaseFixture,
  openInstallerFixture,
} from './fixtures/installer.js'

function value<T>(result: Outcome<T>): T {
  if (!result.ok) throw new Error(result.error.detailCode)
  return result.value
}
const refuse = (result: Outcome<unknown>, detailCode: string) =>
  expect(result).toMatchObject({ ok: false, error: { detailCode } })

describe.each(['default', 'reference'])('persistent installer proposals: %s', (providerId) => {
  async function fixture(
    run: (f: ReturnType<typeof openInstallerFixture>, directory: string) => Promise<void>,
  ) {
    const directory = mkdtempSync(join(tmpdir(), 'installer-test-'))
    const f = openInstallerFixture(providerId, directory)
    try {
      await run(f, directory)
    } finally {
      f.close()
      rmSync(directory, { recursive: true, force: true })
    }
  }
  it('keeps stable owner/request identity over reconnect, validates DTOs and rejects changed input with no effects', () =>
    fixture(async (f) => {
      const call = installerContext(),
        input = installerFixtureRequest()
      const accepted = value(await f.subject.requestChange(input, call))
      expect(await f.subject.requestChange(input, { ...call, invocationId: 'other-client' })).toEqual({
        ok: true,
        value: accepted,
      })
      refuse(await f.subject.requestChange({ ...input, reason: 'changed' }, call), 'request_input_conflict')
      refuse(await f.subject.requestChange({ ...input, connectionId: 'browser' }, call), 'schema_invalid')
      refuse(
        await f.subject.proposalStatus(
          { proposalId: accepted.proposalId },
          { ...call, principalRef: 'other-owner' },
        ),
        'proposal_owner_required',
      )
      for (const kind of ['local', 'npm', 'git'] as const) {
        const common = { sourceId: 'fixture-source', digest: '1'.repeat(64) }
        const locator: W['PackageLocator'] =
          kind === 'local'
            ? { kind, ...common, pathRef: 'fixture-path' }
            : kind === 'npm'
              ? { kind, ...common, name: 'fixture', version: '1.0.0', integrity: 'sha512-fixture' }
              : {
                  kind,
                  ...common,
                  repository: 'fixture-repository',
                  commit: 'a'.repeat(40),
                  subdirectory: '',
                }
        const request: W['ChangeProposalRequest'] = {
          ...input,
          requestId: kind,
          change: { kind: 'package', operation: 'install', locator },
        }
        const first = value(await f.subject.requestChange(request, call))
        expect(value(await f.subject.requestChange(request, call))).toEqual(first)
        expect(first.status).toBe('planning')
      }
      for (const method of ['prepare', 'activate', 'disable', 'repair', 'applyResourceChange'])
        expect(method in f.subject).toBe(false)
    }))

  it('enforces CAS across handles and cancellation never erases original operation or publication facts', () =>
    fixture(async (f, dir) => {
      const call = installerContext()
      const accepted = value(await f.subject.requestChange(installerFixtureRequest(), call))
      const read = f.journal.read(accepted.proposalId)
      read.proposal.status = 'denied'
      expect(f.journal.read(accepted.proposalId).proposal.status).toBe('planning')
      const second = openInstallerFixture(providerId, dir)
      try {
        const cancelled = value(
          await f.subject.cancelProposal(
            { proposalId: accepted.proposalId, expectedRevision: 1, reason: 'stop' },
            call,
          ),
        )
        expect(cancelled).toMatchObject({ status: 'cancelled', revision: 2 })
        refuse(
          await second.subject.cancelProposal(
            { proposalId: accepted.proposalId, expectedRevision: 1, reason: 'stale' },
            call,
          ),
          'proposal_revision_conflict',
        )
        refuse(await second.controller.plan(accepted.proposalId, 2, call), 'proposal_cancelled')
      } finally {
        second.close()
      }
      const next = value(
        await f.subject.requestChange({ ...installerFixtureRequest(), requestId: 'operation' }, call),
      )
      const applying = bindInstallerFixtureOperation(f.journal, next.proposalId)
      const receipt = {
        authorityId: 'fixture-maintenance',
        receiptId: 'original-receipt',
        digest: '2'.repeat(64),
      }
      const published = f.journal.compareAndSwap(next.proposalId, applying.proposal.revision, {
        ...applying,
        proposal: {
          ...applying.proposal,
          revision: applying.proposal.revision + 1,
          status: 'applied',
          resultRef: receipt,
        },
      })
      const result = value(
        await f.subject.cancelProposal(
          {
            proposalId: next.proposalId,
            expectedRevision: published.proposal.revision,
            reason: 'after publication',
          },
          call,
        ),
      )
      expect(result.status).toBe('applied')
      expect(result.resultRef).toEqual(receipt)
      expect(f.journal.read(next.proposalId).operation).toEqual(applying.operation)
      expect(() =>
        f.journal.compareAndSwap(next.proposalId, result.revision, {
          ...published,
          proposal: { ...result, revision: result.revision + 1, status: 'cancelled' },
        }),
      ).toThrow()
    }))

  it('keeps queries read-only and probes the original ID without reinstallation, including uncertain outcomes', () =>
    fixture(async (f, dir) => {
      const accepted = value(await f.subject.requestChange(installerFixtureRequest(), installerContext()))
      const record = bindInstallerFixtureOperation(f.journal, accepted.proposalId)
      const before = readFileSync(join(dir, 'journal.sqlite'))
      expect(
        value(await f.subject.proposalStatus({ proposalId: accepted.proposalId }, installerContext())).status,
      ).toBe('unknown')
      expect(readFileSync(join(dir, 'journal.sqlite'))).toEqual(before)
      expect(f.journal.read(accepted.proposalId)).toEqual(record)
      const observing = openInstallerFixture(providerId, dir, {
        readLocalOperation: async (operation) => ({
          ok: true,
          value: {
            operationId: operation.operationId,
            planDigest: record.proposal.planDigest as string,
            state: 'published',
            heads: { kind: 'release', routeId: 'route', routeRevision: 2, releaseSetId: 'new' },
            checkpoint: null,
            receipt: {
              authorityId: 'fixture-maintenance',
              receiptId: 'original-receipt',
              digest: '2'.repeat(64),
            },
          },
        }),
      })
      try {
        const found = value(
          await observing.subject.proposalStatus({ proposalId: accepted.proposalId }, installerContext()),
        )
        expect(found).toMatchObject({ status: 'applied', resultRef: { receiptId: 'original-receipt' } })
        expect(readFileSync(join(dir, 'journal.sqlite'))).toEqual(before)
      } finally {
        observing.close()
      }
    }))

  it('plans independently of a broken business root and denies missing/current/changed approvals and all effects', () =>
    fixture(async (f) => {
      const call = installerContext()
      const accepted = value(await f.subject.requestChange(installerFixtureRequest(), call))
      const create =
        providerId === 'default' ? createPackageMaintenanceController : createReferenceFixtureController
      expect(() => {
        throw new Error('broken business root')
      }).toThrow('broken business root')
      const planned = value(await f.controller.plan(accepted.proposalId, 1, call))
      expect(planned.status).toBe('awaiting-approval')
      expect(value(await f.controller.proposalStatus({ proposalId: planned.proposalId }, call))).toEqual(
        planned,
      )
      refuse(
        await f.controller.checkApproval(
          planned.proposalId,
          planned.revision,
          'old-tool-session-grant',
          call,
        ),
        'deployment_approval_unavailable',
      )
      const absent = create({ ...f.ports, currentAuthorization: null })
      refuse(await absent.prepare({}, call), 'current_authorization_unavailable')
      for (const method of ['prepare', 'activate', 'disable', 'repair', 'applyResourceChange'] as const)
        refuse(await f.controller[method]({}, call), 'installer_effect_unimplemented')
      const approval = {
        kind: 'deployment' as const,
        proposalId: planned.proposalId,
        owner: call.principalRef,
        scope: planned.scope,
        planDigest: planned.planDigest as string,
        actorRef: call.principalRef,
        expiresAt: '2027-01-01T00:00:00Z',
        decision: 'approved' as const,
        reference: inlineInstallerRef({ approval: 'fixed-plan' }),
      }
      for (const patch of [
        { planDigest: '0'.repeat(64) },
        { owner: 'other' },
        { expiresAt: '2020-01-01T00:00:00Z' },
        { kind: 'tool-session' },
        { scope: { kind: 'installation', installationId: 'foreign' } },
      ]) {
        const wrong = create({
          ...f.ports,
          readDeploymentApproval: async () => ({
            ok: true,
            value: { ...approval, ...patch } as typeof approval,
          }),
        })
        refuse(
          await wrong.checkApproval(planned.proposalId, planned.revision, 'approval', call),
          'deployment_approval_mismatch',
        )
      }
      let clock = '2026-10-03T00:00:00Z'
      let approvalRead = false
      const expiring = create({
        ...f.ports,
        now: () => clock,
        readDeploymentApproval: async () => {
          approvalRead = true
          return { ok: true, value: approval }
        },
        currentAuthorization: async (context) => {
          if (approvalRead) clock = approval.expiresAt
          return { ok: true, value: context.principalRef }
        },
      })
      refuse(
        await expiring.checkApproval(planned.proposalId, planned.revision, 'approval', call),
        'deployment_approval_mismatch',
      )
      expect(f.journal.read(planned.proposalId).proposal.revision).toBe(planned.revision)
      const approvedController = create({
        ...f.ports,
        readDeploymentApproval: async () => ({ ok: true, value: approval }),
      })
      expect(
        value(await approvedController.checkApproval(planned.proposalId, planned.revision, 'approval', call))
          .status,
      ).toBe('approved')
      refuse(await approvedController.activate({}, call), 'installer_effect_unimplemented')
      expect(f.journal.read(planned.proposalId).operation).toBeNull()
      const approved = f.journal.read(planned.proposalId)
      const cancelled = value(
        await f.subject.cancelProposal(
          {
            proposalId: planned.proposalId,
            expectedRevision: approved.proposal.revision,
            reason: 'before operation',
          },
          call,
        ),
      )
      const saved = f.journal.read(planned.proposalId)
      expect(() =>
        f.journal.compareAndSwap(planned.proposalId, cancelled.revision, {
          ...saved,
          operation: {
            operationId: 'late-operation',
            reference: inlineInstallerRef({ upgradeId: 'late-operation' }),
          },
          proposal: { ...saved.proposal, revision: cancelled.revision + 1 },
        }),
      ).toThrow('proposal_cancelled')
    }))

  it('binds package plans to the authorized scope route and rechecks current authority before persisting', () =>
    fixture(async (f) => {
      const plan = await installerReleaseFixture()
      const pkg = plan.targetReleaseSet.packages[0]
      if (!pkg) throw new Error('fixture package missing')
      const locator: W['PackageLocator'] = {
        kind: 'local',
        sourceId: pkg.sourceRef,
        pathRef: 'fixture-path',
        digest: pkg.digest,
      }
      const input: W['ChangeProposalRequest'] = {
        ...installerFixtureRequest(),
        change: { kind: 'package', operation: 'install', locator },
      }
      const call = installerContext()
      const accepted = value(await f.subject.requestChange(input, call))
      const create =
        providerId === 'default' ? createPackageMaintenanceController : createReferenceFixtureController
      const ports = {
        ...f.ports,
        generateVerifiedPlan: async () => ({
          ok: true as const,
          value: { kind: 'release' as const, value: plan },
        }),
      }
      refuse(await create(ports).plan(accepted.proposalId, 1, call), 'release_target_validation_unavailable')
      const wrong = create({
        ...ports,
        resolveReleaseRoute: async () => ({ ok: true, value: 'other-route' }),
      })
      refuse(await wrong.plan(accepted.proposalId, 1, call), 'plan_target_conflict')
      const bound = create({ ...ports, resolveReleaseRoute: async () => ({ ok: true, value: plan.routeId }) })
      expect(value(await bound.plan(accepted.proposalId, 1, call))).toMatchObject({
        status: 'awaiting-approval',
        planDigest: plan.planFingerprint,
      })
      let route = plan.routeId
      const drift = create({
        ...ports,
        resolveReleaseRoute: async () => ({ ok: true, value: route }),
        readDeploymentApproval: async () => {
          route = 'drifted-route'
          return {
            ok: true,
            value: {
              kind: 'deployment',
              decision: 'approved',
              proposalId: accepted.proposalId,
              owner: call.principalRef,
              scope: input.targetScope,
              planDigest: plan.planFingerprint,
              actorRef: call.principalRef,
              expiresAt: '2027-01-01T00:00:00Z',
              reference: inlineInstallerRef({ approval: 'release' }),
            },
          }
        },
      })
      refuse(await drift.checkApproval(accepted.proposalId, 2, 'approval', call), 'plan_target_conflict')
      expect(f.journal.read(accepted.proposalId).proposal.status).toBe('awaiting-approval')
      const id = value(
        await f.subject.requestChange({ ...installerFixtureRequest(), requestId: 'revoked' }, call),
      ).proposalId
      let revoked = false
      const changing = create({
        ...f.ports,
        currentAuthorization: async (current) =>
          revoked
            ? {
                ok: false,
                error: {
                  code: 'denied',
                  detailCode: 'authority_revoked',
                  message: 'revoked',
                  diagnosticId: 'revoked',
                  retryAdvice: { kind: 'never' },
                },
              }
            : { ok: true, value: current.principalRef },
        generateVerifiedPlan: async (request) => {
          revoked = true
          return {
            ok: true,
            value: f.ports.generateVerifiedPlan
              ? value(await f.ports.generateVerifiedPlan(request, call))
              : { kind: 'release', value: plan },
          }
        },
      })
      refuse(await changing.plan(id, 1, call), 'authority_revoked')
      expect(f.journal.read(id).proposal).toMatchObject({ status: 'planning', revision: 1 })
    }))
})

it('generates only evidence-bound repair advice and preserves current heads and original receipts', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'installer-repair-'))
  const f = openInstallerFixture('default', dir)
  try {
    const proposal = value(await f.subject.requestChange(installerFixtureRequest(), installerContext()))
    const record = bindInstallerFixtureOperation(f.journal, proposal.proposalId)
    const heads: W['UpgradeExpectedHeads'] = {
      kind: 'release',
      routeId: 'route',
      routeRevision: 1,
      releaseSetId: 'old',
    }
    const checkpoint: W['UpgradeCheckpoint'] = {
      key: 'verified-candidate',
      inputDigest: record.inputDigest,
      evidence: [inlineInstallerRef({ verified: true })],
      completedAt: '2026-10-03T00:00:00Z',
    }
    const unpublished: InstallOperationObservation = {
      operationId: 'original-upgrade',
      planDigest: record.proposal.planDigest as string,
      state: 'unpublished',
      heads,
      checkpoint,
      receipt: null,
    }
    const verify = () => ({ ok: true as const, value: heads })
    const receipt = {
      authorityId: 'fixture-maintenance',
      receiptId: 'original-receipt',
      digest: '3'.repeat(64),
    }
    const published = { ...unpublished, state: 'published' as const, receipt }
    const observations = [
      unpublished,
      published,
      { ...published, checkpoint: null },
      { ...unpublished, state: 'unknown' as const },
      { ...published, operationId: 'new-id' },
    ]
    expect(observations.map((row) => createInstallRepairPlan(record, row, heads, verify))).toEqual(
      observations.map((row) => createReferenceFixtureRepairPlan(record, row, heads, verify)),
    )
    for (const repair of [createInstallRepairPlan, createReferenceFixtureRepairPlan]) {
      expect(value(repair(record, unpublished, heads, verify)).action).toBe('reclaim-unpublished')
      expect(value(repair(record, published, heads, verify))).toMatchObject({
        action: 'probe-published',
        originalReceipt: receipt,
      })
      expect(
        value(repair(record, published, { ...heads, routeRevision: 2, releaseSetId: 'current' }, verify))
          .action,
      ).toBe('new-reverse-operation')
      refuse(repair(record, { ...published, checkpoint: null }, heads, verify), 'checkpoint_unverified')
      refuse(repair(record, { ...unpublished, state: 'unknown' }, heads, verify), 'operation_unknown')
      refuse(repair(record, unpublished, { ...heads, routeRevision: 2 }, verify), 'repair_heads_conflict')
      refuse(
        repair(record, { ...published, operationId: 'new-id' }, heads, verify),
        'operation_identity_conflict',
      )
    }
    expect(f.journal.read(proposal.proposalId)).toEqual(record)
    const reference = installRepairPlanRef(value(createInstallRepairPlan(record, published, heads, verify)))
    f.journal.compareAndSwap(proposal.proposalId, record.proposal.revision, {
      ...record,
      repairPlanRef: reference,
      proposal: { ...record.proposal, revision: record.proposal.revision + 1 },
    })
    const reopened = openInstallerFixture('default', dir)
    try {
      expect(reopened.journal.read(proposal.proposalId).repairPlanRef).toEqual(reference)
    } finally {
      reopened.close()
    }
  } finally {
    f.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

it('keeps reference implementation independent and agrees on inputs, outputs and refusal codes', async () => {
  const defaultText = [
    '../../src/runtime/providers/package-installer.ts',
    '../../src/runtime/install-journal.ts',
    '../../src/runtime/repair-plan.ts',
    '../../src/runtime/package-apply.ts',
    '../../src/runtime/deployment-approval.ts',
  ]
    .map((path) => readFileSync(new URL(path, import.meta.url), 'utf8'))
    .join('\n')
  const referenceText =
    readFileSync(
      new URL('../../../../examples/runtime-reference/src/providers/deployment-approval.ts', import.meta.url),
      'utf8',
    ) +
    readFileSync(
      new URL('../../../../examples/runtime-reference/src/providers/package-apply.ts', import.meta.url),
      'utf8',
    ) +
    readFileSync(
      new URL('../../../../examples/runtime-reference/src/providers/package-installer.ts', import.meta.url),
      'utf8',
    )
  expect(referenceText).not.toMatch(/from\s+['"][^'"]*package-manager/)
  const lines = (text: string) =>
    new Set(
      text
        .split('\n')
        .map((row) => row.trim())
        .filter(Boolean),
    )
  const left = lines(defaultText),
    right = lines(referenceText)
  const overlap = [...right].filter((row) => left.has(row)).length / Math.min(left.size, right.size)
  expect(overlap).toBeLessThanOrEqual(0.5)
  const dirs = ['default', 'reference'].map((name) => mkdtempSync(join(tmpdir(), `installer-cross-${name}-`)))
  const subjects = dirs.map((dir, index) => openInstallerFixture(index === 0 ? 'default' : 'reference', dir))
  try {
    const call = installerContext(),
      input = installerFixtureRequest()
    const outcomes = await Promise.all(
      subjects.map(async (f) => {
        const accepted = await f.subject.requestChange(input, call)
        const conflict = await f.subject.requestChange({ ...input, reason: 'changed' }, call)
        const cancelled = await f.subject.cancelProposal(
          { proposalId: value(accepted).proposalId, expectedRevision: 1, reason: 'cancel' },
          call,
        )
        return [accepted, conflict, cancelled]
      }),
    )
    expect(installerDigest(outcomes[0])).toBe(installerDigest(outcomes[1]))
  } finally {
    for (const subject of subjects) subject.close()
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
  }
})
