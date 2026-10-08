import { CoreError } from '@agnes/core-common/types'
import type { SystemPromptProvider } from '@agnes/extension-api'
import type { SystemPromptConfig, SystemPromptSection } from '@agnes/protocol'
import { validateAgainst } from '@agnes/protocol'
import { SystemPromptSection as SectionSchema } from '@agnes/protocol/gen/agnes-v1'

export type PinnedSystemPrompt = { config: SystemPromptConfig; provider: SystemPromptProvider }
export function composeSystemPrompt(
  binding: PinnedSystemPrompt | undefined,
  sections: readonly SystemPromptSection[],
  liveSections: readonly SystemPromptSection[] = [],
): SystemPromptSection[] {
  const instructions = binding
    ? binding.provider.compose(structuredClone(binding.config), structuredClone(sections))
    : sections
  // Core facts remain live even when the deployment composer replaces all plugin instructions.
  const composed = Array.isArray(instructions) ? [...instructions, ...liveSections] : instructions
  if (
    !Array.isArray(composed) ||
    composed.length > 256 ||
    new Set(composed.map((section) => section.id)).size !== composed.length ||
    composed.some((section) => !validateAgainst(SectionSchema, section).ok) ||
    new TextEncoder().encode(composed.map((section) => section.text).join('\n\n')).byteLength > 1024 * 1024
  )
    throw new CoreError('E_ENVELOPE', 'system prompt provider returned invalid sections')
  return structuredClone([...composed]).sort((a, b) => a.order - b.order)
}
