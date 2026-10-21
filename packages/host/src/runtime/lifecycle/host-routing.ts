import type { Kernel } from '@agnes/core'
import type { Host } from './host.js'

/** Every new Host member needs an ownership decision before it can be exposed by a facade. */
export const HOST_MEMBER_SCOPES = {
  systemPromptPreview: 'deployment',
  securityStatus: 'deployment',
  compositionSessions: 'deployment',
  resolveAgent: 'deployment',
  sessionBundleCatalog: 'deployment',
  executionIdentity: 'session',
  sessionCapabilities: 'session',
  pluginGenerationStatus: 'deployment',
  pluginGenerationStatusAsync: 'deployment',
  sessionGeneration: 'session',
  lastChange: 'deployment',
  containerHandle: 'deployment',
  sessionBinding: 'session',
  readSessionRows: 'session',
  readSessionView: 'session',
  sessionRuntime: 'session',
  releaseSessionGeneration: 'session',
  migrateSessionGeneration: 'session',
  compositionPublicationStatus: 'deployment',
  reloadPlugin: 'deployment',
  collectPluginGenerations: 'deployment',
  runtimeTargetSnapshot: 'deployment',
  runtimeSkillCandidates: 'deployment',
  activationBarrier: 'deployment',
  approvalGrants: 'deployment',
  profileServices: 'deployment',
  resolveService: 'session',
  callService: 'session',
  inspectService: 'session',
  authorizeServiceControl: 'session',
  applyModelProfile: 'deployment',
  prewarmDefaultComposition: 'deployment',
  profile: 'deployment',
  kernel: 'session',
  provider: 'deployment',
  providerFingerprint: 'deployment',
  modelAdapterCatalog: 'deployment',
  memory: 'session',
  providers: 'deployment',
  seamBindings: 'deployment',
  runtimes: 'deployment',
  lockedPackageMutations: 'deployment',
  computerUse: 'session',
  presets: 'deployment',
  resolveActor: 'deployment',
  acceptWorkspaceBinding: 'deployment',
  createSession: 'session',
  setSessionPreset: 'session',
  extensions: 'deployment',
  reloadEcosystemExtension: 'deployment',
  refreshSkillRow: 'deployment',
  ordinaryConvergence: 'deployment',
  applyRuntimeTarget: 'deployment',
  extensionRows: 'deployment',
  close: 'deployment',
  validatePresetSwitch: 'session',
  validateModelSwitch: 'session',
} as const satisfies Record<keyof Host, 'session' | 'deployment'>

type SessionMember = {
  [K in keyof Host]-?: (typeof HOST_MEMBER_SCOPES)[K] extends 'session' ? K : never
}[keyof Host]
export type HostSessionRoutes = { [K in SessionMember]: Host[K] }
export type HostFacadeOverrides = HostSessionRoutes & {
  [K in Exclude<keyof Host, SessionMember>]?: Host[K]
}

const KERNEL_MEMBER_SCOPES = {
  toolRuntimes: 'deployment',
  toolPolicies: 'deployment',
  loopEvents: 'deployment',
  loops: 'deployment',
  tools: 'deployment',
  sessions: 'session',
  clock: 'deployment',
  ids: 'deployment',
  hooks: 'deployment',
  invariants: 'deployment',
  projections: 'deployment',
  slots: 'deployment',
  resources: 'deployment',
  o: 'deployment',
  get: 'session',
  session: 'session',
  invalidateSeams: 'deployment',
  registrations: 'deployment',
  close: 'deployment',
} as const satisfies Record<keyof Kernel, 'session' | 'deployment'>

/** Missing JS properties (including `then`) remain missing; actual unclassified ports fail closed. */
export function memberScope(
  scopes: Readonly<Record<string, string>>,
  property: string | symbol,
  ...targets: object[]
): string | undefined {
  if (typeof property === 'string' && Object.hasOwn(scopes, property)) return scopes[property]
  if (targets.some((target) => property in target))
    throw new Error(`E_HOST_UNCLASSIFIED: ${String(property)} needs an explicit ownership route`)
  return undefined
}

/** Kernel session entry points use the same binding owner as the Host ports, never the head. */
export function createKernelFacade(
  base: Kernel,
  current: () => Kernel,
  owner: (key: string, coldRead?: boolean) => Kernel,
  sessions: Kernel['sessions'],
): Kernel {
  return new Proxy(base, {
    get(_target, property) {
      const scope = memberScope(KERNEL_MEMBER_SCOPES, property, base, current())
      if (!scope) return undefined
      if (property === 'sessions') return sessions
      const target = current(),
        value = Reflect.get(target, property, target),
        baseValue = target === base ? value : Reflect.get(base, property, base)
      // Facade instrumentation replaces base; retain its observed method even after publication.
      // A different binding/deployment still selects that receiver's own implementation.
      const call = (receiver: Kernel, args: unknown[]) =>
        Reflect.apply(
          receiver === target
            ? value
            : receiver === base
              ? baseValue
              : Reflect.get(receiver, property, receiver),
          receiver,
          args,
        )
      if (property === 'get') return (key: string) => call(owner(key, true), [key])
      if (property === 'session')
        return (...args: Parameters<Kernel['session']>) => call(owner(args[0]), args)
      if (scope === 'session') throw new Error(`E_HOST_SESSION_ROUTE: ${String(property)}`)
      return typeof value === 'function' ? (...args: unknown[]) => call(current(), args) : value
    },
  })
}

/** The aggregate view does not change which binding owns a deletion. */
export function createSessionMapFacade(
  base: Kernel['sessions'],
  owner: (key: string) => Kernel['sessions'],
  maps: () => readonly Kernel['sessions'][],
): Kernel['sessions'] {
  return new Proxy(base, {
    get(_target, property) {
      if (property === 'delete') return (key: string) => owner(key).delete(key)
      const all = new Map(maps().flatMap((map) => [...map]))
      const value = Reflect.get(all, property, all)
      return typeof value === 'function' ? value.bind(all) : value
    },
  })
}
