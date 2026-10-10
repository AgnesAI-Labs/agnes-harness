import { createHash } from 'node:crypto'
import { realpathSync } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import { isAbsolute, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { EventEnvelope, ModelPricePolicy, RuntimeIdentity } from '@agnes/protocol'
import type { AttemptEvidence } from '@agnes/runtime-comparison'

export interface PricingRequest {
  schemaVersion: 1
  trajectoryPath: string
  sourceIdentity: {
    sourceRevision?: string
    sourceTreeSha256?: string
    workspaceReceiptHash?: string
    distributionSha256?: string
  }
  historicalInput?: { sourceTreeSha256?: string; distributionSha256: string }
  jevIdentities?: Array<{ originalEndpoint: string; proxyEndpoint: string; requestedModel: string }>
  llmPolicies?: Array<{ route: string; model: string; policy: ModelPricePolicy; policySource: string }>
}
export interface PricingTrajectory {
  schemaVersion: 1
  format: 'agh-ledger'
  sessionId: string
  runtime: RuntimeIdentity
  throughSeq: number
  complete: boolean
  events: EventEnvelope[]
}
type PricingAlgorithms = Pick<
  typeof import('@agnes/host'),
  'accountComparisonLane' | 'projectComparisonAttemptEvidence'
> &
  Pick<typeof import('@agnes/runtime-comparison'), 'accountLane' | 'pricingFromModelQuote'> &
  Pick<typeof import('@agnes/protocol'), 'validModelPricePolicy' | 'validateEvent'>

export class PricingError extends Error {
  constructor(readonly code: string) {
    super(code)
  }
}
const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
const text = (value: unknown): value is string =>
  typeof value === 'string' && value.length > 0 && value.length <= 2048 && !/[\p{Cc}]/u.test(value)
const digest = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)
const exact = (value: Record<string, unknown>, keys: string[]): boolean =>
  Object.keys(value).every((key) => keys.includes(key))
function endpoint(value: unknown): value is string {
  if (!text(value) || value !== value.trim()) return false
  try {
    const url = new URL(value)
    return (
      ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password && !url.search && !url.hash
    )
  } catch {
    return false
  }
}

export function parsePricingRequest(value: unknown): PricingRequest {
  if (
    !object(value) ||
    !exact(value, [
      'schemaVersion',
      'trajectoryPath',
      'sourceIdentity',
      'historicalInput',
      'jevIdentities',
      'llmPolicies',
    ]) ||
    value.schemaVersion !== 1 ||
    !text(value.trajectoryPath) ||
    !isAbsolute(value.trajectoryPath) ||
    !object(value.sourceIdentity)
  )
    throw new PricingError('REQUEST_INVALID')
  const source = value.sourceIdentity
  if (
    !exact(source, ['sourceRevision', 'sourceTreeSha256', 'workspaceReceiptHash', 'distributionSha256']) ||
    (source.distributionSha256 !== undefined && !digest(source.distributionSha256)) ||
    !digest(source.workspaceReceiptHash) ||
    (source.sourceRevision !== undefined && !text(source.sourceRevision)) ||
    (source.sourceTreeSha256 !== undefined && !digest(source.sourceTreeSha256)) ||
    (source.workspaceReceiptHash !== undefined && !digest(source.workspaceReceiptHash))
  )
    throw new PricingError('SOURCE_IDENTITY_INVALID')
  if (
    value.historicalInput !== undefined &&
    (!object(value.historicalInput) ||
      !exact(value.historicalInput, ['sourceTreeSha256', 'distributionSha256']) ||
      !digest(value.historicalInput.distributionSha256) ||
      (value.historicalInput.sourceTreeSha256 !== undefined &&
        !digest(value.historicalInput.sourceTreeSha256)))
  )
    throw new PricingError('SOURCE_IDENTITY_INVALID')
  const mappings = new Set<string>()
  if (value.jevIdentities !== undefined) {
    if (!Array.isArray(value.jevIdentities)) throw new PricingError('REQUEST_INVALID')
    for (const mapping of value.jevIdentities) {
      if (
        !object(mapping) ||
        !exact(mapping, ['originalEndpoint', 'proxyEndpoint', 'requestedModel']) ||
        !endpoint(mapping.originalEndpoint) ||
        !endpoint(mapping.proxyEndpoint) ||
        !text(mapping.requestedModel)
      )
        throw new PricingError('JEV_IDENTITY_INVALID')
      const key = JSON.stringify([mapping.proxyEndpoint, mapping.requestedModel])
      if (mappings.has(key)) throw new PricingError('JEV_IDENTITY_AMBIGUOUS')
      mappings.add(key)
    }
  }
  const policies = new Set<string>()
  if (value.llmPolicies !== undefined) {
    if (!Array.isArray(value.llmPolicies)) throw new PricingError('REQUEST_INVALID')
    for (const binding of value.llmPolicies) {
      if (
        !object(binding) ||
        !exact(binding, ['route', 'model', 'policy', 'policySource']) ||
        !text(binding.route) ||
        !text(binding.model) ||
        !text(binding.policySource) ||
        !object(binding.policy)
      )
        throw new PricingError('POLICY_BINDING_INVALID')
      const key = JSON.stringify([binding.route, binding.model])
      if (policies.has(key)) throw new PricingError('POLICY_BINDING_AMBIGUOUS')
      policies.add(key)
    }
  }
  return value as unknown as PricingRequest
}

