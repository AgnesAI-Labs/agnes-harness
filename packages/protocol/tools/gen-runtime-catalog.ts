import type { JsonSchemaDoc } from './gen-core.js'

type Json = Record<string, unknown>
const object = (value: unknown): value is Json =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
const identifier = (value: unknown): value is string =>
  typeof value === 'string' && /^[A-Za-z_$][\w$]*$/.test(value)
const exactKeys = (value: Json, keys: string[]): boolean =>
  Object.keys(value).sort().join(',') === [...keys].sort().join(',')

/** Missing broker metadata never grants an operation. */
export function normalizeBrokerCatalog(value: unknown): Json {
  if (!object(value)) throw new Error('missing runtime service catalog')
  return Object.fromEntries(
    Object.entries(value).map(([contract, raw]) => {
      if (!object(raw) || !object(raw.methods)) throw new Error(`invalid runtime service catalog ${contract}`)
      return [
        contract,
        {
          ...raw,
          methods: Object.fromEntries(
            Object.entries(raw.methods).map(([method, operation]) => {
              if (!object(operation)) throw new Error(`invalid runtime service method ${contract}.${method}`)
              const allowed = operation.sameAttemptBrokerAllowed ?? false
              if (
                (Object.hasOwn(operation, 'clientOnly') && typeof operation.clientOnly !== 'boolean') ||
                (operation.clientOnly === true && operation.local !== true)
              )
                throw new Error(`invalid client-only method ${contract}.${method}`)
              if (
                (Object.hasOwn(operation, 'sameAttemptBrokerAllowed') &&
                  typeof operation.sameAttemptBrokerAllowed !== 'boolean') ||
                (allowed &&
                  (operation.local === true ||
                    operation.kind !== 'action' ||
                    typeof operation.input !== 'string' ||
                    !operation.input ||
                    typeof operation.output !== 'string' ||
                    !operation.output))
              )
                throw new Error(`invalid broker eligibility ${contract}.${method}`)
              return [method, { ...operation, sameAttemptBrokerAllowed: allowed }]
            }),
          ),
        },
      ]
    }),
  )
}

/** Expand optional maintenance operations from their sole template authority. */
export function normalizeRuntimeCatalog(metadata: JsonSchemaDoc, wireNames?: ReadonlySet<string>): Json {
  const catalog = normalizeBrokerCatalog(metadata['x-service-catalog'])
  const outbox = metadata['x-events-outbox-api']
  if (outbox !== undefined) {
    if (
      !object(outbox) ||
      !exactKeys(outbox, ['feature', 'contracts', 'localInterface', 'methods']) ||
      outbox.feature !== 'outbox-administration.v1' ||
      outbox.localInterface !== 'EventsOutboxControl' ||
      !Array.isArray(outbox.contracts) ||
      outbox.contracts.length !== 1 ||
      outbox.contracts[0] !== 'agh.state' ||
      !object(outbox.methods) ||
      !exactKeys(outbox.methods, ['deadLetters', 'redriveOutbox'])
    )
      throw new Error('invalid events outbox owner template')
    const signatures = {
      deadLetters: ['query', 'OutboxDeadLettersRequest', 'PageOutboxDeadLetterItem'],
      redriveOutbox: ['control', 'OutboxRedriveRequest', 'OutboxRedriveResult'],
    } as const
    const owner = catalog['agh.state']
    if (!object(owner) || !object(owner.methods)) throw new Error('missing outbox owner catalog')
    for (const [method, expected] of Object.entries(signatures)) {
      const raw = outbox.methods[method]
      if (
        !object(raw) ||
        !exactKeys(raw, ['kind', 'input', 'output']) ||
        raw.kind !== expected[0] ||
        raw.input !== expected[1] ||
        raw.output !== expected[2] ||
        (wireNames && (!wireNames.has(expected[1]) || !wireNames.has(expected[2]))) ||
        Object.hasOwn(owner.methods, method)
      )
        throw new Error(`invalid events outbox method ${method}`)
      owner.methods[method] = {
        ...raw,
        inputTypeId: `agh.state/${method}.request@1`,
        outputTypeId: `agh.state/${method}.response@1`,
        requiredFeature: outbox.feature,
        sameAttemptBrokerAllowed: false,
      }
    }
  }
  const transfer = metadata['x-authority-transfer-api']
  if (transfer === undefined) return catalog
  if (
    !object(transfer) ||
    !exactKeys(transfer, ['feature', 'contracts', 'methods']) ||
    transfer.feature !== 'authority-transfer.v1' ||
    !object(transfer.methods) ||
    !Array.isArray(transfer.contracts)
  )
    throw new Error('invalid authority transfer template')
  const contracts = transfer.contracts as unknown[]
  const backend = Object.keys(catalog).filter(
    (name) => !['agh.ui-registry', 'agh.renderer', 'agh.shell'].includes(name),
  )
  if (
    contracts.some((name) => typeof name !== 'string') ||
    new Set(contracts).size !== contracts.length ||
    [...contracts].sort().join(',') !== backend.sort().join(',')
  )
    throw new Error('invalid authority transfer backend eligibility')
  const localNames = ['fence', 'export', 'exportPage', 'import', 'verify', 'activate', 'abort', 'probe']
  if (!exactKeys(transfer.methods, localNames)) throw new Error('invalid authority transfer method set')
  for (const [local, raw] of Object.entries(transfer.methods)) {
    const suffix = local[0]?.toUpperCase() + local.slice(1)
    if (
      !object(raw) ||
      !exactKeys(raw, ['backendMethod', 'input', 'output']) ||
      raw.backendMethod !== `authority${suffix}` ||
      !identifier(raw.input) ||
      !identifier(raw.output) ||
      raw.input !== `AuthorityTransferControl${suffix}Request` ||
      (wireNames && (!wireNames.has(raw.input) || !wireNames.has(raw.output)))
    )
      throw new Error(`invalid authority transfer method ${local}`)
    for (const contract of contracts as string[]) {
      const methods = (catalog[contract] as Json).methods as Json
      if (Object.hasOwn(methods, raw.backendMethod))
        throw new Error(`authority transfer method collision ${contract}.${raw.backendMethod}`)
      methods[raw.backendMethod] = {
        kind: 'maintenance',
        input: raw.input,
        output: raw.output,
        inputTypeId: `${contract}/${raw.backendMethod}.request@1`,
        outputTypeId: `${contract}/${raw.backendMethod}.response@1`,
        requiredFeature: transfer.feature,
        sameAttemptBrokerAllowed: false,
      }
    }
  }
  return catalog
}
