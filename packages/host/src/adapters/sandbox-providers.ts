import { type Context, Service } from '@agnes/cordis'
import {
  defineProviderKind,
  LOCAL_SANDBOX_PROVIDER_ID,
  type SandboxCapabilities,
  type SandboxPlatform,
  type SandboxProvider,
  type SandboxProviderCatalogEntry,
  type SandboxProviderConfig,
  type SandboxProviderInstance,
  type SandboxProviderRegistration,
  sandboxUnavailable,
} from '@agnes/extension-api'
import type { RowOriginLookup } from '@agnes/plugin-runtime/host'
import {
  installProviderRegistry,
  type ProviderRegistry,
  providerSource,
} from '../assemble/provider-registry.js'
import { HostError } from '../errors.js'
import type { ExecAdapter } from './exec.js'

export { LOCAL_SANDBOX_PROVIDER_ID }

declare module '@agnes/cordis' {
  interface Context {
    sandboxProviders: SandboxProviderRegistry
  }
}

const PROVIDER_ID = /^[a-z][a-z0-9-]{0,63}$/
const PLATFORMS = new Set<SandboxPlatform>(['darwin', 'linux', 'win32'])

type Registration = {
  id: string
  version: string
  provider: SandboxProvider
  entry: SandboxProviderCatalogEntry
  active: boolean
  instances: Set<() => Promise<void>>
}

export type SandboxProviderSlot = {
  registry?: SandboxProviderRegistry
  /** Chosen once. Later config edits do not move running commands. */
  selected?: SandboxProviderInstance
  options?: Readonly<Record<string, string>>
}

function freezeCapabilities(capabilities: SandboxCapabilities): SandboxCapabilities {
  return Object.freeze({
    network: capabilities.network,
    ...(capabilities.programmatic === undefined ? {} : { programmatic: capabilities.programmatic }),
    fsWrite: Object.freeze(capabilities.fsWrite.map((scope) => Object.freeze({ path: scope.path }))),
    platform: Object.freeze([...capabilities.platform]),
    available: capabilities.available,
    ...(capabilities.enforcement
      ? {
          enforcement: Object.freeze({
            level: capabilities.enforcement.level,
            scope: Object.freeze([...capabilities.enforcement.scope]),
          }),
        }
      : {}),
    ...(capabilities.unavailableReason === undefined
      ? {}
      : { unavailableReason: capabilities.unavailableReason }),
  })
}

function validCapabilities(capabilities: SandboxCapabilities | undefined): boolean {
  if (
    !capabilities ||
    typeof capabilities.network !== 'boolean' ||
    typeof capabilities.available !== 'boolean' ||
    (capabilities.programmatic !== undefined && typeof capabilities.programmatic !== 'boolean')
  )
    return false
  const enforcement = capabilities.enforcement
  if (
    enforcement &&
    (!['none', 'partial', 'full'].includes(enforcement.level) ||
      !Array.isArray(enforcement.scope) ||
      enforcement.scope.some((scope) => !['file', 'network', 'process'].includes(scope)))
  )
    return false
  if (!Array.isArray(capabilities.platform) || !Array.isArray(capabilities.fsWrite)) return false
  if (capabilities.platform.some((platform) => !PLATFORMS.has(platform))) return false
  return capabilities.fsWrite.every((scope) => typeof scope?.path === 'string' && scope.path.length > 0)
}

/** Per-Cordis-root catalog. The selected id is fixed until the process starts again. */
export class SandboxProviderRegistry extends Service implements SandboxProviderRegistration {
  private readonly registrations: ProviderRegistry<SandboxProvider>
  private readonly records = new WeakMap<SandboxProvider, Registration>()
  private selection: { id: string; instance: SandboxProviderInstance } | undefined
  private selectedId: string | undefined
  private readonly workspaceInstances = new Map<string, Promise<SandboxProviderInstance>>()

