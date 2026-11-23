import type { RecapFactSnapshot } from '@agnes/extension-api'
import { composeRecapMarkdown, renderDeterministicNarrative } from './recap-formatter.js'
import { validateRecapOutput } from './recap-validator.js'

/** Explicit headless/benchmark entry. Only the caller can supply a model or spend a request. */
export async function generateHybridRecap(
  snapshot: RecapFactSnapshot,
  narrate?: (facts: RecapFactSnapshot, instruction: string) => Promise<string>,
) {
  const deterministic = () => renderDeterministicNarrative(snapshot)
  const compose = (
    narrative: string,
    narrativeSource: 'deterministic' | 'narrator' | 'deterministic_fallback',
    violations: readonly { code: string; detail: string }[] = [],
  ) => ({ narrative, narrativeSource, markdown: composeRecapMarkdown(snapshot, narrative), violations })
  if (!narrate) return compose(deterministic(), 'deterministic')
  try {
    // Isolate the authority used for validation even from a narrator that mutates its input.
    const text = await narrate(
      structuredClone(snapshot),
      'Summarize only these runtime facts. Name each unresolved and external task and its status. Attribute only verified paths to their owning task. Give the next actions.',
    )
    if (text.trim()) {
      const result = validateRecapOutput(text, snapshot)
      return result.valid
        ? compose(text, 'narrator')
        : compose(deterministic(), 'deterministic_fallback', result.violations)
    }
  } catch {
    return compose(deterministic(), 'deterministic_fallback', [
      { code: 'NARRATOR_ERROR', detail: 'Narration unavailable' },
    ])
  }
  return compose(deterministic(), 'deterministic_fallback', [
    { code: 'EMPTY_NARRATIVE', detail: 'No narrative returned' },
  ])
}
