import {
  type ChildAgentProvider,
  type CompactionEngine,
  childAgentKind,
  compactionKind,
  type PersistenceProvider,
  ProviderError,
  type ProviderIdentity,
  type ProviderKind,
  parseSemver,
  persistenceKind,
  type SandboxProvider,
  sandboxKind,
  type ToolPolicy,
  type ToolRuntimeProvider,
  toolPolicyKind,
  toolRuntimeKind,
} from '@agnes/extension-api'

/** Validate author declarations early; Host admission validates the untrusted declaration again. */
export function defineProvider<T extends ProviderIdentity, P extends T>(
  kind: ProviderKind<T>,
  provider: P,
): P {
  const id = (provider as { id?: unknown } | undefined)?.id
  const fail = (message: string, cause?: unknown) =>
    new ProviderError('E_PROVIDER_INVALID', message, {
      kind: kind.kind,
      operation: 'define',
      provider: typeof id === 'string' ? id : undefined,
      ...(cause === undefined ? {} : { cause }),
    })
  if (
    typeof id !== 'string' ||
    !id.trim() ||
    typeof provider.version !== 'string' ||
    !parseSemver(provider.version)
  )
    throw fail(`Invalid ${kind.kind} declaration; provide id, semver version and its operations`)
  try {
    kind.validate(provider)
  } catch (cause) {
    throw fail(`Invalid ${kind.kind} declaration; provide id, semver version and its operations`, cause)
  }
  return provider
}
export function defineToolRuntime<P extends ToolRuntimeProvider>(provider: P): P {
  return defineProvider(toolRuntimeKind, provider)
}
export function defineToolPolicy<P extends ToolPolicy>(provider: P): P {
  return defineProvider(toolPolicyKind, provider)
}
export function defineCompactionEngine<P extends CompactionEngine>(provider: P): P {
  return defineProvider(compactionKind, provider)
}
export function defineSandboxProvider<P extends SandboxProvider>(provider: P): P {
  return defineProvider(sandboxKind, provider)
}
export function definePersistenceProvider<P extends PersistenceProvider>(provider: P): P {
  return defineProvider(persistenceKind, provider)
}
export function defineChildAgentProvider<P extends ChildAgentProvider>(provider: P): P {
  return defineProvider(childAgentKind, provider)
}