async function algorithms(): Promise<PricingAlgorithms> {
  const [host, comparison, protocol] = await Promise.all([
    import('@agnes/host'),
    import('@agnes/runtime-comparison'),
    import('@agnes/protocol'),
  ])
  return {
    accountComparisonLane: host.accountComparisonLane,
    projectComparisonAttemptEvidence: host.projectComparisonAttemptEvidence,
    accountLane: comparison.accountLane,
    pricingFromModelQuote: comparison.pricingFromModelQuote,
    validModelPricePolicy: protocol.validModelPricePolicy,
    validateEvent: protocol.validateEvent,
  }
}

function trajectory(value: unknown, api: PricingAlgorithms): PricingTrajectory {
  if (
    !object(value) ||
    value.schemaVersion !== 1 ||
    value.format !== 'agh-ledger' ||
    !text(value.sessionId) ||
    !object(value.runtime) ||
    !['native', 'jevloop'].includes(String(value.runtime.id)) ||
    value.runtime.version !== '1' ||
    !Number.isSafeInteger(value.throughSeq) ||
    Number(value.throughSeq) < 1 ||
    value.complete !== true ||
    !Array.isArray(value.events) ||
    value.events.length !== value.throughSeq
  )
    throw new PricingError('TRAJECTORY_INCOMPLETE')
  for (const [index, row] of value.events.entries())
    if (!object(row) || row.seq !== index + 1 || !api.validateEvent(row).ok)
      throw new PricingError('TRAJECTORY_INVALID_PREFIX')
  return value as unknown as PricingTrajectory
}

