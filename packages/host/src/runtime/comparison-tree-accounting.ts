import {
  type FamilyAccounting as ComparisonAccountingFamily,
  type LaneAccounting as ComparisonAccountingLane,
  type Total as ComparisonAccountingTotal,
  combineFamilyCosts,
  aggregateAccountingTotals as total,
} from '@agnes/runtime-comparison'

const zero = (): ComparisonAccountingTotal => ({ state: 'complete', value: 0, knownSubtotal: 0, missing: 0 })
/** Add independently validated session-owned attempts, never ledger seqs or assistant projections. */
export function aggregateComparisonTreeAccounting(
  members: readonly ComparisonAccountingLane[],
  throughSeq: number,
  complete: boolean,
): ComparisonAccountingLane {
  const family = (name: 'llm' | 'jev'): ComparisonAccountingFamily => {
    const values = members.map((member) => member[name])
    const outcomes = { completed: 0, failed: 0, cancelled: 0, unknown: 0, pending: 0 }
    const byPurpose: ComparisonAccountingFamily['byPurpose'] = Object.create(null)
    for (const value of values) {
      for (const key of Object.keys(outcomes) as Array<keyof typeof outcomes>)
        outcomes[key] += value.outcomes[key]
      for (const [purpose, row] of Object.entries(value.byPurpose)) {
        const prior = byPurpose[purpose] ?? {
          attempts: 0,
          outcomes: { completed: 0, failed: 0, cancelled: 0, unknown: 0, pending: 0 },
        }
        prior.attempts += row.attempts
        for (const key of Object.keys(outcomes) as Array<keyof typeof outcomes>)
          prior.outcomes[key] += row.outcomes[key]
        byPurpose[purpose] = prior
      }
    }
    const billing = (source: 'gateway' | 'estimated') => ({
      attempts: values.reduce((sum, row) => sum + row.reportedBilling[source].attempts, 0),
      usdMicros: total(
        values.map((row) => row.reportedBilling[source].usdMicros),
        complete,
        true,
      ),
      subscriptionAttempts: values.reduce(
        (sum, row) => sum + row.reportedBilling[source].subscriptionAttempts,
        0,
      ),
      nonSubscriptionAttempts: values.reduce(
        (sum, row) => sum + row.reportedBilling[source].nonSubscriptionAttempts,
        0,
      ),
    })
    return {
      attempts: values.reduce((sum, row) => sum + row.attempts, 0),
      outcomes,
      byPurpose,
      tokens: Object.fromEntries(
        ['inputUncached', 'cacheRead', 'cacheWrite', 'output', 'reasoning', 'inputTotal', 'total'].map(
          (key) => [
            key,
            total(
              values.map((row) => row.tokens[key as keyof typeof row.tokens]),
              complete,
              true,
            ),
          ],
        ),
      ) as ComparisonAccountingFamily['tokens'],
      costs: combineFamilyCosts(values, complete),
      bucketCosts: Object.fromEntries(
        [...new Set(values.flatMap((row) => Object.keys(row.bucketCosts ?? {})))].map((currency) => [
          currency,
          Object.fromEntries(
            [...new Set(values.flatMap((row) => Object.keys(row.bucketCosts?.[currency] ?? {})))].map(
              (bucket) => [
                bucket,
                total(
                  values.map(
                    (row) =>
                      row.bucketCosts?.[currency]?.[
                        bucket as 'inputTotal' | 'inputUncached' | 'cacheRead' | 'cacheWrite' | 'output'
                      ] ??
                      (row.attempts === 0 ||
                      (row.bucketCosts && !row.bucketCosts[currency] && row.unpricedAttempts === 0)
                        ? zero()
                        : {
                            state: 'unknown',
                            value: null,
                            knownSubtotal: null,
                            missing: Math.max(1, row.unpricedAttempts),
                          }),
                  ),
                  complete,
                ),
              ],
            ),
          ),
        ]),
      ),
      priceMultipliers: [
        ...new Set(
          values
            .flatMap((row) => row.priceMultipliers ?? [])
            .filter((value) => Number.isFinite(value) && value >= 0),
        ),
      ].sort((left, right) => left - right),
      currentPriceAttempts: values.reduce((sum, row) => sum + (row.currentPriceAttempts ?? 0), 0),
      unpricedAttempts: values.reduce((sum, row) => sum + row.unpricedAttempts, 0),
      reportedBilling: {
        gateway: billing('gateway'),
        estimated: billing('estimated'),
        missingAttempts: values.reduce((sum, row) => sum + row.reportedBilling.missingAttempts, 0),
      },
    }
  }
  const issues = [
    ...new Set([...members.flatMap((member) => member.issues), ...(complete ? [] : ['incomplete_tree'])]),
  ]
  const all = complete && members.every((member) => member.state === 'complete')
  const llm = family('llm')
  const jev = family('jev')
  return {
    afterSeq: 0,
    throughSeq,
    state: all ? 'complete' : members.some((member) => member.state !== 'unknown') ? 'partial' : 'unknown',
    llm,
    jev,
    totalCosts: combineFamilyCosts([llm, jev], complete),
    issues,
  }
}
