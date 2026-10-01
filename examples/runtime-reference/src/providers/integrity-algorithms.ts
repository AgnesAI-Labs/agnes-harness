import { createHash } from 'node:crypto'
import { jcs } from '@agnes/protocol'
import {
  boundedCanonicalJson,
  type IntegrityCanonicalizeResult,
  type IntegrityVerifyRequest,
  type IntegrityVerifyResult,
  type JsonValue,
  RuntimeAuthorCodecPolicy,
  type RuntimeError,
  validateRuntime,
} from '@agnes/protocol/runtime'

export class IntegrityRefusal extends Error {
  readonly error: RuntimeError
  constructor(code: RuntimeError['code'], detailCode: string) {
    super('Integrity computation refused')
    this.error = {
      code,
      detailCode,
      message: this.message,
      diagnosticId: 'reference-integrity',
      retryAdvice: detailCode === 'deadline_exceeded' ? { kind: 'retry_read' } : { kind: 'never' },
    }
  }
}

export function rejectIntegrity(code: RuntimeError['code'], detail: string): never {
  throw new IntegrityRefusal(code, detail)
}

const hash = (value: unknown): string => createHash('sha256').update(jcs(value), 'utf8').digest('hex')
const requireRelation = (value: boolean): void => {
  if (!value) rejectIntegrity('invalid_input', 'integrity_mismatch')
}

/** Snapshot before inspecting values: accessors and non-JSON objects never execute. */
function jsonInput(value: unknown): JsonValue {
  const safe = boundedCanonicalJson(value, {
    maxBytes: RuntimeAuthorCodecPolicy.payload.maxCanonicalJsonBytes,
    maxDepth: RuntimeAuthorCodecPolicy.payload.maxDepth,
    maxMembers: RuntimeAuthorCodecPolicy.payload.maxMembers,
  })
  if (!safe.ok)
    rejectIntegrity(
      safe.errors.some((item) => item.code === 'RANGE') ? 'quota' : 'invalid_input',
      'integrity_input_invalid',
    )
  return safe.value.json
}

export function referenceCanonicalize(input: unknown): IntegrityCanonicalizeResult {
  const checked = validateRuntime('IntegrityCanonicalizeRequest', jsonInput(input))
  if (!checked.ok) rejectIntegrity('invalid_input', 'integrity_input_invalid')
  const canonical = jcs(checked.value.value)
  return {
    canonical,
    digest: createHash('sha256').update(canonical, 'utf8').digest('hex'),
    bytes: Buffer.byteLength(canonical, 'utf8'),
  }
}

function ledger(request: Extract<IntegrityVerifyRequest, { kind: 'ledger-page' }>): IntegrityVerifyResult {
  let { lastSeq, legacyThroughSeq, headDigest } = request.initial
  requireRelation(legacyThroughSeq <= lastSeq && (headDigest !== null || legacyThroughSeq === lastSeq))
  for (const { sessionKey, event, integrity } of request.rows) {
    requireRelation(lastSeq < Number.MAX_SAFE_INTEGER && event.seq === lastSeq + 1)
    if (integrity === null) {
      requireRelation(headDigest === null)
      legacyThroughSeq = event.seq
    } else if (integrity.mode === 'anchor') {
      requireRelation(headDigest === null && integrity.previousDigest === null)
      requireRelation(
        integrity.digest === hash({ algorithm: request.algorithm, sessionKey, legacyThroughSeq, event }),
      )
      headDigest = integrity.digest
    } else {
      requireRelation(headDigest !== null && integrity.previousDigest === headDigest)
      requireRelation(
        integrity.digest ===
          hash({ algorithm: request.algorithm, sessionKey, previousDigest: integrity.previousDigest, event }),
      )
      headDigest = integrity.digest
    }
    lastSeq = event.seq
  }
  return { kind: 'ledger-page', checkpoint: { lastSeq, legacyThroughSeq, headDigest } }
}