/** All currency formulas remain in the existing Host/runtime-comparison implementation. */
export async function reestimate(
  requestInput: unknown,
  trajectoryInput: unknown,
  injected?: PricingAlgorithms,
) {
  const api = injected ?? (await algorithms())
  const request = parsePricingRequest(requestInput)
  const source = trajectory(trajectoryInput, api)
  for (const binding of request.llmPolicies ?? [])
    if (!api.validModelPricePolicy(binding.policy)) throw new PricingError('POLICY_INVALID')
  const input = {
    sessionId: source.sessionId,
    runtime: source.runtime,
    events: source.events,
    afterSeq: 0,
    throughSeq: source.throughSeq,
    complete: true,
  }
  const originalAccounting = api.accountComparisonLane(input)
  const originalProjection = api.projectComparisonAttemptEvidence(input)
  if (!originalProjection.complete) throw new PricingError('SOURCE_ACCOUNTING_UNVERIFIED')
  const events = structuredClone(source.events)
  const restoredIdentity: Array<{
    family: 'jev'
    requestedSeq: number
    originalEndpoint: string
    proxyEndpoint: string
    requestedModel: string
    basis: 'caller-supplied-relay-binding'
  }> = []
  const usedMappings = new Set<string>()
  for (const row of events) {
    if (row.type !== 'runtime/record' || !object(row.data) || !object(row.data.record)) continue
    const record = row.data.record
    const call = object(record.call) ? record.call : undefined
    if (record.kind !== 'model.requested' || call?.purpose !== 'decision' || !request.jevIdentities?.length)
      continue
    const match = request.jevIdentities.filter(
      (mapping) =>
        call.backend === 'jev' &&
        call.endpoint === mapping.proxyEndpoint &&
        call.requestedModel === mapping.requestedModel,
    )
    if (match.length !== 1) throw new PricingError('JEV_IDENTITY_MISMATCH')
    const mapping = match[0]
    if (!mapping) throw new PricingError('JEV_IDENTITY_MISMATCH')
    call.endpoint = mapping.originalEndpoint
    usedMappings.add(JSON.stringify([mapping.proxyEndpoint, mapping.requestedModel]))
    restoredIdentity.push({
      family: 'jev',
      requestedSeq: row.seq,
      ...mapping,
      basis: 'caller-supplied-relay-binding',
    })
  }
  if (
    (request.jevIdentities ?? []).some(
      (mapping) => !usedMappings.has(JSON.stringify([mapping.proxyEndpoint, mapping.requestedModel])),
    )
  )
    throw new PricingError('JEV_IDENTITY_UNUSED')
  const projection = api.projectComparisonAttemptEvidence({ ...input, events })
  if (!projection.complete) throw new PricingError('DERIVED_ACCOUNTING_UNVERIFIED')
  const policyMatches = new Set<string>()
  const estimated: AttemptEvidence[] = projection.events.map((attempt) => {
    if (attempt.family !== 'llm') return attempt
    const binding = request.llmPolicies?.find(
      (policy) => policy.route === attempt.route && policy.model === attempt.model,
    )
    if (!binding) return attempt
    policyMatches.add(JSON.stringify([binding.route, binding.model]))
    const admitted = source.events[attempt.originSeq - 1]
    const settled = source.events[attempt.seq - 1]
    if (!admitted || !settled) throw new PricingError('ATTEMPT_IDENTITY_INVALID')
    const quote = {
      version: 1 as const,
      basis: 'configured' as const,
      route: binding.route,
      model: binding.model,
      admittedAt: Date.parse(admitted.ts),
      policy: structuredClone(binding.policy),
    }
    return {
      ...attempt,
      priceBasis: 'current' as const,
      ...(attempt.stage === 'settled'
        ? {
            pricing: api.pricingFromModelQuote(
              quote,
              { route: attempt.route, model: attempt.model, observedModel: attempt.observedModel },
              Date.parse(settled.ts),
            ),
          }
        : {}),
    }
  })
  if (
    (request.llmPolicies ?? []).some(
      (policy) => !policyMatches.has(JSON.stringify([policy.route, policy.model])),
    )
  )
    throw new PricingError('POLICY_IDENTITY_UNUSED')
  const derivedAccounting = api.accountLane(
    estimated,
    { afterSeq: 0, throughSeq: source.throughSeq },
    projection.complete,
  )
  const coverage = (family: 'jev' | 'llm') => {
    const starts = estimated.filter((attempt) => attempt.family === family && attempt.stage === 'started')
    const settlements = estimated.filter(
      (attempt) => attempt.family === family && attempt.stage === 'settled',
    )
    return {
      attempts: starts.length,
      settledAttempts: settlements.length,
      pendingAttempts: starts.length - settlements.length,
      missingUsageAttempts: settlements.filter((attempt) => attempt.usage == null).length,
      missingPricingAttempts: settlements.filter((attempt) => attempt.pricing == null).length,
      zeroOutputRateWithoutOutputUsageAttempts: settlements.filter(
        (attempt) => attempt.pricing?.perMillion.output === 0 && attempt.usage?.output == null,
      ).length,
      gatewayBillingAttempts: settlements.filter((attempt) => attempt.billing?.source === 'gateway').length,
      estimateBillingAttempts: settlements.filter((attempt) => attempt.billing?.source === 'estimated')
        .length,
    }
  }
  return {
    schemaVersion: 1,
    basis: 'current-reestimate',
    sessionId: source.sessionId,
    runtime: source.runtime,
    originalAccounting,
    originalAccountingBasis: 'current-helper-over-unmodified-ledger',
    derivedAccounting,
    restoredIdentity,
    jevPolicies: projection.events
      .filter((attempt) => attempt.family === 'jev' && attempt.stage === 'started')
      .map((attempt) => ({
        requestedSeq: attempt.originSeq,
        priceBasis: attempt.priceBasis ?? 'unknown',
        quote: attempt.priceQuote ?? null,
        policySource:
          'Host resolveJevPriceEstimate in the current helper code; estimate is not reported billing',
      })),
    policies: request.llmPolicies ?? [],
    coverage: { jev: coverage('jev'), llm: coverage('llm') },
    units: { costs: 'currency-units-by-currency', reportedBilling: 'USD-micros' },
    billingPreference:
      'gateway-reported billing takes precedence; estimates are independent and never added to reported billing',
    provenance: {
      basis: 'current',
      sourceIdentity: request.sourceIdentity,
      throughSeq: source.throughSeq,
      changes:
        'relay identity restoration in a cloned ledger; explicit LLM policies only in derived attempt projection',
      preservesOriginalQuotesAndBilling: true,
      helperSha256: null as string | null,
      currentModelPricingCodeSha256: null as string | null,
      historicalInput: request.historicalInput ?? null,
      sourceIdentityScope:
        'caller-supplied current helper receipt; historical runtime artifact identity is separate',
    },
  }
}

