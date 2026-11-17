import {
  type SandboxCapabilities,
  type SandboxEnforcement,
  type SandboxExecutionPolicy,
  type SandboxPlatform,
  type SandboxProvider,
  type SandboxProviderConfig,
  sandboxUnavailable,
} from '@agnes/extension-api'
import { RELEASE_DEFAULTS } from '@agnes/package-manager'
import {
  WINDOWS_ACL_ENFORCEMENT,
  type WindowsAclExecution,
  workspaceRootInvalid,
} from '../windows-acl/execution.js'
import type { WindowsAclLaunchPermit } from '../windows-acl/leases.js'
import { honoursWindowsBoundary } from '../windows-acl/policy.js'
import type { ExecAdapter } from './exec.js'
import { loopbackActivation } from './loopback-activation.js'

function platformOf(os: string): readonly SandboxPlatform[] {
  if (os === 'darwin' || os === 'linux' || os === 'win32') return Object.freeze([os])
  return Object.freeze([])
}

type LaunchRequest = Readonly<{ policy?: SandboxExecutionPolicy; enforcement?: SandboxEnforcement }>

const marked = (request: LaunchRequest) =>
  request.enforcement?.boundary !== undefined || request.policy?.requiredEnforcement.boundary !== undefined

/** An instance without a lease refuses every call that names the Windows partial contract. */
function assertUnleased(request: LaunchRequest): void {
  if (marked(request))
    throw sandboxUnavailable('a Windows write-restricted call needs the Host lease it was decided under')
}

/**
 * The Windows lease an instance was created for, if any. An instance with a lease runs only calls
 * that carry the partial contract, each re-decided and launched under a fresh permit.
 */
function windowsLeaseOf(
  config: SandboxProviderConfig,
  os: string,
  windowsAcl: WindowsAclExecution | undefined,
):
  | {
      permit(request: LaunchRequest): Promise<WindowsAclLaunchPermit>
      release(): Promise<void>
    }
  | undefined {
  const ref = config.executionLease
  if (ref === undefined) return undefined
  if (os !== 'win32' || !windowsAcl || config.workspaceRoot === undefined)
    throw sandboxUnavailable('Windows write-restricted execution is unavailable on this Host')
  const lease = windowsAcl.lease(ref)
  return {
    permit: async (request) => {
      if (!marked(request)) throw sandboxUnavailable('this instance runs only Windows write-restricted calls')
      windowsAcl.check(request, ref)
      return lease.prepareLaunch()
    },
    release: () => windowsAcl.release(ref),
  }
}

/**
 * Adapts the Host spawner to the public execution entry. The Base OS compiler supplies
 * confined argv and its probed enforcement; the Host supplies the bound per-call policy.
 * Direct unbound calls are refused. An explicit L0 preset reports no process confinement.
 */
