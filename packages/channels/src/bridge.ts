import { createHash } from 'node:crypto'
import { lstatSync } from 'node:fs'
import { realpath } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import type {
  ChannelConfiguration,
  ChannelProvider,
  ChannelRuntime,
  ProfileManagedInit,
} from '@agnes/extension-api'
import { channelKind } from '@agnes/extension-api'
import { createPrivateDirectorySync, hasPrivateDaclSync } from '@agnes/system-node'
import { ChannelBindings } from './bindings.js'
import { decideAttention } from './runner/attention.js'
import type { RunnerConfig } from './runner/config.js'
import { createRunner, type Runner, type RunnerDeps, type RunnerLog } from './runner/runner.js'
import { createRunnerSupervisor } from './runner/supervisor.js'

export interface ChannelBridgeOptions {
  owner: string
  stateDirectory: string
  resolveSecret(ref: string): Promise<string> | string
  createClient(config: RunnerConfig, stateDirectory: string): RunnerDeps['client']
  log: Record<'info' | 'warn' | 'error', (message: string) => void>
}

/** One current-profile resource. All platform-independent forwarding remains in the runner. */
export async function startChannelBridge(
  provider: ChannelProvider,
  init: ProfileManagedInit,
  options: ChannelBridgeOptions,
): Promise<ChannelRuntime> {
  channelKind.validate(provider)
  const config = init.config as unknown as ChannelConfiguration
  if (
    !config ||
    !Array.isArray(config.instances) ||
    config.instances.length > 32 ||
    !isAbsolute(options.stateDirectory)
  )
    throw new Error('Invalid channel configuration')
  const ids = new Set<string>()
  for (const instance of config.instances) {
    if (
      !/^[a-z][a-z0-9-]{0,47}$/.test(instance.id) ||
      ids.has(instance.id) ||
      !isAbsolute(instance.workspace)
    )
      throw new Error('Invalid or duplicate channel instance')
    ids.add(instance.id)
    const allowed = [...provider.manifest.credentials.required, ...provider.manifest.credentials.optional]
    if (
      !instance.credentialRefs ||
      Object.entries(instance.credentialRefs).some(
        ([key, ref]) => !allowed.includes(key) || !/^secret:\/\/[a-z0-9-]+\/[a-z0-9._-]+$/.test(ref),
      ) ||
      provider.manifest.credentials.required.some((key) => !instance.credentialRefs[key])
    )
      throw new Error('Channel credentials require declared secret references')
  }
  const running: {
    id: string
    workspace: string
    bindings: ChannelBindings
    supervisor: ReturnType<typeof createRunnerSupervisor>
    active?: Runner
  }[] = []
  let stopped = false
  let stopping: Promise<void> | undefined
  const assertCurrent = () => {
    init.signal.throwIfAborted()
    init.assertCurrent()
  }
  const stop = () =>
    (stopping ??= (async () => {
      stopped = true
      for (const row of running) row.supervisor.stopIntake()
      // Abort an in-flight connect before the supervisor waits for its startup to settle.
      await Promise.all(
        running.map(async (row) => {
          try {
            await row.active?.stop({ drainMs: 2000 })
          } finally {
            await row.supervisor.stop({ drainMs: 0 })
          }
        }),
      )
    })().finally(() => init.signal.removeEventListener('abort', aborted)))
  init.onShutdown(async () => {
    await stop()
    return { state: 'settled' }
  })
  const aborted = () => {
    void stop().catch(() => {})
  }
  init.signal.addEventListener('abort', aborted, { once: true })
  try {
    assertCurrent()
    privateDirectory(options.stateDirectory)
    // Removed or replaced connections must never resurrect an earlier session binding.
    const currentKeys = new Set(
      config.instances.map((instance) => {
        const key = createHash('sha256').update(`${options.owner}\0${instance.id}`).digest('hex').slice(0, 32)
        const fingerprint = createHash('sha256').update(JSON.stringify(instance)).digest('hex')
        return `bindings:${key}:${fingerprint}`
      }),
    )
    init.store.transaction(() => {
      let cursor: string | undefined
      do {
        assertCurrent()
        const page = init.store.scan({ prefix: 'bindings:', limit: 100, ...(cursor ? { cursor } : {}) })
        for (const row of page.rows) if (!currentKeys.has(row.key)) init.store.delete(row.key)
        if (page.nextCursor && page.nextCursor === cursor)
          throw new Error('Channel storage cursor did not advance')
        cursor = page.nextCursor
      } while (cursor)
    })
    for (const instance of config.instances) {
      assertCurrent()
      const workspace = await realpath(instance.workspace)
      assertCurrent()
      const key = createHash('sha256').update(`${options.owner}\0${instance.id}`).digest('hex').slice(0, 32)
      const state = join(options.stateDirectory, key)
      privateDirectory(state)
      const cfg: RunnerConfig = {
        channel: provider.id,
        tenant: key,
        agent: instance.agent,
        ...(instance.agent === 'default' ? {} : { launchAgent: instance.agent }),
        workspace,
        connect: { kind: 'unix', path: 'host-discovery' },
        credentialsFile: '',
        allowFrom: instance.allowFrom,
        requireMention: instance.requireMention,
        ackReaction: 'off',
        outbound: { costLine: false },
        directory: { sync: false },
        healthz: { enabled: false, port: 0 },
      }
      const fingerprint = createHash('sha256').update(JSON.stringify(instance)).digest('hex')
      const bindings = new ChannelBindings(init.store, `bindings:${key}:${fingerprint}`, assertCurrent)
      const row: (typeof running)[number] = { id: instance.id, workspace, bindings, supervisor: undefined! }
      row.supervisor = createRunnerSupervisor(async () => {
        assertCurrent()
        if (stopped) throw new Error('Channel resource is stopping')
        const secrets: Record<string, string> = {}
        for (const [key, ref] of Object.entries(instance.credentialRefs)) {
          secrets[key] = await options.resolveSecret(ref)
          assertCurrent()
        }
        // Do not forward platform diagnostic details, which can contain authentication headers.
        const log: RunnerLog = {
          info: () => options.log.info('channel runtime event'),
          warn: () => options.log.warn('channel runtime warning'),
          error: () => options.log.error('channel runtime error'),
        }
        const adapter = await provider.create({ config: instance.config ?? {} })
        let client: RunnerDeps['client'] | undefined
        try {
          assertCurrent()
          if (
            stopped ||
            adapter.manifest.id !== provider.id ||
            !isDeepStrictEqual(adapter.manifest, provider.manifest)
          )
            throw new Error('Channel adapter differs from its registered manifest')
          if (
            Object.entries(adapter.capabilities()).some(
              ([key, value]) =>
                value === true &&
                provider.manifest.capabilities[key as keyof typeof provider.manifest.capabilities] !== true,
            )
          )
            throw new Error('Channel adapter exceeds its declared capabilities')
          client = options.createClient(cfg, state)
          const guarded = new Proxy(adapter, {
            get(target, key) {
              const value = Reflect.get(target, key)
              if (typeof value !== 'function') return value
              return (...args: unknown[]) => {
                if (key !== 'disconnect') assertCurrent()
                return Reflect.apply(value, target, args)
              }
            },
          })
          const runner = createRunner({
            adapter: guarded,
            client,
            cfg,
            secrets,
            log,
            strictShutdown: true,
            bindings: {
              resolve: (key) => bindings.resolve(key),
              observe(event) {
                if (event.kind !== 'message' || decideAttention(event, cfg, false) !== 'respond') return
                const intent = adapter.toSession(event, { tenant: cfg.tenant, agent: cfg.agent })
                if (intent) bindings.observe(event, intent.sessionKey)
              },
            },
            refsPath: join(state, 'refs.sqlite'),
          })
          row.active = runner
          bindings.runner = runner
          return { client, runner }
        } catch (error) {
          await adapter.disconnect().catch(() => {})
          await client?.close().catch(() => {})
          throw error
        }
      }, options.log)
      running.push(row)
      await row.supervisor.start()
      assertCurrent()
    }
    init.ready()
    return {
      async session(session) {
        assertCurrent()
        const workspace = await realpath(session.workspace)
        return {
          instances: running
            .filter((row) => row.workspace === workspace)
            .map((row) => ({
              id: row.id,
              connection: row.active?.status() ?? null,
              ...row.bindings.view(session.id),
            })),
        }
      },
      async binding(action, input, session) {
        assertCurrent()
        const row = running.find((row) => row.id === input.instanceId)
        if (!row || row.workspace !== (await realpath(session.workspace)))
          throw new Error('Channel workspace differs from session')
        return await row.bindings.change(action, input, session.id)
      },
      status() {
        assertCurrent()
        return {
          provider: provider.id,
          instances: running.map((row) => ({
            id: row.id,
            connection: row.active?.status() ?? null,
            ...row.bindings.summary(),
          })),
        }
      },
    }
  } catch {
    await stop()
    throw new Error('Channel startup failed; check credentials, workspace and backend connectivity')
  } finally {
    if (stopped) init.signal.removeEventListener('abort', aborted)
  }
}

function privateDirectory(path: string): void {
  try {
    createPrivateDirectorySync(path)
  } catch (error) {
    const stat = lstatSync(path)
    if (!stat.isDirectory() || stat.isSymbolicLink() || !hasPrivateDaclSync(path)) throw error
  }
}
