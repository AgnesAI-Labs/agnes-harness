import type { FactChainParams, FactChainResult } from '@agnes/protocol'
import { validateMethod } from '@agnes/protocol'
import type { Session } from '@agnes/sdk/browser'

/**
 * The trace's fact-chain read. Request, tool and artifact anchors use the session read; a feedback
 * candidate's authoring record is read through the admin route that owns drafting, as before.
 */
export async function readTraceFactChain(
  session: Session | undefined,
  params: FactChainParams,
  switched: () => Error,
  signal?: AbortSignal,
): Promise<FactChainResult> {
  if (!session || session.id !== params.sessionId) throw switched()
  if (params.anchor.kind !== 'authoring')
    return session.factChain(params.anchor, params.laneId, { timeoutMs: 600_000 })
  const response = await fetch('/admin/api/fact-chain', {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(params),
    ...(signal ? { signal } : {}),
  })
  const value: unknown = await response.json()
  if (!response.ok || !validateMethod('_agnes/v1/session.factChain', 'result', value).ok)
    throw new Error('Unavailable')
  return value as FactChainResult
}
