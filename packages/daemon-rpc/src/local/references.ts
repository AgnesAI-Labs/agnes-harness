import type { HostSession } from '@agnes/host'
import {
  type ContentBlock,
  type ReferenceSelection,
  rpcError,
  validateReferenceSelections,
} from '@agnes/protocol'
import { sessionReferences } from '@agnes/worker-runtime'

export function callReferences(
  session: HostSession,
  operation: 'search' | 'resolve',
  input: unknown,
): Promise<unknown> {
  const remote = session as unknown as {
    references?: (operation: string, input: unknown) => Promise<unknown>
  }
  return remote.references
    ? remote.references(operation, input)
    : sessionReferences(session, operation, input as string | ReferenceSelection[])
}

/** Client text cannot forge a receipt. Only backend-resolved blocks acquire reference metadata. */
export async function resolvePromptReferences(
  session: HostSession,
  content: ContentBlock[],
  selections: unknown,
  signal?: AbortSignal,
): Promise<ContentBlock[]> {
  if (content.some((block) => block.type === 'text' && block.reference !== undefined))
    throw rpcError('INVALID_PARAMS', { reason: 'Reference receipts are backend-owned.' })
  let refs: ReferenceSelection[]
  try {
    refs = validateReferenceSelections(selections)
  } catch {
    throw rpcError('INVALID_PARAMS', { reason: 'Invalid reference selection.' })
  }
  if (!refs.length) return content
  signal?.throwIfAborted()
  const resolved = (await callReferences(session, 'resolve', refs)) as ContentBlock[]
  signal?.throwIfAborted()
  return [...content, ...resolved]
}
