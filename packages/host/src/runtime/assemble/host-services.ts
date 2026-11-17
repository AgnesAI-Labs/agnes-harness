import { dirname } from 'node:path'
import type { Kernel, SeamImplementations } from '@agnes/core'
import { serviceContext } from '@agnes/host-extensions/ext-host/service-context'
import { serviceInvoker } from '@agnes/host-extensions/ext-host/service-invocation'
import {
  CHANNEL_PAIRING_OWNER,
  createChannelPairingApprovals,
} from '@agnes/host-extensions/profile/channel-pairing'
import { createProfileServiceRuntime } from '@agnes/host-extensions/profile/runtime'
import { createConfigurationService } from '@agnes/host-infrastructure/configuration'
import type { AssemblyContext } from './context.js'
import type { ExtensionHost } from './extension-host.js'
import type { ProcessServices } from './process-services.js'
import type { RefinementHost } from './refinement.js'
import { authorizeServiceProcess } from './service-process-policy.js'

const LOCAL_OWNER = Object.freeze({ kind: 'local' })
const channelRegistries = new Map<
  string,
  Set<import('@agnes/host-extensions/ext-host/services').ServiceRegistry>
>()

/** The extension service call surface and the session configuration service the Host exposes. */
export function createHostServices(
  ctx: AssemblyContext,
  input: Readonly<{
    proc: ProcessServices
    kernel: Kernel
    host: ExtensionHost
    seams: SeamImplementations
    publishProfileCurrent: () => void
    refinement: RefinementHost
  }>,
) {
  const { deps } = ctx
  const { kernel, proc, host } = input
  const { adapters } = proc
  const { services } = host
  const { seams } = input
  const key = `${ctx.dataDir}/profile:${ctx.profile.name}`
  const registries = channelRegistries.get(key) ?? new Set()
  channelRegistries.set(key, registries)
  registries.add(services)
  ctx.rollback.push('channel-services', () => {
    registries.delete(services)
    if (!registries.size) channelRegistries.delete(key)
  })
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
    registry: {
      resolve(owner, name) {
        if (!['channel.session', 'channel.bind', 'channel.unbind'].includes(name))
          return services.resolve(owner, name)
        // Channel connections are profile singletons. Pinned sessions supply the workspace and
        // authenticated caller, but must not resurrect a retired channel service registration.
        for (const registry of registries) {
          const entry = registry.resolve(owner, name)
          if (!entry) continue
          try {
            proc.profileActivations.require(owner, entry.integrity, undefined, entry.activationRevision)
            return entry
          } catch {
            /* Only the current publication can handle a channel binding. */
          }
        }
        return undefined
      },
    },
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
  // Pairing codes are asked of the local owner too, in the same profile decision journal.
  const channelPairing = createChannelPairingApprovals({
    targets: proc.channelTargets,
    decisions: () => profileServices.hostDecisions(LOCAL_OWNER),
    clock: ctx.clock,
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
    hostOwners: new Map([...input.refinement.decisionOwners, [CHANNEL_PAIRING_OWNER, channelPairing.owner]]),
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
  // Saves of task experience under ask are asked of the local owner, who lists and answers profile
  // decisions through the same credential.
  input.refinement.bindDecisions(() => profileServices.hostDecisions(LOCAL_OWNER))
  const sessionConfiguration = createConfigurationService({
    home: deps.homeDir ?? dirname(dirname(deps.profileDir)),
    profile: ctx.profile.name,
    profileDir: deps.profileDir,
  })
  return { servicesInvocation, sessionConfiguration, profileServices, pairing: channelPairing }
}