  constructor(
    ctx: Context,
    private readonly origins?: RowOriginLookup,
  ) {
    super(ctx, 'sandboxProviders')
    this.registrations = installProviderRegistry(
      ctx,
      defineProviderKind<SandboxProvider>({
        kind: 'sandbox',
        restartRequired: true,
        validate(provider) {
          if (
            !PROVIDER_ID.test(provider.id) ||
            !provider.version ||
            typeof provider.create !== 'function' ||
            !validCapabilities(provider.capabilities)
          )
            throw new HostError('E_API_RANGE', 'invalid sandbox provider registration')
        },
        capabilities: (provider) => [
          ...(provider.capabilities.network ? ['network'] : []),
          ...provider.capabilities.fsWrite.map((scope) => `fsWrite:${scope.path}`),
          ...provider.capabilities.platform.map((platform) => `platform:${platform}`),
        ],
      }),
      (owner, source, provider) => owner.sandboxProviders.register(provider, source),
    )
  }

  register(provider: SandboxProvider, sourcePackage?: string): () => Promise<void> {
    this.registrations.definition.validate(provider)
    const record: Registration = {
      id: provider.id,
      version: provider.version,
      provider,
      entry: Object.freeze({
        id: provider.id,
        version: provider.version,
        sourcePackage: providerSource(
          this.ctx,
          this.origins,
          sourcePackage ?? '@agnes/host',
          sourcePackage !== undefined,
        ),
        capabilities: freezeCapabilities(provider.capabilities),
        restartRequired: true,
      }),
      active: true,
      instances: new Set(),
    }
    const unregister = this.registrations.register(
      record.entry.sourcePackage,
      provider,
      this.ctx,
      async () => {
        record.active = false
        // Drain constructors as well as active instances before provider-owned cleanup.
        await Promise.allSettled(
          [...this.workspaceInstances.entries()]
            .filter(([key]) => JSON.parse(key)[0] === record.id)
            .map(([, pending]) => pending),
        )
        const results = await Promise.allSettled([...record.instances].map((dispose) => dispose()))
        await provider.cleanup?.()
        const failures = results.filter((result) => result.status === 'rejected')
        if (failures.length)
          throw new AggregateError(
            failures.map((result) => result.reason),
            'sandbox provider cleanup failed',
          )
      },
    )
    this.records.set(provider, record)
    return unregister
  }

  catalog(): readonly SandboxProviderCatalogEntry[] {
    return Object.freeze(
      this.registrations
        .catalog()
        .map((record) => this.records.get(this.registrations.resolve(record.id))!.entry)
        .sort((a, b) => a.id.localeCompare(b.id)),
    )
  }

  selected(): SandboxProviderInstance | undefined {
    return this.selection?.instance
  }

  /**
   * Bind the startup id. Equal workspace/configuration keys share an instance.
   * Different workspaces or options create independent instances of that id.
   * A different id is refused until the process restarts.
   */
  async select(id: string, config: SandboxProviderConfig = {}): Promise<SandboxProviderInstance> {
    if (!PROVIDER_ID.test(id))
      throw new HostError('E_PROFILE_FRAGMENT_KEY', 'sandbox.provider must be a provider id', {
        detail: { field: 'sandbox.provider', id },
      })
    if (this.selectedId) {
      if (this.selectedId !== id)
        throw new HostError(
          'E_DEP_MISSING',
          `sandbox provider ${this.selectedId} is already selected; choosing ${id} requires a restart`,
          { detail: { reason: 'restart-required', selected: this.selectedId, id } },
        )
    }
    this.registrations.resolve(id)
    this.selectedId = id
    const key = JSON.stringify([
      id,
      config.workspaceRoot ?? null,
      Object.entries(config.options ?? {}).sort(([a], [b]) => a.localeCompare(b)),
    ])
    const existing = this.workspaceInstances.get(key)
    if (existing) return existing
    const pending = this.createInstance(id, config)
    this.workspaceInstances.set(key, pending)
    try {
      return await pending
    } catch (error) {
      this.workspaceInstances.delete(key)
      throw error
    }
  }

