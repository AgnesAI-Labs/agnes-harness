import type {
  AuthorSchema,
  CallContext,
  EmptyAuthorConfig,
  Outcome,
  ProviderFactory,
  ServiceProvider,
} from '@agnes/extension-api/runtime'
import {
  type BudgetReconcileRequest,
  type BudgetReleaseQuotaRequest,
  type BudgetReserveQuotaRequest,
  type BudgetReserveRequest,
  type BudgetSettleRequest,
  type ProviderDescriptor,
  type SessionBudgetClientReadRequest,
  type SessionBudgetResult,
  validateRuntime,
} from '@agnes/protocol/runtime'
import type { DefaultBudgetConfig } from '../budget/config.js'
import { type BudgetStore, createBudgetReservations } from '../budget/reservations.js'
import { type AccountingProviderAuthority, createAccountingFactory } from './accounting.js'

/** Installed Host owner, including complete authorized session budget observation. */
export interface DefaultBudgetAuthority extends AccountingProviderAuthority {
  readonly store: BudgetStore
  readSessionBudget(
    input: SessionBudgetClientReadRequest,
    context: CallContext,
    snapshot?: string,
  ): Promise<Outcome<{ value: SessionBudgetResult; snapshot: string }>>
}
const methods = {
  reserve: { kind: 'control', input: 'BudgetReserveRequest', output: 'BudgetReserveResult' },
  settle: { kind: 'control', input: 'BudgetSettleRequest', output: 'BudgetSettleResult' },
  reconcile: { kind: 'control', input: 'BudgetReconcileRequest', output: 'BudgetReconcileResult' },
  reserveQuota: { kind: 'control', input: 'BudgetReserveQuotaRequest', output: 'QuotaReservation' },
  releaseQuota: { kind: 'control', input: 'BudgetReleaseQuotaRequest', output: 'QuotaReservation' },
  readSessionBudget: {
    kind: 'query',
    input: 'SessionBudgetClientReadRequest',
    output: 'SessionBudgetResult',
  },
} as const
export function createDefaultBudgetFactory<C extends DefaultBudgetConfig | EmptyAuthorConfig>(
  descriptor: ProviderDescriptor,
  authority: DefaultBudgetAuthority,
  configCodec: AuthorSchema<C>,
): ProviderFactory<ServiceProvider> {
  const rules = createBudgetReservations(authority.store)
  return createAccountingFactory(
    'agh.budget',
    descriptor,
    configCodec,
    authority,
    methods,
    async (method, input, context, snapshot) => {
      switch (method) {
        case 'reserve': {
          const value = validateRuntime('BudgetReserveRequest', input)
          if (!value.ok) throw new TypeError('Invalid reserve input')
          return { value: await rules.reserve(value.value as BudgetReserveRequest, context) }
        }
        case 'settle': {
          const value = validateRuntime('BudgetSettleRequest', input)
          if (!value.ok) throw new TypeError('Invalid settle input')
          return { value: await rules.settle(value.value as BudgetSettleRequest, context) }
        }
        case 'reconcile': {
          const value = validateRuntime('BudgetReconcileRequest', input)
          if (!value.ok) throw new TypeError('Invalid reconcile input')
          return { value: await rules.reconcile(value.value as BudgetReconcileRequest, context) }
        }
        case 'reserveQuota': {
          const value = validateRuntime('BudgetReserveQuotaRequest', input)
          if (!value.ok) throw new TypeError('Invalid quota input')
          return { value: await rules.reserveQuota(value.value as BudgetReserveQuotaRequest, context) }
        }
        case 'releaseQuota': {
          const value = validateRuntime('BudgetReleaseQuotaRequest', input)
          if (!value.ok) throw new TypeError('Invalid quota release')
          return { value: await rules.releaseQuota(value.value as BudgetReleaseQuotaRequest, context) }
        }
        case 'readSessionBudget': {
          const value = validateRuntime('SessionBudgetClientReadRequest', input)
          if (!value.ok) throw new TypeError('Invalid session budget query')
          const result = await authority.readSessionBudget(value.value, context, snapshot)
          if (!result.ok) throw result.error
          return result.value
        }
        default:
          throw new TypeError('Unknown Budget method')
      }
    },
  )
}
