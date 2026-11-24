import type { ViewFilter } from './pipeline.js'
import type { HideRange } from './view.js'

const reference = /<!--\s*ref:(r[0-9a-z]{10})\s*-->|\bref:[ \t]+(r[0-9a-z]{10})\b/gu

export const refViewFilter: ViewFilter = (entry, ctx) => {
  if (ctx.layer !== 'workspace') return []
  const ranges: HideRange[] = []
  let start = 0
  let withdrawn = false
  const finish = (end: number) => {
    if (withdrawn) {
      ranges.push({
        start,
        end,
        appliesTo: 'both',
        reason: 'ref-withdrawn',
        mergeGroup: 'ref-withdrawn',
        notice: '[1 line referencing withdrawn or expired memory hidden]',
      })
    }
    withdrawn = false
  }
  for (const line of entry.content.matchAll(/[^\n]*\n|[^\n]+$/gu)) {
    if (!line[0].trim()) {
      finish(line.index)
      start = line.index + line[0].length
    } else if (!withdrawn) {
      for (const match of line[0].matchAll(reference)) {
        const validity = ctx.validity(match[1] ?? match[2]!)
        if (validity !== 'valid' && validity !== 'delivered') {
          withdrawn = true
          break
        }
      }
    }
  }
  finish(entry.content.length)
  return ranges
}
