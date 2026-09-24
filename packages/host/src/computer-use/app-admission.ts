import { windowsEnvironmentNamesEqual } from '@agnes/system-node'
import { createPlatform } from '../adapters/platform.js'
import type { ComputerUseAppIdentity } from '../profile/types.js'

const HARD_DENY_CATEGORIES = new Set([
  'terminal',
  'password-manager',
  'system-security',
  'payment',
  'two-factor',
])

export type ComputerUseResolvedAppIdentity =
  | Readonly<{
      platform: 'win32'
      executablePath: string
      mappedImagePath: string
      imageBinding: 'mapped-image-file-handle-v1'
      publisherSha256: string
      processStartTime: string
      category?: string
    }>
  | Readonly<{
      platform: 'win32'
      executablePath: string
      mappedImagePath: string
      imageBinding: 'mapped-image-file-handle-v1'
      packageFamilyName: string
      processStartTime: string
      category?: string
    }>
  | Readonly<{
      platform: 'darwin'
      bundleId: string
      /**
       * Apple platform binaries are valid strict Security.framework code objects but do not all
       * carry a third-party Developer Team ID.  An omitted value is therefore acceptable only in
       * the explicit all-apps profile; allowlist matching below still requires one.
       */
      teamId?: string
      signatureSha256: string
      processStartTime: string
      category?: string
    }>
  | Readonly<{
      platform: 'linux'
      desktopId: string
      executablePath: string
      installSource: string
      processStartTime: string
      category?: string
    }>

export type ComputerUseAppAdmissionDecision =
  | Readonly<{ allowed: true }>
  | Readonly<{
      allowed: false
      code: 'app_identity_invalid' | 'app_hard_denied' | 'app_not_allowlisted'
    }>

function sha256(value: unknown): value is string {
  return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)
}

function text(value: unknown, maximum: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= maximum && !value.includes('\0')
}

function valid(identity: ComputerUseResolvedAppIdentity): boolean {
  if (!identity || typeof identity !== 'object' || Array.isArray(identity)) return false
  if (identity.category !== undefined && !text(identity.category, 64)) return false
  if (identity.platform === 'win32') {
    const stableIdentity =
      'publisherSha256' in identity
        ? sha256(identity.publisherSha256)
        : 'packageFamilyName' in identity && text(identity.packageFamilyName, 255)
    return Boolean(
      text(identity.executablePath, 4096) &&
        text(identity.mappedImagePath, 4096) &&
        identity.imageBinding === 'mapped-image-file-handle-v1' &&
        stableIdentity &&
        /^[0-9]+$/.test(identity.processStartTime),
    )
  }
  if (identity.platform === 'darwin')
    return (
      text(identity.bundleId, 255) &&
      (identity.teamId === undefined || text(identity.teamId, 64)) &&
      sha256(identity.signatureSha256) &&
      text(identity.processStartTime, 192)
    )
  if (identity.platform === 'linux')
    return (
      text(identity.desktopId, 255) &&
      text(identity.executablePath, 4096) &&
      text(identity.installSource, 1024) &&
      text(identity.processStartTime, 192)
    )
  return false
}

function windowsPathEqual(left: string, right: string): boolean {
  try {
    return windowsEnvironmentNamesEqual(left, right)
  } catch {
    // This function can be unit-tested on another platform, but production Windows must use the
    // OS ordinal comparison above. ASCII folding is intentionally narrow and never used to admit a
    // non-Windows identity.
    return (
      createPlatform().os !== 'win32' &&
      /^[\x20-\x7e]+$/.test(left + right) &&
      left.toLowerCase() === right.toLowerCase()
    )
  }
}

function matches(identity: ComputerUseResolvedAppIdentity, candidate: ComputerUseAppIdentity): boolean {
  if (identity.platform !== candidate.platform) return false
  if (identity.platform === 'win32' && candidate.platform === 'win32') {
    if (!windowsPathEqual(identity.executablePath, candidate.executablePath)) return false
    if ('publisherSha256' in identity && 'publisherSha256' in candidate)
      return identity.publisherSha256 === candidate.publisherSha256
    if ('packageFamilyName' in identity && 'packageFamilyName' in candidate)
      return identity.packageFamilyName === candidate.packageFamilyName
    return false
  }
  if (identity.platform === 'darwin' && candidate.platform === 'darwin')
    return (
      identity.bundleId === candidate.bundleId &&
      identity.teamId !== undefined &&
      identity.teamId === candidate.teamId &&
      identity.signatureSha256 === candidate.signatureSha256
    )
  if (identity.platform === 'linux' && candidate.platform === 'linux')
    return (
      identity.desktopId === candidate.desktopId &&
      identity.executablePath === candidate.executablePath &&
      identity.installSource === candidate.installSource
    )
  return false
}

/** Host-only gate. App names/window titles never participate in this decision. */
export function evaluateComputerUseAppAdmission(
  identity: ComputerUseResolvedAppIdentity,
  allowlist: readonly ComputerUseAppIdentity[],
  allowAllApps = false,
): ComputerUseAppAdmissionDecision {
  if (!valid(identity) || !Array.isArray(allowlist))
    return Object.freeze({ allowed: false, code: 'app_identity_invalid' })
  if (identity.category && HARD_DENY_CATEGORIES.has(identity.category))
    return Object.freeze({ allowed: false, code: 'app_hard_denied' })
  if (allowAllApps) return Object.freeze({ allowed: true })
  if (!allowlist.some((candidate) => matches(identity, candidate)))
    return Object.freeze({ allowed: false, code: 'app_not_allowlisted' })
  return Object.freeze({ allowed: true })
}
