import { scanPages } from '@agnes/core-ledger/log/scan-pages'
import type { ToolResult } from '@agnes/extension-api'
import type { SessionImpl } from '../step/session.js'

/** A closed turn stays closed; a late receipt adds evidence to its original effect. */
export async function lateToolResponse(s: SessionImpl, toolUseId: string): Promise<ToolResult | undefined> {
  for await (const page of scanPages((query) => s.d.log.scan(query), {
    type: 'x/core/late-effect-receipt',
    lane: s.lane,
    fromSeq: (s.d.log.parent?.boundarySeq ?? 0) + 1,
    toSeq: s.lastSeq,
    order: 'desc',
  })) {
    for (const event of page) {
      if (event.origin !== 'system' || event.trust !== 'trusted') continue
      const data = event.data as unknown as {
        version: number
        effects: { effectId: string }[]
        receipts: { type: string; data: { version?: number; toolUseId?: string; result?: ToolResult } }[]
      }
      if (data.version !== 1 || !Array.isArray(data.receipts) || !Array.isArray(data.effects)) continue
      const response = data.receipts.find(
        (row) =>
          row.type === 'x/core/tool-response' && row.data.version === 1 && row.data.toolUseId === toolUseId,
      )?.data.result
      if (!response) continue
      for (const seq of event.sourceEventSeqs ?? []) {
        const [intent] = await s.d.log.scan({ fromSeq: seq, toSeq: seq, limit: 1 })
        const body = intent?.data as { effectId?: string; tool?: { toolUseId?: string } } | undefined
        if (
          intent?.type === 'effect/intent' &&
          intent.origin === 'system' &&
          intent.trust === 'trusted' &&
          body?.tool?.toolUseId === toolUseId &&
          data.effects.some((effect) => effect.effectId === body.effectId)
        )
          return structuredClone(response)
      }
    }
  }
}
