import type { ToolDef } from '@agnes/extension-api'
import { Type } from '@sinclair/typebox'

/** The smallest thing the tool registry will accept, for fixtures that are about registration. */
export function fixtureTool(name: string): ToolDef {
  return {
    name,
    description: `fixture tool ${name}`,
    parameters: Type.Object({}, { additionalProperties: false }),
    meta: {
      isReadOnly: true,
      isDestructive: false,
      isConcurrencySafe: true,
      isOpenWorld: false,
      replay: 'safe',
      costHint: undefined,
      deferLoading: false,
      requiresApproval: 'never',
    },
    async execute() {
      return { content: [{ type: 'text', text: name }] }
    },
  }
}
