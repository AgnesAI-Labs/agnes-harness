import { type CurrentSessionRuntime, type RegisteredTool, type SessionImpl, ToolRegistry } from '@agnes/core'
import { bindMountedConfiguration, readMountedConfiguration } from '../mounted-attestation.js'

/** Host-owned mounting policy. Disabled definitions remain available to Native sessions. */
export const JEV_TOOL_MOUNT = Object.freeze({
  id: 'agnes-jev-basic-tools-v1',
  names: Object.freeze(['read', 'ls', 'grep', 'edit', 'write', 'shell']),
})
const baselines = new WeakMap<SessionImpl, () => ToolRegistry>()

/** Common installed definitions for comparison attestation, never an execution registry. */
export function jevToolMountBaseline(session: SessionImpl): ToolRegistry | undefined {
  return baselines.get(session)?.()
}

/** Install before opening the loop: every lookup, including nested dispatch, sees this registry. */
export function mountJevTools(session: SessionImpl): void {
  const lookup = session.d.currentRuntime
  baselines.set(session, () => lookup?.current(session.key)?.tools ?? session.d.registry)
  let fallback: CurrentSessionRuntime | undefined
  const fallbackView = (): CurrentSessionRuntime => {
    // Resolve the actual Core fallback, not a possibly revoked published scope. This synchronous
    // read also follows later fallback hook assignments without adding a public Core capability.
    const installed = session.d.currentRuntime
    delete session.d.currentRuntime
    try {
      const hooks = session.hooks
      const resources = session.currentResources()
      const runtimePromptPreloader = session.d.runtimePromptPreloader
      if (
        fallback &&
        fallback.hooks === hooks &&
        fallback.resources === resources &&
        fallback.runtimePromptPreloader === runtimePromptPreloader
      )
        return fallback
      fallback = {
        tools: session.d.registry,
        hooks,
        resources,
        ...(runtimePromptPreloader ? { runtimePromptPreloader } : {}),
      }
      return fallback
    } finally {
      if (installed) session.d.currentRuntime = installed
      else delete session.d.currentRuntime
    }
  }
  let priorDefinitions: readonly RegisteredTool[] = []
  let mountedTools = new ToolRegistry()
  let priorSource: CurrentSessionRuntime | undefined
  let mounted: CurrentSessionRuntime | undefined
  session.d.currentRuntime = {
    current(key) {
      if (key !== session.key) return lookup?.current(key)
      const source = lookup?.current(key) ?? fallbackView()
      const definitions = JEV_TOOL_MOUNT.names.flatMap((name) => {
        const definition = source.tools.resolve(name)
        return definition ? [definition] : []
      })
      // Registry schema hashes do not identify executable wrappers. An owner can reload with
      // unchanged schemas, so compare the actual attested registrations instead.
      if (
        !(
          definitions.length === priorDefinitions.length &&
          definitions.every((definition, index) => definition === priorDefinitions[index])
        )
      ) {
        mountedTools = new ToolRegistry()
        for (const definition of definitions) {
          mountedTools.add(definition, {
            ...definition.source,
            executionDomain: definition.executionDomain,
            ...(definition.packageIdentity === undefined
              ? {}
              : { packageIdentity: definition.packageIdentity }),
            ...(definition.packageVersion === undefined ? {} : { packageVersion: definition.packageVersion }),
          })
        }
        priorDefinitions = definitions
      }
      if (
        mounted &&
        source === priorSource &&
        mounted.tools === mountedTools &&
        mounted.hooks === source.hooks &&
        mounted.resources === source.resources &&
        mounted.runtimePromptPreloader === source.runtimePromptPreloader
      )
        return mounted
      mounted = Object.freeze({ ...source, tools: mountedTools })
      bindMountedConfiguration(mounted, () => readMountedConfiguration(source))
      priorSource = source
      return mounted
    },
  }
  // Materialize the initial table now, rather than waiting for model request projection.
  session.currentTools()
}
