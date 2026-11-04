import type { MemorySession } from '@agnes/extension-api'
import { rpcError } from '@agnes/protocol'
import type { AdminMemoryParams } from '@agnes/protocol/gen/app-server'
import type { SavedParagraphs } from '../refinement/saved-paragraphs.js'

/**
 * Human edits are explicit CAS operations, independent of the agent's off/ask/auto permission. Saved
 * task experience paragraphs (`saved`) are managed the same way, on their own: a request names either
 * them, the settings, or a file. A host without that management answers an empty list.
 */
export async function manageMemory(
  memory: MemorySession | undefined,
  input: AdminMemoryParams,
  saved?: SavedParagraphs,
) {
  if (!memory) throw rpcError('SEMANTIC_REJECTED', { reason: 'MEMORY_PROVIDER_UNAVAILABLE' })
  try {
    if (input.settings && (input.content !== undefined || input.file !== undefined))
      throw rpcError('INVALID_PARAMS', { reason: 'MEMORY_INVALID_REQUEST' })
    if (input.saved && (input.settings || input.content !== undefined || input.file !== undefined))
      throw rpcError('INVALID_PARAMS', { reason: 'MEMORY_INVALID_REQUEST' })
    if (
      (input.content !== undefined) !== (input.baseHash !== undefined) ||
      (input.content !== undefined && !input.file)
    )
      throw rpcError('INVALID_PARAMS', { reason: 'MEMORY_INVALID_REQUEST' })
    const paragraphs = input.saved
      ? saved
        ? await saved(memory, input.cwd, input.saved)
        : { paragraphs: [] }
      : undefined
    const file = input.file
      ? input.content === undefined
        ? await memory.readFile(input.file)
        : await memory.editFile(input.file, input.content, input.baseHash!)
      : undefined
    const inspection = input.settings ? await memory.configure(input.settings) : await memory.inspect()
    return { inspection, ...(file ? { file } : {}), ...(paragraphs ? { saved: paragraphs } : {}) }
  } finally {
    await memory.close?.()
  }
}
