import { mkdirSync } from 'node:fs'
import { access, readFile, stat, writeFile } from 'node:fs/promises'
import { buildRuntimeTarget, encodeRuntimeTargetArtifact } from '@agnes/plugin-runtime/host'
import type { RuntimeTargetArtifact } from '@agnes/protocol'
import { hasPrivateDaclSync } from '@agnes/system-node'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  createRuntimeTargetProbeLauncher,
  RUNTIME_TARGET_PROBE_REAP_TIMEOUT_MS,
  RUNTIME_TARGET_PROBE_TIMEOUT_MS,
  type RuntimeTargetProbeWorker,
  type RuntimeTargetProbeWorkerInput,
  spawnRuntimeTargetProbeWorker,
} from '../src/supervisor/runtime-target-probe.js'

const validArtifact = encodeRuntimeTargetArtifact(
  buildRuntimeTarget({
    rows: [],
    resourceRevision: 'b'.repeat(64),
    compositeRevision: 'c'.repeat(64),
    resources: { mcp: [], skills: {} },
  }),
)
const canonical = Buffer.from(validArtifact.canonicalBase64, 'base64')

function artifact(): RuntimeTargetArtifact {
  return structuredClone(validArtifact) as RuntimeTargetArtifact
}

function controlledWorker() {
  let resolve!: () => void
  let reject!: (error: unknown) => void
  const result = new Promise<void>((yes, no) => {
    resolve = yes
    reject = no
  })
  const close = vi.fn(async () => undefined)
  return { worker: { result, close } satisfies RuntimeTargetProbeWorker, resolve, reject, close }
}

afterEach(() => vi.useRealTimers())

