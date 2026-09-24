import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createExtensionActivationBarrier, type Host, type ResolvedProfile } from '@agnes/host'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { type DaemonConfig, DEFAULT_LIMITS } from '../src/config.js'
import { CommandQueue } from '../src/local/command-queue.js'
import { LocalEndpoint } from '../src/local/endpoint.js'
import { registerExtensions } from '../src/local/methods/extensions.js'
import { MemoryJournal } from '../src/local/ports.js'
import type { CommandFrame } from '../src/supervisor/frames.js'
import { workerServiceCaller, workerServiceInspector } from '../src/supervisor/service-worker.js'
import { listenUnix } from '../src/supervisor/socket.js'
import { daemonSocketPaths } from '../src/supervisor/socket-paths.js'
import { WorkerPool } from '../src/supervisor/worker-pool.js'
import { handleServiceCommand } from '../src/worker/commands.js'
import { createWorkerServiceAuthority } from '../src/worker/service-authority.js'
import { serviceOwner, servicePackageId, serviceRowId } from './service-row-fixture.js'

const grant = { extension: serviceOwner, name: 'sales.list', range: '^1.0.0' }
const effectGrant = { extension: serviceOwner, name: 'sales.create', range: '^1.0.0' }
const credential = {
  kind: 'surface-service',
  source: 'reports',
  subjectCredential: { kind: 'sso', userId: 'alice' },
  grants: [grant, effectGrant],
}
const cleanup: Array<() => void | Promise<void>> = []
function socketPaths(dir: string) {
  const paths = daemonSocketPaths({ dataDir: dir, ipc: process.platform === 'win32' ? 'pipe' : 'unix' })
  if (process.platform !== 'win32' && dirname(paths.socketPath) !== join(dir, 'daemon'))
    cleanup.push(() => rmSync(dirname(paths.socketPath), { recursive: true, force: true }))
  return paths
}

afterEach(async () => {
  for (const dispose of cleanup.splice(0).reverse()) await dispose()
})

function surfaceEndpoint(
  callService: Host['callService'],
  inspectService: Host['inspectService'],
  journal: MemoryJournal,
  resolveServiceSession = async (sessionId: string) => sessionId,
): { ep: LocalEndpoint; queue: CommandQueue } {
  const ep = new LocalEndpoint({ clock: Date.now, principalId: 'transport' })
  ep.establishPrincipal('surface:reports:portal:alice')
  ep.conn.initialized = true
  ep.conn.clientId = 'reports-bff'
  ep.conn.authKind = 'surface'
  ep.conn.credentialKind = 'sso'
  ep.conn.credential = { kind: 'sso', userId: 'alice' }
  ep.conn.surface = Object.freeze({
    sourceId: 'reports',
    sourceAuthKeyId: 'reports-key',
    grants: Object.freeze([Object.freeze(effectGrant)]),
  })
  const queue = new CommandQueue()
  registerExtensions(ep, {
    activationBarrier: createExtensionActivationBarrier(),
    journal,
    commandQueue: queue,
    callService,
    inspectService,
    resolveServiceSession,
  })
  return { ep, queue }
}

const effectRequest = (id: number, mode: 'timeout' | 'cancel' | 'crash' | 'ok', commandId: string) => ({
  jsonrpc: '2.0' as const,
  id,
  method: '_agnes/v1/extension.call' as const,
  params: {
    sessionId: 'session-1',
    extension: serviceOwner,
    service: 'sales.create',
    input: { mode },
    commandId,
  },
})