  private async createInstance(id: string, config: SandboxProviderConfig): Promise<SandboxProviderInstance> {
    const record = this.records.get(this.registrations.resolve(id))!
    this.registrations.select('process', id)
    const probed = (await record.provider.probe?.()) ?? record.provider.capabilities
    if (!validCapabilities(probed))
      throw new HostError('E_API_RANGE', `sandbox provider returned invalid capabilities: ${id}`)
    record.entry = Object.freeze({
      ...record.entry,
      capabilities: freezeCapabilities(probed),
    })
    const instance = await record.provider.create(config)
    if (
      !instance ||
      instance.id !== id ||
      typeof instance.exec !== 'function' ||
      typeof instance.dispose !== 'function' ||
      !validCapabilities(instance.capabilities)
    )
      throw new HostError('E_API_RANGE', `sandbox provider returned an invalid instance: ${id}`)
    let disposal: Promise<void> | undefined
    const dispose = () => {
      disposal ??= Promise.resolve()
        .then(() => instance.dispose())
        .then(() => undefined)
        .finally(() => record.instances.delete(dispose))
      return disposal
    }
    if (!record.active) {
      await dispose()
      throw new HostError('E_DEP_MISSING', `sandbox provider was unloaded: ${id}`)
    }
    record.instances.add(dispose)
    const bound = Object.freeze({
      id: instance.id,
      capabilities: freezeCapabilities(instance.capabilities),
      exec: (request: Parameters<SandboxProviderInstance['exec']>[0]) => {
        if (disposal || !record.active)
          return Promise.reject(sandboxUnavailable('the workspace sandbox instance is disposed'))
        return instance.exec(request)
      },
      dispose,
    })
    this.selection = { id, instance: bound }
    this.registrations.select('process', id)
    return bound
  }
}

export function installSandboxProviders(root: Context, origins?: RowOriginLookup): SandboxProviderRegistry {
  return new SandboxProviderRegistry(root, origins)
}

/** Read-only admin view. It does not contain factories or credentials. */
export function sandboxProviderCatalog(root: Context): readonly SandboxProviderCatalogEntry[] {
  return root.sandboxProviders.catalog()
}

/** Profile field `sandbox: { provider }`. An omitted provider means the local host sandbox. */
export function readSandboxStartupConfig(
  value: unknown,
): Readonly<{ provider: string; options?: Readonly<Record<string, string>> }> | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    throw new HostError('E_PROFILE_FRAGMENT_KEY', 'sandbox must be a mapping', {
      detail: { field: 'sandbox' },
    })
  const record = value as Record<string, unknown>
  for (const key of Object.keys(record)) {
    if (key !== 'provider' && key !== 'options')
      throw new HostError('E_PROFILE_FRAGMENT_KEY', `sandbox.${key} is not a startup field`, {
        detail: { field: `sandbox.${key}` },
      })
  }
  if (
    record.options !== undefined &&
    (record.options === null ||
      typeof record.options !== 'object' ||
      Array.isArray(record.options) ||
      Object.values(record.options).some((value) => typeof value !== 'string'))
  )
    throw new HostError('E_PROFILE_FRAGMENT_KEY', 'sandbox.options must be a mapping of strings')
  if (record.provider === undefined && record.options === undefined) return undefined
  const provider = record.provider ?? LOCAL_SANDBOX_PROVIDER_ID
  if (typeof provider !== 'string' || !PROVIDER_ID.test(provider))
    throw new HostError('E_PROFILE_FRAGMENT_KEY', 'sandbox.provider must be a provider id', {
      detail: { field: 'sandbox.provider' },
    })
  return Object.freeze({
    provider,
    ...(record.options ? { options: Object.freeze({ ...(record.options as Record<string, string>) }) } : {}),
  })
}

export function sandboxProviderIdFrom(
  config: { sandbox?: { provider?: string; options?: Readonly<Record<string, string>> } } | undefined,
): string {
  const id = config?.sandbox?.provider
  return id === undefined || id === '' ? LOCAL_SANDBOX_PROVIDER_ID : id
}

/**
 * Select the profile's provider the first time a workspace is fitted.
 * Remote execution keeps the remote runner. A missing provider is not replaced
 * with the local one.
 */