export function createLocalSandboxProvider(
  exec: ExecAdapter,
  os: string,
  options: {
    ownProcesses?: boolean
    l1Implementation?: SandboxCapabilities['l1Implementation']
    /** Trusted Windows execution authority; present only on a Windows Host that can apply it. */
    windowsAcl?: WindowsAclExecution
  } = {},
): SandboxProvider {
  const platform = platformOf(os)
  const windowsAcl = os === 'win32' ? options.windowsAcl : undefined
  const capabilities: SandboxCapabilities = Object.freeze({
    network: true,
    l1Implementation: options.l1Implementation ?? 'unknown',
    programmatic: os !== 'win32',
    shellStdin: os === 'win32',
    fsWrite: Object.freeze([]),
    // The partial contract this provider can apply; the full L1 fact above is unchanged.
    ...(windowsAcl ? { enforcement: WINDOWS_ACL_ENFORCEMENT } : {}),
    platform,
    available: platform.length > 0,
    ...(platform.length > 0 ? {} : { unavailableReason: `unsupported platform ${os}` }),
  })
  return {
    id: RELEASE_DEFAULTS.sandboxProvider,
    version: '0.0.0',
    capabilities,
    create(config, signal) {
      signal?.throwIfAborted()
      const windowsLease = windowsLeaseOf(config, os, windowsAcl)
      let disposed = false
      const controllers = new Set<AbortController>()
      const activations = new Set<{ close(): void }>()
      const activate = (
        policy: import('@agnes/extension-api').SandboxExecutionPolicy,
        actual: import('@agnes/extension-api').SandboxEnforcement,
        signal?: AbortSignal,
      ) => {
        const activation = loopbackActivation(policy, actual, os)
        if (!activation) return undefined
        const bound = {
          ...activation,
          unwatch() {
            signal?.removeEventListener('abort', bound.close)
          },
          close() {
            activations.delete(bound)
            bound.unwatch()
            activation.close()
          },
        }
        activations.add(bound)
        signal?.addEventListener('abort', bound.close, { once: true })
        if (signal?.aborted) bound.close()
        return bound
      }
      const processes = new Set<import('@agnes/extension-api').SandboxProcess>()
      const pending = new Set<Promise<Awaited<ReturnType<ExecAdapter['run']>>>>()
      // Each launch re-checks the leased root. A root that is gone or is another directory now
      // refuses the launch and stops every process this instance still runs there.
      const permit = async (lease: NonNullable<typeof windowsLease>, request: LaunchRequest) => {
        try {
          return await lease.permit(request)
        } catch (error) {
          if (workspaceRootInvalid(error)) {
            for (const controller of controllers) controller.abort(error)
            await Promise.allSettled([...processes].map((handle) => handle.close()))
          }
          throw error
        }
      }
      return {
        id: RELEASE_DEFAULTS.sandboxProvider,
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
            required.scope.some((scope) => !actual.scope.includes(scope)) ||
            !honoursWindowsBoundary(required, actual)
          )
            throw sandboxUnavailable('interactive execution cannot enforce this policy')
          if (request.pty && actual.boundary)
            throw sandboxUnavailable('a Windows write-restricted process cannot open a PTY')
          if (!windowsLease) assertUnleased(request)
          const launch = windowsLease ? await permit(windowsLease, request) : undefined
          const activation = activate(request.policy, actual, request.signal)
          let handle: import('@agnes/extension-api').SandboxProcess
          try {
            handle = await exec.openProcess([...request.argv], {
              cwd: request.cwd,
              ...(request.stdin === undefined ? {} : { stdin: request.stdin }),
              ...(request.env || activation ? { env: { ...request.env, ...activation?.env } } : {}),
              ...(activation ? { loopbackFd: activation.fd, onExit: activation.close } : {}),
              ...(request.pty ? { pty: request.pty } : {}),
              ...(request.signal ? { signal: request.signal } : {}),
              ...(launch ? { windowsAcl: launch } : {}),
            })
          } catch (error) {
            activation?.close()
            throw error
          } finally {
            // Open is authorized by the call; the returned process belongs to the session.
            // Core aborts the call signal on settlement, including successful background starts.
            activation?.unwatch()
          }
          const bound = {
            ...handle,
            enforcement: actual,
            async close() {
              activation?.close()
              await handle.close()
            },
          }
          processes.add(bound)
          void bound.exited.then((result) => {
            activation?.close()
            if (!result.error) processes.delete(bound)
          })
          if (request.signal?.aborted) {
            await bound.close()
            request.signal.throwIfAborted()
          }
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
          if (request.network && ['deny', 'loopback-serve'].includes(request.policy.network.mode))
            throw sandboxUnavailable('the local sandbox provider does not grant network access')
          const actual = request.enforcement
          const required = request.policy.requiredEnforcement
          if (
            (required.level === 'full' && actual.level !== 'full') ||
            required.scope.some((scope) => !actual.scope.includes(scope)) ||
            !honoursWindowsBoundary(required, actual)
          )
            throw sandboxUnavailable('the local OS sandbox cannot enforce this policy')
          if (!windowsLease) assertUnleased(request)
          const launch = windowsLease ? await permit(windowsLease, request) : undefined
          const activation = activate(request.policy, actual, request.signal)
          const controller = new AbortController()
          controllers.add(controller)
          let invocation: Promise<Awaited<ReturnType<ExecAdapter['run']>>>
          try {
            invocation = exec
              .run([...request.argv], {
                cwd: request.cwd,
                ...(request.env || activation ? { env: { ...request.env, ...activation?.env } } : {}),
                ...(activation ? { loopbackFd: activation.fd, onExit: activation.close } : {}),
                ...(request.stdin === undefined ? {} : { stdin: request.stdin }),
                ...(request.bridge ? { bridge: request.bridge } : {}),
                signal: request.signal
                  ? AbortSignal.any([request.signal, controller.signal])
                  : controller.signal,
                ...(request.limits?.timeoutMs === undefined ? {} : { timeoutMs: request.limits.timeoutMs }),
                ...(request.limits?.maxOutputBytes === undefined
                  ? {}
                  : { maxOutputBytes: request.limits.maxOutputBytes }),
                ...(launch ? { windowsAcl: launch } : {}),
              })
              .finally(() => activation?.close())
          } catch (error) {
            controllers.delete(controller)
            activation?.close()
            throw error
          }
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
            ...(result.stoppedProcesses === undefined ? {} : { stoppedProcesses: result.stoppedProcesses }),
            enforcement: actual,
            ...(result.signal === undefined ? {} : { signal: result.signal }),
          }
        },
        async dispose() {
          disposed = true
          for (const activation of activations) activation.close()
          for (const controller of controllers) controller.abort(new Error('workspace sandbox disposed'))
          await Promise.allSettled([...pending])
          await Promise.all([...processes].map((handle) => handle.close()))
          if (options.ownProcesses) await exec.killAll()
          // Its processes are stopped; the lease releases its temp only once they have exited.
          await windowsLease?.release()
        },
      }
    },
  }
}