describe('runtime target probe launcher', () => {
  it('creates a unique private data directory and exact private target file for every probe', async () => {
    const seen: RuntimeTargetProbeWorkerInput[] = []
    const bodies: Uint8Array[] = []
    const closes: Array<ReturnType<typeof vi.fn>> = []
    const spawnWorker = vi.fn((input: RuntimeTargetProbeWorkerInput) => {
      seen.push(input)
      const close = vi.fn(async () => undefined)
      closes.push(close)
      return {
        result: Promise.all([
          readFile(input.targetFile).then((body) => bodies.push(body)),
          ...(process.platform === 'win32'
            ? [
                Promise.resolve().then(() => {
                  expect(hasPrivateDaclSync(input.dataDir)).toBe(true)
                  expect(hasPrivateDaclSync(input.targetFile)).toBe(true)
                }),
              ]
            : [
                stat(input.dataDir).then((entry) => expect(entry.mode & 0o777).toBe(0o700)),
                stat(input.targetFile).then((entry) => expect(entry.mode & 0o777).toBe(0o600)),
              ]),
        ]).then(() => undefined),
        close,
      }
    })
    const probe = createRuntimeTargetProbeLauncher({ spawnWorker })

    await Promise.all([probe(artifact()), probe(artifact())])

    expect(seen).toHaveLength(2)
    expect(closes.every((close) => close.mock.calls.length === 1)).toBe(true)
    expect(seen[0]?.dataDir).not.toBe(seen[1]?.dataDir)
    expect(bodies).toEqual([canonical, canonical])
    for (const input of seen) {
      expect(input.workerKey).toBe(`@probe:${artifact().digest}`)
      expect(input.workerKind).toBe('probe')
      expect(input.env.AGNES_RUNTIME_TARGET_FILE).toBe(input.targetFile)
      expect(input.env.AGNES_WORKER_KEY).toBe(input.workerKey)
      expect(input.env.AGNES_WORKER_KIND).toBe('probe')
      expect(input.env.AGNES_WORKER_ROOT).toBe(input.dataDir)
      await expect(access(input.dataDir)).rejects.toThrow()
    }
  })

  it('uses the repository Windows DACL seams instead of POSIX mode bits', async () => {
    const createPrivateDirectory = vi.fn((path: string) => mkdirSync(path))
    const writePrivateFile = vi.fn(async (path: string, data: Uint8Array) => {
      await writeFile(path, data, { flag: 'wx', mode: 0o600 })
    })
    let input: RuntimeTargetProbeWorkerInput | undefined
    const probe = createRuntimeTargetProbeLauncher({
      platform: 'win32',
      windowsPrivateFileSystem: { createPrivateDirectory, writePrivateFile },
      spawnWorker: (candidate) => {
        input = candidate
        return {
          result: readFile(candidate.targetFile).then((body) => expect(body).toEqual(canonical)),
          close: async () => undefined,
        }
      },
    })

    await probe(artifact())

    expect(input).toBeDefined()
    expect(createPrivateDirectory).toHaveBeenCalledOnce()
    expect(createPrivateDirectory).toHaveBeenCalledWith(input?.dataDir)
    expect(writePrivateFile).toHaveBeenCalledOnce()
    expect(writePrivateFile.mock.calls[0]?.[0]).toBe(input?.targetFile)
    expect(writePrivateFile.mock.calls[0]?.[1]).toEqual(new Uint8Array(canonical))
    await expect(access(input?.dataDir ?? '')).rejects.toThrow()
  })

  it.each(['EEXIST', 'EACCES'])(
    'does not delete an unowned path when private creation fails: %s',
    async (code) => {
      const { mkdtemp, chmod, rm } = await import('node:fs/promises')
      const remove = vi.fn(rm)
      const spawnWorker = vi.fn()
      const writePrivateFile = vi.fn()
      const failure = Object.assign(new Error(code), { code })
      const probe = createRuntimeTargetProbeLauncher({
        platform: 'win32',
        fileSystem: { mkdtemp, chmod, writeFile, rm: remove },
        windowsPrivateFileSystem: {
          createPrivateDirectory: () => {
            throw failure
          },
          writePrivateFile,
        },
        spawnWorker,
      })
      await expect(probe(artifact())).rejects.toBe(failure)
      expect(remove).not.toHaveBeenCalled()
      expect(writePrivateFile).not.toHaveBeenCalled()
      expect(spawnWorker).not.toHaveBeenCalled()
    },
  )

  it('removes inherited AGNES variables case-insensitively', async () => {
    process.env.agnes_probe_secret = 'must-not-cross'
    process.env.AgNeS_business_state = 'must-not-cross-either'
    let inherited: Readonly<NodeJS.ProcessEnv> | undefined
    try {
      const probe = createRuntimeTargetProbeLauncher({
        spawnWorker: (input) => {
          inherited = input.env
          return { result: Promise.resolve(), close: async () => undefined }
        },
      })
      await probe(artifact())
    } finally {
      delete process.env.agnes_probe_secret
      delete process.env.AgNeS_business_state
    }

    expect(inherited).toBeDefined()
    expect(inherited).not.toHaveProperty('agnes_probe_secret')
    expect(inherited).not.toHaveProperty('AgNeS_business_state')
  })

  it('strictly rejects malformed base64 and a digest mismatch before spawning', async () => {
    const spawnWorker = vi.fn()
    const probe = createRuntimeTargetProbeLauncher({ spawnWorker })
    await expect(
      probe({ ...artifact(), canonicalBase64: `${artifact().canonicalBase64}\n` }),
    ).rejects.toThrow('E_RUNTIME_TARGET_SCHEMA')
    await expect(probe({ ...artifact(), digest: `sha256-${'0'.repeat(64)}` })).rejects.toThrow(
      'E_RUNTIME_TARGET_DIGEST',
    )
    await expect(
      probe({
        ...artifact(),
        identity: { ...artifact().identity, compositeRevision: 'd'.repeat(64) },
      }),
    ).rejects.toThrow('E_RUNTIME_TARGET_IDENTITY')
    expect(spawnWorker).not.toHaveBeenCalled()
  })

  it.each([
    ['validation', new Error('candidate validation failed')],
    ['spawn', new Error('spawn refused')],
  ])('preserves the primary %s failure and removes the private directory', async (phase, failure) => {
    let dataDir = ''
    const closes: Array<ReturnType<typeof vi.fn>> = []
    const spawnWorker = vi.fn((input: RuntimeTargetProbeWorkerInput) => {
      dataDir = input.dataDir
      if (phase === 'spawn') throw failure
      const close = vi.fn(async () => undefined)
      closes.push(close)
      return { result: Promise.reject(failure), close }
    })
    const probe = createRuntimeTargetProbeLauncher({ spawnWorker })

    await expect(probe(artifact())).rejects.toBe(failure)
    expect(closes.every((close) => close.mock.calls.length === 1)).toBe(true)
    await expect(access(dataDir)).rejects.toThrow()
  })

  it('uses a 15 second hard timeout, closes the worker, and cleans the directory', async () => {
    vi.useFakeTimers()
    const controlled = controlledWorker()
    let dataDir = ''
    let signalSpawned!: () => void
    const spawned = new Promise<void>((resolve) => {
      signalSpawned = resolve
    })
    const probe = createRuntimeTargetProbeLauncher({
      spawnWorker: (input) => {
        dataDir = input.dataDir
        signalSpawned()
        return controlled.worker
      },
    })

    const pending = probe(artifact())
    await spawned
    await vi.advanceTimersByTimeAsync(RUNTIME_TARGET_PROBE_TIMEOUT_MS)

    await expect(pending).rejects.toThrow('E_RUNTIME_PROBE_TIMEOUT')
    expect(controlled.close).toHaveBeenCalledOnce()
    await expect(access(dataDir)).rejects.toThrow()
  })

  it('keeps the primary error first when worker close fails and still cleans files', async () => {
    const primary = new Error('candidate invalid')
    const killFailure = new Error('kill failed')
    let dataDir = ''
    const probe = createRuntimeTargetProbeLauncher({
      spawnWorker: (input) => {
        dataDir = input.dataDir
        return { result: Promise.reject(primary), close: async () => Promise.reject(killFailure) }
      },
    })

    const error = await probe(artifact()).catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(AggregateError)
    expect((error as AggregateError).errors).toEqual([primary, killFailure])
    await expect(access(dataDir)).rejects.toThrow()
  })

  it('cleans the probe directory after timeout even when SIGKILL never produces exit', async () => {
    vi.useFakeTimers()
    const child = {
      exitCode: null,
      signalCode: null,
      once: vi.fn(() => child),
      kill: vi.fn(() => true),
    }
    const processFactory = spawnRuntimeTargetProbeWorker({
      executable: '/runtime/node',
      spawn: vi.fn(() => child) as never,
    })
    let dataDir = ''
    let signalSpawned!: () => void
    const spawned = new Promise<void>((resolve) => {
      signalSpawned = resolve
    })
    const probe = createRuntimeTargetProbeLauncher({
      spawnWorker: (input) => {
        dataDir = input.dataDir
        signalSpawned()
        return processFactory(input)
      },
    })

    const observed = probe(artifact()).catch((error: unknown) => error)
    await spawned
    await vi.advanceTimersByTimeAsync(RUNTIME_TARGET_PROBE_TIMEOUT_MS)
    await vi.advanceTimersByTimeAsync(RUNTIME_TARGET_PROBE_REAP_TIMEOUT_MS)

    const error = await observed
    expect(error).toBeInstanceOf(AggregateError)
    expect((error as AggregateError).errors).toEqual([
      expect.objectContaining({ code: 'E_RUNTIME_PROBE_TIMEOUT' }),
      expect.objectContaining({ code: 'E_RUNTIME_PROBE_PROCESS' }),
    ])
    await expect(access(dataDir)).rejects.toThrow()
  })

  it('does not expose business state or the current worker to the isolated factory', async () => {
    const business = { sessions: 3, reports: 2, sqliteWrites: 0, currentWorker: '@shared' }
    let keys: readonly string[] = []
    const probe = createRuntimeTargetProbeLauncher({
      spawnWorker: (input) => {
        keys = Object.keys(input).sort()
        return { result: Promise.resolve(), close: async () => undefined }
      },
    })

    await probe(artifact())

    expect(keys).toEqual(['dataDir', 'env', 'targetFile', 'workerKey', 'workerKind'])
    expect(business).toEqual({ sessions: 3, reports: 2, sqliteWrites: 0, currentWorker: '@shared' })
  })
})

