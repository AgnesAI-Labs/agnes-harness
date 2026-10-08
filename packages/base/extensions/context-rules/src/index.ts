import { dirname } from 'node:path'
import { defineExtension, type ProjectionDef } from '@agnes/extension-api'
import { loadContextRules } from './files.js'

type Scopes = { directories: string[] }
export const rulesProjection: ProjectionDef<Scopes> = {
  name: 'scopes',
  stateVersion: 1,
  stateSchema: {
    type: 'object',
    required: ['directories'],
    properties: { directories: { type: 'array', items: { type: 'string' } } },
    additionalProperties: false,
  },
  init: () => ({ directories: [] }),
  apply(state, event) {
    if (event.type !== 'tool/call') return state as Scopes
    const argv = (event.data as { args?: Record<string, unknown> }).args
    if (!argv || typeof argv !== 'object' || Array.isArray(argv)) return state as Scopes
    const directories = [...state.directories]
    for (const key of ['path', 'file_path', 'filePath', 'cwd']) {
      const path = argv[key]
      if (typeof path === 'string' && path.length <= 4096)
        directories.push(key === 'cwd' ? path : dirname(path))
    }
    const next = [...new Set(directories)].slice(-128)
    if (next.length === state.directories.length && next.every((dir, i) => dir === state.directories[i]))
      return state as Scopes
    return { directories: next }
  },
}
export default defineExtension((agnes) => {
  const disposers = [
    agnes.registerProjection(rulesProjection),
    agnes.registerHook('context', async (_payload, ctx) => {
      const state = await ctx.projections.readOwn<Scopes>('scopes')
      const snapshot = await loadContextRules(
        ctx.session.workspaceRoot,
        state.status === 'available' ? state.value.directories : [],
        undefined,
        undefined,
        ctx.signal,
      )
      return {
        refreshOnRequest: true,
        sections: [{ id: 'agents-md', order: 120, content: snapshot.content }],
      }
    }),
  ]
  return () => {
    for (const dispose of disposers.reverse()) dispose()
  }
})
export {
  type ContextConfig,
  contextHome,
  parseContextConfig,
  readContextConfig,
  writeContextConfig,
} from './config.js'
export { loadContextRules, type RulesSnapshot } from './files.js'
