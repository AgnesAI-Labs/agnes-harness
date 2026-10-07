import { type ChildProcess, spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import {
  type SandboxCapabilities,
  type SandboxExecRequest,
  type SandboxExecResult,
  type SandboxFsWriteScope,
  type SandboxPlatform,
  type SandboxProvider,
  type SandboxProviderConfig,
  type SandboxProviderRegistration,
  sandboxUnavailable,
} from '@agnes/extension-api'

const DEFAULT_IMAGE = 'alpine:3.20'
const DEFAULT_MAX_OUTPUT = 1024 * 1024

export type DockerProbe = (signal?: AbortSignal) => Promise<SandboxCapabilities>

function hostPlatform(): readonly SandboxPlatform[] {
  if (process.platform === 'darwin' || process.platform === 'linux' || process.platform === 'win32')
    return Object.freeze([process.platform])
  return Object.freeze([])
}

function missing(reason: string): SandboxCapabilities {
  return Object.freeze({
    network: false,
    fsWrite: Object.freeze([]),
    platform: hostPlatform(),
    available: false,
    unavailableReason: reason,
  })
}

/** Ask the docker CLI whether a daemon is reachable. A failure stays unavailable. */
export function probeDocker(signal?: AbortSignal): Promise<SandboxCapabilities> {
  return new Promise((resolve) => {
    let settled = false
    const finish = (capabilities: SandboxCapabilities) => {
      if (settled) return
      settled = true
      resolve(capabilities)
    }
    let child: ChildProcess
    try {
      child = spawn('docker', ['version', '--format', '{{.Server.Version}}'], {
        stdio: ['ignore', 'ignore', 'ignore'],
        windowsHide: true,
      })
    } catch {
      finish(missing('docker CLI is not available'))
      return
    }
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      finish(missing('docker CLI is not available'))
    }, 5_000)
    const onAbort = () => {
      child.kill('SIGKILL')
      finish(missing('docker CLI is not available'))
    }
    signal?.addEventListener('abort', onAbort, { once: true })
    child.on('error', () => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      finish(missing('docker CLI is not available'))
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      finish(
        code === 0
          ? Object.freeze({
              network: true,
              fsWrite: Object.freeze([]),
              platform: hostPlatform(),
              available: true,
            })
          : missing('docker CLI is not available'),
      )
    })
  })
}

function assertPath(path: string): void {
  if (
    typeof path !== 'string' ||
    path.length === 0 ||
    path.includes('\0') ||
    path.includes(',') ||
    path.includes('\n')
  )
    throw sandboxUnavailable('sandbox path is not a bindable absolute path')
  if (
    process.platform === 'win32'
      ? !/^[A-Za-z]:[\\/]/.test(path) && !path.startsWith('\\\\')
      : !path.startsWith('/')
  )
    throw sandboxUnavailable('sandbox path is not absolute')
}

function imageOf(config: SandboxProviderConfig): string {
  const image = config.options?.image ?? DEFAULT_IMAGE
  if (!/^[A-Za-z0-9][A-Za-z0-9_./:-]{0,200}$/.test(image))
    throw sandboxUnavailable('docker image name is invalid')
  return image
}

type Live = { child: ChildProcess; name: string }

function capture(
  stream: NodeJS.ReadableStream | null,
  max: number,
  sink: { text: string; truncated: boolean },
): void {
  stream?.on('data', (chunk: Buffer | string) => {
    const text = typeof chunk === 'string' ? chunk : chunk.toString('utf8')
    const room = max - sink.text.length
    if (room <= 0) {
      sink.truncated = true
      return
    }
    if (text.length > room) {
      sink.text += text.slice(0, room)
      sink.truncated = true
      return
    }
    sink.text += text
  })
}

/**
 * Run commands in a Docker container through the docker CLI.
 * When the CLI or daemon is missing, capabilities stay unavailable and exec refuses.
 * This provider does not run the command on the host instead.
 */
export function createDockerSandboxProvider(probe: DockerProbe = probeDocker): SandboxProvider {
  let capabilities: SandboxCapabilities = missing('docker CLI has not been probed')
  return {
    id: 'docker',
    version: '0.0.0',
    get capabilities() {
      return capabilities
    },
    probe(signal) {
      return Promise.resolve(probe(signal)).then((next) => {
        capabilities = next
        return next
      })
    },
    async create(config) {
      const probed = await probe()
      capabilities = probed
      const image = imageOf(config)
      const workspace = config.workspaceRoot
      if (workspace !== undefined) assertPath(workspace)
      const instanceCapabilities: SandboxCapabilities = probed.available
        ? Object.freeze({
            network: true,
            fsWrite: Object.freeze(workspace === undefined ? [] : [Object.freeze({ path: workspace })]),
            platform: hostPlatform(),
            available: true,
          })
        : probed
      const live = new Set<Live>()
      const kill = (entry: Live) => {
        entry.child.kill('SIGKILL')
        const killer = spawn('docker', ['kill', entry.name], { stdio: 'ignore', windowsHide: true })
        killer.on('error', () => {})
        killer.unref()
      }
      return {
        id: 'docker',
        capabilities: instanceCapabilities,
        exec(request) {
          if (!instanceCapabilities.available)
            return Promise.reject(
              sandboxUnavailable(instanceCapabilities.unavailableReason ?? 'docker CLI is not available'),
            )
          return runContainer(request, image, workspace, instanceCapabilities, live, kill)
        },
        dispose() {
          for (const entry of live) kill(entry)
          live.clear()
        },
      }
    },
  }
}

