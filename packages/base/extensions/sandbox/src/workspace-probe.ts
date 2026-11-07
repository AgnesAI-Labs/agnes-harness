import type {
  Enforcement,
  HostSpawnSandboxWorkspaceBackend,
  SandboxExecBackend,
  SandboxWorkspaceBackend,
} from '@agnes/core'
import type { Logger } from '@agnes/extension-api'
import { decideBackendAvailability } from './availability.js'
import {
  type BackendProbeExec,
  type DetectBackendInput,
  detectBackend,
  hostSpawnBackend,
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
  /**
   * The Host's own offer to start processes under its Windows write restriction, after its trusted
   * local provider decided the contract for this policy. Absent everywhere else.
   */
  hostSpawn?: HostSpawnSandboxWorkspaceBackend
}>

/** Host-private probe result. SandboxReadinessManager exposes only its `confine` surface to Base. */
export type ProbedSandboxWorkspace = SandboxWorkspaceBackend &
  Readonly<{
    name: 'none' | 'bwrap' | 'seatbelt' | 'windows-acl'
    execBackend: SandboxExecBackend
    enforcement: Enforcement
    degraded: boolean
    implementation: 'implemented' | 'unimplemented' | 'unknown'
    probeState: 'ready' | 'failed' | 'unprobed'
    hostSpawn?: HostSpawnSandboxWorkspaceBackend
  }>

const fault = (code: string, message: string): Error & { code: string } =>
  Object.assign(new Error(`${code}: ${message}`), { code })

/** Pure package-owned backend compiler. Host owns and supplies the revocable raw probe per call. */
export async function sandboxWorkspaceProbe(
  input: SandboxWorkspaceProbeInput,
): Promise<ProbedSandboxWorkspace> {
  const implementation = sandboxImplementation(input.platform ?? '')
  if (input.hostSpawn !== undefined) return hostSpawnWorkspace(input, implementation)
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

/**
 * The Host-started branch: no argv is compiled and nothing is probed by running a command. Only an
 * L1 request without stronger requirements can take it; a required full boundary, loopback serving
 * or a network allowlist is refused here as well as by the Host's own decision.
 */
function hostSpawnWorkspace(
  input: SandboxWorkspaceProbeInput,
  implementation: ProbedSandboxWorkspace['implementation'],
): ProbedSandboxWorkspace {
  if (
    input.level !== 'L1' ||
    input.required ||
    input.options.loopbackServe ||
    (input.options.networkAllow?.length ?? 0) > 0
  )
    throw fault('E_SANDBOX_WORKSPACE', 'the Windows write restriction cannot satisfy this sandbox request')
  const backend = hostSpawnBackend(input.hostSpawn, input.platform)
  input.log.info('sandbox backend', { name: backend.name, enforcement: backend.enforcement })
  return Object.freeze({
    name: backend.name,
    execBackend: 'windows-acl',
    enforcement: backend.enforcement,
    hostSpawn: backend.hostSpawn,
    degraded: false,
    implementation,
    probeState: 'ready',
    confine: (request: Readonly<{ argv: readonly string[] }>) => backend.confine(request.argv),
  })
}
