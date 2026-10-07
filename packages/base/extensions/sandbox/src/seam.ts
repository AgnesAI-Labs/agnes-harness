import type { Enforcement, SandboxSeam, SeamWorkspace } from '@agnes/core'
import { expandShell } from '../../../src/sandbox-shell.js'
import type { SeamFactory } from '../../../src/seam-init.js'

const fault = (code: string, message: string): Error & { code: string } =>
  Object.assign(new Error(`${code}: ${message}`), { code })

const unavailable = (): never => {
  throw fault('E_WORKSPACE_REQUIRED', 'sandbox seam is not bound to a workspace')
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

async function bindWorkspace(workspace: SeamWorkspace): Promise<SandboxSeam> {
  assertWorkspace(workspace)
  const backend = await workspace.readiness.ready(workspace.signal)
  const policy = workspace.policy
  const forWorkspace = (next: SeamWorkspace): Promise<SandboxSeam> => bindWorkspace(next)
  const providerId = workspace.providerId
  const external = providerId !== undefined && providerId !== 'local'
  const bound: SandboxSeam = {
    forWorkspace,
    async exec(cmd, opts) {
      const raw = expandShell(cmd, workspace.shell, workspace.shellCommand)
      // The selected provider owns the process. Wrapping the argv in the host
      // OS sandbox and then handing that argv to the provider would fake both.
      if (external && providerId !== undefined) {
        return workspace.exec([...raw], {
          ...opts,
          sandbox: {
            policyDigest: policy.digest,
            backend: workspace.execBackend,
            provider: providerId,
          },
        })
      }
      const argv = await backend.confine({ argv: raw, cwd: opts.cwd })
      return workspace.exec([...argv], {
        ...opts,
        sandbox: { policyDigest: policy.digest, backend: workspace.execBackend },
      })
    },
    async confine(argv) {
      if (external)
        throw fault('SANDBOX_UNAVAILABLE', 'the selected sandbox provider does not rewrite host argv')
      return [...(await backend.confine({ argv, cwd: workspace.root }))]
    },
    fsPolicy: () => policy,
    enforcement(): Enforcement {
      if (workspace.binding().policyDigest !== policy.digest) return { level: 'none', scope: [] }
      if (external) return { level: 'partial', scope: ['process'] }
      return {
        level: workspace.enforcement.level,
        scope: [...workspace.enforcement.scope],
      }
    },
  }
  return Object.freeze(bound)
}

/**
 * Package-level sandbox factory. Host supplies the policy and root-bound readiness only when it
 * constructs a session workspace; this object has no raw probe and cannot compile another policy.
 */
export const sandboxSeam: SeamFactory<SandboxSeam> = async () =>
  Object.freeze<SandboxSeam>({
    forWorkspace: (workspace: SeamWorkspace) => bindWorkspace(workspace),
    exec: async () => unavailable(),
    confine: async () => unavailable(),
    fsPolicy: unavailable,
    enforcement: (): Enforcement => ({ level: 'none', scope: [] }),
  })
