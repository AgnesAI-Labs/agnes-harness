import { createHash } from 'node:crypto'

export const FORMAT = 'agnes.skill-quality.eval/v1'
export const EVENT = 'quality.recorded'
export const keyOf = (sessionId) => {
  if (typeof sessionId !== 'string' || !sessionId || sessionId.length > 160 || sessionId.includes('\0'))
    throw new Error('QUALITY_SESSION_INVALID')
  return `quality:${sessionId}`
}
export const digest = (value) => `sha256-${createHash('sha256').update(value).digest('hex')}`
const hash = (value) => typeof value === 'string' && /^sha256-[a-f0-9]{64}$/.test(value)
const text = (value, max = 512) => typeof value === 'string' && value.length > 0 && value.length <= max
const object = (value) => value && typeof value === 'object' && !Array.isArray(value)
const exact = (value, keys) => object(value) && Object.keys(value).every((key) => keys.includes(key))
const invalid = () => {
  throw new Error('QUALITY_EVIDENCE_INVALID')
}

/** A manual bridge envelope can reference any P01 artifact; it never attests who ran it. */
export function parseEvidence(json) {
  if (typeof json !== 'string' || Buffer.byteLength(json) > 48 * 1024) return invalid()
  const value = JSON.parse(json)
  if (
    !exact(value, [
      'format',
      'candidateHash',
      'baseHash',
      'skillRevision',
      'artifact',
      'environment',
      'cases',
      'kind',
    ]) ||
    value.format !== FORMAT ||
    !hash(value.candidateHash) ||
    !(value.baseHash === null || hash(value.baseHash)) ||
    !text(value.skillRevision, 128) ||
    !['eval-import', 'self-assessment'].includes(value.kind) ||
    !exact(value.artifact, ['sha256', 'label']) ||
    !hash(value.artifact.sha256) ||
    !text(value.artifact.label) ||
    !object(value.environment) ||
    Object.keys(value.environment).length !== 14 ||
    !['dataset', 'prompt', 'tools', 'fixtures', 'model', 'loop', 'skills', 'pins'].every((key) =>
      hash(value.environment[key]),
    ) ||
    !(value.environment.seed === null || Number.isSafeInteger(value.environment.seed)) ||
    !['runtime', 'modelLabel', 'runner', 'budget'].every((key) => text(value.environment[key], 256)) ||
    !['scripted', 'strict-replay', 'sequence-replay', 'live'].includes(value.environment.mode) ||
    !Array.isArray(value.cases) ||
    value.cases.length < 1 ||
    value.cases.length > 24
  )
    return invalid()
  const ids = new Set()
  for (const row of value.cases) {
    if (
      !exact(row, ['id', 'status', 'executed', 'expected', 'actual']) ||
      !text(row.id, 80) ||
      ids.has(row.id) ||
      !['passed', 'failed', 'skipped'].includes(row.status) ||
      !Number.isSafeInteger(row.executed) ||
      row.executed < 0 ||
      row.executed > 10000 ||
      (row.status !== 'skipped' && row.executed < 1) ||
      !text(row.expected, 1024) ||
      !text(row.actual, 1024)
    )
      return invalid()
    ids.add(row.id)
  }
  if (!value.cases.some((row) => row.executed > 0 && row.status !== 'skipped')) return invalid()
  return structuredClone(value)
}

/** Receipts come only from pluginManage, never from an imported report. */
export function candidateReceipt(value) {
  if (
    !object(value) ||
    !/^candidate-[a-f0-9]{32}$/.test(value.candidateId) ||
    !hash(value.candidateHash) ||
    !(value.baseHash === null || hash(value.baseHash)) ||
    !text(value.packageId, 256) ||
    !text(value.origin?.sessionKey, 160) ||
    !['draft', 'tested', 'review', 'publishing', 'published', 'rejected', 'failed', 'interrupted'].includes(
      value.state,
    )
  )
    throw new Error('QUALITY_CANDIDATE_INVALID')
  const tests =
    value.tests &&
    hash(value.tests.hash) &&
    ['passed', 'failed'].includes(value.tests.state) &&
    Number.isSafeInteger(value.tests.count) &&
    value.tests.count >= 0
      ? {
          hash: value.tests.hash,
          state: value.tests.state,
          count: value.tests.count,
          runner: String(value.tests.runner).slice(0, 128),
        }
      : null
  return {
    candidateId: value.candidateId,
    candidateHash: value.candidateHash,
    baseHash: value.baseHash,
    packageId: value.packageId,
    sourceSession: value.origin.sessionKey,
    state: value.state,
    hostTests: tests,
    humanReviewer: value.state === 'published' ? value.reviewer : null,
  }
}

export function qualityView(record) {
  const { evidence, candidate, installedObservation } = record
  const reasons = []
  if (evidence && evidence.candidateHash !== candidate.candidateHash) reasons.push('candidate-changed')
  if (evidence && evidence.baseHash !== candidate.baseHash) reasons.push('base-changed')
  if (evidence && installedObservation !== undefined && evidence.baseHash !== installedObservation)
    reasons.push('installed-base-changed')
  const freshness = reasons.length
    ? 'stale'
    : !evidence || installedObservation === undefined
      ? 'unknown'
      : 'observed'
  return {
    ...record,
    freshness,
    reasons,
    authority: evidence?.kind ?? 'none',
    verified: false,
    counts: evidence
      ? {
          passed: evidence.cases.filter((row) => row.status === 'passed').length,
          failed: evidence.cases.filter((row) => row.status === 'failed').length,
          skipped: evidence.cases.filter((row) => row.status === 'skipped').length,
          executed: evidence.cases.reduce((sum, row) => sum + row.executed, 0),
        }
      : null,
  }
}
export const emptyState = () => ({ records: [] })
export function upsert(state, record) {
  return {
    records: [
      ...state.records.filter((row) => row.candidate.candidateId !== record.candidate.candidateId),
      record,
    ].slice(-8),
  }
}
export const projection = (owner) => ({
  name: 'quality',
  stateVersion: 1,
  inputEventTypes: [`x/${owner}/quality.recorded`],
  maxStateBytes: 262144,
  stateSchema: { type: 'object' },
  init: emptyState,
  apply(state, event) {
    return event.origin === `ext:${owner}` && event.type === `x/${owner}/quality.recorded`
      ? upsert(state, event.data)
      : state
  },
  view: (state) => ({ records: state.records.map(qualityView) }),
})
