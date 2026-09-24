import type { Enforcement, SandboxExecBackend, SandboxWorkspaceBackend } from '@agnes/core'
import type { Logger } from '@agnes/extension-api'
import { decideBackendAvailability } from './availability.js'
import { type BackendProbeExec, type DetectBackendInput, detectBackend } from './backend-runtime.js'
import { requireClosedNetwork, validateArgv } from './backends/shared.js'

export type SandboxWorkspaceProbeInput = Readonly<{
  level: 'L0' | 'L1'
  required: boolean
  onUnavailable: 'deny' | 'allow'
  shell: DetectBackendInput['shell']
  options: DetectBackendInput['options']
  probeExec: BackendProbeExec
  log: Logger
  signal?: AbortSignal
}>

/** Host-private probe result. SandboxReadinessManager exposes only its `confine` surface to Base. */
export type ProbedSandboxWorkspace = SandboxWorkspaceBackend &
  Readonly<{
    name: 'none' | 'bwrap' | 'seatbelt'
    execBackend: SandboxExecBackend
    enforcement: Enforcement
    degraded: boolean
  }>

const fault = (code: string, message: string): Error & { code: string } =>
  Object.assign(new Error(`${code}: ${message}`), { code })

/** Pure package-owned backend compiler. Host owns and supplies the revocable raw probe per call. */
export async function sandboxWorkspaceProbe(
  input: SandboxWorkspaceProbeInput,
): Promise<ProbedSandboxWorkspace> {
  const backend = await detectBackend(input)
  const available = backend.name !== 'none'
  const availability = decideBackendAvailability({
    available,
    required: input.required,
    onUnavailable: input.onUnavailable,
  })
  if (availability.action === 'refuse-init')
    throw fault('E_SANDBOX_WORKSPACE', `no sandbox backend is available: ${availability.reason}`)
  const degraded = availability.action === 'allow-unconfined'
  if (degraded) requireClosedNetwork(input.options.networkAllow)
  const denyOperations = availability.action === 'deny-operation'
  const enforcement: Enforcement = available ? backend.enforcement : { level: 'partial', scope: ['file'] }
  const result: ProbedSandboxWorkspace = {
    name: backend.name,
    execBackend: available ? 'l1' : 'none',
    enforcement: { ...enforcement, scope: [...enforcement.scope] },
    degraded,
    confine(request) {
      if (available) return backend.confine(request.argv, { ...input.options, cwd: request.cwd })
      if (denyOperations)
        throw fault('SANDBOX_UNAVAILABLE', 'no sandbox backend is available for this workspace')
      return validateArgv(request.argv)
    },
  }
  Object.freeze(result.enforcement.scope)
  Object.freeze(result.enforcement)
  return Object.freeze(result)
}
