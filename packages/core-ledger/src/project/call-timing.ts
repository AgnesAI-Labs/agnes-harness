import type { CostLedger, Timing } from '@agnes/protocol'

const fields = [
  'ttftMs',
  'durationMs',
  'providerCallMs',
  'prepareMs',
  'captureMs',
  'dispatchMs',
  'firstOutputMs',
  'outputMs',
  'finalizeMs',
] as const satisfies readonly (keyof Timing)[]

/** Project call observations without leaking ledger-only turn-gap fields or inventing zeroes. */
export function callTiming(timing: NonNullable<CostLedger['timing']>): Timing {
  return Object.fromEntries(
    fields.flatMap((key) => (typeof timing[key] === 'number' ? [[key, timing[key]]] : [])),
  )
}
