import { basename, extname } from 'node:path'
import { type ArtifactRef, defineExtension, defineTool, type ProjectionDef } from '@agnes/extension-api'
import { interactionSurfaceId, renderInteractionSurface } from '../../../src/interaction-surfaces.js'
import { Type } from '@sinclair/typebox'

type Deliverable = { name: string; description: string; ref: ArtifactRef }
type State = { presented: Record<string, Deliverable[]> }
const MAX_FILE_BYTES = 32 * 1024 * 1024
const MIME: Record<string, string> = {
  '.pdf': 'application/pdf',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.html': 'text/html',
  '.md': 'text/markdown',
  '.txt': 'text/plain',
  '.csv': 'text/csv',
  '.json': 'application/json',
}
export const deliverableProjection: ProjectionDef<State> = {
  name: 'presented',
  stateVersion: 1,
  stateSchema: {
    type: 'object',
    required: ['presented'],
    properties: {
      presented: { type: 'object', additionalProperties: { type: 'array', items: { type: 'object' } } },
    },
    additionalProperties: false,
  },
  init: () => ({ presented: {} }),
  apply(state, event) {
    if (event.type !== 'x/agnes/deliverables/presented') return state as State
    const data = event.data as { toolUseId: string; files: Deliverable[] }
    const presented = { ...state.presented, [data.toolUseId]: data.files }
    while (
      Object.keys(presented).length > 1 &&
      new TextEncoder().encode(JSON.stringify(presented)).length > 230000
    )
      delete presented[Object.keys(presented)[0]!]
    return { presented }
  },
}
export default defineExtension((agnes) => {
  const disposers = [agnes.registerProjection(deliverableProjection)]
  disposers.push(
    agnes.registerTool(
      defineTool({
        name: 'present',
        description:
          'Register existing workspace files as deliverables. Copies the files into session artifacts for durable open/download cards. Does not create files. Each file must be readable, regular and at most 32 MiB; the total per call is also limited to 32 MiB.',
        parameters: Type.Object(
          {
            files: Type.Array(
              Type.Object(
                {
                  path: Type.String({ minLength: 1, maxLength: 4096 }),
                  name: Type.Optional(Type.String({ minLength: 1, maxLength: 256 })),
                  description: Type.Optional(Type.String({ maxLength: 1024 })),
                },
                { additionalProperties: false },
              ),
              { minItems: 1, maxItems: 16 },
            ),
          },
          { additionalProperties: false },
        ),
        meta: {
          isReadOnly: true,
          isDestructive: false,
          isConcurrencySafe: false,
          isOpenWorld: false,
          replay: 'idempotent',
          costHint: {},
          deferLoading: false,
          requiresApproval: 'never',
        },
        async execute(args, ctx) {
          try {
            const previous = await ctx.projections.readOwn<State>('presented')
            if (previous.status !== 'available') throw new Error('deliverable persistence unavailable')
            if (
              new TextEncoder().encode(
                JSON.stringify(
                  args.files.map((file) => ({
                    name: basename(file.name ?? file.path).slice(0, 256),
                    description: file.description ?? '',
                  })),
                ),
              ).length > 60000
            )
              throw new Error('deliverables exceed the card payload limit')
            const existing = previous.value.presented[ctx.session.toolUseId]
            const files: Deliverable[] = existing ?? []
            if (!existing) {
              // Validate all files before registering any; artifact blobs may be reclaimed if commit fails.
              const loaded = []
              let total = 0
              for (const file of args.files) {
                const st = await ctx.fs.stat(file.path)
                if (st.kind !== 'file' || st.size > MAX_FILE_BYTES)
                  throw new Error(`present requires a regular file of at most 32 MiB: ${file.path}`)
                total += st.size
                if (total > MAX_FILE_BYTES) throw new Error('present accepts at most 32 MiB in one call')
                const bytes = await ctx.fs.read(file.path, { limit: MAX_FILE_BYTES + 1 })
                if (bytes.length > MAX_FILE_BYTES) throw new Error(`file grew beyond 32 MiB: ${file.path}`)
                total += bytes.length - st.size
                if (total > MAX_FILE_BYTES) throw new Error('files grew beyond the 32 MiB call limit')
                loaded.push({ file, bytes })
              }
              for (const { file, bytes } of loaded) {
                const name = basename(file.name ?? file.path).slice(0, 256)
                const ref = await ctx.artifacts.put(bytes, {
                  name,
                  mime: MIME[extname(file.path).toLowerCase()] ?? 'application/octet-stream',
                })
                files.push({ name, description: file.description ?? '', ref })
              }
              await agnes.events.append('presented', { toolUseId: ctx.session.toolUseId, files })
            }
            await renderInteractionSurface(ctx, {
              id: interactionSurfaceId(ctx.session.toolUseId),
              revision: 1,
              title: 'Deliverables / 交付物',
              placement: { inline: true, workbench: true, preferred: 'inline' },
              components: files.map((_, i) => ({ id: 'file-' + i, kind: 'text', dataKey: 'file-' + i })),
              data: Object.fromEntries(
                files.map((file, i) => [
                  'file-' + i,
                  `${file.name} — ${file.description} (${file.ref.size} bytes; artifact ${file.ref.sha256})`,
                ]),
              ),
              actions: [],
            })
            return {
              content: [
                { type: 'text', text: `Presented ${files.map((f) => f.name).join(', ')}` },
                ...files.map((f) => ({ type: 'ref' as const, ref: f.ref })),
              ],
              details: { deliverables: files },
            }
          } catch (e) {
            return { content: [{ type: 'text', text: `present failed: ${String(e)}` }], isError: true }
          }
        },
      }),
    ),
  )
  return () => {
    for (const dispose of disposers) dispose()
  }
})