describe('child process probe adapter', () => {
  it('spawns the configured executable with the isolated env and maps exit zero to success', async () => {
    const listeners = new Map<string, (...args: never[]) => void>()
    const child = {
      exitCode: null,
      signalCode: null,
      once: vi.fn((event: string, listener: (...args: never[]) => void) => {
        listeners.set(event, listener)
        return child
      }),
      kill: vi.fn(() => true),
    }
    const spawn = vi.fn(() => child)
    const factory = spawnRuntimeTargetProbeWorker({
      executable: '/runtime/node',
      args: ['/runtime/probe-entry.js'],
      spawn: spawn as never,
    })
    const input: RuntimeTargetProbeWorkerInput = {
      workerKey: `@probe:${artifact().digest}`,
      workerKind: 'probe',
      dataDir: '/private/probe',
      targetFile: '/private/probe/runtime-target.json',
      env: { AGNES_RUNTIME_TARGET_FILE: '/private/probe/runtime-target.json' },
    }

    const worker = await factory(input)
    listeners.get('exit')?.(0 as never, null as never)
    await expect(worker.result).resolves.toBeUndefined()
    expect(spawn).toHaveBeenCalledWith('/runtime/node', ['/runtime/probe-entry.js'], {
      cwd: '/private/probe',
      env: input.env,
      stdio: 'ignore',
      windowsHide: true,
    })
    await worker.close('finished')
    expect(child.kill).not.toHaveBeenCalled()
  })

  it('reports validation failure from a non-zero exit and does not kill an exited process', async () => {
    const listeners = new Map<string, (...args: never[]) => void>()
    const child = {
      exitCode: null,
      signalCode: null,
      once: vi.fn((event: string, listener: (...args: never[]) => void) => {
        listeners.set(event, listener)
        return child
      }),
      kill: vi.fn(() => true),
    }
    const factory = spawnRuntimeTargetProbeWorker({
      executable: '/runtime/node',
      spawn: vi.fn(() => child) as never,
    })
    const worker = factory({
      workerKey: `@probe:${artifact().digest}`,
      workerKind: 'probe',
      dataDir: '/private/probe',
      targetFile: '/private/probe/runtime-target.json',
      env: {},
    })
    listeners.get('exit')?.(7 as never, null as never)
    await expect(worker.result).rejects.toThrow('E_RUNTIME_PROBE_PROCESS')
    await worker.close('failed')
    expect(child.kill).not.toHaveBeenCalled()
  })

  it('reports a failed SIGKILL attempt without hiding it', async () => {
    const child = {
      exitCode: null,
      signalCode: null,
      once: vi.fn(() => child),
      kill: vi.fn(() => false),
    }
    const factory = spawnRuntimeTargetProbeWorker({
      executable: '/runtime/node',
      spawn: vi.fn(() => child) as never,
    })
    const worker = factory({
      workerKey: `@probe:${artifact().digest}`,
      workerKind: 'probe',
      dataDir: '/private/probe',
      targetFile: '/private/probe/runtime-target.json',
      env: {},
    })

    await expect(worker.close('timed-out')).rejects.toThrow('probe worker could not be terminated')
    expect(child.kill).toHaveBeenCalledWith('SIGKILL')
  })

  it('treats a child that exits during SIGKILL as already reaped even when kill returns false', async () => {
    const listeners = new Map<string, (...args: never[]) => void>()
    const child = {
      exitCode: null,
      signalCode: null,
      once: vi.fn((event: string, listener: (...args: never[]) => void) => {
        listeners.set(event, listener)
        return child
      }),
      kill: vi.fn(() => {
        listeners.get('exit')?.(0 as never, 'SIGKILL' as never)
        return false
      }),
    }
    const factory = spawnRuntimeTargetProbeWorker({
      executable: '/runtime/node',
      spawn: vi.fn(() => child) as never,
    })
    const worker = factory({
      workerKey: `@probe:${artifact().digest}`,
      workerKind: 'probe',
      dataDir: '/private/probe',
      targetFile: '/private/probe/runtime-target.json',
      env: {},
    })

    await expect(worker.close('timed-out')).resolves.toBeUndefined()
  })

  it('bounds reap when SIGKILL succeeds but the child never reports exit', async () => {
    vi.useFakeTimers()
    const child = {
      exitCode: null,
      signalCode: null,
      once: vi.fn(() => child),
      kill: vi.fn(() => true),
    }
    const factory = spawnRuntimeTargetProbeWorker({
      executable: '/runtime/node',
      spawn: vi.fn(() => child) as never,
    })
    const worker = factory({
      workerKey: `@probe:${artifact().digest}`,
      workerKind: 'probe',
      dataDir: '/private/probe',
      targetFile: '/private/probe/runtime-target.json',
      env: {},
    })

    const closing = worker.close('timed-out')
    const rejected = expect(closing).rejects.toThrow('did not exit within 1000 ms after SIGKILL')
    await vi.advanceTimersByTimeAsync(RUNTIME_TARGET_PROBE_REAP_TIMEOUT_MS)

    await rejected
    expect(child.kill).toHaveBeenCalledWith('SIGKILL')
  })
})
