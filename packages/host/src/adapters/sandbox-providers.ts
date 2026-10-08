import { type Context, Service } from '@agnes/cordis'
import {
  defineProviderKind,
  LOCAL_SANDBOX_PROVIDER_ID,
  ProviderError,
  type SandboxCapabilities,
  type SandboxPlatform,
  type SandboxProvider,
  type SandboxProviderCatalogEntry,
  type SandboxProviderConfig,
  type SandboxProviderInstance,
  type SandboxProviderRegistration,
  sandboxUnavailable,
} from '@agnes/extension-api'
import { PROVIDER_ID, sandboxProviderIdFrom } from '@agnes/host-common/profile/sandbox-startup'
import type { RowOriginLookup } from '@agnes/plugin-runtime/host'
import { ProviderLifetime } from '../assemble/provider-lifetime.js'
import {
  installProviderRegistry,
  type ProviderRegistry,
  providerSource,
} from '../assemble/provider-registry.js'
import type { ExecAdapter } from './exec.js'

export { readSandboxStartupConfig, sandboxProviderIdFrom } from '@agnes/host-common/profile/sandbox-startup'
export { LOCAL_SANDBOX_PROVIDER_ID }

declare module '@agnes/cordis' {
  interface Context {
    sandboxProviders: SandboxProviderRegistry
  }
}

const PLATFORMS = new Set<SandboxPlatform>(['darwin', 'linux', 'win32'])

