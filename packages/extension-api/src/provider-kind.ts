/** A provider kind describes registration, not the operations of its providers. */
export interface ProviderIdentity {
  readonly id: string
  readonly version: string
}

export interface ProviderSelection {
  provider: string
  /** Optional except when more than one version of a versioned kind is installed. */
  version?: string
}

export interface ProviderKind<T extends ProviderIdentity> {
  readonly kind: string
  readonly restartRequired: boolean
  readonly versioned?: boolean
  readonly validate: (provider: T) => void
  readonly capabilities?: (provider: T) => readonly string[]
}

export function defineProviderKind<T extends ProviderIdentity>(
  definition: Omit<ProviderKind<T>, 'restartRequired'> & { restartRequired?: boolean },
): ProviderKind<T> {
  if (
    !/^[a-z][a-z0-9-]*$/.test(definition.kind) ||
    typeof definition.validate !== 'function' ||
    (definition.restartRequired !== undefined && typeof definition.restartRequired !== 'boolean') ||
    (definition.versioned !== undefined && typeof definition.versioned !== 'boolean')
  )
    throw new Error('Provider kind requires a name and a validator')
  return Object.freeze({ ...definition, restartRequired: definition.restartRequired ?? false })
}

/** Read-only metadata. Active means selected in the reported configuration, not session liveness. */
export interface ProviderCatalogEntry extends ProviderIdentity {
  readonly kind: string
  readonly sourcePackage: string
  readonly capabilities: readonly string[]
  readonly restartRequired: boolean
  readonly active: boolean
  readonly selectedFor: readonly string[]
}

export interface ProvidersCatalogPort {
  catalog(): readonly ProviderCatalogEntry[]
}

/** The same author entry point for every kind; named services remain compatibility facades. */
export interface ProviderRegistrationPort extends ProvidersCatalogPort {
  register<T extends ProviderIdentity>(
    kind: string | ProviderKind<T>,
    sourcePackage: string,
    provider: T,
  ): () => void | Promise<void>
  resolve<T extends ProviderIdentity>(kind: ProviderKind<T>, selection: string | ProviderSelection): T
}

export interface ProviderPluginContext {
  providers: ProviderRegistrationPort
}
