import type { JsonSchemaDoc } from './gen-core.js'

type Json = Record<string, unknown>
const object = (value: unknown): value is Json =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
const header = '// generated from schema/runtime by tools/gen-runtime.ts — do not edit\n'

/** All limits and error classifications come from the public authority document. */
export function generateRuntimeArtifactArtifacts(document: JsonSchemaDoc, graph: JsonSchemaDoc) {
  const policy = document['x-artifact-policy']
  const details = document['x-runtime-error-details']
  const defaults = document['x-runtime-error-http-defaults']
  const codes = new Set(
    ((graph.$defs?.RuntimeErrorCode as Json)?.anyOf as Json[] | undefined)?.map((branch) => branch.const),
  )
  if (!object(policy) || !object(details) || !object(defaults) || codes.size !== 10)
    throw new Error('missing artifact or runtime error policy')
  for (const key of ['maxTitleBytes', 'maxMediaTypeBytes', 'uploadReservationTtlMs', 'downloadTicketTtlMs'])
    if (!Number.isSafeInteger(policy[key]) || (policy[key] as number) <= 0)
      throw new Error(`invalid artifact policy ${key}`)
  const title = graph.$defs?.ArtifactTitle as Json | undefined
  const mediaType = graph.$defs?.ArtifactMediaType as Json | undefined
  if (
    title?.['x-max-utf8-bytes'] !== policy.maxTitleBytes ||
    mediaType?.['x-max-utf8-bytes'] !== policy.maxMediaTypeBytes ||
    typeof policy.descriptor !== 'string' ||
    !graph.$defs?.[policy.descriptor] ||
    policy.ticketSingleUse !== false ||
    policy.ticketRange !== 'open-ended'
  )
    throw new Error('artifact policy disagrees with schema')
  const catalog = document['x-service-catalog'] as Json | undefined
  const artifactMethods = ((catalog?.['agh.artifacts'] as Json)?.methods ?? {}) as Json
  for (const key of ['reserve', 'publish']) {
    const operation = policy[key]
    if (!object(operation) || operation.contract !== 'agh.artifacts' || operation.method !== key)
      throw new Error(`invalid artifact publication operation ${key}`)
    const declared = artifactMethods[key]
    if (
      !object(declared) ||
      declared.requiredFeature !== policy.publicationFeature ||
      declared.kind !== 'action'
    )
      throw new Error(`artifact publication feature mismatch ${key}`)
  }
  const redeem = artifactMethods.redeemDownload
  if (
    !object(redeem) ||
    redeem.local !== true ||
    redeem.localInterface !== 'ArtifactAccessPort' ||
    redeem.localMethod !== 'redeemDownload' ||
    redeem.kind !== 'query' ||
    redeem.requiredFeature !== policy.ticketFeature ||
    redeem.sameAttemptBrokerAllowed !== false ||
    ['input', 'output', 'inputTypeId', 'outputTypeId'].some((key) => Object.hasOwn(redeem, key))
  )
    throw new Error('artifact download must use the Local delivery port')
  const stateValues = (name: string): unknown[] => {
    const schema = graph.$defs?.[name] as Json
    const branches = schema.anyOf as Json[] | undefined
    if (branches)
      return branches.map((branch) => {
        const properties = branch.properties as Json
        return ((properties.state ?? properties.status) as Json)?.const
      })
    const properties = schema.properties as Json
    return ((properties.status as Json).anyOf as Json[]).map((branch) => branch.const)
  }
  if (
    JSON.stringify(policy.uploadStates) !== JSON.stringify(stateValues('UploadSession')) ||
    JSON.stringify(policy.publicationStates) !== JSON.stringify(stateValues('ArtifactReservation')) ||
    !Array.isArray(policy.uploadStates) ||
    !Array.isArray(policy.blobStates) ||
    JSON.stringify([...policy.uploadStates, ...policy.blobStates]) !==
      JSON.stringify(stateValues('BlobInspectResult'))
  )
    throw new Error('artifact policy state vocabulary mismatch')
  const retryKinds = new Set(
    ((graph.$defs?.RetryAdvice as Json)?.anyOf as Json[] | undefined)
      ?.map((branch) => (branch.properties as Json | undefined)?.kind as Json)
      .map((kind) => kind?.const),
  )
  const status = (value: unknown) =>
    Number.isSafeInteger(value) && (value as number) >= 400 && (value as number) <= 599
  if (Object.keys(defaults).length !== codes.size || Object.keys(defaults).some((code) => !codes.has(code)))
    throw new Error('runtime error HTTP defaults must cover every code')
  if (Object.values(defaults).some((value) => !status(value)))
    throw new Error('invalid runtime error HTTP default')
  for (const [detail, value] of Object.entries(details)) {
    if (
      !/^[a-z][a-z0-9_]*$/.test(detail) ||
      !object(value) ||
      Object.keys(value).sort().join(',') !== 'code,httpStatus,retryAdviceKinds' ||
      !codes.has(value.code) ||
      !status(value.httpStatus) ||
      !Array.isArray(value.retryAdviceKinds) ||
      !value.retryAdviceKinds.length ||
      new Set(value.retryAdviceKinds).size !== value.retryAdviceKinds.length ||
      value.retryAdviceKinds.some((kind) => !retryKinds.has(kind)) ||
      (value.code === 'unknown_effect' && value.retryAdviceKinds.join(',') !== 'reconcile')
    )
      throw new Error(`invalid runtime error detail ${detail}`)
  }
  const freeze = `function freeze<T>(value: T): T {\n  if (value !== null && typeof value === 'object') {\n    for (const child of Object.values(value)) freeze(child)\n    Object.freeze(value)\n  }\n  return value\n}\n`
  const tables = {
    RuntimeArtifactPolicy: policy,
    RuntimeErrorDetails: details,
    RuntimeErrorHttpDefaults: defaults,
  }
  return {
    'gen/ts/runtime-artifact-policy.ts':
      header +
      freeze +
      Object.entries(tables)
        .map(([name, value]) => `export const ${name} = freeze(${JSON.stringify(value, null, 2)} as const)\n`)
        .join(''),
    'src/runtime/artifacts.ts': `${header}import type { RuntimeError, ValidationResult } from './public.js'
import { validateRuntime } from './public.js'
import { RuntimeErrorDetails, RuntimeErrorHttpDefaults } from '../../gen/ts/runtime-artifact-policy.js'
export { RuntimeArtifactPolicy, RuntimeErrorDetails, RuntimeErrorHttpDefaults } from '../../gen/ts/runtime-artifact-policy.js'

/** Unknown detail extensions keep their code; reserved details cannot change classification. */
export function validateRuntimeErrorDetail(value: unknown): ValidationResult<RuntimeError> {
  const result = validateRuntime('RuntimeError', value)
  if (!result.ok) return result
  const error = result.value
  const rules: Readonly<Record<string, { readonly code: string; readonly retryAdviceKinds: readonly string[] }>> = RuntimeErrorDetails
  const rule = Object.hasOwn(rules, error.detailCode) ? rules[error.detailCode] : undefined
  if ((rule && (rule.code !== error.code || !rule.retryAdviceKinds.includes(error.retryAdvice.kind))) ||
    (error.code === 'unknown_effect' && error.retryAdvice.kind !== 'reconcile'))
    return { ok: false, errors: [{ path: '/detailCode', message: 'runtime error classification mismatch', code: 'ENUM' }] }
  return result
}

/** HTTP status is a presentation mapping, never proof of business admission or retry permission. */
export function runtimeErrorHttpStatus(value: RuntimeError): number {
  const checked = validateRuntimeErrorDetail(value)
  if (!checked.ok) throw new TypeError('invalid runtime error classification')
  const rules: Readonly<Record<string, { readonly httpStatus: number }>> = RuntimeErrorDetails
  return (Object.hasOwn(rules, checked.value.detailCode) ? rules[checked.value.detailCode]?.httpStatus : undefined) ?? RuntimeErrorHttpDefaults[checked.value.code]
}
`,
  }
}
