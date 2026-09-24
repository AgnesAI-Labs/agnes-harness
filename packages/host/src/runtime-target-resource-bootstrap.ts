import type { McpRuntimeInput } from './resources/mcp.js'
import type { SkillRuntimeInput } from './resources/skills.js'
import type {
  RuntimeTargetResourceFactory,
  RuntimeTargetResourceFactoryInput,
} from './runtime-target-resources.js'

export type HostRuntimeTargetResources = Readonly<{
  input: RuntimeTargetResourceFactoryInput
  mcp: McpRuntimeInput
  skills: SkillRuntimeInput
}>

const EMPTY_MCP: McpRuntimeInput = Object.freeze({ list: () => Object.freeze([]) })
const EMPTY_SKILLS: SkillRuntimeInput = Object.freeze({
  list: () => Object.freeze([]),
  read: () => Object.freeze({ ok: false, code: 'NOT_FOUND' as const }),
  readFile: () => Object.freeze({ ok: false, code: 'NOT_FOUND' as const }),
})

export type HostRuntimeTargetResourceFactoryOptions = Readonly<{
  mcp?: McpRuntimeInput
  skills?: SkillRuntimeInput
}>

/**
 * Convert one canonical target resource snapshot into a Host generation.
 *
 * Live MCP/Skills facades are borrowed from the worker/Host boundary when present. Cleanup only
 * revokes this generation's wrapper; it does not close the process-wide resource runtime.
 */
export function createHostRuntimeTargetResourceFactory(
  options: HostRuntimeTargetResourceFactoryOptions = {},
): RuntimeTargetResourceFactory<HostRuntimeTargetResources> {
  const mcp = options.mcp ?? EMPTY_MCP
  const skills = options.skills ?? EMPTY_SKILLS
  return Object.freeze({
    create(input, scope) {
      let closed = false
      scope.defer(() => {
        closed = true
      })
      const resources: HostRuntimeTargetResources = Object.freeze({
        input,
        mcp: Object.freeze({
          list: () => {
            if (closed) throw new Error('E_RESOURCE_GENERATION_UNAVAILABLE: resource generation is closed')
            return mcp.list()
          },
        }),
        skills: Object.freeze({
          list: () => {
            if (closed) throw new Error('E_RESOURCE_GENERATION_UNAVAILABLE: resource generation is closed')
            return skills.list()
          },
          read: (resourceId: string, session: { sessionKey: string }) => {
            if (closed) throw new Error('E_RESOURCE_GENERATION_UNAVAILABLE: resource generation is closed')
            return skills.read(resourceId, session)
          },
          readFile: (
            resourceId: string,
            expectedRevision: string,
            relativePath: string,
            session: { sessionKey: string },
          ) => {
            if (closed) throw new Error('E_RESOURCE_GENERATION_UNAVAILABLE: resource generation is closed')
            return skills.readFile(resourceId, expectedRevision, relativePath, session)
          },
          // A closed generation opens nothing: an empty list rather than a throw inside the fence.
          readRoots: () => (closed ? [] : (skills.readRoots?.() ?? [])),
          ...(skills.runInWorkspace
            ? {
                runInWorkspace: <T>(sessionKey: string, invoke: () => Promise<T>) => {
                  if (closed)
                    throw new Error('E_RESOURCE_GENERATION_UNAVAILABLE: resource generation is closed')
                  return skills.runInWorkspace?.(sessionKey, invoke) as Promise<T>
                },
              }
            : {}),
        }),
      })
      return resources
    },
  })
}
