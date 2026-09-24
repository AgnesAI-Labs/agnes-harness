import type { Enforcement } from '@agnes/core'
import type { Logger } from '@agnes/extension-api'
import { bwrapConfine } from './backends/bwrap.js'
import { seatbeltConfine } from './backends/seatbelt.js'
import type { ClosedNetworkConfineOptions } from './backends/shared.js'
import { backendCompileFault, requireClosedNetwork, validateArgv } from './backends/shared.js'

export type BackendName = 'none' | 'bwrap' | 'seatbelt'

export type RuntimeBackend = Readonly<{
  name: BackendName
  enforcement: Enforcement
  confine(argv: readonly string[], options: ClosedNetworkConfineOptions): string[]
}>

type ProbeResult = Readonly<{
  code: number
  stdout: string
  stderr: string
  truncated: boolean
  timedOut: boolean
  signal?: string
}>

export type BackendProbeExec = (
  argv: string[],
  options: { cwd: string; timeoutMs: number; signal?: AbortSignal; maxOutputBytes: number },
) => Promise<ProbeResult>

export type DetectBackendInput = Readonly<{
  level: 'L0' | 'L1'
  shell: 'posix' | 'powershell'
  options: ClosedNetworkConfineOptions
  probeExec: BackendProbeExec
  log: Logger
  signal?: AbortSignal
}>

const NONE_ENFORCEMENT: Enforcement = {
  level: 'none',
  scope: [],
}
const FULL_ENFORCEMENT: Enforcement = {
  level: 'full',
  scope: ['file', 'network', 'process'],
}
Object.freeze(NONE_ENFORCEMENT.scope)
Object.freeze(NONE_ENFORCEMENT)
Object.freeze(FULL_ENFORCEMENT.scope)
Object.freeze(FULL_ENFORCEMENT)

/**
 * An identity transform is not a backend. Keeping this object callable makes an accidental use
 * fail closed at the same boundary as a real compiler, instead of returning a raw argv that a
 * caller could mistake for confinement.
 */
export const NONE_BACKEND: RuntimeBackend = Object.freeze({
  name: 'none',
  enforcement: NONE_ENFORCEMENT,
  confine(argv) {
    validateArgv(argv)
    throw backendCompileFault('E_SANDBOX_HOST_ENFORCEMENT_REQUIRED', 'no OS sandbox backend is active')
  },
})

export const BWRAP_BACKEND: RuntimeBackend = Object.freeze({
  name: 'bwrap',
  enforcement: FULL_ENFORCEMENT,
  confine: bwrapConfine,
})

export const SEATBELT_BACKEND: RuntimeBackend = Object.freeze({
  name: 'seatbelt',
  enforcement: FULL_ENFORCEMENT,
  confine: seatbeltConfine,
})

const PROBE_TOKEN = 'agnes-sandbox-probe-v1'

async function runsBoundary(input: DetectBackendInput, backend: RuntimeBackend): Promise<boolean> {
  // The child shell is deliberate: success proves the OS accepted the complete confinement argv
  // and that a descendant executes inside it. For bwrap, successful setup also proves the kernel
  // accepted the PID/IPC/UTS/network namespace flags. Compiler tests and the macOS acceptance tests
  // separately exercise denied file and loopback operations.
  const command = ['/bin/sh', '-c', `/bin/sh -c 'printf ${PROBE_TOKEN}'`]
  let argv: string[]
  try {
    argv = backend.confine(command, input.options)
  } catch (error) {
    // An unsupported allowlist is a policy refusal, not a missing binary. Never turn it into the
    // `on_unavailable` path, where an explicit allow could silently open the whole network.
    if ((error as { code?: unknown })?.code === 'E_SANDBOX_NETWORK_ALLOWLIST_UNSUPPORTED') throw error
    return false
  }
  try {
    const result = await input.probeExec(argv, {
      cwd: input.options.cwd,
      timeoutMs: 3_000,
      maxOutputBytes: 4_096,
      ...(input.signal === undefined ? {} : { signal: input.signal }),
    })
    return !result.timedOut && result.code === 0 && result.stdout === PROBE_TOKEN
  } catch {
    return false
  }
}

/**
 * Select an actually runnable closed-network backend during the Host's revocable probe window.
 * Platform capability labels and executable presence are intentionally insufficient: a bwrap
 * binary on a host with disabled user namespaces, or sandbox-exec that rejects the generated
 * profile, is unavailable here. Windows stays unavailable until HostExec can apply and prove a
 * restricted token/job/network boundary; this module never fabricates one by rewriting argv.
 */
export async function detectBackend(input: DetectBackendInput): Promise<RuntimeBackend> {
  if (input.level !== 'L1' || input.shell !== 'posix') return NONE_BACKEND
  requireClosedNetwork(input.options.networkAllow)

  for (const backend of [BWRAP_BACKEND, SEATBELT_BACKEND]) {
    if (await runsBoundary(input, backend)) {
      input.log.info('sandbox backend', { name: backend.name, enforcement: backend.enforcement })
      return backend
    }
  }
  input.log.info('sandbox backend', { name: NONE_BACKEND.name, enforcement: NONE_BACKEND.enforcement })
  return NONE_BACKEND
}
