import { defineExtension, defineTool, type ToolContext } from '@agnes/extension-api'
import { Type } from '@sinclair/typebox'
import { candidateTemplate } from './candidate-templates.js'
import { creatorAssets } from './generated/assets.js'

const meta = {
  isReadOnly: false,
  isDestructive: true,
  isConcurrencySafe: false,
  isOpenWorld: false,
  replay: 'never' as const,
  requiresApproval: 'always' as const,
  costHint: undefined,
  deferLoading: undefined,
}
const candidateId = Type.String({ pattern: '^candidate-[a-f0-9]{32}$' }),
  expectedHash = Type.String({ pattern: '^sha256-[a-f0-9]{64}$' })
const file = Type.Object(
  { path: Type.String({ minLength: 1, maxLength: 240 }), content: Type.String({ maxLength: 131072 }) },
  { additionalProperties: false },
)
async function request(ctx: ToolContext, input: unknown) {
  ctx.signal.throwIfAborted()
  if (!ctx.pluginManage)
    return {
      isError: true,
      content: [
        { type: 'text' as const, text: 'Host-reviewed authoring is unavailable. No files were installed.' },
      ],
    }
  const value = await ctx.pluginManage.request(input)
  ctx.signal.throwIfAborted()
  return { content: [{ type: 'text' as const, text: JSON.stringify(value) }] }
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
      'Ask permission to run bounded Node author tests against this exact candidate hash, using the public testkit. Tests never publish.',
    parameters: Type.Object({ candidateId, expectedHash }, { additionalProperties: false }),
    meta,
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
      'Replace candidate files through the Host authoring port. Supply the complete text tree. Every change invalidates tests and human review.',
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
    description: 'Read a candidate, its files, hash, tests and review state.',
    parameters: Type.Object({ candidateId }, { additionalProperties: false }),
    meta: { ...meta, isReadOnly: true, isDestructive: false, replay: 'safe', requiresApproval: 'never' },
    async execute(args, ctx) {
      return request(ctx, { action: 'candidate.show', ...args })
    },
  }),
] as const
export default defineExtension((api) => {
  const disposers = pluginCreatorTools.map((tool) => api.registerTool(tool))
  disposers.push(
    api.registerHook('context', () => ({
      sections: [
        {
          id: 'plugin-creator',
          order: 165,
          content:
            'To grow a plugin or Skill: read plugin_creator_guide; plugin_scaffold creates a private candidate, plugin_candidate_read/write edit its full text tree, plugin_test runs tests for its hash, plugin_install_local submits it for human review. Only the human may publish in Settings → Plugins. Never write drafts to plugin/Skill discovery roots. Old sessions keep their pinned generation.',
        },
      ],
    })),
  )
  return () => {
    for (const dispose of disposers.reverse()) dispose()
  }
})
