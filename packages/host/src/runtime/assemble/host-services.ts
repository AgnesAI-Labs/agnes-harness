import { dirname } from 'node:path'
import type { Kernel, SeamImplementations } from '@agnes/core'
import { serviceContext } from '@agnes/host-extensions/ext-host/service-context'
import { serviceInvoker } from '@agnes/host-extensions/ext-host/service-invocation'
import { createProfileServiceRuntime } from '@agnes/host-extensions/profile/runtime'
import { createConfigurationService } from '@agnes/host-infrastructure/configuration'
import type { AssemblyContext } from './context.js'
import type { ExtensionHost } from './extension-host.js'
import type { ProcessServices } from './process-services.js'
import { authorizeServiceProcess } from './service-process-policy.js'

/** The extension service call surface and the session configuration service the Host exposes. */
export function createHostServices(
  ctx: AssemblyContext,
  input: Readonly<{
    proc: ProcessServices
    kernel: Kernel
    host: ExtensionHost
    seams: SeamImplementations
    publishProfileCurrent: () => void
  }>,
) {
  const { deps } = ctx
  const { kernel, proc, host } = input
  const { adapters } = proc
  const { services } = host
  const { seams } = input
  const servicesInvocation = serviceInvoker({
    authorize: async (entry, params, actor, workspace, signal) => {
      if (
        entry.capability.name === 'jobs.control' &&
        params.input &&
        typeof params.input === 'object' &&
        !Array.isArray(params.input) &&
        ['open', 'run', 'send'].includes(String(params.input.operation))
      )
        await authorizeServiceProcess(
          kernel.get(params.sessionId),
          {
            actor,
            session: {
              key: params.sessionId,
              lane: 'main',
              workspaceRoot: workspace.root,
              turn: 0,
              step: 0,
            },
            requestId: params.commandId ?? 'inspection',
            signal,
          },
          workspace.root,
        )
    },
    registry: services,
    ...(deps.serviceAuthority ? { authority: deps.serviceAuthority } : {}),
    principals: seams.principals,
    audit: deps.audit,
    signal: ctx.abort.signal,
    context: serviceContext({
      workspaceInvocationFor: ctx.workspaceInvocationFor,
      authorizeProcess: (identity, cwd) =>
        authorizeServiceProcess(kernel.get(identity.session?.key ?? ''), identity, cwd),
      seams,
      networkAllow: Object.freeze([...adapters.fs.fence().networkAllow]),
      log: deps.log,
    }),
  })
  const profileServices = createProfileServiceRuntime({
    streams: proc.profileStreams,
    managed: proc.profileManaged,
    barrier: ctx.activationBarrier,
    journalKey: `${ctx.dataDir}/profile:${ctx.profile.name}`,
    publishCurrent: input.publishProfileCurrent,
    ...(deps.decisionsChanged ? { decisionsChanged: deps.decisionsChanged } : {}),
    wakes: proc.profileWakes,
    profileId: ctx.profile.name,
    registry: services,
    activations: proc.profileActivations,
    storage: adapters.storage,
    metadata: adapters.storage.metadata,
    seams,
    log: deps.log,
    ...(deps.serviceAuthority ? { authority: deps.serviceAuthority } : {}),
    clock: ctx.clock,
    signal: ctx.abort.signal,
    networkAllow: Object.freeze([...adapters.fs.fence().networkAllow]),
    audit: (detail) => deps.audit.write({ kind: 'extension.profile-call', detail }),
  })
  ctx.rollback.push('profile-services', () => profileServices.close())
  const sessionConfiguration = createConfigurationService({
    home: deps.homeDir ?? dirname(dirname(deps.profileDir)),
    profile: ctx.profile.name,
    profileDir: deps.profileDir,
  })
  return { servicesInvocation, sessionConfiguration, profileServices }
}
