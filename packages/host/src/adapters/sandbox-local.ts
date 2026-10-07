import {
  LOCAL_SANDBOX_PROVIDER_ID,
  type SandboxCapabilities,
  type SandboxPlatform,
  type SandboxProvider,
  sandboxUnavailable,
} from '@agnes/extension-api'
import type { ExecAdapter } from './exec.js'

function platformOf(os: string): readonly SandboxPlatform[] {
  if (os === 'darwin' || os === 'linux' || os === 'win32') return Object.freeze([os])
  return Object.freeze([])
}

/**
 * Adapts the Host spawner to the public execution entry. The Base OS compiler supplies
 * confined argv and its probed enforcement; the Host supplies the bound per-call policy.
 * Direct unbound calls are refused. An explicit L0 preset reports no process confinement.
 */
export function createLocalSandboxProvider(
  exec: ExecAdapter,
  os: string,
  options: { ownProcesses?: boolean } = {},
): SandboxProvider {
  const platform = platformOf(os)
  const capabilities: SandboxCapabilities = Object.freeze({
    network: true,
    programmatic: os !== 'win32',
    fsWrite: Object.freeze([]),
    platform,
    available: platform.length > 0,
    ...(platform.length > 0 ? {} : { unavailableReason: `unsupported platform ${os}` }),
  })
  return {
    id: LOCAL_SANDBOX_PROVIDER_ID,
    version: '0.0.0',
    capabilities,
    create(config, signal) {
      signal?.throwIfAborted()
      let disposed = false
      const controllers = new Set<AbortController>()
      const processes = new Set<import('@agnes/extension-api').SandboxProcess>()
      const pending = new Set<Promise<Awaited<ReturnType<ExecAdapter['run']>>>>()
      return {
        id: LOCAL_SANDBOX_PROVIDER_ID,
        capabilities,
        async openProcess(request) {
          if (disposed || !exec.openProcess)
            throw sandboxUnavailable('local interactive execution is unavailable')
          request.signal?.throwIfAborted()
          if (
            !request.policy ||
            !request.enforcement ||
            (config.workspaceRoot && config.workspaceRoot !== request.policy.workspaceRoot)
          )
            throw sandboxUnavailable('interactive execution requires a bound policy')
          const required = request.policy.requiredEnforcement,
            actual = request.enforcement
          if (
            (required.level === 'full' && actual.level !== 'full') ||
            required.scope.some((scope) => !actual.scope.includes(scope))
          )
            throw sandboxUnavailable('interactive execution cannot enforce this policy')
          const handle = await exec.openProcess([...request.argv], {
            cwd: request.cwd,
            ...(request.env ? { env: { ...request.env } } : {}),
            ...(request.pty ? { pty: request.pty } : {}),
            ...(request.signal ? { signal: request.signal } : {}),
          })
          const bound = { ...handle, enforcement: actual }
          processes.add(bound)
          void bound.exited.then(() => processes.delete(bound))
          if (disposed) {
            await bound.close()
            throw sandboxUnavailable('workspace sandbox was disposed during launch')
          }
          return bound
        },
        async exec(request) {
          if (request.bridge && !capabilities.programmatic)
            throw sandboxUnavailable('programmatic transport is unavailable on this platform')
          if (disposed) throw sandboxUnavailable('the workspace sandbox instance is disposed')
          request.signal?.throwIfAborted()
          if (!capabilities.available)
            throw sandboxUnavailable(capabilities.unavailableReason ?? 'local sandbox is unavailable')
          if (!request.policy || !request.enforcement)
            throw sandboxUnavailable(
              'the local provider requires a bound execution policy and OS enforcement result',
            )
          if (config.workspaceRoot && request.policy.workspaceRoot !== config.workspaceRoot)
            throw sandboxUnavailable('the execution policy names a different workspace')
          if (request.network && request.policy.network.mode === 'deny')
            throw sandboxUnavailable('the local sandbox provider does not grant network access')
          const actual = request.enforcement
          const required = request.policy.requiredEnforcement
          if (
            (required.level === 'full' && actual.level !== 'full') ||
            required.scope.some((scope) => !actual.scope.includes(scope))
          )
            throw sandboxUnavailable('the local OS sandbox cannot enforce this policy')
          const controller = new AbortController()
          controllers.add(controller)
          const invocation = exec.run([...request.argv], {
            cwd: request.cwd,
            ...(request.env === undefined ? {} : { env: { ...request.env } }),
            ...(request.stdin === undefined ? {} : { stdin: request.stdin }),
            ...(request.bridge ? { bridge: request.bridge } : {}),
            signal: request.signal ? AbortSignal.any([request.signal, controller.signal]) : controller.signal,
            ...(request.limits?.timeoutMs === undefined ? {} : { timeoutMs: request.limits.timeoutMs }),
            ...(request.limits?.maxOutputBytes === undefined
              ? {}
              : { maxOutputBytes: request.limits.maxOutputBytes }),
          })
          pending.add(invocation)
          let result: Awaited<typeof invocation>
          try {
            result = await invocation
          } finally {
            controllers.delete(controller)
            pending.delete(invocation)
          }
          return {
            code: result.code,
            stdout: result.stdout,
            stderr: result.stderr,
            truncated: result.truncated,
            timedOut: result.timedOut,
            enforcement: actual,
            ...(result.signal === undefined ? {} : { signal: result.signal }),
          }
        },
        async dispose() {
          disposed = true
          for (const controller of controllers) controller.abort(new Error('workspace sandbox disposed'))
          await Promise.allSettled([...pending])
          await Promise.all([...processes].map((handle) => handle.close()))
          if (options.ownProcesses) await exec.killAll()
        },
      }
    },
  }
}
