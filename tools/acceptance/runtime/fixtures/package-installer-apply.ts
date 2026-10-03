import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { CallContext, Outcome } from '../../../../packages/extension-api/src/runtime/index.js'
import type { DeploymentApprovalTerminal } from '../../../../packages/package-manager/src/runtime/deployment-approval.js'
import { buildLockedPackage } from '../../../../packages/package-manager/src/runtime/package-build.js'
import {
  createPackageMaintenanceController,
  type InstallOperationObservation,
  type PackageMaintenancePorts,
} from '../../../../packages/package-manager/src/runtime/providers/package-installer.js'
import {
  createReferenceFixtureController,
  inlineInstallerRef,
  installerContext,
  installerFixturePlan,
  installerFixtureRequest,
  openInstallerFixture,
} from '../../../../packages/package-manager/test/runtime/fixtures/installer.js'
import { installerApplyBuild } from '../../../../packages/package-manager/test/runtime/fixtures/installer-apply-build.js'
import { jcs } from '../../../../packages/protocol/src/jcs.js'
import type { RuntimeWireTypes as W } from '../../../../packages/protocol/src/runtime/index.js'
import { canonicalJsonDigest } from '../../../../packages/protocol/src/runtime/index.js'
import { installerApprovalFixture } from './package-installer-approval.js'

const wire = (await import(
  new URL('../../../../packages/extension-api/testkit/runtime/contracts/assembly-fixture.js', import.meta.url)
    .href
)) as typeof import('../../../../packages/extension-api/testkit/runtime/contracts/assembly-fixture.js')
const publication = (await import(
  new URL('../../../../packages/extension-api/testkit/runtime/contracts/assembly-publish.js', import.meta.url)
    .href
)) as typeof import('../../../../packages/extension-api/testkit/runtime/contracts/assembly-publish.js')
const bindingModule = (await import(
  new URL('../../../../packages/host/test/runtime/fixtures/assembly-publish-binding.js', import.meta.url).href
)) as typeof import('../../../../packages/host/test/runtime/fixtures/assembly-publish-binding.js')
const hostPublication = (await import(
  new URL('../../../../packages/host/src/runtime/assembly/publication.js', import.meta.url).href
)) as typeof import('../../../../packages/host/src/runtime/assembly/publication.js')
const referencePublication = (await import(
  new URL('../../../../examples/runtime-reference/src/providers/assembly-publication.js', import.meta.url)
    .href
)) as typeof import('../../../../examples/runtime-reference/src/providers/assembly-publication.js')

// Reuse only immutable input templates; every case gets cloned inputs and its own owner stores.
let installTemplate: ReturnType<typeof wire.assemblyFixture> | undefined
let upgradeTemplate: ReturnType<typeof publication.upgradeAssemblyFixture> | undefined
function fixtureInput(operation: 'install' | 'disable' | 'repair' | 'resource') {
  if (operation === 'install') {
    installTemplate ??= wire.assemblyFixture()
    return structuredClone(installTemplate)
  }
  upgradeTemplate ??= publication.upgradeAssemblyFixture()
  return structuredClone(upgradeTemplate)
}

