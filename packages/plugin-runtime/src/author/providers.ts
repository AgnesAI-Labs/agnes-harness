import {
  type ChildAgentProvider,
  type CompactionEngine,
  type KindMap,
  type PersistenceProvider,
  ProviderError,
  parseSemver,
  type SandboxProvider,
  type ToolPolicy,
  type ToolRuntimeProvider,
  definePersistenceProvider as validatePersistenceProvider,
} from '@agnes/extension-api'

/** Validate author declarations early; Host admission still validates the untrusted declaration. */
export function defineProvider<K extends keyof KindMap, P extends KindMap[NoInfer<K>]>(
  kind: K,
  provider: P,
): P {
  const methods: Record<keyof KindMap, readonly string[]> = {
    loop: ['create', 'resume'],
    'model-adapter': ['create'],
    compaction: ['create'],
    persistence: ['open'],
    sandbox: ['create'],
    'tool-runtime': ['create'],
    'tool-policy': ['decide'],
    'child-agent': ['start'],
  }
  const value = provider as unknown as Record<string, unknown>
  if (
    !value ||
    typeof value.id !== 'string' ||
    !value.id.trim() ||
    typeof value.version !== 'string' ||
    !parseSemver(value.version) ||
    methods[kind].some((method) => typeof value[method] !== 'function') ||
    (kind === 'model-adapter' &&
      (typeof (value.wireApi ?? value.api) !== 'string' ||
        !(value.wireApi ?? value.api) ||
        (value.wireApi !== undefined && value.api !== undefined && value.wireApi !== value.api)))
  )
    throw new ProviderError(
      'E_PROVIDER_INVALID',
      `Invalid ${kind} declaration; provide id, semver version and its operations`,
      { kind, operation: 'define', provider: typeof value?.id === 'string' ? value.id : undefined },
    )
  const capabilities = value.capabilities as Record<string, unknown> | undefined
  const flags =
    kind === 'model-adapter'
      ? ['imageInput', 'tools', 'streaming']
      : kind === 'child-agent'
        ? ['continuable', 'interrupt', 'modelSelection', 'inheritsParentContext', 'worktree']
        : kind === 'sandbox'
          ? ['available', 'network']
          : []
  if (
    (flags.length && (!capabilities || flags.some((flag) => typeof capabilities[flag] !== 'boolean'))) ||
    (kind === 'sandbox' &&
      (!Array.isArray(capabilities?.platform) || !Array.isArray(capabilities?.fsWrite))) ||
    (kind === 'loop' && (!Array.isArray(value.capabilities) || !value.codec))
  )
    throw new ProviderError('E_PROVIDER_INVALID', `Invalid ${kind} capabilities`, {
      kind,
      provider: provider.id,
      operation: 'define',
    })
  if (kind === 'persistence') validatePersistenceProvider(provider as PersistenceProvider)
  return provider
}
export function defineToolRuntime<P extends ToolRuntimeProvider>(provider: P): P {
  return defineProvider('tool-runtime', provider)
}
export function defineToolPolicy<P extends ToolPolicy>(provider: P): P {
  return defineProvider('tool-policy', provider)
}
export function defineCompactionEngine<P extends CompactionEngine>(provider: P): P {
  return defineProvider('compaction', provider)
}
export function defineSandboxProvider<P extends SandboxProvider>(provider: P): P {
  return defineProvider('sandbox', provider)
}
export function definePersistenceProvider<P extends PersistenceProvider>(provider: P): P {
  return defineProvider('persistence', provider)
}
export function defineChildAgentProvider<P extends ChildAgentProvider>(provider: P): P {
  return defineProvider('child-agent', provider)
}
