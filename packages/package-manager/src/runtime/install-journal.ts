import { createHash } from 'node:crypto'
import { chmodSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type { Outcome } from '@agnes/extension-api/runtime'
import { jcs } from '@agnes/protocol'
import { validateRuntime, type RuntimeWireTypes as Wire } from '@agnes/protocol/runtime'
import type { InstallApplyCheckpoint } from './package-apply.js'

/** Private proposal record. Operation refs point to the sole external upgrade authority. */
export interface InstallRecord {
  readonly applyCheckpoint?: InstallApplyCheckpoint
  readonly version: 1
  readonly input: Wire['ChangeProposalRequest']
  readonly inputDigest: string
  readonly owner: string
  readonly proposal: Wire['ChangeProposal']
  readonly approvalRef: Wire['DataRef'] | null
  readonly operation: { readonly operationId: string; readonly reference: Wire['DataRef'] } | null
  readonly cancellation: { readonly reason: string } | null
  readonly repairPlanRef: Wire['DataRef'] | null
}

export interface InstallJournal {
  accept(input: Wire['ChangeProposalRequest'], owner: string): InstallRecord
  read(proposalId: string): InstallRecord
  compareAndSwap(proposalId: string, revision: number, next: InstallRecord): InstallRecord
  close(): void
}

export class InstallFault extends Error {
  constructor(
    readonly code: Wire['RuntimeErrorCode'],
    readonly detailCode: string,
  ) {
    super(detailCode)
  }
}

export function installerDigest(value: unknown): string {
  return createHash('sha256').update(jcs(value)).digest('hex')
}

export function installerFailure<T>(code: Wire['RuntimeErrorCode'], detailCode: string): Outcome<T> {
  return {
    ok: false,
    error: {
      code,
      detailCode,
      message: detailCode,
      retryAdvice: { kind: 'never' },
      diagnosticId: `installer:${detailCode}`,
    },
  }
}

export function installerAttempt<T>(action: () => T): Outcome<T> {
  try {
    return { ok: true, value: action() }
  } catch (error) {
    return error instanceof InstallFault
      ? installerFailure(error.code, error.detailCode)
      : installerFailure('internal', 'journal_unavailable')
  }
}

export function installerWire<K extends keyof Wire>(name: K, input: unknown): Wire[K] {
  const result = validateRuntime(name, input)
  if (!result.ok) throw new InstallFault('invalid_input', 'schema_invalid')
  return structuredClone(result.value)
}

export function initialInstallRecord(input: Wire['ChangeProposalRequest'], owner: string): InstallRecord {
  const request = installerWire('ChangeProposalRequest', input)
  installerWire('Id', owner)
  return {
    version: 1,
    input: request,
    inputDigest: installerDigest(request),
    owner,
    proposal: {
      proposalId: `proposal:${installerDigest([owner, request.requestId])}`,
      requestId: request.requestId,
      requester: owner,
      revision: 1,
      scope: request.targetScope,
      status: 'planning',
      plan: null,
      planDigest: null,
      interactionRef: null,
      resultRef: null,
      error: null,
    },
    approvalRef: null,
    operation: null,
    cancellation: null,
    repairPlanRef: null,
  }
}

export function validateInstallRecord(raw: InstallRecord): InstallRecord {
  if (
    !raw ||
    Object.keys(raw)
      .filter((key) => key !== 'applyCheckpoint')
      .sort()
      .join(',') !==
      'approvalRef,cancellation,input,inputDigest,operation,owner,proposal,repairPlanRef,version' ||
    raw.version !== 1
  )
    throw new InstallFault('internal', 'journal_corrupt')
  const input = installerWire('ChangeProposalRequest', raw.input)
  const proposal = installerWire('ChangeProposal', raw.proposal)
  const initial = initialInstallRecord(input, raw.owner)
  if (
    raw.inputDigest !== initial.inputDigest ||
    proposal.proposalId !== initial.proposal.proposalId ||
    proposal.requestId !== input.requestId ||
    proposal.requester !== raw.owner ||
    proposal.revision < 1 ||
    installerDigest(proposal.scope) !== installerDigest(input.targetScope)
  )
    throw new InstallFault('internal', 'journal_corrupt')
  if ((proposal.plan === null) !== (proposal.planDigest === null))
    throw new InstallFault('internal', 'journal_corrupt')
  if (proposal.plan !== null) {
    const digest =
      proposal.plan.kind === 'release' ? proposal.plan.value.planFingerprint : proposal.plan.value.digest
    if (digest !== proposal.planDigest) throw new InstallFault('internal', 'journal_corrupt')
  }
  if (raw.approvalRef !== null) installerWire('DataRef', raw.approvalRef)
  if (raw.repairPlanRef !== null) installerWire('DataRef', raw.repairPlanRef)
  if (raw.operation !== null) {
    if (Object.keys(raw.operation).sort().join(',') !== 'operationId,reference')
      throw new InstallFault('internal', 'journal_corrupt')
    installerWire('Id', raw.operation.operationId)
    installerWire('DataRef', raw.operation.reference)
    if (
      proposal.plan === null ||
      raw.approvalRef === null ||
      (proposal.plan.kind === 'release' && proposal.plan.value.upgradeId !== raw.operation.operationId)
    )
      throw new InstallFault('internal', 'journal_corrupt')
  }
  if (
    raw.cancellation !== null &&
    (Object.keys(raw.cancellation).join(',') !== 'reason' || typeof raw.cancellation.reason !== 'string')
  )
    throw new InstallFault('internal', 'journal_corrupt')
  if (raw.operation === null && ['applying', 'applied', 'unknown'].includes(proposal.status))
    throw new InstallFault('internal', 'journal_corrupt')
  if (
    ['approved', 'applying', 'applied', 'unknown'].includes(proposal.status) &&
    (proposal.plan === null || raw.approvalRef === null)
  )
    throw new InstallFault('internal', 'journal_corrupt')
  if (raw.applyCheckpoint) {
    const cp = raw.applyCheckpoint
    if (
      Object.keys(cp).sort().join(',') !==
      'binding,buildEvidence,candidateRef,inputsDigest,interactionId,phase,responseId'
    )
      throw new InstallFault('internal', 'journal_corrupt')
    installerWire('Id', cp.interactionId)
    installerWire('ApprovalRequest', cp.binding.request)
    installerWire('DataRef', cp.binding.planRef)
    installerWire('DataRef', cp.binding.input)
    if (
      cp.binding.proposalId !== proposal.proposalId ||
      cp.binding.planRevision > proposal.revision ||
      cp.binding.planDigest !== proposal.planDigest
    )
      throw new InstallFault('internal', 'journal_corrupt')
    if (cp.responseId !== null) installerWire('Id', cp.responseId)
    if (cp.inputsDigest !== null) installerWire('Digest', cp.inputsDigest)
    if (
      !['approval', 'started', 'built', 'prepared', 'publishing', 'done'].includes(cp.phase) ||
      proposal.interactionRef?.interactionId !== cp.interactionId ||
      !Array.isArray(cp.buildEvidence)
    )
      throw new InstallFault('internal', 'journal_corrupt')
    for (const evidence of cp.buildEvidence) installerWire('DataRef', evidence)
    if (cp.candidateRef !== null) installerWire('DataRef', cp.candidateRef)
    if (cp.phase !== 'approval' && (!raw.operation || !cp.inputsDigest || !cp.responseId))
      throw new InstallFault('internal', 'journal_corrupt')
  } else if ('applyCheckpoint' in raw) throw new InstallFault('internal', 'journal_corrupt')
  return structuredClone(raw)
}

export function validateInstallTransition(previous: InstallRecord, next: InstallRecord): InstallRecord {
  validateInstallRecord(next)
  if (previous.cancellation !== null && previous.operation === null && next.operation !== null)
    throw new InstallFault('cancelled', 'proposal_cancelled')
  if (
    previous.operation === null &&
    next.operation !== null &&
    (previous.proposal.status !== 'approved' || next.proposal.status !== 'applying')
  )
    throw new InstallFault('conflict', 'invalid_transition')
  if (
    previous.proposal.resultRef === null &&
    next.proposal.resultRef !== null &&
    (previous.operation === null || next.proposal.status !== 'applied')
  )
    throw new InstallFault('conflict', 'invalid_transition')
  if (
    installerDigest([previous.input, previous.owner, previous.inputDigest]) !==
      installerDigest([next.input, next.owner, next.inputDigest]) ||
    next.proposal.revision !== previous.proposal.revision + 1 ||
    (previous.proposal.plan !== null &&
      installerDigest(previous.proposal.plan) !== installerDigest(next.proposal.plan)) ||
    (previous.approvalRef !== null &&
      installerDigest(previous.approvalRef) !== installerDigest(next.approvalRef)) ||
    (previous.operation !== null &&
      installerDigest(previous.operation) !== installerDigest(next.operation)) ||
    (previous.proposal.resultRef !== null &&
      installerDigest(previous.proposal.resultRef) !== installerDigest(next.proposal.resultRef)) ||
    (previous.cancellation !== null &&
      installerDigest(previous.cancellation) !== installerDigest(next.cancellation))
  )
    throw new InstallFault('conflict', 'immutable_fact')
  if (previous.applyCheckpoint) {
    const old = previous.applyCheckpoint,
      cp = next.applyCheckpoint
    const phases = ['approval', 'started', 'built', 'prepared', 'publishing', 'done']
    if (
      !cp ||
      cp.interactionId !== old.interactionId ||
      installerDigest(cp.binding) !== installerDigest(old.binding) ||
      (old.responseId !== null && old.responseId !== cp.responseId) ||
      (old.inputsDigest !== null && old.inputsDigest !== cp.inputsDigest) ||
      phases.indexOf(cp.phase) < phases.indexOf(old.phase) ||
      installerDigest(cp.buildEvidence.slice(0, old.buildEvidence.length)) !==
        installerDigest(old.buildEvidence) ||
      (old.candidateRef !== null && installerDigest(old.candidateRef) !== installerDigest(cp.candidateRef))
    )
      throw new InstallFault('conflict', 'immutable_fact')
  } else if (next.applyCheckpoint && (previous.proposal.status !== 'awaiting-approval' || previous.operation))
    throw new InstallFault('conflict', 'invalid_transition')
  const transitions: Record<Wire['ChangeProposal']['status'], readonly Wire['ChangeProposal']['status'][]> = {
    planning: ['awaiting-approval', 'denied', 'cancelled'],
    'awaiting-approval': ['awaiting-approval', 'approved', 'denied', 'cancelled'],
    approved: ['applying', 'cancelled'],
    applying: ['applying', 'unknown', 'applied'],
    unknown: ['unknown', 'applying', 'applied'],
    applied: ['applied'],
    denied: ['denied'],
    cancelled: ['cancelled'],
  }
  if (!transitions[previous.proposal.status].includes(next.proposal.status))
    throw new InstallFault('conflict', 'invalid_transition')
  return structuredClone(next)
}

/** Local SQLite transactions only; this store never owns release routes or publication. */
export function openInstallJournal(file: string): InstallJournal {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 })
  const database = new DatabaseSync(file)
  chmodSync(file, 0o600)
  database.exec(`PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;
    CREATE TABLE IF NOT EXISTS proposals (
      id TEXT PRIMARY KEY, owner TEXT NOT NULL, request_id TEXT NOT NULL,
      revision INTEGER NOT NULL, payload TEXT NOT NULL, digest TEXT NOT NULL,
      UNIQUE(owner, request_id));`)
  let closed = false
  const checkOpen = () => {
    if (closed) throw new InstallFault('internal', 'journal_closed')
  }
  // Reuse validation only for the exact bytes and metadata read from SQLite, never by revision alone.
  let cached: { key: string; record: InstallRecord } | undefined
  const decode = (row: Record<string, unknown> | undefined): InstallRecord => {
    if (!row) throw new InstallFault('denied', 'proposal_not_found')
    const key = JSON.stringify([row.id, row.owner, row.request_id, row.revision, row.payload, row.digest])
    if (cached?.key === key) return structuredClone(cached.record)
    if (typeof row.payload !== 'string' || installerDigest(JSON.parse(row.payload)) !== row.digest)
      throw new InstallFault('internal', 'journal_corrupt')
    const record = validateInstallRecord(JSON.parse(row.payload) as InstallRecord)
    if (
      record.proposal.proposalId !== row.id ||
      record.owner !== row.owner ||
      record.proposal.requestId !== row.request_id ||
      record.proposal.revision !== row.revision
    )
      throw new InstallFault('internal', 'journal_corrupt')
    cached = { key, record }
    return structuredClone(record)
  }
  const transaction = <T>(action: () => T): T => {
    checkOpen()
    database.exec('BEGIN IMMEDIATE')
    try {
      const result = action()
      database.exec('COMMIT')
      return result
    } catch (error) {
      database.exec('ROLLBACK')
      throw error
    }
  }
  const read = (id: string): InstallRecord => {
    checkOpen()
    return decode(database.prepare('SELECT * FROM proposals WHERE id = ?').get(id))
  }
  return {
    read,
    accept(input, owner) {
      const draft = initialInstallRecord(input, owner)
      return transaction(() => {
        const row = database
          .prepare('SELECT * FROM proposals WHERE owner = ? AND request_id = ?')
          .get(owner, input.requestId)
        if (row) {
          const prior = decode(row)
          if (prior.inputDigest !== draft.inputDigest)
            throw new InstallFault('conflict', 'request_input_conflict')
          return prior
        }
        database
          .prepare('INSERT INTO proposals VALUES (?, ?, ?, ?, ?, ?)')
          .run(
            draft.proposal.proposalId,
            owner,
            input.requestId,
            1,
            JSON.stringify(draft),
            installerDigest(draft),
          )
        return structuredClone(draft)
      })
    },
    compareAndSwap(id, revision, next) {
      return transaction(() => {
        const prior = read(id)
        if (prior.proposal.revision !== revision)
          throw new InstallFault('conflict', 'proposal_revision_conflict')
        const checked = validateInstallTransition(prior, next)
        database
          .prepare('UPDATE proposals SET revision = ?, payload = ?, digest = ? WHERE id = ?')
          .run(checked.proposal.revision, JSON.stringify(checked), installerDigest(checked), id)
        return checked
      })
    },
    close() {
      if (!closed) {
        closed = true
        cached = undefined
        database.close()
      }
    },
  }
}
