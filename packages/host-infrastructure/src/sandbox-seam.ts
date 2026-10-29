import type { Enforcement, SandboxSeam, SeamWorkspace } from '@agnes/core'
import { type SandboxExecutionPolicy, SHELL_SENTINEL, SHELL_STDIN_SENTINEL } from '@agnes/extension-api'

const fault = (code: string, message: string): Error & { code: string } =>
  Object.assign(new Error(`${code}: ${message}`), { code })

const unbound = (): never => {
  throw fault('E_WORKSPACE_REQUIRED', 'sandbox seam is not bound to a workspace')
}

/** Expansion is argument construction only. It provides no OS isolation. */
export function expandShell(
  argv: string[],
  dialect: 'posix' | 'powershell',
  shellCommand?: (command: string) => string[],
): string[] {
  if (
    !Array.isArray(argv) ||
    argv.length === 0 ||
    !argv[0] ||
    argv.some((arg) => typeof arg !== 'string' || arg.includes('\0')) ||
    (dialect !== 'posix' && dialect !== 'powershell')
  )
    throw new Error('invalid sandbox command')
  if (argv[0] === SHELL_STDIN_SENTINEL) throw new Error('stdin shell requires openProcess')
  if (argv[0] !== SHELL_SENTINEL) return [...argv]
  // Never silently discard arguments or turn a missing command into successful empty execution.
  if (argv.length !== 2 || !argv[1]) throw new Error('invalid sandbox shell command')
  if (dialect === 'powershell' && shellCommand) return shellCommand(argv[1])
  return dialect === 'posix' ? ['sh', '-c', argv[1]] : ['pwsh', '-NoProfile', '-Command', argv[1]]
}

function assertWorkspace(workspace: SeamWorkspace): void {
  if (
    !workspace ||
    typeof workspace !== 'object' ||
    typeof workspace.root !== 'string' ||
    workspace.root.length === 0 ||
    workspace.root.includes('\0') ||
    workspace.policy?.workspaceRoot !== workspace.root ||
    !/^[a-f0-9]{64}$/.test(workspace.policy?.digest ?? '') ||
    typeof workspace.readiness?.ready !== 'function' ||
    typeof workspace.exec !== 'function' ||
    typeof workspace.binding !== 'function' ||
    (workspace.execBackend !== 'none' &&
      workspace.execBackend !== 'l1' &&
      workspace.execBackend !== 'remote') ||
    (workspace.shell !== 'posix' && workspace.shell !== 'powershell') ||
    (workspace.providerId !== undefined && !/^[a-z][a-z0-9-]{0,63}$/.test(workspace.providerId))
  )
    throw fault('E_SANDBOX_WORKSPACE', 'Host supplied an invalid bound workspace')
}

/**
 * A remote workspace runs every command on the other machine through the Host's gate. The binding
 * stamped on a request is checked against what the Host bound, and the gate authorizes `cwd`
 * against that policy over the remote fence before anything is shipped. `confine` is a refusal,
 * not a degraded local wrapper: a caller that spawns its own process would spawn on this machine,
 * which is a different destination, not a weaker form of running remotely.
 */
async function bindRemote(workspace: SeamWorkspace): Promise<SandboxSeam> {
  if (workspace.binding().policyDigest !== workspace.policy.digest)
    throw fault('E_SANDBOX_WORKSPACE', 'the remote workspace is not bound to its Host policy')
  await workspace.readiness.ready(workspace.signal)
  const bound: SandboxSeam = {
    forWorkspace: bindWorkspace,
    exec: (cmd, opts) => {
      if (cmd[0] === SHELL_STDIN_SENTINEL)
        return Promise.reject(
          fault('SANDBOX_UNAVAILABLE', 'stdin shell requires a provider openProcess port'),
        )
      return workspace.exec(cmd, {
        ...opts,
        sandbox: { policyDigest: workspace.policy.digest, backend: 'remote' },
      })
    },
    confine: async () => {
      throw new Error(
        'confine() is unavailable under a remote sandbox: use exec(), which runs on the remote host',
      )
    },
    fsPolicy: () => workspace.policy,
    enforcement: () => ({ level: workspace.enforcement.level, scope: [...workspace.enforcement.scope] }),
  }
  return Object.freeze(bound)
}