export async function pricingMain(argv: string[] = process.argv.slice(2)): Promise<number> {
  if (
    argv.length !== 4 ||
    argv[0] !== '--request' ||
    argv[2] !== '--output' ||
    !isAbsolute(argv[3] as string)
  )
    throw new PricingError('ARGUMENTS_INVALID')
  const request = parsePricingRequest(JSON.parse(await readFile(argv[1] as string, 'utf8')))
  if (
    resolve(request.trajectoryPath) === resolve(argv[3] as string) ||
    resolve(argv[1] as string) === resolve(argv[3] as string)
  )
    throw new PricingError('OUTPUT_OVERLAPS_SOURCE')
  const result = await reestimate(request, JSON.parse(await readFile(request.trajectoryPath, 'utf8')))
  result.provenance.helperSha256 = createHash('sha256')
    .update(await readFile(fileURLToPath(import.meta.url)))
    .digest('hex')
  result.provenance.currentModelPricingCodeSha256 = result.provenance.helperSha256
  await writeFile(argv[3] as string, `${JSON.stringify(result, null, 2)}\n`, { mode: 0o600 })
  return 0
}

if (
  process.argv[1] &&
  realpathSync(fileURLToPath(import.meta.url)) === realpathSync(resolve(process.argv[1]))
) {
  pricingMain()
    .then((code) => {
      process.exitCode = code
    })
    .catch((error: unknown) => {
      process.stderr.write(`${error instanceof PricingError ? error.code : 'PRICING_FAILED'}\n`)
      process.exitCode = 2
    })
}