type Registration = {
  id: string
  version: string
  provider: SandboxProvider
  entry: SandboxProviderCatalogEntry
  lifetime: ProviderLifetime
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
            throw new TypeError('invalid sandbox provider registration')
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
    this.registrations.validate(sourcePackage ?? '@agnes/host', provider)
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
      lifetime: new ProviderLifetime('sandbox', provider.id),
    }
    const wrapped: SandboxProvider = {
      ...provider,
      probe: (signal) =>
        record.lifetime.run((joined) => provider.probe?.(joined) ?? provider.capabilities, signal),
      create: (config, signal) =>
        record.lifetime.run(
          async (joined) => this.ownInstance(record, await provider.create(config, joined), joined),
          signal,
        ),
    }
    const unregister = this.registrations.register(record.entry.sourcePackage, wrapped, this.ctx, () =>
      record.lifetime.close(() => provider.cleanup?.()),
    )
    this.records.set(wrapped, record)
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
  async select(
    id: string,
    config: SandboxProviderConfig = {},
    signal?: AbortSignal,
  ): Promise<SandboxProviderInstance> {
    signal?.throwIfAborted()
    if (!PROVIDER_ID.test(id))
      throw new ProviderError('E_PROVIDER_INVALID', 'sandbox.provider must be a provider id', {
        kind: 'sandbox',
        provider: id,
        operation: 'select',
      })
    if (this.selectedId) {
      if (this.selectedId !== id)
        throw new ProviderError(
          'E_PROVIDER_INCOMPATIBLE',
          `sandbox provider ${this.selectedId} is already selected; choosing ${id} requires a restart`,
          {
            kind: 'sandbox',
            provider: id,
            operation: 'select',
            hint: 'Restart the process to change providers',
          },
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
    if (existing) {
      const instance = await existing
      signal?.throwIfAborted()
      return instance
    }
    const pending = this.createInstance(id, config, signal)
    this.workspaceInstances.set(key, pending)
    try {
      return await pending
    } catch (error) {
      this.workspaceInstances.delete(key)
      throw error
    }
  }

  private async createInstance(
    id: string,
    config: SandboxProviderConfig,
    signal?: AbortSignal,
  ): Promise<SandboxProviderInstance> {
    const provider = this.registrations.resolve(id)
    const record = this.records.get(provider)!
    this.registrations.select('process', id)
    const probed = (await provider.probe?.(signal)) ?? provider.capabilities
    if (!validCapabilities(probed))
      throw new ProviderError('E_PROVIDER_INVALID', `sandbox provider returned invalid capabilities: ${id}`, {
        kind: 'sandbox',
        provider: id,
        operation: 'probe',
      })
    record.entry = Object.freeze({
      ...record.entry,
      capabilities: freezeCapabilities(probed),
    })
    const instance = await provider.create(config, signal)
    this.selection = { id, instance }
    return instance
  }

  private async ownInstance(
    record: Registration,
    instance: SandboxProviderInstance,
    signal: AbortSignal,
  ): Promise<SandboxProviderInstance> {
    const id = record.id
    const valid =
      instance &&
      instance.id === id &&
      typeof instance.exec === 'function' &&
      typeof instance.dispose === 'function' &&
      validCapabilities(instance.capabilities)
    const lifetime = new ProviderLifetime('sandbox', id)
    const opened = new Set<import('@agnes/extension-api').SandboxProcess>()
    const opening = new Set<Promise<import('@agnes/extension-api').SandboxProcess>>()
    const dispose = record.lifetime.own(() =>
      lifetime.close(
        () => {
          if (typeof instance?.dispose === 'function') return instance.dispose()
        },
        async () => {
          await Promise.allSettled([...opening])
          const results = await Promise.allSettled([...opened].map((handle) => handle.close()))
          const errors = results
            .filter((result) => result.status === 'rejected')
            .map((result) => result.reason)
          if (errors.length) throw new AggregateError(errors, 'interactive provider cleanup failed')
        },
      ),
    )
    if (!valid || signal.aborted) {
      await dispose()
      signal.throwIfAborted()
      throw new ProviderError('E_PROVIDER_INVALID', `sandbox provider returned an invalid instance: ${id}`, {
        kind: 'sandbox',
        provider: id,
        operation: 'create',
      })
    }
    const bound = Object.freeze({
      id: instance.id,
      capabilities: freezeCapabilities(instance.capabilities),
      exec: async (request: Parameters<SandboxProviderInstance['exec']>[0]) => {
        if (record.lifetime.signal.aborted || lifetime.signal.aborted)
          throw sandboxUnavailable('the workspace sandbox instance is disposed')
        const joined = AbortSignal.any([
          request.signal ?? lifetime.signal,
          lifetime.signal,
          record.lifetime.signal,
        ])
        return lifetime.track(Promise.resolve().then(() => instance.exec({ ...request, signal: joined })))
      },
      ...(instance.openProcess
        ? {
            openProcess: async (
              request: Parameters<NonNullable<SandboxProviderInstance['openProcess']>>[0],
            ) => {
              if (record.lifetime.signal.aborted || lifetime.signal.aborted)
                throw sandboxUnavailable('the workspace sandbox instance is disposed')
              const joined = AbortSignal.any([
                request.signal ?? lifetime.signal,
                lifetime.signal,
                record.lifetime.signal,
              ])
              const pending = instance.openProcess!({ ...request, signal: joined }).then(async (handle) => {
                if (joined.aborted) {
                  await handle.close()
                  if (record.lifetime.signal.aborted || lifetime.signal.aborted)
                    throw sandboxUnavailable('provider was disposed during interactive launch')
                  joined.throwIfAborted()
                }
                opened.add(handle)
                void handle.exited.then(() => opened.delete(handle))
                return handle
              })
              opening.add(pending)
              void pending.then(
                () => opening.delete(pending),
                () => opening.delete(pending),
              )
              return pending
            },
          }
        : {}),
      dispose,
    })
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
    throw new ProviderError(
      'E_PROVIDER_INCOMPATIBLE',
      'a remote workspace cannot select another sandbox provider',
      { kind: 'sandbox', provider: id, operation: 'select' },
    )
  if (!slot.registry) {
    if (id !== LOCAL_SANDBOX_PROVIDER_ID)
      throw new ProviderError('E_PROVIDER_UNKNOWN', `sandbox provider is not registered: ${id}`, {
        kind: 'sandbox',
        provider: id,
        operation: 'select',
      })
    return LOCAL_SANDBOX_PROVIDER_ID
  }
  if (slot.selected) {
    if (slot.selected.id !== id)
      throw new ProviderError(
        'E_PROVIDER_INCOMPATIBLE',
        `sandbox provider ${slot.selected.id} is already selected; choosing ${id} requires a restart`,
        { kind: 'sandbox', provider: id, operation: 'select' },
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
    async openProcess(argv, opts) {
      const policy = opts.sandbox?.policy
      let selected = slot.selected
      if (!selected || !policy)
        throw sandboxUnavailable('interactive execution requires a bound provider policy')
      if (slot.registry)
        selected = await slot.registry.select(selected.id, {
          workspaceRoot: policy.workspaceRoot,
          ...(slot.options ? { options: slot.options } : {}),
        })
      if (!selected.capabilities.available || !selected.openProcess)
        throw sandboxUnavailable('the selected provider does not support interactive execution')
      if (opts.sandbox?.provider && opts.sandbox.provider !== selected.id)
        throw sandboxUnavailable('interactive provider binding differs')
      const actual =
        selected.id === LOCAL_SANDBOX_PROVIDER_ID
          ? opts.sandbox?.enforcement
          : selected.capabilities.enforcement
      if (
        !actual ||
        (policy.requiredEnforcement.level === 'full' && actual.level !== 'full') ||
        policy.requiredEnforcement.scope.some((scope) => !actual.scope.includes(scope))
      )
        throw sandboxUnavailable('interactive provider cannot enforce this policy')
      const handle = await selected.openProcess({
        argv,
        cwd: opts.cwd,
        policy,
        enforcement: actual,
        ...(opts.env ? { env: opts.env } : {}),
        ...(opts.pty ? { pty: opts.pty } : {}),
        ...(opts.signal ? { signal: opts.signal } : {}),
      })
      if (
        (policy.requiredEnforcement.level === 'full' && handle.enforcement.level !== 'full') ||
        policy.requiredEnforcement.scope.some((scope) => !handle.enforcement.scope.includes(scope))
      ) {
        await handle.close()
        throw sandboxUnavailable('interactive provider did not supply required enforcement')
      }
      return handle
    },
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
