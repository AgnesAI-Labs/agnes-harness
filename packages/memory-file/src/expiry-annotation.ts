import { annotations } from '@agnes/protocol/memory-expiry'
import type { NextExpiryProvider, ViewFilter } from './pipeline.js'
import type { HideRange } from './view.js'

export { annotations }

export const expiryViewFilter: ViewFilter = (entry, ctx) => {
  const ranges: HideRange[] = []
  for (const { start, end, expiresAt } of annotations(entry.content)) {
    if (expiresAt > ctx.now) continue
    const invalid = !Number.isFinite(expiresAt)
    ranges.push({
      start,
      end,
      appliesTo: 'both',
      reason: invalid ? 'expiry-invalid' : 'expiry-annotation',
      notice: invalid
        ? '[1 paragraph with unparseable expiry date hidden]'
        : '[1 paragraph past its expiry date hidden]',
    })
  }
  return ranges
}

export const expiryNextExpiry: NextExpiryProvider = (files, ctx) => {
  let earliest: number | undefined
  for (const entry of files) {
    for (const { expiresAt } of annotations(entry.content)) {
      if (expiresAt > ctx.now && (earliest === undefined || expiresAt < earliest)) earliest = expiresAt
    }
  }
  return earliest
}
