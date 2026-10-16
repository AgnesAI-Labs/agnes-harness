import type { PackageContributionSummary } from '@agnes/protocol'
import { canonical } from './integrity.js'

/** Earlier plugin-core builds omitted client.streams during normalization. Keep their sealed
 * grants (and capability hash) unchanged; discovering declarations is never a grant of access.
 * Only the reviewed update path may persist the newly normalized contribution. */
export function reviewedContributionsMatch(
  inspected: readonly PackageContributionSummary[],
  reviewed: readonly PackageContributionSummary[],
): boolean {
  const projected = inspected.map((row, index) => {
    const prior = reviewed[index]
    if (
      'client' in row &&
      row.client &&
      prior &&
      'client' in prior &&
      prior.client &&
      prior.client.streams === undefined
    ) {
      const { streams: _streams, ...client } = row.client
      return { ...row, client }
    }
    return row
  })
  return canonical(projected) === canonical(reviewed)
}