describe('S5 service worker boundary', () => {
  it('accepts only a bounded authenticated authority envelope', async () => {
    const authority = createWorkerServiceAuthority()
    await expect(authority.resolve(credential)).resolves.toEqual({
      source: 'reports',
      subjectCredential: { kind: 'sso', userId: 'alice' },
      grants: [grant, effectGrant],
    })
    const localWeb = {
      kind: 'surface-service',
      source: 'client-web',
      subjectCredential: { kind: 'local' },
      grants: [grant],
    }
    await expect(authority.resolve(localWeb)).resolves.toEqual({
      source: 'client-web',
      subjectCredential: { kind: 'local' },
      grants: [grant],
    })
    for (const invalid of [
      { ...credential, source: '../reports' },
      { ...credential, kind: 'source-auth' },
      { ...credential, subjectCredential: { kind: 'local' } },
      { ...localWeb, source: 'client-web-other' },
      { ...localWeb, subjectCredential: { kind: 'local', forged: true } },
      { ...credential, grants: [{ ...grant, name: '*' }] },
      { ...credential, sourceSecret: 'must-not-cross-worker-wire' },
    ])
      await expect(authority.resolve(invalid)).rejects.toThrow('invalid service authority')
  })

  it('requires the private session key to match the public call and forwards effect admission', async () => {
    const callService = vi.fn(async () => ({ output: { ok: true } }))
    const host = { callService } as unknown as Host
    const frame: CommandFrame = {
      kind: 'command',
      requestId: '1',
      method: 'callService',
      params: {
        callId: 'call-1',
        sessionKey: 'session-1',
        call: {
          sessionId: 'session-1',
          extension: serviceOwner,
          service: 'sales.list',
          input: {},
          commandId: 'effect-1',
        },
        credential,
        effectCommandId: 'effect-1',
      },
    }
    await expect(handleServiceCommand(host, frame, new Map())).resolves.toEqual({
      output: { ok: true },
    })
    expect(callService).toHaveBeenCalledWith(frame.params.call, credential, expect.any(AbortSignal), {
      commandId: 'effect-1',
    })

    const forged = structuredClone(frame)
    forged.requestId = '2'
    forged.params.sessionKey = 'another-session'
    await expect(handleServiceCommand(host, forged, new Map())).rejects.toMatchObject({
      data: { code: 'CAPABILITY_DENIED' },
    })
    expect(callService).toHaveBeenCalledTimes(1)
  })

  it('uses one profile-hash worker namespace and aborts through a parallel control command', async () => {
    const commands: Array<{ method: string; params: Record<string, unknown> }> = []
    let rejectCall!: (error: unknown) => void
    const link = {
      command(method: string, params: Record<string, unknown>) {
        commands.push({ method, params })
        if (method === 'callService')
          return new Promise((_resolve, reject) => {
            rejectCall = reject
          })
        return Promise.resolve({})
      },
    }
    const acquireSharedWorker = vi.fn(async () => link)
    const profile = { hash: 'profile-sha256' } as ResolvedProfile
    const caller = workerServiceCaller({ acquireSharedWorker } as never, () => profile)
    const inspector = workerServiceInspector({ acquireSharedWorker } as never, () => profile)
    await expect(
      inspector(
        { sessionId: 'session-1', extension: serviceOwner, service: 'sales.list', input: {} },
        credential,
      ),
    ).resolves.toEqual({})
    expect(commands[0]?.method).toBe('inspectService')
    const ac = new AbortController()
    const running = caller(
      {
        sessionId: 'session-1',
        extension: serviceOwner,
        service: 'sales.list',
        input: {},
        commandId: 'effect-1',
      },
      credential,
      ac.signal,
      { commandId: 'effect-1' },
    )
    await vi.waitFor(() => expect(commands[1]?.method).toBe('callService'))
    ac.abort()
    await vi.waitFor(() => expect(commands[2]?.method).toBe('abortService'))
    expect(acquireSharedWorker).toHaveBeenCalledWith()
    expect(commands[1]?.params).toMatchObject({
      call: { commandId: 'effect-1' },
      credential,
      effectCommandId: 'effect-1',
    })
    expect(commands[2]?.params.callId).toBe(commands[1]?.params.callId)
    rejectCall(new Error('worker link closed'))
    await expect(running).rejects.toThrow('worker link closed')
  })

  it('inspects trusted Service kind in the same profile worker and marks acquire failures pre-dispatch', async () => {
    const profile = { hash: 'profile-sha256' } as ResolvedProfile
    const command = vi.fn(async () => ({ kind: 'effect' }))
    const acquireSharedWorker = vi.fn(async () => ({ command }))
    const inspect = workerServiceInspector({ acquireSharedWorker } as never, () => profile)
    await expect(
      inspect(
        {
          sessionId: 'session-1',
          extension: serviceOwner,
          service: 'sales.create',
          input: {},
          commandId: 'create-1',
        },
        credential,
      ),
    ).resolves.toEqual({ kind: 'effect' })
    expect(acquireSharedWorker).toHaveBeenCalledWith()
    expect(command).toHaveBeenCalledWith('inspectService', expect.objectContaining({ credential }), {
      timeoutMs: 31_000,
    })

    const unavailable = workerServiceCaller(
      { acquireSharedWorker: vi.fn(async () => Promise.reject(new Error('spawn failed'))) } as never,
      () => profile,
    )
    await expect(
      unavailable(
        {
          sessionId: 'session-1',
          extension: serviceOwner,
          service: 'sales.create',
          input: {},
          commandId: 'create-1',
        },
        credential,
        undefined,
        { commandId: 'create-1' },
      ),
    ).rejects.toMatchObject({ data: { code: 'INTERNAL_ERROR', _servicePhase: 'pre-dispatch' } })
  })

  it('loads a real Service in the workspace-bound session of the shared worker', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'agnes-service-worker-'))
    cleanup.push(() => rmSync(dir, { recursive: true, force: true }))
    const pkg = join(dir, 'service-package')
    mkdirSync(pkg, { recursive: true })
    const capability = {
      name: 'sales.list',
      kind: 'query',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        required: ['region'],
        properties: { region: { type: 'string' } },
      },
      outputSchema: {
        type: 'object',
        additionalProperties: false,
        required: ['region'],
        properties: { region: { type: 'string' } },
      },
      timeoutMs: 1_000,
      maxResultBytes: 1_024,
    }
    const effectCapability = { ...capability, name: 'sales.create', kind: 'effect' }
    writeFileSync(
      join(pkg, 'package.json'),
      JSON.stringify({
        name: servicePackageId,
        version: '1.0.0',
        type: 'module',
        exports: './index.mjs',
        agnes: {
          plugins: [{ id: serviceRowId, export: 'main', services: [capability.name, effectCapability.name] }],
        },
      }),
    )
    writeFileSync(
      join(pkg, 'index.mjs'),
      `export const main = { apply(ctx) {
        ctx.services.register({ ...${JSON.stringify(capability)},
          async handler(input, serviceCtx) {
            if (!serviceCtx.actor.id) throw new Error('missing actor');
            return { region: input.region };
          }
        });
        ctx.services.register({ ...${JSON.stringify(effectCapability)},
          async handler(input, serviceCtx) {
            if (!serviceCtx.actor.id) throw new Error('missing actor');
            return { region: input.region };
          }
        });
      } };`,
    )
    const profile = {
      name: 'local-dev',
      hash: 'service-profile-hash',
      dataDir: dir,
      cacheDir: join(dir, 'cache'),
    } as ResolvedProfile
    const profileFile = join(dir, 'profile.json')
    writeFileSync(profileFile, JSON.stringify(profile))
    const config: DaemonConfig = {
      profileName: 'local-dev',
      dataDir: dir,
      ...socketPaths(dir),
      limits: { ...DEFAULT_LIMITS, workerStartupMs: 10_000 },
    }
    const pool = new WorkerPool({
      config,
      profile,
      profileFile,
      execPath: process.execPath,
      execArgv: ['--import', 'tsx'],
      workerEntry: fileURLToPath(new URL('./fake-service-worker-entry.ts', import.meta.url)),
      clock: Date.now,
      onEvent: () => undefined,
      onRequest: async () => undefined,
      notices: { emit() {} },
    })
    const server = await listenUnix(config.workersSocketPath, (socket) => pool.adopt(socket))
    cleanup.push(async () => {
      await pool.closeAll(2_000).catch(() => undefined)
      pool.killAll()
      await server.close()
    })
    const link = await pool.acquireSharedWorker()
    await link.openSession('session-1', {
      binding: {
        version: 1,
        sessionKey: 'session-1',
        workspaceId: 'a'.repeat(64),
        revision: 1,
        canonicalRoot: realpathSync(dir),
      },
    })
    await expect(
      link.command('inspectService', {
        callId: 'real-service-inspect',
        sessionKey: 'session-1',
        call: {
          sessionId: 'session-1',
          extension: serviceOwner,
          service: 'sales.list',
          input: { region: 'east' },
        },
        credential,
      }),
    ).resolves.toEqual({ kind: 'query' })
    await expect(
      link.command('callService', {
        callId: 'real-service-call',
        sessionKey: 'session-1',
        call: {
          sessionId: 'session-1',
          extension: serviceOwner,
          service: 'sales.list',
          input: { region: 'east' },
        },
        credential,
      }),
    ).resolves.toEqual({ output: { region: 'east' } })
    await expect(
      link.command('inspectService', {
        callId: 'real-effect-inspect',
        sessionKey: 'session-1',
        call: {
          sessionId: 'session-1',
          extension: serviceOwner,
          service: 'sales.create',
          input: { region: 'west' },
          commandId: 'create-west',
        },
        credential,
      }),
    ).resolves.toEqual({ kind: 'effect' })
    await expect(
      link.command('callService', {
        callId: 'real-effect-call',
        sessionKey: 'session-1',
        call: {
          sessionId: 'session-1',
          extension: serviceOwner,
          service: 'sales.create',
          input: { region: 'west' },
          commandId: 'create-west',
        },
        credential,
        effectCommandId: 'create-west',
      }),
    ).resolves.toEqual({ output: { region: 'west' } })
    // A service worker refuses every session method; it has no HostSession or writer lease.
    const uncheckedCommand = link.command.bind(link) as unknown as (
      method: string,
      params: Record<string, unknown>,
    ) => Promise<unknown>
    await expect(uncheckedCommand('scan', {})).rejects.toMatchObject({
      message: expect.stringContaining('method unavailable in service worker'),
    })
  }, 20_000)

  it('keeps entered effects uncertain across real worker timeout, cancellation and process crash', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'agnes-service-effect-failures-'))
    cleanup.push(() => rmSync(dir, { recursive: true, force: true }))
    const pkg = join(dir, 'service-package')
    const marker = join(dir, 'effect-marker.jsonl')
    mkdirSync(pkg, { recursive: true })
    const capability = {
      name: 'sales.create',
      kind: 'effect',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        required: ['mode'],
        properties: { mode: { enum: ['timeout', 'cancel', 'crash', 'ok'] } },
      },
      outputSchema: {
        type: 'object',
        additionalProperties: false,
        required: ['mode'],
        properties: { mode: { type: 'string' } },
      },
      timeoutMs: 100,
      maxResultBytes: 1_024,
    }
    writeFileSync(
      join(pkg, 'package.json'),
      JSON.stringify({
        name: servicePackageId,
        version: '1.0.0',
        type: 'module',
        exports: './index.mjs',
        agnes: { plugins: [{ id: serviceRowId, export: 'main', services: [capability.name] }] },
      }),
    )
    writeFileSync(
      join(pkg, 'index.mjs'),
      `import { appendFileSync } from 'node:fs';
       const marker = ${JSON.stringify(marker)};
       export const main = { apply(ctx) { ctx.services.register({ ...${JSON.stringify(capability)},
         async handler(input, serviceCtx) {
           appendFileSync(marker, JSON.stringify({ mode: input.mode, commandId: serviceCtx.requestId }) + '\\n');
           if (input.mode === 'crash') process.exit(17);
           if (input.mode === 'timeout') await new Promise(() => {});
           if (input.mode === 'cancel') await new Promise((resolve, reject) => {
             const abort = () => reject(serviceCtx.signal.reason);
             if (serviceCtx.signal.aborted) abort();
             else serviceCtx.signal.addEventListener('abort', abort, { once: true });
           });
           return { mode: input.mode };
         }
       }); } };`,
    )
    const profile = {
      name: 'local-dev',
      hash: 'service-effect-failure-profile',
      dataDir: dir,
      cacheDir: join(dir, 'cache'),
    } as ResolvedProfile
    const profileFile = join(dir, 'profile.json')
    writeFileSync(profileFile, JSON.stringify(profile))
    const config: DaemonConfig = {
      profileName: 'local-dev',
      dataDir: dir,
      ...socketPaths(dir),
      limits: { ...DEFAULT_LIMITS, workerStartupMs: 10_000 },
    }
    const pool = new WorkerPool({
      config,
      profile,
      profileFile,
      execPath: process.execPath,
      execArgv: ['--import', 'tsx'],
      workerEntry: fileURLToPath(new URL('./fake-service-worker-entry.ts', import.meta.url)),
      clock: Date.now,
      onEvent: () => undefined,
      onRequest: async () => undefined,
      notices: { emit() {} },
    })
    const server = await listenUnix(config.workersSocketPath, (socket) => pool.adopt(socket))
    cleanup.push(async () => {
      await pool.closeAll(2_000).catch(() => undefined)
      pool.killAll()
      await server.close()
    })
    const callService = workerServiceCaller(pool, () => profile)
    const inspectService = workerServiceInspector(pool, () => profile)
    let sessionWorker: Awaited<ReturnType<WorkerPool['acquireSharedWorker']>> | undefined
    let openedOnce = false
    const resolveServiceSession = async (sessionId: string): Promise<string> => {
      const link = await pool.acquireSharedWorker()
      if (link !== sessionWorker) {
        await link.openSession(sessionId, {
          binding: {
            version: 1,
            sessionKey: sessionId,
            workspaceId: 'b'.repeat(64),
            revision: 1,
            canonicalRoot: realpathSync(dir),
          },
          ...(openedOnce ? { resume: true } : {}),
        })
        openedOnce = true
        sessionWorker = link
      }
      return sessionId
    }
    const journal = new MemoryJournal(Date.now)
    const markerModes = (): string[] =>
      existsSync(marker)
        ? readFileSync(marker, 'utf8')
            .trim()
            .split('\n')
            .filter(Boolean)
            .map((line) => (JSON.parse(line) as { mode: string }).mode)
        : []
    const retryIsStillUnknown = async (
      mode: 'timeout' | 'cancel' | 'crash',
      commandId: string,
      requestId: number,
    ): Promise<void> => {
      const retry = surfaceEndpoint(callService, inspectService, journal, resolveServiceSession)
      await expect(retry.ep.handle(effectRequest(requestId, mode, commandId))).resolves.toMatchObject({
        error: { data: { code: 'OUTCOME_UNKNOWN' } },
      })
      await retry.ep.close()
      await retry.queue.close()
      expect(markerModes().filter((seen) => seen === mode)).toHaveLength(1)
    }

    const timedOut = surfaceEndpoint(callService, inspectService, journal, resolveServiceSession)
    await expect(timedOut.ep.handle(effectRequest(1, 'timeout', 'timeout-effect'))).resolves.toMatchObject({
      error: { data: { code: 'OUTCOME_UNKNOWN' } },
    })
    await timedOut.ep.close()
    await timedOut.queue.close()
    await retryIsStillUnknown('timeout', 'timeout-effect', 2)

    const cancelled = surfaceEndpoint(callService, inspectService, journal, resolveServiceSession)
    const pendingCancel = cancelled.ep.handle(effectRequest(3, 'cancel', 'cancel-effect'))
    await vi.waitFor(() => expect(markerModes()).toContain('cancel'))
    await cancelled.ep.close()
    await expect(pendingCancel).resolves.toMatchObject({
      error: { data: { code: 'OUTCOME_UNKNOWN' } },
    })
    await cancelled.queue.close()
    await retryIsStillUnknown('cancel', 'cancel-effect', 4)

    const preDispatchJournal = new MemoryJournal(Date.now)
    const abandon = vi.spyOn(preDispatchJournal, 'abandon')
    const unavailableCall = workerServiceCaller(
      {
        acquireSharedWorker: vi.fn(async () => {
          throw new Error('worker unavailable before dispatch')
        }),
      } as never,
      () => profile,
    )
    const refused = surfaceEndpoint(
      unavailableCall,
      inspectService,
      preDispatchJournal,
      resolveServiceSession,
    )
    await expect(refused.ep.handle(effectRequest(7, 'ok', 'pre-dispatch-effect'))).resolves.toMatchObject({
      error: { data: { code: 'INTERNAL_ERROR' } },
    })
    expect(abandon).toHaveBeenCalledWith(expect.objectContaining({ commandId: 'pre-dispatch-effect' }))
    expect(markerModes()).not.toContain('ok')
    await refused.ep.close()
    await refused.queue.close()

    const closeRaceJournal = new MemoryJournal(Date.now)
    const closeRaceAbandon = vi.spyOn(closeRaceJournal, 'abandon')
    const closeAfterInspect: Host['inspectService'] = async (params, serviceCredential, signal) => {
      const inspected = await inspectService(params, serviceCredential, signal)
      const active = sessionWorker
      if (!active) throw new Error('expected an open shared session worker')
      await active.closeSession(params.sessionId, 'close between inspect and effect call')
      sessionWorker = undefined
      return inspected
    }
    const closedBeforeEffect = surfaceEndpoint(
      callService,
      closeAfterInspect,
      closeRaceJournal,
      resolveServiceSession,
    )
    await expect(
      closedBeforeEffect.ep.handle(effectRequest(8, 'ok', 'closed-before-effect')),
    ).resolves.toMatchObject({
      error: { data: { code: 'E_WORKSPACE_REQUIRED' } },
    })
    expect(closeRaceAbandon).toHaveBeenCalledWith(
      expect.objectContaining({ commandId: 'closed-before-effect' }),
    )
    expect(markerModes()).not.toContain('ok')
    await closedBeforeEffect.ep.close()
    await closedBeforeEffect.queue.close()

    const crashed = surfaceEndpoint(callService, inspectService, journal, resolveServiceSession)
    await expect(crashed.ep.handle(effectRequest(5, 'crash', 'crash-effect'))).resolves.toMatchObject({
      error: { data: { code: 'OUTCOME_UNKNOWN' } },
    })
    await crashed.ep.close()
    await crashed.queue.close()
    // A killed session writer keeps its durable writer lease until expiry. The immediate retry
    // therefore cannot rebuild a workspace yet, but it must fail closed and must not execute the
    // already-uncertain effect a second time.
    const crashRetry = surfaceEndpoint(callService, inspectService, journal, resolveServiceSession)
    await expect(crashRetry.ep.handle(effectRequest(6, 'crash', 'crash-effect'))).resolves.toMatchObject({
      error: { data: { code: 'INTERNAL_ERROR' } },
    })
    await crashRetry.ep.close()
    await crashRetry.queue.close()
    expect(markerModes().filter((seen) => seen === 'crash')).toHaveLength(1)
  }, 20_000)
})
