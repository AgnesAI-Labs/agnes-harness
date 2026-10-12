import { dirname } from 'node:path'
import type { Kernel } from '@agnes/core'
import { serviceContext } from '@agnes/host-extensions/ext-host/service-context'
import { serviceInvoker } from '@agnes/host-extensions/ext-host/service-invocation'
import { createConfigurationService } from '@agnes/host-infrastructure/configuration'
import type { AssemblyContext } from './context.js'
import type { ExtensionHost } from './extension-host.js'
import type { ProcessServices } from './process-services.js'
import { authorizeServiceProcess } from './service-process-policy.js'

/** The extension service call surface and the session configuration service the Host exposes. */
export function createHostServices(
  ctx: AssemblyContext,
  input: Readonly<{ proc: ProcessServices; kernel: Kernel; host: ExtensionHost }>,
) {
  const { deps } = ctx
  const { kernel, proc, host } = input
  const { adapters } = proc
  const { services } = host
  const seams = ctx.live.seams.get()
  const servicesInvocation = serviceInvoker({
    authorize: async (entry, params, actor, workspace, signal) => {
      if (
        entry.owner === 'agnes/jobs-web' &&
        entry.capability.name === 'jobs.control' &&
        params.input &&
        typeof params.input === 'object' &&
        !Array.isArray(params.input) &&
        ['open', 'send'].includes(String(params.input.operation))
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
      authorizeProcess: (identity, cwd) =>
        authorizeServiceProcess(kernel.get(identity.session?.key ?? ''), identity, cwd),
      seams,
      networkAllow: Object.freeze([...adapters.fs.fence().networkAllow]),
      log: deps.log,
    }),
  })
  const sessionConfiguration = createConfigurationService({
    home: deps.homeDir ?? dirname(dirname(deps.profileDir)),
    profile: ctx.profile.name,
    profileDir: deps.profileDir,
  })
  return { servicesInvocation, sessionConfiguration }
}
