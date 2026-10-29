import { dirname } from 'node:path'
import type { Kernel } from '@agnes/core'
import { createTrajectoryLifecycle } from '@agnes/host-artifacts/trajectory-lifecycle'
import { assertCompositionCompatible } from '@agnes/host-common/profile/composition'
import { capabilityEnabled } from '../profile/session-capabilities.js'
import { startObservabilityFeed } from '../services/observability-feed.js'
import { createSessionTasks } from '../sessions/session-tasks.js'
import type { createCapabilities } from './capabilities.js'
import type { AssemblyContext } from './context.js'
import type { createEcosystemContexts } from './ecosystem-context.js'
import type { createKernel } from './kernel-stage.js'
import type { RuntimeTargetHost } from './runtime-target.js'

/**
 * Once the kernel exists: the observability feed, the composition tool-call policy and the
 * privacy trajectory lifecycle the `agnes/privacy` extension is given.
 */
export async function startKernelHooks(
  ctx: AssemblyContext,
  input: Readonly<{
    kernel: Kernel
    kernelStage: Awaited<ReturnType<typeof createKernel>>
    capabilities: ReturnType<typeof createCapabilities>
    ecosystem: ReturnType<typeof createEcosystemContexts>
    runtimeTarget: RuntimeTargetHost
  }>,
) {
  const { deps, rollback, env, workspaceInvocationFor } = ctx
  const { publicationDispatch } = ctx.gates
  const { kernel, kernelStage, capabilities, ecosystem, runtimeTarget } = input
  const { extensionSessions, compositionLease } = kernelStage
  const { compositionForPreset, sessionCapabilities } = capabilities
  const dataDir = ctx.dataDir
  const home = deps.homeDir ?? dirname(dirname(deps.profileDir))
  const observabilityHost = runtimeTarget.extensionServices.current
  const observabilityFeed = observabilityHost
    ? await startObservabilityFeed({
        providers: runtimeTarget.pluginTree.root.providers,
        host: observabilityHost,
        home,
        kernel,
        profileHash: ctx.profile.hash,
        dataDir,
        profileDir: deps.profileDir,
        ...(ctx.profile.adapters.secrets.path ? { secretsDir: ctx.profile.adapters.secrets.path } : {}),
        ...(deps.sessionGeneration ? { sessionGeneration: deps.sessionGeneration } : {}),
      })
    : undefined
  const observability = observabilityFeed?.observability
  const observeSession = observabilityFeed?.observeSession ?? (() => () => undefined)
  if (observabilityFeed?.stop) rollback.push('observability-hooks', observabilityFeed.stop)
  if (ctx.profile.composition) {
    assertCompositionCompatible(compositionForPreset(), compositionForPreset(ctx.profile.presets.default))
    const stopPolicy = kernel.hooks.on(
      'tool_call',
      (payload, context) => {
        const session = kernel.sessions.get(context.session.key)
        if (!session) return { allow: false, reason: 'Composition session is unavailable.' }
        const args =
          payload.args && typeof payload.args === 'object' && !Array.isArray(payload.args) ? payload.args : {}
        const mcpServer =
          ['list_mcp_resources', 'list_mcp_resource_templates', 'read_mcp_resource'].includes(payload.name) &&
          typeof args.server === 'string'
            ? args.server
            : undefined
        const capabilities = sessionCapabilities(session.key, undefined, {
          name: payload.name,
          readOnly: payload.meta.isReadOnly === true,
          ...(mcpServer ? { mcpServer } : {}),
        })
        return capabilityEnabled(capabilities.tools, payload.name) &&
          capabilities.resourceRequest?.enabled !== false
          ? { allow: true }
          : { allow: false, reason: 'Tool denied by the selected composition policy.' }
      },
      { source: 'agnes/composition', trust: 'builtin', hookRank: 0 },
    )
    rollback.push('composition-policy', () => {
      stopPolicy()
      compositionLease?.revoke('host closed')
    })
  }
  ecosystem.sessionTasks.current = createSessionTasks((ref) => extensionSessions.resolve(ref))
  ecosystem.privacyTrajectory.current = createTrajectoryLifecycle(
    {
      ...deps,
      env,
      resolve: (ref) => extensionSessions.resolve(ref),
    },
    workspaceInvocationFor,
    publicationDispatch,
  )
  return { observability, observeSession }
}
