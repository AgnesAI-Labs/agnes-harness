import type { Enforcement, SandboxExecBackend, SandboxWorkspaceBackend } from '@agnes/core'
import type { Logger } from '@agnes/extension-api'
import { decideBackendAvailability } from './availability.js'
import {
  type BackendProbeExec,
  type DetectBackendInput,
  detectBackend,
  sandboxImplementation,
} from './backend-runtime.js'
import { requireClosedNetwork, validateArgv } from './backends/shared.js'

export type SandboxWorkspaceProbeInput = Readonly<{
  level: 'L0' | 'L1'
  required: boolean
  onUnavailable: 'deny' | 'allow' | 'allow-if-unimplemented'
  platform?: string
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
    implementation: 'implemented' | 'unimplemented' | 'unknown'
    probeState: 'ready' | 'failed' | 'unprobed'
  }>

const fault = (code: string, message: string): Error & { code: string } =>
  Object.assign(new Error(`${code}: ${message}`), { code })

/** Pure package-owned backend compiler. Host owns and supplies the revocable raw probe per call. */
export async function sandboxWorkspaceProbe(
  input: SandboxWorkspaceProbeInput,
): Promise<ProbedSandboxWorkspace> {
  const implementation = sandboxImplementation(input.platform ?? '')
  if (
    input.onUnavailable === 'allow-if-unimplemented' &&
    (input.level !== 'L1' || implementation === 'unknown')
  )
    throw fault(
      'E_SANDBOX_WORKSPACE',
      'conditional isolation requires an L1 request and known implementation',
    )
  if (
    input.options.loopbackServe &&
    input.onUnavailable !== 'deny' &&
    input.onUnavailable !== 'allow-if-unimplemented'
  )
    throw fault('E_SANDBOX_WORKSPACE', 'loopback serving cannot fall back to unconfined execution')
  const backend = await detectBackend(input)
  const available = backend.name !== 'none'
  const availability = decideBackendAvailability({
    available,
    implementation,
    required: input.required,
    onUnavailable: input.onUnavailable,
  })
  if (availability.action === 'refuse-init')
    throw fault(
      'E_SANDBOX_WORKSPACE',
      implementation === 'unimplemented'
        ? 'OS isolation is not implemented for this execution target; the required sandbox cannot be satisfied.'
        : 'L1 sandbox unavailable: Seatbelt (macOS) or bubblewrap (Linux) did not pass the execution probe. Install/enable the OS backend, or explicitly select full-access to run without OS confinement.',
    )
  const degraded = availability.action === 'allow-unconfined'
  if (degraded) requireClosedNetwork(input.options.networkAllow)
  const denyOperations = availability.action === 'deny-operation'
  const enforcement: Enforcement = available ? backend.enforcement : { level: 'partial', scope: ['file'] }
  const result: ProbedSandboxWorkspace = {
    name: backend.name,
    execBackend: available ? 'l1' : 'none',
    enforcement: { ...enforcement, scope: [...enforcement.scope] },
    degraded,
    implementation,
    probeState: available
      ? 'ready'
      : input.level === 'L1' && implementation === 'implemented'
        ? 'failed'
        : 'unprobed',
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
