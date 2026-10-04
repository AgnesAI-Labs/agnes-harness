import { canonicalJson, type RegisteredTool, sha256Hex } from '@agnes/core'

// Pins cover the full reviewed builtin description, schema and metadata. Source and the
// first registration fingerprint are checked separately by the consumers.
const contracts: Record<string, string> = {
  subagent_send_message: 'f44b8fe9ee0ec0a1130e14795e14f0955f7f21a5ec543708442dcee1ebb87e65',
  subagent_interrupt: '5c53d69bb27d755f6e5ee42741719be8d4a7b50554952a13d7bd90ee1113323c',
}

export function verifiedChildControlTool(definition: RegisteredTool): boolean {
  return (
    definition.source.source === 'agnes/subagent' &&
    definition.source.trust === 'builtin' &&
    definition.executionDomain === 'workspace' &&
    definition.classify === undefined &&
    definition.policyVersion === undefined &&
    contracts[definition.name] !== undefined &&
    sha256Hex(
      canonicalJson(
        JSON.parse(
          JSON.stringify({
            description: definition.description,
            meta: definition.meta,
            parameters: definition.parameters,
          }),
        ),
      ),
    ) === contracts[definition.name]
  )
}
