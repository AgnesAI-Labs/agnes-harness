import { spawn as nodeSpawn } from 'node:child_process'
import { lstatSync, realpathSync } from 'node:fs'
import { createServer } from 'node:net'
import { isAbsolute, relative, sep } from 'node:path'
import { type HealthProbe, probeSurfaceHealth } from './health.js'
import type {
  SurfaceEndpoint,
  SurfaceExit,
  SurfaceRuntimeAdapter,
  SurfaceRuntimeHandle,
  SurfaceRuntimeStart,
} from './types.js'
import { startWindowsSurface } from './windows-runtime.js'

export type SurfaceSpawnOptions = Readonly<{
  cwd: string
  env: Readonly<Record<string, string>>
  shell: false
  stdio: 'ignore'
  windowsHide: true
}>

export type SpawnedSurfaceProcess = {
  readonly pid?: number
  readonly exitCode: number | null
  readonly signalCode: NodeJS.Signals | null
  once(event: 'exit', listener: (code: number | null, signal: NodeJS.Signals | null) => void): unknown
  once(event: 'error', listener: (error: Error) => void): unknown
  removeListener(
    event: 'exit',
    listener: (code: number | null, signal: NodeJS.Signals | null) => void,
  ): unknown
  removeListener(event: 'error', listener: (error: Error) => void): unknown
  kill(signal: NodeJS.Signals): boolean
}

export type LocalNodeRuntimeOptions = Readonly<{
  executable?: string
  allocatePort?: () => number | Promise<number>
  spawn?: (executable: string, argv: readonly string[], options: SurfaceSpawnOptions) => SpawnedSurfaceProcess
  healthProbe?: HealthProbe
  cleanup?: (sourceId: string) => void | Promise<void>
}>

export function createLocalNodeRuntime(options: LocalNodeRuntimeOptions = {}): SurfaceRuntimeAdapter {
  const spawn = options.spawn ?? defaultSpawn
  const allocatePort = options.allocatePort ?? allocateLoopbackPort
  const healthProbe = options.healthProbe ?? probeSurfaceHealth
  return {
    kind: 'local-node',
    async start(input) {
      input.signal.throwIfAborted()
      const artifact = validateArtifact(input)
      const port = await allocatePort()
      if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
        throw new Error('surface runtime allocated an invalid port')
      }
      input.signal.throwIfAborted()
      const endpoint: SurfaceEndpoint = {
        host: '127.0.0.1',
        port,
        healthPath: input.surface.descriptor.healthPath,
      }
      const env = Object.freeze({
        NODE_ENV: 'production',
        HOST: endpoint.host,
        PORT: String(endpoint.port),
        AGNES_SURFACE_SOURCE_ID: input.surface.instance.sourceId,
        AGNES_SURFACE_MOUNT: input.surface.instance.mount,
        AGNES_SURFACE_CONFIG: JSON.stringify(input.surface.instance.config),
        AGNES_SURFACE_SECRETS: JSON.stringify(input.secrets),
      })
      let child: SpawnedSurfaceProcess
      const windows = process.platform === 'win32' // guards-allow-platform: owned default Windows Surface process tree.
      if (windows && !options.spawn)
        return startWindowsSurface({
          executable: options.executable ?? process.execPath,
          ...artifact,
          env,
          signal: input.signal,
          endpoint,
          sourceId: input.surface.instance.sourceId,
          probe: healthProbe,
          ...(options.cleanup ? { cleanup: options.cleanup } : {}),
        })
      try {
        child = spawn(options.executable ?? process.execPath, [artifact.entry], {
          cwd: artifact.cwd,
          env,
          shell: false,
          stdio: 'ignore',
          windowsHide: true,
        })
      } catch {
        throw new Error('surface process could not be started')
      }
      return processHandle(child, endpoint, input.surface.instance.sourceId, healthProbe, options.cleanup)
    },
  }
}

function processHandle(
  child: SpawnedSurfaceProcess,
  endpoint: SurfaceEndpoint,
  sourceId: string,
  healthProbe: HealthProbe,
  cleanupHook: LocalNodeRuntimeOptions['cleanup'],
): SurfaceRuntimeHandle {
  let cleanupPromise: Promise<void> | undefined
  let settle!: (exit: SurfaceExit) => void
  const exited = new Promise<SurfaceExit>((resolve) => {
    settle = resolve
  })
  const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
    child.removeListener('error', onError)
    settle(Object.freeze({ code, signal }))
  }
  const onError = () => {
    child.removeListener('exit', onExit)
    settle(Object.freeze({ code: child.exitCode, signal: child.signalCode }))
  }
  child.once('exit', onExit)
  child.once('error', onError)
  return Object.freeze({
    sourceId,
    endpoint,
    ...(child.pid === undefined ? {} : { pid: child.pid }),
    exited,
    probe: (signal: AbortSignal) => healthProbe(endpoint, signal),
    terminate: () => {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM')
    },
    kill: () => {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
    },
    cleanup() {
      cleanupPromise ??= Promise.resolve(cleanupHook?.(sourceId)).catch((error: unknown) => {
        cleanupPromise = undefined
        throw error
      })
      return cleanupPromise
    },
  })
}

function validateArtifact(input: SurfaceRuntimeStart): Readonly<{ entry: string; cwd: string }> {
  if (input.surface.descriptor.artifact.kind !== 'node') {
    throw new Error('local surface runtime supports only node artifacts')
  }
  const { entry, cwd } = input.artifact
  if (!isAbsolute(entry) || !isAbsolute(cwd)) {
    throw new Error('trusted surface artifact resolver returned an invalid entry')
  }
  let realEntry: string
  let realCwd: string
  try {
    const cwdStat = lstatSync(cwd)
    const entryStat = lstatSync(entry)
    if (cwdStat.isSymbolicLink() || entryStat.isSymbolicLink()) throw new Error('symlink')
    if (!cwdStat.isDirectory() || !entryStat.isFile()) throw new Error('invalid')
    realCwd = realpathSync.native(cwd)
    realEntry = realpathSync.native(entry)
  } catch {
    throw new Error('trusted surface artifact resolver returned an unavailable entry')
  }
  const pathFromRoot = relative(realCwd, realEntry)
  const descriptorEntry = input.surface.descriptor.artifact.entry
  const expectedDescriptorEntry = `./${pathFromRoot.split(sep).join('/')}`
  if (
    pathFromRoot.length === 0 ||
    pathFromRoot === '..' ||
    pathFromRoot.startsWith(`..${sep}`) ||
    isAbsolute(pathFromRoot) ||
    descriptorEntry !== expectedDescriptorEntry ||
    !/\.(?:js|mjs|cjs)$/.test(realEntry)
  ) {
    throw new Error('trusted surface artifact resolver returned an invalid entry')
  }
  return Object.freeze({ entry: realEntry, cwd: realCwd })
}

function defaultSpawn(
  executable: string,
  argv: readonly string[],
  options: SurfaceSpawnOptions,
): SpawnedSurfaceProcess {
  return nodeSpawn(executable, [...argv], options) as SpawnedSurfaceProcess
}

async function allocateLoopbackPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer()
    server.unref()
    server.once('error', reject)
    server.listen({ host: '127.0.0.1', port: 0, exclusive: true }, () => {
      const address = server.address()
      if (address === null || typeof address === 'string') {
        server.close(() => reject(new Error('surface port allocation failed')))
        return
      }
      server.close((error) => {
        if (error) reject(new Error('surface port allocation failed'))
        else resolve(address.port)
      })
    })
  })
}