export async function bindStartupSandboxProvider(
  slot: SandboxProviderSlot,
  config: { sandbox?: { provider?: string; options?: Readonly<Record<string, string>> } } | undefined,
  workspaceRoot: string,
  remote: boolean,
): Promise<string> {
  const id = sandboxProviderIdFrom(config)
  if (remote && id !== LOCAL_SANDBOX_PROVIDER_ID)
    throw new HostError('E_DEP_MISSING', 'a remote workspace cannot select another sandbox provider', {
      detail: { reason: 'remote-provider', id },
    })
  if (!slot.registry) {
    if (id !== LOCAL_SANDBOX_PROVIDER_ID)
      throw new HostError('E_DEP_MISSING', `sandbox provider is not registered: ${id}`, {
        detail: { reason: 'provider-missing', id },
      })
    return LOCAL_SANDBOX_PROVIDER_ID
  }
  if (slot.selected) {
    if (slot.selected.id !== id)
      throw new HostError(
        'E_DEP_MISSING',
        `sandbox provider ${slot.selected.id} is already selected; choosing ${id} requires a restart`,
        { detail: { reason: 'restart-required', selected: slot.selected.id, id } },
      )
  }
  const instance = await slot.registry.select(id, {
    workspaceRoot,
    ...(config?.sandbox?.options ? { options: config.sandbox.options } : {}),
  })
  slot.selected = instance
  if (config?.sandbox?.options) slot.options = config.sandbox.options
  return instance.id
}

/**
 * Every local and third-party execution uses the selected public instance after
 * the policy gate. Resolve by the authorized workspace, never the last fitted cwd.
 * Missing policy or unavailable enforcement refuses execution.
 */
export function createSandboxDispatchExec(local: ExecAdapter, slot: SandboxProviderSlot): ExecAdapter {
  return {
    async run(argv, opts) {
      let selected = slot.selected
      if (!selected) throw sandboxUnavailable('no sandbox provider is bound to this workspace')
      if (slot.registry && opts.sandbox?.policy)
        selected = await slot.registry.select(selected.id, {
          workspaceRoot: opts.sandbox.policy.workspaceRoot,
          ...(slot.options ? { options: slot.options } : {}),
        })
      if (!selected.capabilities.available)
        throw sandboxUnavailable(selected.capabilities.unavailableReason ?? 'sandbox provider is unavailable')
      const named = opts.sandbox?.provider
      if (named !== undefined && named !== selected.id)
        throw sandboxUnavailable('the request names a different sandbox provider')
      const policy = opts.sandbox?.policy
      if (!policy) throw sandboxUnavailable('the request carries no authorized execution policy')
      opts.signal?.throwIfAborted()
      const required = policy.requiredEnforcement
      const offered =
        selected.id === LOCAL_SANDBOX_PROVIDER_ID
          ? opts.sandbox?.enforcement
          : selected.capabilities.enforcement
      if (
        required.level === 'full' &&
        (offered?.level !== 'full' || required.scope.some((scope) => !offered.scope.includes(scope)))
      )
        throw sandboxUnavailable('the provider cannot supply the required enforcement')
      if (opts.bridge && selected.capabilities.programmatic !== true)
        throw sandboxUnavailable('the selected provider does not support programmatic transport')
      const result = await selected.exec({
        argv,
        cwd: opts.cwd,
        policy,
        ...(opts.sandbox?.enforcement ? { enforcement: opts.sandbox.enforcement } : {}),
        ...(opts.env === undefined ? {} : { env: opts.env }),
        ...(opts.stdin === undefined ? {} : { stdin: opts.stdin }),
        ...(opts.bridge ? { bridge: opts.bridge } : {}),
        ...(opts.signal === undefined ? {} : { signal: opts.signal }),
        limits: {
          ...(opts.timeoutMs === undefined ? {} : { timeoutMs: opts.timeoutMs }),
          ...(opts.maxOutputBytes === undefined ? {} : { maxOutputBytes: opts.maxOutputBytes }),
        },
        fsWrite: Object.freeze(policy.fsWrite.allow.map((path) => Object.freeze({ path }))),
        network: policy.network.mode !== 'deny',
      })
      const actual = result.enforcement
      if (
        !actual ||
        (required.level === 'full' && actual.level !== 'full') ||
        required.scope.some((scope) => !actual.scope.includes(scope))
      )
        throw sandboxUnavailable('the provider did not report the required enforcement')
      return {
        code: result.code,
        stdout: result.stdout,
        stderr: result.stderr,
        truncated: result.truncated,
        timedOut: result.timedOut,
        ...(result.signal === undefined ? {} : { signal: result.signal }),
      }
    },
    async killAll() {
      await slot.selected?.dispose()
      await local.killAll()
    },
  }
}
