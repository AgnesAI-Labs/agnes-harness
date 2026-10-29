import type { ServiceDef } from '@agnes/extension-api'
import { applyPlanCommand, readPlanMode } from './state.js'

const outputSchema = { type: 'object', additionalProperties: true }
export const planServiceCapabilities = [
  {
    name: 'plan.status',
    kind: 'query' as const,
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    outputSchema,
    timeoutMs: 10000,
    maxResultBytes: 1048576,
  },
  {
    name: 'plan.command',
    kind: 'effect' as const,
    inputSchema: {
      type: 'object',
      properties: { line: { type: 'string', maxLength: 8192, pattern: '^\\s*/plan(?:\\s|$)' } },
      required: ['line'] as string[],
      additionalProperties: false,
    },
    outputSchema,
    timeoutMs: 10000,
    maxResultBytes: 1048576,
  },
] as const

export function createPlanServices(available: () => boolean): ServiceDef[] {
  return [
    {
      ...planServiceCapabilities[0],
      async handler(_input, ctx) {
        if (!ctx.session) throw new Error('Plan mode requires a session')
        if (!available()) return { active: false, updatedAt: '', available: false }
        return { ...readPlanMode(ctx.session.workspaceRoot) }
      },
    },
    {
      ...planServiceCapabilities[1],
      async handler(input, ctx) {
        if (
          !ctx.session ||
          !input ||
          typeof input !== 'object' ||
          Array.isArray(input) ||
          typeof input.line !== 'string'
        )
          throw new Error('Plan command requires a session and line')
        if (ctx.actor.role === 'extension' || ctx.source !== 'plan-admin')
          throw new Error('Plan commands require human workspace control')
        if (!available()) return { active: false, text: 'Plan mode is off (provider unavailable)' }
        return applyPlanCommand(ctx.session.workspaceRoot, input.line)
      },
    },
  ]
}