export async function openInstallerApplyFixture(
  kind: 'default' | 'reference',
  directory: string,
  operation: 'install' | 'disable' | 'repair' | 'resource' = 'install',
  hook?: (phase: string) => Promise<void>,
  build?: { sourceKind?: 'local' | 'npm' | 'git'; fault?: 'secret' | 'failure' },
) {
  const input = fixtureInput(operation)
  if (operation === 'disable' || operation === 'repair') {
    input.plan.operation = operation
    wire.resealAssemblyFixture(input)
  }
  const buildTask = build
    ? await installerApplyBuild(kind, build.sourceKind, build.fault, async (phase, owner) => {
        writeFileSync(
          join(directory, 'build-owner.json'),
          JSON.stringify({ operationId: input.plan.upgradeId, ...owner }),
          { flush: true },
        )
        await hook?.(phase)
      })
    : undefined
  if (buildTask) {
    const lock = buildTask.pkg.lock
    input.resolution.lockGraph.entries.push(lock)
    const target: W['ReleaseSet'] = input.plan.targetReleaseSet
    target.packages.push({
      packageId: lock.packageId,
      version: lock.version,
      digest: lock.digest,
      sourceRef: lock.locator.sourceId,
      integrityRef:
        lock.manifestRef.kind === 'inline' ? lock.manifestRef.digest : lock.manifestRef.blob.digest,
      entries: {},
    })
    input.configuration.profile.policy.sourcePolicy.allowBuildScripts = true
    wire.resealAssemblyFixture(input)
  }
  const binding = bindingModule.assemblyTestBinding(kind)
  const assembly = await binding.open(input, directory)
  const subject = binding.create(input, assembly.lifecycle, assembly.ports)
  const stage =
    kind === 'default'
      ? new hostPublication.AssemblyPublication(input, assembly.ports)
      : referencePublication.referencePublication(
          { plan: input.plan, graph: input.graph, raw: input },
          assembly.ports,
        )
  const call: CallContext = {
    ...installerContext(),
    principalRef: 'fixture-principal',
    scope: { kind: 'runtime', installationId: 'fixture-installation', runtimeId: 'fixture-runtime' },
  }
  const f = openInstallerFixture(kind, directory, {
    currentAuthorization: async (context) => ({ ok: true, value: context.principalRef }),
  })
  const control = {
    get authorized() {
      return assembly.control.authorized
    },
    set authorized(value: boolean) {
      assembly.control.authorized = value
    },
    failCandidate: false,
    losePublishResponse: false,
    approval: null as DeploymentApprovalTerminal | null,
  }
  const approvals = installerApprovalFixture(
    kind,
    directory,
    () => assembly.control.now,
    async () => {
      if (operation === 'resource') return null
      const recordId = `release-route:${input.plan.routeId}`
      // Read the original route through the injected store; avoid decoding unrelated owner history.
      const found = await assembly.ports.store.query(
        {
          target: assembly.ports.target,
          method: 'assembly.records',
          input: inlineInstallerRef({ recordIds: [recordId] }),
        },
        call,
      )
      if (!found.ok) throw new Error(found.error.detailCode)
      const reply = wire.fixtureWire('QueryReply', found.value)
      if (reply.kind !== 'value' || reply.output.kind !== 'inline')
        throw new Error('source route decoder unavailable')
      const output = reply.output
      if (
        output.digest !== canonicalJsonDigest(output.value) ||
        output.bytes !== Buffer.byteLength(jcs(output.value))
      )
        throw new Error('source route integrity failed')
      const body = output.value
      if (!body || typeof body !== 'object' || Array.isArray(body) || !Array.isArray(body.records))
        throw new Error('source route response invalid')
      const records = body.records.map((row) => wire.fixtureWire('MaintenanceEnvelopeJsonValue', row))
      if (records.length > 1 || records.some((row) => row.recordId !== recordId))
        throw new Error('source route identity failed')
      const route = records[0]
      const facts = route ? publication.maintenanceData(route) : null
      if (!facts?.activeReleaseSetId) return null
      return {
        kind: 'release',
        routeId: input.plan.routeId,
        routeRevision: route?.revision ?? 0,
        releaseSetId: facts.activeReleaseSetId as string,
      }
    },
    hook,
  )
  const approvalRead = approvals.read
  const patchApproval = approvals.patch
  let resourceReceipt: W['ReceiptPointer'] | null = null
  const resourceFile = join(directory, 'resource-owner.json')
  let checkpoint: string | undefined
  const durableJournal = {
    ...f.journal,
    compareAndSwap(...args: Parameters<typeof f.journal.compareAndSwap>) {
      const saved = f.journal.compareAndSwap(...args)
      if (saved.proposal.status === 'approved') checkpoint = 'approval-checked'
      else if (saved.applyCheckpoint?.phase === 'started') checkpoint = 'operation-linked'
      else if (saved.applyCheckpoint?.phase === 'built') checkpoint = 'build-checkpointed'
      else if (saved.applyCheckpoint?.phase === 'prepared') checkpoint = 'candidate-linked'
      return saved
    },
  }
  const ports: PackageMaintenancePorts = {
    ...f.ports,
    journal: durableJournal,
    now: () => assembly.control.now,
    currentAuthorization: async (context) => {
      if (checkpoint) {
        const phase = checkpoint
        checkpoint = undefined
        await hook?.(phase)
      }
      return control.authorized
        ? { ok: true, value: context.principalRef }
        : {
            ok: false,
            error: {
              code: 'denied',
              detailCode: 'deployment_permission_revoked',
              message: 'revoked',
              diagnosticId: 'fixture',
              retryAdvice: { kind: 'never' },
            },
          }
    },
    async deploymentAudit(evidence) {
      writeFileSync(join(directory, 'deployment-audit.json'), JSON.stringify(evidence), { flush: true })
      return { ok: true, value: undefined }
    },
    deploymentIdentity: async (context) => ({
      ok: true,
      value: {
        tenantId: 'fixture-tenant',
        principalRef: context.principalRef,
        credentialRef: 'fixture-credential',
      },
    }),
    resolveReleaseRoute: async () => ({ ok: true, value: input.plan.routeId }),
    validatePlanInput: async (request, plan) => {
      const change = request.change
      if (
        change.kind !== 'package' ||
        plan.kind !== 'release' ||
        !input.fixture.previousRelease?.packages.some(
          (p) => p.digest === change.locator.digest && p.sourceRef === change.locator.sourceId,
        ) ||
        plan.value.sourceReleaseSetId !== input.fixture.previousRelease.releaseSetId
      )
        throw new Error('unverified source replacement')
      return { ok: true, value: undefined }
    },
    generateVerifiedPlan: async (request) => ({
      ok: true,
      value:
        request.change.kind === 'package'
          ? { kind: 'release', value: input.plan }
          : installerFixturePlan(request),
    }),
    deploymentApproval: approvals.port,
    executionInputs: async (record) => ({
      ok: true,
      value: {
        operation: {
          operationId:
            record.proposal.plan?.kind === 'release'
              ? record.proposal.plan.value.upgradeId
              : 'fixture-resource-command',
          reference: inlineInstallerRef({
            originalOwner: operation === 'resource' ? 'resource' : 'maintenance',
            planDigest: record.proposal.planDigest,
          }),
        },
        graph: operation === 'resource' ? null : input.graph,
        builds: buildTask ? [buildTask.input] : [],
      },
    }),
    async selectDisableProposal() {
      const record = f.journal.accept(request, call.principalRef)
      return {
        ok: true,
        value: { proposalId: record.proposal.proposalId, revision: record.proposal.revision },
      }
    },
    buildPackage: buildLockedPackage,
    async retainOperation() {
      const result = await stage.stage(call)
      await hook?.('retained')
      return result
    },
    async candidate(request, context) {
      await hook?.('preparing')
      if (control.failCandidate)
        return {
          ok: false,
          error: {
            code: 'incompatible',
            detailCode: 'fixture_candidate_failed',
            message: 'candidate failed',
            diagnosticId: 'fixture',
            retryAdvice: { kind: 'never' },
          },
        }
      const result = await subject.prepare(request, context)
      await hook?.('prepared')
      return result
    },
    async publish(request, context) {
      await hook?.('publishing')
      const result = await subject.publish(request, context)
      await hook?.('published')
      if (result.ok && control.losePublishResponse) throw new Error('lost publication response')
      return result
    },
    async resourceApply(request) {
      await hook?.('resource-started')
      resourceReceipt = {
        authorityId: 'fixture-resource-owner',
        receiptId: request.operation.operationId,
        digest: canonicalJsonDigest(request.plan),
      }
      writeFileSync(resourceFile, JSON.stringify(resourceReceipt), { flush: true })
      await hook?.('resource-committed')
      return { ok: true, value: resourceReceipt }
    },
    async readLocalOperation(original) {
      let planDigest: string | null = null
      try {
        planDigest = approvalRead().binding.planDigest
      } catch {
        /* No approval. */
      }
      if (!planDigest) throw new Error('no original plan')
      if (operation === 'resource') {
        try {
          resourceReceipt = JSON.parse(readFileSync(resourceFile, 'utf8')) as W['ReceiptPointer']
        } catch {
          resourceReceipt = null
        }
        return {
          ok: true,
          value: {
            operationId: original.operationId,
            planDigest,
            state: resourceReceipt ? 'published' : 'unpublished',
            heads: null,
            checkpoint: null,
            receipt: resourceReceipt,
          } as InstallOperationObservation,
        }
      }
      const snapshot = assembly.snapshot()
      const op = snapshot.records.find((row) => row.recordId === `upgrade:${original.operationId}`)
      const data = op ? publication.maintenanceData(op) : null
      const committed = data?.state === 'committed'
      const receipt = committed
        ? {
            authorityId: assembly.database.authority.authorityId,
            receiptId: `publish:${original.operationId}`,
            digest: canonicalJsonDigest(data),
          }
        : null
      return {
        ok: true,
        value: {
          operationId: original.operationId,
          planDigest,
          state: committed ? 'published' : 'unpublished',
          heads:
            !committed && input.plan.sourceReleaseSetId === null
              ? null
              : {
                  kind: 'release',
                  routeId: input.plan.routeId,
                  routeRevision: committed
                    ? (input.plan.expectedRouteRevision ?? 0) + 1
                    : (input.plan.expectedRouteRevision ?? 0),
                  releaseSetId: committed
                    ? input.plan.targetReleaseSet.releaseSetId
                    : input.plan.sourceReleaseSetId!,
                },
          checkpoint: null,
          receipt,
        },
      }
    },
  }
  const controller = (
    kind === 'default' ? createPackageMaintenanceController : createReferenceFixtureController
  )(ports)
  // Queries use exactly the same original owner reader; no candidate or build entry is reachable.
  const query = openInstallerFixture(kind, directory, {
    currentAuthorization: ports.currentAuthorization,
    readLocalOperation: ports.readLocalOperation,
  })
  const request: W['ChangeProposalRequest'] =
    operation === 'resource'
      ? { ...installerFixtureRequest(), targetScope: call.scope }
      : {
          requestId: `fixture-${operation}`,
          reason: 'replace a broken contribution through maintenance',
          targetScope: call.scope,
          change: {
            kind: 'package',
            operation:
              operation === 'repair'
                ? 'upgrade'
                : input.plan.operation === 'repair' || input.plan.operation === 'rollback'
                  ? 'upgrade'
                  : input.plan.operation,
            locator:
              operation === 'disable' || operation === 'repair'
                ? {
                    ...input.graph.lock.entries[0]!.locator,
                    digest: input.fixture.previousRelease!.packages[0]!.digest,
                  }
                : input.graph.lock.entries[0]!.locator,
          },
        }
  let closed = false
  return {
    ...f,
    controller,
    ports,
    query,
    call,
    request,
    control,
    input,
    assembly,
    patchApproval,
    approvals,
    async approved() {
      const accepted = await f.subject.requestChange(request, call)
      if (!accepted.ok) throw new Error(accepted.error.detailCode)
      let saved = f.journal.read(accepted.value.proposalId).proposal
      if (saved.status === 'planning') {
        const planned = await (operation === 'repair' ? controller.planRepair : controller.plan)(
          saved.proposalId,
          saved.revision,
          call,
        )
        if (!planned.ok) throw new Error(planned.error.detailCode)
        saved = planned.value
      }
      if (!saved.interactionRef) {
        const approval = await controller.requestApproval(saved.proposalId, saved.revision, call)
        if (!approval.ok) throw new Error(approval.error.detailCode)
        saved = approval.value
      }
      await hook?.('approval-linked')
      return saved
    },
    async close() {
      if (closed) return
      closed = true
      controller.dispose()
      query.close()
      f.close()
      await subject.dispose()
      await assembly.close()
    },
  }
}

export function coldInstallerApplyStatus(
  kind: 'default' | 'reference',
  directory: string,
): Outcome<W['ChangeProposal']> {
  const output = execFileSync(
    process.execPath,
    [
      '--import',
      'tsx',
      fileURLToPath(
        new URL(
          '../../../../packages/package-manager/test/runtime/fixtures/installer-apply-process.ts',
          import.meta.url,
        ),
      ),
    ],
    {
      env: {
        ...process.env,
        INSTALLER_APPLY_DIRECTORY: directory,
        INSTALLER_APPLY_KIND: kind,
        INSTALLER_APPLY_OPERATION: 'install',
        INSTALLER_APPLY_READ: '1',
      },
      encoding: 'utf8',
      timeout: 30000,
    },
  )
  return (JSON.parse(output) as { status: Outcome<W['ChangeProposal']> }).status
}
