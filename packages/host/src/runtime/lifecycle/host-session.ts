import type { Kernel } from '@agnes/core'

// core does not export a type named `Session`; it exports SessionImpl and SessionLogImpl. Taking the
// return type instead of pinning a name means a rename over there is not a break over here.
export type HostSession = Awaited<ReturnType<Kernel['session']>> & {
  /** Host-private policy snapshot for local author-code execution; never plugin arguments. */
  readonly commandSandboxPolicy?: () => {
    policy: import('@agnes/core').FsPolicy
    network: 'allow' | 'deny'
    local: boolean
    allowsUnconfined?: boolean
  }
  readonly hasActiveProcesses?: () => boolean
  readonly intelligentUi?: Pick<
    import('@agnes/intelligent-ui-contract').IntelligentUiInstance,
    'action' | 'read' | 'refresh'
  >
  readonly pluginGenerationId?: string
  readonly referenceResolvers?: import('@agnes/extension-api').ReferenceResolverPort
  readonly referenceSessions?: import('@agnes/extension-api').ReferenceContext['sessions']
  readonly referenceLimits?: import('@agnes/extension-api').ReferenceLimits
}