const utf8Order = (left: string, right: string): number =>
  Buffer.compare(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8'))
function sideKey(
  entry: Extract<IntegrityVerifyRequest, { kind: 'commit-manifest' }>['sideEntries'][number],
): readonly string[] {
  switch (entry.kind) {
    case 'action-created':
      return [entry.kind, entry.actionId]
    case 'signal-consumed':
      return [entry.kind, entry.signalId]
    case 'outbox-created':
      return [entry.kind, entry.eventId]
    case 'receipt-created':
      return [entry.kind, entry.receiptId]
    case 'usage-origin':
      return [entry.kind, entry.sourceAuthorityId, entry.originKey]
  }
}
function compareTuple(left: readonly string[], right: readonly string[]): number {
  for (let index = 0; index < left.length; index++) {
    const order = utf8Order(left[index] as string, right[index] as string)
    if (order !== 0) return order
  }
  return 0
}
function manifest(
  request: Extract<IntegrityVerifyRequest, { kind: 'commit-manifest' }>,
): IntegrityVerifyResult {
  const { commit, mutations, sideEntries } = request
  let previousRecord: string | undefined
  const mutationValues = mutations.map(({ commitId, recordId, previousRevision, next }) => {
    requireRelation(commitId === commit.commitId)
    if (previousRecord !== undefined) requireRelation(utf8Order(previousRecord, recordId) < 0)
    previousRecord = recordId
    if (next === null) requireRelation(previousRevision !== null && previousRevision > 0)
    else if (previousRevision === null) requireRelation(next.recordRevision === 1)
    else
      requireRelation(
        previousRevision > 0 &&
          previousRevision < Number.MAX_SAFE_INTEGER &&
          next.recordRevision === previousRevision + 1,
      )
    return { recordId, previousRevision, next }
  })
  const counts = { createdActions: 0, consumedSignals: 0, outboxEvents: 0, receipts: 0, usageOrigins: 0 }
  let previousKey: readonly string[] | undefined
  const sideValues = sideEntries.map((entry) => {
    requireRelation(entry.commitId === commit.commitId)
    const key = sideKey(entry)
    if (previousKey !== undefined) requireRelation(compareTuple(previousKey, key) < 0)
    previousKey = key
    switch (entry.kind) {
      case 'action-created':
        counts.createdActions++
        break
      case 'signal-consumed':
        counts.consumedSignals++
        break
      case 'outbox-created':
        counts.outboxEvents++
        break
      case 'receipt-created':
        counts.receipts++
        break
      case 'usage-origin':
        counts.usageOrigins++
        break
    }
    const { commitId: _removed, ...value } = entry
    return value
  })
  requireRelation(commit.mutationCount === mutations.length && jcs(commit.counts) === jcs(counts))
  const mutationsDigest = hash(mutationValues)
  const sideListsDigest = hash(sideValues)
  requireRelation(mutationsDigest === commit.mutationsDigest && sideListsDigest === commit.sideListsDigest)
  return { kind: 'commit-manifest', commitId: commit.commitId, mutationsDigest, sideListsDigest }
}

/** Checks the supplied page/manifest only; never attests to its provenance or a complete history. */
export function referenceVerify(input: unknown): IntegrityVerifyResult {
  const value = jsonInput(input)
  if (value && !Array.isArray(value) && typeof value === 'object') {
    if (value.kind === 'ledger-page') {
      if (value.algorithm !== 'agnes-ledger-jcs-sha256-v1')
        rejectIntegrity('incompatible', 'integrity_format_unsupported')
      if (Array.isArray(value.rows) && value.rows.length > 500)
        rejectIntegrity('quota', 'integrity_page_limit')
    } else if (value.kind === 'commit-manifest') {
      for (const key of ['mutations', 'sideEntries'])
        if (Array.isArray(value[key]) && value[key].length > 10000)
          rejectIntegrity('quota', 'integrity_manifest_limit')
    }
  }
  const checked = validateRuntime('IntegrityVerifyRequest', value)
  if (!checked.ok) rejectIntegrity('invalid_input', 'integrity_input_invalid')
  return checked.value.kind === 'ledger-page' ? ledger(checked.value) : manifest(checked.value)
}
