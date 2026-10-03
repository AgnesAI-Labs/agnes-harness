import { createHash } from 'node:crypto'
import { chmodSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type { CallContext, Outcome } from '@agnes/extension-api/runtime'
import { jcs } from '@agnes/protocol'
import { validateRuntime, type RuntimeWireTypes as W } from '@agnes/protocol/runtime'
import {
  createReferencePackageApplyController,
  type ReferenceApplyCheckpoint,
  type ReferenceApplyPorts,
} from './package-apply.js'

// Independently stored revision history; no imports from the default provider or its journal.
export interface ReferenceInstallRecord {
  applyCheckpoint?: ReferenceApplyCheckpoint
  version: 1
  input: W['ChangeProposalRequest']
  inputDigest: string
  owner: string
  proposal: W['ChangeProposal']
  approvalRef: W['DataRef'] | null
  operation: { operationId: string; reference: W['DataRef'] } | null
  cancellation: { reason: string } | null
  repairPlanRef: W['DataRef'] | null
}
export interface ReferenceInstallJournal {
  read(id: string): ReferenceInstallRecord
  accept(request: W['ChangeProposalRequest'], principal: string): ReferenceInstallRecord
  compareAndSwap(id: string, expected: number, replacement: ReferenceInstallRecord): ReferenceInstallRecord
  close(): void
}
interface Observation {
  operationId: string
  planDigest: string
  state: 'unpublished' | 'published' | 'unknown'
  heads: W['UpgradeExpectedHeads'] | null
  checkpoint: W['UpgradeCheckpoint'] | null
  receipt: W['ReceiptPointer'] | null
}
export interface ReferenceInstallerOptions {
  journal: ReferenceInstallJournal
  currentAuthorization:
    | ((
        call: CallContext,
        scope: W['ScopeRef'],
        permission: 'propose' | 'read' | 'cancel' | 'maintain',
      ) => Promise<Outcome<string>>)
    | null
  readLocalOperation:
    | ((
        operation: NonNullable<ReferenceInstallRecord['operation']>,
        call: CallContext,
      ) => Promise<Outcome<Observation>>)
    | null
}

export class Refusal extends Error {
  constructor(
    readonly category: W['RuntimeErrorCode'],
    readonly detail: string,
  ) {
    super(detail)
  }
}
const fingerprint = (data: unknown): string => createHash('sha256').update(jcs(data)).digest('hex')
function reject(category: W['RuntimeErrorCode'], detail: string): never {
  throw new Refusal(category, detail)
}
function parsed<K extends keyof W>(type: K, data: unknown): W[K] {
  const result = validateRuntime(type, data)
  if (!result.ok) reject('invalid_input', 'schema_invalid')
  return structuredClone(result.value)
}
async function outcome<T>(run: () => Promise<T>): Promise<Outcome<T>> {
  try {
    return { ok: true, value: await run() }
  } catch (failure) {
    const code = failure instanceof Refusal ? failure.category : 'internal'
    const detailCode = failure instanceof Refusal ? failure.detail : 'installer_port_unavailable'
    return {
      ok: false,
      error: {
        code,
        detailCode,
        message: detailCode,
        diagnosticId: `installer:${detailCode}`,
        retryAdvice: { kind: 'never' },
      },
    }
  }
}

function validateRow(record: ReferenceInstallRecord): ReferenceInstallRecord {
  if (
    Object.keys(record)
      .filter((key) => key !== 'applyCheckpoint')
      .sort()
      .join(',') !==
      'approvalRef,cancellation,input,inputDigest,operation,owner,proposal,repairPlanRef,version' ||
    record.version !== 1
  )
    reject('internal', 'journal_corrupt')
  parsed('Id', record.owner)
  parsed('ChangeProposalRequest', record.input)
  const p = parsed('ChangeProposal', record.proposal)
  if (
    p.revision < 1 ||
    p.requester !== record.owner ||
    p.requestId !== record.input.requestId ||
    p.proposalId !== `proposal:${fingerprint([record.owner, p.requestId])}` ||
    record.inputDigest !== fingerprint(record.input) ||
    fingerprint(p.scope) !== fingerprint(record.input.targetScope)
  )
    reject('internal', 'journal_corrupt')
  if (
    p.plan === null
      ? p.planDigest !== null
      : p.planDigest !== (p.plan.kind === 'release' ? p.plan.value.planFingerprint : p.plan.value.digest)
  )
    reject('internal', 'journal_corrupt')
  if (record.approvalRef !== null) parsed('DataRef', record.approvalRef)
  if (record.repairPlanRef !== null) parsed('DataRef', record.repairPlanRef)
  if (record.operation !== null) {
    if (Object.keys(record.operation).sort().join(',') !== 'operationId,reference')
      reject('internal', 'journal_corrupt')
    parsed('Id', record.operation.operationId)
    parsed('DataRef', record.operation.reference)
    if (
      !record.approvalRef ||
      !p.plan ||
      (p.plan.kind === 'release' && p.plan.value.upgradeId !== record.operation.operationId)
    )
      reject('internal', 'journal_corrupt')
  } else if (['applying', 'unknown', 'applied'].includes(p.status)) reject('internal', 'journal_corrupt')
  if (['approved', 'applying', 'unknown', 'applied'].includes(p.status) && (!record.approvalRef || !p.plan))
    reject('internal', 'journal_corrupt')
  if (
    record.cancellation !== null &&
    (Object.keys(record.cancellation).join(',') !== 'reason' ||
      typeof record.cancellation.reason !== 'string')
  )
    reject('internal', 'journal_corrupt')
  const c = record.applyCheckpoint
  if (c) {
    if (
      Object.keys(c).sort().join(',') !==
      'binding,buildEvidence,candidateRef,inputsDigest,interactionId,phase,responseId'
    )
      reject('internal', 'journal_corrupt')
    parsed('Id', c.interactionId)
    parsed('ApprovalRequest', c.binding.request)
    parsed('DataRef', c.binding.planRef)
    parsed('DataRef', c.binding.input)
    if (
      c.binding.proposalId !== p.proposalId ||
      c.binding.planRevision > p.revision ||
      c.binding.planDigest !== p.planDigest
    )
      reject('internal', 'journal_corrupt')
    if (c.responseId !== null) parsed('Id', c.responseId)
    if (c.inputsDigest !== null) parsed('Digest', c.inputsDigest)
    if (
      !['approval', 'started', 'built', 'prepared', 'publishing', 'done'].includes(c.phase) ||
      p.interactionRef?.interactionId !== c.interactionId ||
      !Array.isArray(c.buildEvidence)
    )
      reject('internal', 'journal_corrupt')
    for (const evidence of c.buildEvidence) parsed('DataRef', evidence)
    if (c.candidateRef !== null) parsed('DataRef', c.candidateRef)
    if (c.phase !== 'approval' && (!record.operation || !c.responseId || !c.inputsDigest))
      reject('internal', 'journal_corrupt')
  } else if ('applyCheckpoint' in record) reject('internal', 'journal_corrupt')
  return structuredClone(record)
}

export function openReferenceInstallJournal(path: string): ReferenceInstallJournal {
  mkdirSync(dirname(path), { mode: 0o700, recursive: true })
  const sql = new DatabaseSync(path)
  chmodSync(path, 0o600)
  sql.exec(`PRAGMA synchronous=FULL; PRAGMA journal_mode=DELETE; PRAGMA busy_timeout=5000;
    CREATE TABLE IF NOT EXISTS history (identity TEXT NOT NULL, revision INTEGER NOT NULL,
      document TEXT NOT NULL, checksum TEXT NOT NULL, PRIMARY KEY(identity, revision));`)
  let ended = false
  const live = () => {
    if (ended) reject('internal', 'journal_closed')
  }
  let last: { wire: string; checked: ReferenceInstallRecord } | undefined
  const readOptional = (id: string) => {
    live()
    const row = sql.prepare('SELECT * FROM history WHERE identity=? ORDER BY revision DESC LIMIT 1').get(id)
    if (!row) return null
    const wire = JSON.stringify(row)
    if (last?.wire === wire) return structuredClone(last.checked)
    if (typeof row.document !== 'string') reject('internal', 'journal_corrupt')
    const data = JSON.parse(row.document) as ReferenceInstallRecord
    if (
      fingerprint(data) !== row.checksum ||
      data.proposal.proposalId !== row.identity ||
      data.proposal.revision !== row.revision
    )
      reject('internal', 'journal_corrupt')
    const checked = validateRow(data)
    last = { wire, checked }
    return structuredClone(checked)
  }
  const write = (data: ReferenceInstallRecord) =>
    sql
      .prepare('INSERT INTO history VALUES (?,?,?,?)')
      .run(data.proposal.proposalId, data.proposal.revision, JSON.stringify(data), fingerprint(data))
  const atomic = <T>(work: () => T) => {
    live()
    sql.exec('BEGIN IMMEDIATE')
    try {
      const value = work()
      sql.exec('COMMIT')
      return value
    } catch (error) {
      sql.exec('ROLLBACK')
      throw error
    }
  }
  const read = (id: string) => readOptional(id) ?? reject('denied', 'proposal_not_found')
  return {
    read,
    accept(request, principal) {
      const input = parsed('ChangeProposalRequest', request)
      parsed('Id', principal)
      const id = `proposal:${fingerprint([principal, input.requestId])}`
      return atomic(() => {
        const previous = readOptional(id)
        if (previous) {
          if (previous.inputDigest !== fingerprint(input)) reject('conflict', 'request_input_conflict')
          return previous
        }
        const record: ReferenceInstallRecord = {
          version: 1,
          owner: principal,
          input,
          inputDigest: fingerprint(input),
          approvalRef: null,
          operation: null,
          cancellation: null,
          repairPlanRef: null,
          proposal: {
            proposalId: id,
            requestId: input.requestId,
            requester: principal,
            scope: input.targetScope,
            revision: 1,
            status: 'planning',
            plan: null,
            planDigest: null,
            interactionRef: null,
            resultRef: null,
            error: null,
          },
        }
        write(record)
        return structuredClone(record)
      })
    },
    compareAndSwap(id, expected, replacement) {
      return atomic(() => {
        const old = read(id)
        if (old.proposal.revision !== expected) reject('conflict', 'proposal_revision_conflict')
        const next = validateRow(replacement)
        if (old.cancellation && !old.operation && next.operation) reject('cancelled', 'proposal_cancelled')
        if (
          !old.operation &&
          next.operation &&
          (old.proposal.status !== 'approved' || next.proposal.status !== 'applying')
        )
          reject('conflict', 'invalid_transition')
        if (
          !old.proposal.resultRef &&
          next.proposal.resultRef &&
          (!old.operation || next.proposal.status !== 'applied')
        )
          reject('conflict', 'invalid_transition')
        const fixed = (r: ReferenceInstallRecord) => [r.owner, r.inputDigest, r.input]
        if (fingerprint(fixed(old)) !== fingerprint(fixed(next)) || next.proposal.revision !== expected + 1)
          reject('conflict', 'immutable_fact')
        for (const key of ['approvalRef', 'operation', 'cancellation'] as const)
          if (old[key] !== null && fingerprint(old[key]) !== fingerprint(next[key]))
            reject('conflict', 'immutable_fact')
        for (const key of ['plan', 'resultRef'] as const)
          if (
            old.proposal[key] !== null &&
            fingerprint(old.proposal[key]) !== fingerprint(next.proposal[key])
          )
            reject('conflict', 'immutable_fact')
        if (old.applyCheckpoint) {
          const a = old.applyCheckpoint,
            b = next.applyCheckpoint,
            stages = ['approval', 'started', 'built', 'prepared', 'publishing', 'done']
          if (
            !b ||
            a.interactionId !== b.interactionId ||
            fingerprint(a.binding) !== fingerprint(b.binding) ||
            (a.responseId !== null && a.responseId !== b.responseId) ||
            (a.inputsDigest !== null && a.inputsDigest !== b.inputsDigest) ||
            stages.indexOf(b.phase) < stages.indexOf(a.phase) ||
            fingerprint(a.buildEvidence) !== fingerprint(b.buildEvidence.slice(0, a.buildEvidence.length)) ||
            (a.candidateRef !== null && fingerprint(a.candidateRef) !== fingerprint(b.candidateRef))
          )
            reject('conflict', 'immutable_fact')
        } else if (next.applyCheckpoint && (old.proposal.status !== 'awaiting-approval' || old.operation))
          reject('conflict', 'invalid_transition')
        const from = old.proposal.status,
          to = next.proposal.status
        const allowed =
          from === 'planning'
            ? ['awaiting-approval', 'denied', 'cancelled']
            : from === 'awaiting-approval'
              ? ['awaiting-approval', 'approved', 'denied', 'cancelled']
              : from === 'approved'
                ? ['applying', 'cancelled']
                : ['applying', 'unknown'].includes(from)
                  ? ['applying', 'unknown', 'applied']
                  : [from]
        if (!allowed.includes(to)) reject('conflict', 'invalid_transition')
        write(next)
        return next
      })
    },
    close() {
      if (!ended) {
        ended = true
        last = undefined
        sql.close()
      }
    },
  }
}

async function permission(
  options: ReferenceInstallerOptions,
  context: CallContext,
  scope: W['ScopeRef'],
  mode: 'propose' | 'read' | 'cancel' | 'maintain',
) {
  if (context.signal.aborted) reject('cancelled', 'call_cancelled')
  const port = options.currentAuthorization
  if (!port) reject('denied', 'current_authorization_unavailable')
  const answer = await port(context, scope, mode)
  if (!answer.ok) reject(answer.error.code, answer.error.detailCode)
  parsed('Id', answer.value)
  if (answer.value !== context.principalRef) reject('denied', 'principal_mismatch')
  if (context.signal.aborted) reject('cancelled', 'call_cancelled')
  return answer.value
}
function observationMatches(record: ReferenceInstallRecord, found: Observation) {
  if (
    !record.operation ||
    record.operation.operationId !== found.operationId ||
    record.proposal.planDigest !== found.planDigest
  )
    reject('conflict', 'operation_identity_conflict')
  if (record.applyCheckpoint && record.proposal.plan?.kind === 'resource') {
    if (found.heads !== null) reject('conflict', 'operation_identity_conflict')
  } else if (
    !(
      found.heads === null &&
      record.proposal.plan?.kind === 'release' &&
      record.proposal.plan.value.sourceReleaseSetId === null &&
      found.state !== 'published'
    )
  )
    parsed('UpgradeExpectedHeads', found.heads)
  if (found.checkpoint) parsed('UpgradeCheckpoint', found.checkpoint)
  if (found.receipt) parsed('ReceiptPointer', found.receipt)
  if (!['published', 'unpublished', 'unknown'].includes(found.state))
    reject('invalid_input', 'operation_observation_invalid')
  if (found.state === 'published' && !found.receipt) reject('conflict', 'publication_receipt_missing')
  if (
    (found.state === 'unpublished' && (found.receipt || record.proposal.resultRef)) ||
    (record.proposal.resultRef &&
      found.receipt &&
      fingerprint(record.proposal.resultRef) !== fingerprint(found.receipt))
  )
    reject('conflict', 'publication_fact_conflict')
}

async function queryOriginal(
  saved: ReferenceInstallRecord,
  options: ReferenceInstallerOptions,
  call: CallContext,
  mode: 'read' | 'maintain',
): Promise<W['ChangeProposal']> {
  if (!saved.operation) return saved.proposal
  const fallback: W['ChangeProposal'] = {
    ...saved.proposal,
    status: saved.proposal.resultRef ? 'applied' : 'unknown',
  }
  const reader = options.readLocalOperation
  if (!reader) return fallback
  const answer = await outcome(async () => {
    const result = await reader(
      structuredClone(saved.operation as NonNullable<ReferenceInstallRecord['operation']>),
      call,
    )
    if (!result.ok) reject('unknown_effect', 'operation_probe_unavailable')
    return result.value
  })
  await permission(options, call, saved.proposal.scope, mode)
  if (!answer.ok) return fallback
  observationMatches(saved, answer.value)
  return {
    ...saved.proposal,
    status: answer.value.state === 'published' ? 'applied' : fallback.status,
    resultRef: answer.value.receipt ?? saved.proposal.resultRef,
  }
}

export function createReferencePackageInstallerProvider(options: ReferenceInstallerOptions) {
  let unavailable = false
  const available = () => {
    if (unavailable) reject('internal', 'provider_disposed')
  }
  async function owned(id: string, call: CallContext, mode: 'read' | 'cancel') {
    available()
    const saved = options.journal.read(id)
    if (saved.owner !== (await permission(options, call, saved.proposal.scope, mode)))
      reject('denied', 'proposal_owner_required')
    available()
    return saved
  }
  return {
    providerId: 'agh.reference/package-installer',
    contract: 'agh.package-installer' as const,
    implemented: ['requestChange', 'cancelProposal', 'proposalStatus'],
    incomplete: ['prepare', 'activate', 'disable', 'repair', 'applyResourceChange', 'publication-recovery'],
    requestChange(data: unknown, call: CallContext) {
      return outcome(async () => {
        available()
        const request = parsed('ChangeProposalRequest', data)
        const actor = await permission(options, call, request.targetScope, 'propose')
        available()
        return options.journal.accept(request, actor).proposal
      })
    },
    cancelProposal(data: unknown, call: CallContext) {
      return outcome(async () => {
        const request = parsed('PackageInstallerCancelProposalRequest', data)
        const saved = await owned(request.proposalId, call, 'cancel')
        if (saved.proposal.revision !== request.expectedRevision)
          reject('conflict', 'proposal_revision_conflict')
        if (saved.cancellation) return saved.proposal
        const status =
          !saved.operation && !['applied', 'denied'].includes(saved.proposal.status)
            ? ('cancelled' as const)
            : saved.proposal.status
        return options.journal.compareAndSwap(request.proposalId, request.expectedRevision, {
          ...saved,
          cancellation: { reason: request.reason },
          proposal: { ...saved.proposal, status, revision: saved.proposal.revision + 1 },
        }).proposal
      })
    },
    proposalStatus(data: unknown, call: CallContext) {
      return outcome(async () => {
        const request = parsed('PackageInstallerProposalStatusRequest', data)
        const saved = await owned(request.proposalId, call, 'read')
        const status = await queryOriginal(saved, options, call, 'read')
        available()
        return status
      })
    },
    dispose() {
      unavailable = true
    },
  }
}

export interface ReferenceMaintenancePorts extends ReferenceInstallerOptions, ReferenceApplyPorts {
  selectDisableProposal?:
    | ((
        input: W['PackageInstallerDisableRequest'],
        c: CallContext,
      ) => Promise<Outcome<{ proposalId: string; revision: number }>>)
    | null
  validatePlanInput?:
    | ((
        input: W['ChangeProposalRequest'],
        plan: NonNullable<W['ChangeProposal']['plan']>,
        call: CallContext,
      ) => Promise<Outcome<void>>)
    | null
  resolveReleaseRoute: ((scope: W['ScopeRef'], call: CallContext) => Promise<Outcome<string>>) | null
  generateVerifiedPlan:
    | ((
        input: W['ChangeProposalRequest'],
        call: CallContext,
      ) => Promise<Outcome<NonNullable<W['ChangeProposal']['plan']>>>)
    | null
  readDeploymentApproval:
    | ((
        id: string,
        call: CallContext,
      ) => Promise<
        Outcome<{
          kind: 'deployment'
          proposalId: string
          owner: string
          scope: W['ScopeRef']
          planDigest: string
          actorRef: string
          expiresAt: string
          decision: 'approved' | 'denied'
          reference: W['DataRef']
        }>
      >)
    | null
  candidate:
    | ((
        request: W['AssemblyPrepareRequest'],
        call: CallContext,
      ) => Promise<Outcome<W['AssemblyPrepareResult']>>)
    | null
  publish:
    | ((
        request: W['AssemblyPublishRequest'],
        call: CallContext,
      ) => Promise<Outcome<W['AssemblyPublishResult']>>)
    | null
  now: () => string
}

export function createReferencePackageMaintenanceController(ports: ReferenceMaintenancePorts) {
  let disposed = false
  function live() {
    if (disposed) reject('internal', 'provider_disposed')
  }
  async function routeMatches(
    saved: ReferenceInstallRecord,
    plan: NonNullable<W['ChangeProposal']['plan']>,
    call: CallContext,
  ) {
    if (plan.kind === 'release') {
      if (!ports.resolveReleaseRoute) reject('denied', 'release_target_validation_unavailable')
      const route = await ports.resolveReleaseRoute(saved.proposal.scope, call)
      if (!route.ok) reject(route.error.code, route.error.detailCode)
      if (plan.value.routeId !== route.value) reject('conflict', 'plan_target_conflict')
    }
  }
  async function current(id: string, version: number, call: CallContext) {
    live()
    const saved = ports.journal.read(id)
    await permission(ports, call, saved.proposal.scope, 'maintain')
    if (saved.proposal.revision !== version) reject('conflict', 'proposal_revision_conflict')
    if (saved.cancellation) reject('cancelled', 'proposal_cancelled')
    return saved
  }
  const effects = createReferencePackageApplyController(ports)
  const unavailableEffect = (_data: unknown, call: CallContext) =>
    outcome(async () => {
      live()
      await permission(ports, call, call.scope, 'maintain')
      return reject('incompatible', 'installer_effect_unimplemented')
    })
  const planning = (id: string, version: number, call: CallContext, maintenanceRepair = false) =>
    outcome(async () => {
      const saved = await current(id, version, call)
      if (saved.proposal.status !== 'planning') reject('conflict', 'proposal_not_planning')
      if (!ports.generateVerifiedPlan) reject('incompatible', 'plan_generation_unavailable')
      const result = await ports.generateVerifiedPlan(structuredClone(saved.input), call)
      if (!result.ok) reject(result.error.code, result.error.detailCode)
      const plan = structuredClone(result.value)
      const change = saved.input.change
      if (maintenanceRepair && (plan.kind !== 'release' || plan.value.operation !== 'repair'))
        reject('conflict', 'plan_input_conflict')
      if (plan.kind === 'release') {
        parsed('ReleasePlan', plan.value)
        if (
          change.kind !== 'package' ||
          (change.operation !== plan.value.operation &&
            !(maintenanceRepair && change.operation === 'upgrade' && plan.value.operation === 'repair')) ||
          (!['disable', 'repair'].includes(plan.value.operation) &&
            !plan.value.targetReleaseSet.packages.some(
              (row) =>
                row.sourceRef === change.locator.sourceId &&
                row.digest === change.locator.digest &&
                (change.locator.kind !== 'npm' || row.version === change.locator.version),
            ))
        )
          reject('conflict', 'plan_input_conflict')
      } else {
        parsed('ResourceChangePlan', plan.value)
        const value = plan.value
        const source = {
          kind: value.kind,
          resourceId: value.resourceId,
          sourceRef: value.sourceRef,
          operation: value.operation,
          config: value.config,
          targetScope: value.targetScope,
        }
        if (
          change.kind === 'package' ||
          fingerprint(source) !== fingerprint({ ...change, targetScope: saved.input.targetScope })
        )
          reject('conflict', 'plan_input_conflict')
      }
      const name = plan.kind === 'release' ? 'planFingerprint' : 'digest'
      const body = { ...plan.value }
      Reflect.deleteProperty(body, name)
      if (fingerprint(body) !== (plan.kind === 'release' ? plan.value.planFingerprint : plan.value.digest))
        reject('conflict', 'plan_input_conflict')
      if (plan.kind === 'release' && ['disable', 'repair'].includes(plan.value.operation)) {
        if (!ports.validatePlanInput) reject('denied', 'plan_source_validation_unavailable')
        const verified = await ports.validatePlanInput(saved.input, plan, call)
        if (!verified.ok) reject(verified.error.code, verified.error.detailCode)
      }
      await routeMatches(saved, plan, call)
      await current(id, version, call)
      return ports.journal.compareAndSwap(id, version, {
        ...saved,
        proposal: {
          ...saved.proposal,
          revision: version + 1,
          status: 'awaiting-approval',
          plan,
          planDigest: plan.kind === 'release' ? plan.value.planFingerprint : plan.value.digest,
        },
      }).proposal
    })
  return {
    ...effects,
    dispose() {
      disposed = true
      effects.dispose()
    },
    proposalStatus(data: unknown, call: CallContext) {
      return outcome(async () => {
        live()
        const request = parsed('PackageInstallerProposalStatusRequest', data)
        const saved = ports.journal.read(request.proposalId)
        await permission(ports, call, saved.proposal.scope, 'maintain')
        return queryOriginal(saved, ports, call, 'maintain')
      })
    },
    plan(id: string, version: number, call: CallContext) {
      return planning(id, version, call)
    },
    planRepair(id: string, version: number, call: CallContext) {
      return planning(id, version, call, true)
    },
    checkApproval(id: string, version: number, approvalId: string, call: CallContext) {
      return outcome(async () => {
        const saved = await current(id, version, call)
        if (!saved.proposal.plan || saved.proposal.status !== 'awaiting-approval')
          reject('conflict', 'proposal_not_awaiting_approval')
        await routeMatches(saved, saved.proposal.plan, call)
        if (!ports.readDeploymentApproval) reject('denied', 'deployment_approval_unavailable')
        const result = await ports.readDeploymentApproval(approvalId, call)
        if (!result.ok) reject(result.error.code, result.error.detailCode)
        await routeMatches(saved, saved.proposal.plan, call)
        await current(id, version, call)
        const a = result.value
        const timestamp = Date.parse(ports.now())
        const matches =
          a.kind === 'deployment' &&
          a.decision === 'approved' &&
          a.proposalId === id &&
          a.owner === saved.owner &&
          a.planDigest === saved.proposal.planDigest &&
          fingerprint(a.scope) === fingerprint(saved.proposal.scope) &&
          a.actorRef === call.principalRef &&
          Number.isFinite(Date.parse(a.expiresAt)) &&
          Date.parse(a.expiresAt) > timestamp &&
          (saved.proposal.plan.kind !== 'release' ||
            Date.parse(saved.proposal.plan.value.expiresAt) > timestamp)
        if (!matches) reject('denied', 'deployment_approval_mismatch')
        parsed('DataRef', a.reference)
        return ports.journal.compareAndSwap(id, version, {
          ...saved,
          approvalRef: structuredClone(a.reference),
          proposal: { ...saved.proposal, status: 'approved', revision: version + 1 },
        }).proposal
      })
    },
    prepare: unavailableEffect,
    activate: unavailableEffect,
    disable: ports.selectDisableProposal
      ? (data: unknown, call: CallContext) =>
          outcome(async () => {
            live()
            const input = parsed('PackageInstallerDisableRequest', data)
            live()
            await permission(ports, call, call.scope, 'maintain')
            const selection = await ports.selectDisableProposal!(input, call)
            if (!selection.ok) reject(selection.error.code, selection.error.detailCode)
            const saved = ports.journal.read(selection.value.proposalId),
              plan = saved.proposal.plan
            if (
              plan?.kind !== 'release' ||
              plan.value.operation !== 'disable' ||
              !plan.value.affectedContributions.includes(input.contributionId)
            )
              reject('conflict', 'plan_input_conflict')
            const done = await effects.apply(selection.value.proposalId, selection.value.revision, call)
            if (!done.ok) reject(done.error.code, done.error.detailCode)
            return parsed('PackageInstallerDisableResult', { disabledId: input.contributionId })
          })
      : unavailableEffect,
    repair: unavailableEffect,
    applyResourceChange: ports.executionInputs
      ? (data: unknown, call: CallContext) =>
          outcome(async () => {
            live()
            const input = parsed('PackageInstallerApplyResourceChangeRequest', data)
            const saved = ports.journal.read(input.proposalId),
              plan = saved.proposal.plan
            await permission(ports, call, saved.proposal.scope, 'maintain')
            if (
              plan?.kind !== 'resource' ||
              fingerprint(plan.value) !== fingerprint(input.plan) ||
              input.approvalRef !== saved.applyCheckpoint?.interactionId
            )
              reject('conflict', 'plan_input_conflict')
            const done = await effects.apply(input.proposalId, input.expectedProposalRevision, call)
            if (!done.ok) reject(done.error.code, done.error.detailCode)
            if (!done.value.resultRef) reject('unknown_effect', 'operation_unknown')
            return parsed('PackageInstallerApplyResourceChangeResult', {
              proposal: done.value,
              receipt: done.value.resultRef,
            })
          })
      : unavailableEffect,
  }
}

export function createReferenceInstallRepairPlan(
  record: ReferenceInstallRecord,
  observed: Observation,
  currentHeads: W['UpgradeExpectedHeads'],
  verify: (ref: W['DataRef'], checkpoint: W['UpgradeCheckpoint']) => Outcome<W['UpgradeExpectedHeads']>,
) {
  try {
    observationMatches(record, observed)
    const heads = parsed('UpgradeExpectedHeads', currentHeads)
    const checkpoint = observed.checkpoint
    if (!record.operation || !checkpoint?.evidence.length) reject('denied', 'checkpoint_unverified')
    if (observed.state === 'unknown') reject('unknown_effect', 'operation_unknown')
    const checked = verify(record.operation.reference, checkpoint)
    if (!checked.ok) reject(checked.error.code, checked.error.detailCode)
    parsed('UpgradeExpectedHeads', checked.value)
    if (fingerprint(checked.value) !== fingerprint(observed.heads))
      reject('conflict', 'checkpoint_heads_conflict')
    if (
      heads.kind !== 'release' ||
      observed.heads?.kind !== 'release' ||
      heads.routeId !== observed.heads.routeId
    )
      reject('conflict', 'repair_route_conflict')
    const unchanged = fingerprint(heads) === fingerprint(observed.heads)
    if (observed.state === 'unpublished' && !unchanged) reject('conflict', 'repair_heads_conflict')
    const action =
      observed.state === 'published'
        ? unchanged
          ? ('probe-published' as const)
          : ('new-reverse-operation' as const)
        : ('reclaim-unpublished' as const)
    const data = {
      proposalId: record.proposal.proposalId,
      proposalRevision: record.proposal.revision,
      operationRef: record.operation.reference,
      operationId: record.operation.operationId,
      checkpoint: structuredClone(checkpoint),
      currentHeads: heads,
      action,
      originalReceipt: observed.receipt,
    }
    return { ok: true as const, value: { ...data, digest: fingerprint(data) } }
  } catch (error) {
    const code = error instanceof Refusal ? error.category : 'internal'
    const detailCode = error instanceof Refusal ? error.detail : 'journal_unavailable'
    return {
      ok: false as const,
      error: {
        code,
        detailCode,
        message: detailCode,
        diagnosticId: `installer:${detailCode}`,
        retryAdvice: { kind: 'never' as const },
      },
    }
  }
}
