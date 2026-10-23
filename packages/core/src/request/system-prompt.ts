import { CoreError } from '@agnes/core-common/types'
import type { SystemPromptProvider } from '@agnes/extension-api'
import type { SystemPromptConfig, SystemPromptSection } from '@agnes/protocol'
import { parseSystemPromptAppend, validateAgainst } from '@agnes/protocol'
import {
  SystemPromptConfig as ConfigSchema,
  SystemPromptSection as SectionSchema,
} from '@agnes/protocol/gen/agnes-v1'

/** Lets a transport answer with a plain refusal instead of an internal error. */
export const APPEND_REFUSED = { reason: 'system-prompt-append' } as const

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

/**
 * Owner text added to a new session's pinned prompt config: after the deployment's own closing
 * instructions, never replacing anything. Refused, not cut, when a full replacement is in force or the
 * merged field would pass its cap.
 */
export function appendToSystemPromptConfig(config: SystemPromptConfig, append: string): SystemPromptConfig {
  let text: string
  try {
    text = parseSystemPromptAppend(append)
  } catch {
    throw new CoreError('E_ENVELOPE', 'system prompt append is invalid', APPEND_REFUSED)
  }
  if (config.fullOverride !== undefined)
    throw new CoreError(
      'E_ENVELOPE',
      'system prompt append conflicts with a full replacement',
      APPEND_REFUSED,
    )
  const merged = {
    ...config,
    personaSuffix: config.personaSuffix ? `${config.personaSuffix}\n\n${text}` : text,
  }
  if (!validateAgainst(ConfigSchema, merged).ok)
    throw new CoreError(
      'E_ENVELOPE',
      'system prompt append exceeds the closing instruction limit',
      APPEND_REFUSED,
    )
  return merged
}