async function bindLocal(workspace: SeamWorkspace): Promise<SandboxSeam> {
  const backend = await workspace.readiness.ready(workspace.signal)
  const policy = workspace.policy
  const providerId = workspace.providerId
  // An external provider owns the process; wrapping the argv in the host OS sandbox and then
  // handing it to the provider would fake both.
  const external = providerId !== undefined && providerId !== 'local'
  const deny = Object.freeze(policy.rules.filter((rule) => rule.effect === 'deny').map((rule) => rule.path))
  // The Host supplies the authoritative write domain after binding the selected preset.
  const executionPolicy: SandboxExecutionPolicy = Object.freeze({
    workspaceRoot: workspace.root,
    digest: policy.digest,
    fsRead: Object.freeze({ allow: Object.freeze(['/']), deny }),
    fsWrite: Object.freeze({
      allow: Object.freeze(policy.rules.filter((rule) => rule.effect === 'allow').map((rule) => rule.path)),
      deny,
    }),
    network: Object.freeze({
      mode: policy.loopbackServe
        ? ('loopback-serve' as const)
        : policy.networkAllow.length
          ? ('hosts' as const)
          : ('deny' as const),
      hosts: policy.networkAllow,
    }),
    requiredEnforcement: workspace.enforcement,
  })
  const bound: SandboxSeam = {
    forWorkspace: bindWorkspace,
    async openProcess(request) {
      if (!workspace.openProcess)
        throw fault('SANDBOX_UNAVAILABLE', 'interactive process backend is unavailable')
      const singleCommand =
        (request.argv.length === 2 && request.argv[0] === SHELL_SENTINEL) ||
        (request.argv.length === 3 && request.argv[0] === 'sh' && request.argv[1] === '-c')
      if (policy.loopbackServe && (request.pty || !singleCommand))
        throw fault(
          'SANDBOX_UNAVAILABLE',
          'loopback serving requires one shell command; persistent shells and PTYs are unsupported',
        )
      const cwd = request.cwd ?? workspace.root
      const stdinShell = request.argv[0] === SHELL_STDIN_SENTINEL
      if (stdinShell && (request.argv.length !== 1 || request.pty || workspace.shell !== 'powershell'))
        throw fault('SANDBOX_UNAVAILABLE', 'invalid configured stdin shell request')
      const raw = stdinShell
        ? [SHELL_STDIN_SENTINEL]
        : expandShell([...request.argv], workspace.shell, workspace.shellCommand)
      const argv = external ? raw : [...(await backend.confine({ argv: raw, cwd }))]
      return workspace.openProcess(argv, {
        cwd,
        ...(request.signal ? { signal: request.signal } : {}),
        ...(request.env ? { env: { ...request.env } } : {}),
        ...(request.pty ? { pty: request.pty } : {}),
        sandbox: {
          policyDigest: policy.digest,
          backend: workspace.execBackend,
          ...(external && providerId ? { provider: providerId } : {}),
          policy: executionPolicy,
          ...(external
            ? {}
            : {
                enforcement:
                  workspace.execBackend === 'l1' ? workspace.enforcement : { level: 'none', scope: [] },
              }),
        },
      })
    },
    async exec(cmd, opts) {
      const raw = expandShell(cmd, workspace.shell, workspace.shellCommand)
      if (external && providerId !== undefined) {
        return workspace.exec([...raw], {
          ...opts,
          sandbox: {
            policyDigest: policy.digest,
            backend: workspace.execBackend,
            provider: providerId,
            policy: executionPolicy,
          },
        })
      }
      const argv = await backend.confine({ argv: raw, cwd: opts.cwd })
      return workspace.exec([...argv], {
        ...opts,
        sandbox: {
          policyDigest: policy.digest,
          backend: workspace.execBackend,
          policy: executionPolicy,
          enforcement: workspace.execBackend === 'l1' ? workspace.enforcement : { level: 'none', scope: [] },
        },
      })
    },
    async confine(argv) {
      if (workspace.execBackend === 'none' && workspace.requiredFileIsolation)
        throw fault('SANDBOX_UNAVAILABLE', 'protected files require OS isolation; unconfined argv is refused')
      if (external)
        throw fault('SANDBOX_UNAVAILABLE', 'the selected sandbox provider does not rewrite host argv')
      return [...(await backend.confine({ argv, cwd: workspace.root }))]
    },
    fsPolicy: () => policy,
    enforcement(): Enforcement {
      if (workspace.binding().policyDigest !== policy.digest) return { level: 'none', scope: [] }
      if (external) return workspace.enforcement
      return { level: workspace.enforcement.level, scope: [...workspace.enforcement.scope] }
    },
  }
  return Object.freeze(bound)
}

async function bindWorkspace(workspace: SeamWorkspace): Promise<SandboxSeam> {
  assertWorkspace(workspace)
  if (
    workspace.policy.loopbackServe &&
    (workspace.execBackend !== 'l1' ||
      (workspace.providerId !== undefined && workspace.providerId !== 'local'))
  )
    throw fault('SANDBOX_UNAVAILABLE', 'loopback serving requires a local L1 backend')
  return workspace.execBackend === 'remote' ? bindRemote(workspace) : bindLocal(workspace)
}

/**
 * The Host-built sandbox seam. It has no behavior of its own until the Host fits it to one
 * authorized workspace: the policy, the readiness posture and the execution path all arrive on
 * `SeamWorkspace`, and the selected `sandbox` provider (or the Host's remote channel) is what
 * actually runs the process. Before fitting it refuses every operation and reports no enforcement.
 */
export function createSandboxSeam(): SandboxSeam {
  return Object.freeze<SandboxSeam>({
    forWorkspace: bindWorkspace,
    exec: async () => unbound(),
    confine: async () => unbound(),
    fsPolicy: unbound,
    enforcement: (): Enforcement => ({ level: 'none', scope: [] }),
  })
}
