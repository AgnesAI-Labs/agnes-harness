import type { WindowsWriteBoundary } from '@agnes/extension-api'

/** The only partial contract on Windows: ACL-limited writes, open reads and network, job-owned processes. */
export const WINDOWS_WRITE_BOUNDARY: WindowsWriteBoundary = Object.freeze({
  contract: 'windows-write-restricted-v1',
  fileWrite: 'acl-partial',
  fileRead: 'unrestricted',
  network: 'unrestricted',
  processTree: 'job-object',
})

/** Exact match: every field and value, no extra keys. A near miss is not this contract. */
export function isWindowsWriteBoundary(value: unknown): value is WindowsWriteBoundary {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const record = value as Record<string, unknown>
  const expected = Object.entries(WINDOWS_WRITE_BOUNDARY)
  return (
    Object.keys(record).length === expected.length && expected.every(([key, want]) => record[key] === want)
  )
}

export type WindowsAccess = 'read-only' | 'workspace-write' | 'full-access'

/**
 * Facts the Host has already established. Requirements come from trusted configuration or the call
 * itself (`customFsDeny` means an explicit read deny, not the file tools' default protected paths),
 * and `availableBoundary` comes from a trusted local provider's own probe, never from a profile.
 */
export type WindowsExecutionInput = Readonly<{
  access: WindowsAccess
  windowsMode: 'write-restricted' | 'require-full'
  /** `sandbox.required`: a complete isolation backend or no execution. */
  required: boolean
  /** The caller demands private file read protection, for example for a memory provider's files. */
  extraReadIsolation: boolean
  /** An explicit read deny beyond the default protected paths. */
  customFsDeny: boolean
  /** `allow` means no network restriction is required; anything else is an explicit requirement. */
  networkMode: 'allow' | 'deny' | 'hosts' | 'loopback-serve'
  /** The sandbox provider selected for this session. */
  providerId: string
  /** The Host's own built-in provider, as registered with the Host. Only that provider runs the ACL path. */
  localProviderId: string
  availableBoundary?: WindowsWriteBoundary
}>

export type WindowsRefusalReason =
  | 'invalid-input'
  | 'provider-not-local'
  | 'required-isolation'
  | 'read-isolation'
  | 'read-deny'
  | 'network-restriction'
  | 'windows-mode-require-full'
  | 'boundary-unavailable'
  | 'boundary-mismatch'

export type WindowsExecutionDecision =
  | Readonly<{ kind: 'unconfined' }>
  | Readonly<{
      kind: 'windows-write-restricted-v1'
      boundary: WindowsWriteBoundary
      mode: 'read-only' | 'workspace-write'
    }>
  | Readonly<{ kind: 'refusal'; reason: WindowsRefusalReason }>

const refuse = (reason: WindowsRefusalReason): WindowsExecutionDecision => ({ kind: 'refusal', reason })

const ACCESS = new Set<string>(['read-only', 'workspace-write', 'full-access'])
const MODES = new Set<string>(['write-restricted', 'require-full'])
const NETWORK = new Set<string>(['allow', 'deny', 'hosts', 'loopback-serve'])

/**
 * Chooses how one command may run on Windows. It only decides; it starts nothing and touches no ACL.
 * A stronger or unknown requirement is refused rather than reduced to the partial contract, and a
 * session that did not opt in with `write-restricted` is never given it.
 */
export function resolveWindowsExecution(input: WindowsExecutionInput): WindowsExecutionDecision {
  if (
    !input ||
    !ACCESS.has(input.access) ||
    !MODES.has(input.windowsMode) ||
    !NETWORK.has(input.networkMode) ||
    typeof input.required !== 'boolean' ||
    typeof input.extraReadIsolation !== 'boolean' ||
    typeof input.customFsDeny !== 'boolean' ||
    typeof input.providerId !== 'string' ||
    typeof input.localProviderId !== 'string' ||
    input.localProviderId.length === 0
  )
    return refuse('invalid-input')
  // Another provider keeps its own contract; the local ACL path never stands in for it.
  if (input.providerId !== input.localProviderId) return refuse('provider-not-local')
  if (input.required) return refuse('required-isolation')
  if (input.extraReadIsolation) return refuse('read-isolation')
  if (input.customFsDeny) return refuse('read-deny')
  if (input.networkMode !== 'allow') return refuse('network-restriction')
  if (input.access === 'full-access') return { kind: 'unconfined' }
  if (input.windowsMode !== 'write-restricted') return refuse('windows-mode-require-full')
  if (input.availableBoundary === undefined) return refuse('boundary-unavailable')
  if (!isWindowsWriteBoundary(input.availableBoundary)) return refuse('boundary-mismatch')
  return { kind: 'windows-write-restricted-v1', boundary: WINDOWS_WRITE_BOUNDARY, mode: input.access }
}
