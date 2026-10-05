import type { LedgerRow, LedgerSeam } from '@agnes/core'
import type { CallContext, Outcome, ServiceProvider } from '@agnes/extension-api/runtime'
import type * as W from '@agnes/protocol/runtime'

/** Private deployment capabilities. None may come from a plugin, client DTO or inferred identity. */
export type UsageLedgerOwners = Readonly<{
  installer?: {
    connect(
      attempt: W.AttemptRef,
      signal: AbortSignal,
    ): Promise<
      Outcome<{
        binding: W.BindingRef
        authorityId: string
        provider: Pick<ServiceProvider, 'control' | 'query'>
        context: CallContext
        resolve(ref: W.DataRef): Promise<Outcome<unknown>>
        close(): void
      }>
    >
  }
  state?: {
    /** Read a committed attempt/receipt; C33 store.verify must independently verify that same State. */
    verify(
      attempt: W.AttemptRef,
      context: CallContext,
    ): Promise<
      Outcome<{
        request: W.UsageRecordRequest
        reservationRef: W.DomainObjectRef | null
      }>
    >
  }
  session?: {
    /** Persist the original mapping and exclude this run from Kernel inference settlement before returning. */
    claim(
      request: W.UsageRecordRequest,
      context: CallContext,
    ): Promise<
      Outcome<{
        mode: 'runtime-exclusive'
        row: LedgerRow
        /** Recheck the live exclusive claim at commit and call the original effectId-idempotent seam. */
        ledger: Pick<LedgerSeam, 'record'>
      }>
    >
  }
  budget?: {
    /** Only an existing bounded-units reservation is settled, never a manufactured Money reservation. */
    settle(input: W.BudgetSettleRequest, context: CallContext): Promise<Outcome<W.BudgetSettleResult>>
  }
}>
