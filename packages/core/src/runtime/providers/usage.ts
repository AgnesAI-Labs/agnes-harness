import type {
  AuthorSchema,
  CallContext,
  EmptyAuthorConfig,
  Outcome,
  ProviderFactory,
  ServiceProvider,
} from '@agnes/extension-api/runtime'
import {
  type ProviderDescriptor,
  type UsageQueryRequest,
  type UsageQueryResult,
  validateRuntime,
} from '@agnes/protocol/runtime'
import { createUsageOrigins, type UsageOriginStore } from '../usage/origins.js'
import { type AccountingProviderAuthority, createAccountingFactory } from './accounting.js'

export interface DefaultUsageAuthority extends AccountingProviderAuthority {
  readonly store: UsageOriginStore
  query(
    input: UsageQueryRequest,
    context: CallContext,
    snapshot?: string,
  ): Promise<Outcome<{ value: UsageQueryResult; snapshot: string }>>
}
const methods = {
  record: { kind: 'control', input: 'UsageRecordRequest', output: 'UsageRecordResult' },
  query: { kind: 'query', input: 'UsageQueryRequest', output: 'UsageQueryResult' },
} as const
export function createDefaultUsageFactory(
  descriptor: ProviderDescriptor,
  authority: DefaultUsageAuthority,
  configCodec: AuthorSchema<EmptyAuthorConfig>,
): ProviderFactory<ServiceProvider> {
  const rules = createUsageOrigins(authority.store)
  return createAccountingFactory(
    'agh.usage',
    descriptor,
    configCodec,
    authority,
    methods,
    async (method, input, context, snapshot) => {
      if (method === 'record') {
        const value = validateRuntime('UsageRecordRequest', input)
        if (!value.ok) throw new TypeError('Invalid usage record')
        return { value: await rules.record(value.value, context) }
      }
      if (method === 'query') {
        const value = validateRuntime('UsageQueryRequest', input)
        if (!value.ok) throw new TypeError('Invalid usage query')
        const result = await authority.query(value.value, context, snapshot)
        if (!result.ok) throw result.error
        return result.value
      }
      throw new TypeError('Unknown Usage method')
    },
  )
}
