import type { ToolContext } from '@agnes/extension-api'
import { type Context, defineAgnesPlugin, defineTool } from '@agnes/plugin-runtime'
import type { AuthoringCandidate } from '@agnes/protocol'
import { Type } from '@sinclair/typebox'
import { authoringFailure } from './authoring-error.js'
import { candidateResult } from './candidate-result.js'
import { candidateTemplate } from './candidate-templates.js'
import { creatorAssets } from './generated/assets.js'

const meta = {
  isReadOnly: false,
  isDestructive: true,
  isConcurrencySafe: false,
  isOpenWorld: false,
  replay: 'never' as const,
  requiresApproval: 'always' as const,
}
const candidateId = Type.String({ pattern: '^candidate-[a-f0-9]{32}$' }),
  expectedHash = Type.String({ pattern: '^sha256-[a-f0-9]{64}$' })
const file = Type.Object(
  { path: Type.String({ minLength: 1, maxLength: 240 }), content: Type.String({ maxLength: 131072 }) },
  { additionalProperties: false },
)
async function request(
  ctx: ToolContext,
  input: { action: string; candidateId?: string; [key: string]: unknown },
  read?: { offset?: number; expectedHash?: string },
) {
  ctx.signal.throwIfAborted()
  try {
    if (!ctx.pluginManage)
      throw Object.assign(new Error('Host authoring capability is unavailable'), {
        code: 'PLUGIN_PORT_UNAVAILABLE',
      })
    const value = await ctx.pluginManage.request(input)
    ctx.signal.throwIfAborted()
    const result = await candidateResult(ctx, value as AuthoringCandidate, read)
    if (result.isError) {
      const failure = authoringFailure(
        input.action,
        input.candidateId ?? (value as AuthoringCandidate).candidateId,
        'result',
        result.details,
      )
      if (failure)
        return { ...result, details: failure.details, content: [...failure.content, ...result.content] }
    }
    return result
  } catch (error) {
    ctx.signal.throwIfAborted()
    const failure = authoringFailure(
      input.action,
      input.candidateId,
      ctx.pluginManage ? 'request' : 'host-capability',
      error,
    )
    if (failure) return failure
    throw error
  }
}

export const pluginCreatorTools = [
  defineTool({
    name: 'plugin_creator_guide',
    description: 'Read the reviewed plugin/Skill authoring guide.',
    parameters: Type.Object({}, { additionalProperties: false }),
    meta: { ...meta, isReadOnly: true, isDestructive: false, replay: 'safe', requiresApproval: 'never' },
    async execute(_args, ctx) {
      ctx.signal.throwIfAborted()
      return { content: [{ type: 'text', text: creatorAssets.skill }] }
    },
  }),
  defineTool({
    name: 'plugin_scaffold',
    description:
      'Draft a plugin or Markdown Skill in the Host candidate area, outside discovery roots. Returns candidateId and candidateHash; no code is installed.',
    parameters: Type.Object(
      {
        template: Type.Union(
          ['tool', 'tool-with-panel', 'mcp-skills', 'model-adapter', 'loop', 'skill'].map((v) =>
            Type.Literal(v),
          ),
        ),
        name: Type.String({ pattern: '^(?:@[a-z0-9][a-z0-9._-]*/)?[a-z0-9][a-z0-9._-]*$' }),
        directory: Type.Optional(
          Type.String({ description: 'Legacy hint only; candidates are always stored by the Host.' }),
        ),
      },
      { additionalProperties: false },
    ),
    meta,
    async execute(args, ctx) {
      return request(ctx, { action: 'candidate.create', files: candidateTemplate(args.template, args.name) })
    },
  }),
  defineTool({
    name: 'plugin_test',
    description:
      'Run bounded Node author tests for this exact candidate hash using the public testkit. One hash-bound confirmation authorizes execution; full-access skips it only with enforced OS isolation. Tests never publish.',
    parameters: Type.Object({ candidateId, expectedHash }, { additionalProperties: false }),
    // The daemon owns the sole exact-hash execution confirmation.
    meta: { ...meta, isDestructive: false, requiresApproval: 'never' },
    async execute(args, ctx) {
      return request(ctx, { action: 'candidate.test', ...args })
    },
  }),
  defineTool({
    name: 'plugin_install_local',
    description:
      'Submit this passing candidate for human review in Settings → Plugins. This never installs, trusts or enables code; the human publishes the exact reviewed hash.',
    parameters: Type.Object({ candidateId, expectedHash }, { additionalProperties: false }),
    meta,
    async execute(args, ctx) {
      return request(ctx, { action: 'candidate.submit', ...args })
    },
  }),
  defineTool({
    name: 'plugin_candidate_write',
    description:
      'Replace the complete candidate text tree. Build in <=8 KiB new-text steps; use run_code to read/modify/write the full tree without re-emitting unchanged files. After truncation, read the same candidate. Changes invalidate tests and review.',
    parameters: Type.Object(
      { candidateId, expectedHash, files: Type.Array(file, { minItems: 1, maxItems: 64 }) },
      { additionalProperties: false },
    ),
    meta,
    async execute(args, ctx) {
      return request(ctx, { action: 'candidate.write', ...args })
    },
  }),
  defineTool({
    name: 'plugin_candidate_read',
    description:
      'Read candidate source as structured data with a short status and artifact preview. Large sources return candidate-source-page: concatenate consecutive data fragments, then parse once. Continue using nextOffset and expectedHash; stop on a changed hash.',
    parameters: Type.Object(
      {
        candidateId,
        offset: Type.Optional(Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER })),
        expectedHash: Type.Optional(expectedHash),
      },
      { additionalProperties: false },
    ),
    meta: { ...meta, isReadOnly: true, isDestructive: false, replay: 'safe', requiresApproval: 'never' },
    async execute(args, ctx) {
      return request(ctx, { action: 'candidate.show', candidateId: args.candidateId }, args)
    },
  }),
] as const
export default defineAgnesPlugin({
  inject: ['tools', 'hooks'],
  apply(ctx: Context) {
    const disposers = pluginCreatorTools.map((tool) => ctx.tools.register(tool))
    disposers.push(
      ctx.hooks.register('context', () => ({
        sections: [
          {
            id: 'plugin-creator',
            order: 165,
            content:
              'To grow a plugin or Skill: read plugin_creator_guide; plugin_scaffold creates a private candidate, plugin_candidate_read/write edit its full text tree, plugin_test runs tests for its hash, plugin_install_local submits it for human review. Only the human may publish in Settings → Plugins. Never write drafts to plugin/Skill discovery roots. Old sessions keep their pinned generation. Keep new text <=8 KiB per reply; use run_code for incremental full-tree edits. After OUTPUT_LIMIT, read and continue the same candidate.',
          },
        ],
      })),
    )
    return () => {
      for (const dispose of disposers.reverse()) dispose()
    }
  },
})