function mountsFor(
  request: SandboxExecRequest,
  workspace: string | undefined,
): readonly SandboxFsWriteScope[] {
  const requested = request.fsWrite ?? (workspace === undefined ? [] : [{ path: workspace }])
  for (const scope of requested) assertPath(scope.path)
  return requested
}

function runContainer(
  request: SandboxExecRequest,
  image: string,
  workspace: string | undefined,
  capabilities: SandboxCapabilities,
  live: Set<Live>,
  kill: (entry: Live) => void,
): Promise<SandboxExecResult> {
  if (request.argv.length === 0 || request.argv.some((arg) => typeof arg !== 'string' || arg.includes('\0')))
    return Promise.reject(sandboxUnavailable('empty argv'))
  if (request.network && !capabilities.network)
    return Promise.reject(sandboxUnavailable('this sandbox provider does not grant network access'))
  assertPath(request.cwd)
  const writes = mountsFor(request, workspace)
  if (request.fsWrite !== undefined && request.fsWrite.length > 0 && !capabilities.available)
    return Promise.reject(sandboxUnavailable('write scopes cannot be enforced'))
  const name = `agh${randomBytes(8).toString('hex')}`
  const args = ['run', '--rm', '--name', name, '--network', request.network ? 'bridge' : 'none']
  if (writes.length === 0) args.push('--read-only')
  for (const scope of writes) args.push('--mount', `type=bind,src=${scope.path},dst=${scope.path}`)
  args.push('-w', request.cwd)
  for (const [key, value] of Object.entries(request.env ?? {})) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || value.includes('\0') || value.includes('\n'))
      return Promise.reject(sandboxUnavailable('sandbox env is invalid'))
    args.push('-e', `${key}=${value}`)
  }
  args.push(image, ...request.argv)
  return new Promise((resolve, reject) => {
    if (request.signal?.aborted) {
      reject(
        request.signal.reason instanceof Error
          ? request.signal.reason
          : sandboxUnavailable('aborted before start'),
      )
      return
    }
    let child: ChildProcess
    try {
      child = spawn('docker', args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
    } catch (error) {
      reject(sandboxUnavailable(error instanceof Error ? error.message : 'docker CLI is not available'))
      return
    }
    const entry = { child, name }
    live.add(entry)
    const max = request.limits?.maxOutputBytes ?? DEFAULT_MAX_OUTPUT
    const stdout = { text: '', truncated: false }
    const stderr = { text: '', truncated: false }
    capture(child.stdout, max, stdout)
    capture(child.stderr, max, stderr)
    let timedOut = false
    let cancelled = false
    const timer = setTimeout(() => {
      timedOut = true
      kill(entry)
    }, request.limits?.timeoutMs ?? 120_000)
    const onAbort = () => {
      cancelled = true
      kill(entry)
    }
    request.signal?.addEventListener('abort', onAbort, { once: true })
    child.on('error', (error) => {
      clearTimeout(timer)
      request.signal?.removeEventListener('abort', onAbort)
      live.delete(entry)
      reject(sandboxUnavailable(error.message))
    })
    child.on('close', (code, signal) => {
      clearTimeout(timer)
      request.signal?.removeEventListener('abort', onAbort)
      live.delete(entry)
      const ended = signal ?? (cancelled ? 'SIGKILL' : undefined)
      resolve({
        code: code ?? -1,
        stdout: stdout.text,
        stderr: stderr.text,
        truncated: stdout.truncated || stderr.truncated,
        timedOut,
        ...(ended === undefined || ended === null ? {} : { signal: ended }),
      })
    })
    child.stdin?.on('error', () => {})
    if (request.stdin !== undefined) child.stdin?.end(request.stdin)
    else child.stdin?.end()
  })
}

export const dockerSandboxProvider = createDockerSandboxProvider()

/** Cordis plugin. Injects `sandboxProviders` and registers this provider. */
export const sandboxProvidersPlugin = {
  inject: ['sandboxProviders'],
  apply(ctx: { sandboxProviders: SandboxProviderRegistration }) {
    ctx.sandboxProviders.register(createDockerSandboxProvider())
  },
}
