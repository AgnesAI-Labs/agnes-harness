import { HostError, type Layer } from '../errors.js'
import { canonicalJson } from './canonical.js'
import type {
  ComputerUseAppIdentity,
  ComputerUseCapturePolicy,
  ComputerUseProfile,
  ComputerUseRetentionPolicy,
  ResolvedComputerUseProfile,
} from './types.js'

export const DEFAULT_COMPUTER_USE: Readonly<ResolvedComputerUseProfile> = Object.freeze({
  enabled: false,
  appAccess: 'allowlist',
  appAllowlist: Object.freeze([]),
  capture: Object.freeze({
    allowFullDesktop: false,
    maxImageDimension: 1456,
    maxBytesPerImage: 4 * 1024 * 1024,
    maxImagesPerResult: 1,
    maxImagesPerMutationResult: 2,
    maxImagesPerModelRequest: 4,
    maxCapturesPerHour: 120,
  }),
  retention: Object.freeze({
    maxRecentPerSession: 100,
    ttlMs: 24 * 60 * 60_000,
    gcIntervalMs: 60 * 60_000,
    maxExtendedTtlMs: 7 * 24 * 60 * 60_000,
    globalMaxBytes: 1024 * 1024 * 1024,
  }),
})

const CAPTURE_LIMITS = Object.freeze({
  maxImageDimension: { min: 8, max: 1456 },
  maxBytesPerImage: { min: 1024, max: 4 * 1024 * 1024 },
  maxImagesPerResult: { min: 1, max: 1 },
  maxImagesPerMutationResult: { min: 1, max: 2 },
  maxImagesPerModelRequest: { min: 1, max: 4 },
  maxCapturesPerHour: { min: 1, max: 120 },
}) satisfies Record<Exclude<keyof ComputerUseCapturePolicy, 'allowFullDesktop'>, { min: number; max: number }>

const RETENTION_LIMITS = Object.freeze({
  maxRecentPerSession: { min: 1, max: 100 },
  ttlMs: { min: 60_000, max: 7 * 24 * 60 * 60_000 },
  gcIntervalMs: { min: 60_000, max: 60 * 60_000 },
  maxExtendedTtlMs: { min: 60_000, max: 7 * 24 * 60 * 60_000 },
  globalMaxBytes: { min: 4 * 1024 * 1024, max: 1024 * 1024 * 1024 },
}) satisfies Record<keyof ComputerUseRetentionPolicy, { min: number; max: number }>

function fail(layer: Layer, field: string, reason: string): never {
  throw new HostError('E_PROFILE_FRAGMENT_KEY', `invalid or unauthorized computerUse.${field}`, {
    source: { layer },
    detail: { field: `computerUse.${field}`, reason },
  })
}

function record(value: unknown, layer: Layer, field: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) fail(layer, field, 'object')
  return value as Record<string, unknown>
}

function closed(
  value: Record<string, unknown>,
  allowed: readonly string[],
  layer: Layer,
  field: string,
): void {
  const extra = Object.keys(value).find((key) => !allowed.includes(key))
  if (extra) fail(layer, `${field}.${extra}`, 'unknown-field')
}

function boundedInteger(
  value: unknown,
  range: Readonly<{ min: number; max: number }>,
  layer: Layer,
  field: string,
): number {
  if (!Number.isSafeInteger(value) || (value as number) < range.min || (value as number) > range.max)
    fail(layer, field, 'out-of-range')
  return value as number
}

function nonEmpty(value: unknown, max: number, layer: Layer, field: string): string {
  if (typeof value !== 'string' || value.length < 1 || value.length > max)
    fail(layer, field, 'invalid-string')
  return value
}

function digest(value: unknown, layer: Layer, field: string): string {
  const found = nonEmpty(value, 64, layer, field)
  if (!/^[a-f0-9]{64}$/.test(found)) fail(layer, field, 'invalid-sha256')
  return found
}

function appIdentity(value: unknown, layer: Layer, index: number): ComputerUseAppIdentity {
  const field = `appAllowlist[${index}]`
  const item = record(value, layer, field)
  if (item.platform === 'win32') {
    const executablePath = nonEmpty(item.executablePath, 4096, layer, `${field}.executablePath`)
    if (Object.hasOwn(item, 'packageFamilyName')) {
      closed(item, ['platform', 'executablePath', 'packageFamilyName'], layer, field)
      return {
        platform: 'win32',
        executablePath,
        packageFamilyName: nonEmpty(item.packageFamilyName, 255, layer, `${field}.packageFamilyName`),
      }
    }
    closed(item, ['platform', 'executablePath', 'publisherSha256'], layer, field)
    return {
      platform: 'win32',
      executablePath,
      publisherSha256: digest(item.publisherSha256, layer, `${field}.publisherSha256`),
    }
  }
  if (item.platform === 'darwin') {
    closed(item, ['platform', 'bundleId', 'teamId', 'signatureSha256'], layer, field)
    return {
      platform: 'darwin',
      bundleId: nonEmpty(item.bundleId, 255, layer, `${field}.bundleId`),
      teamId: nonEmpty(item.teamId, 64, layer, `${field}.teamId`),
      signatureSha256: digest(item.signatureSha256, layer, `${field}.signatureSha256`),
    }
  }
  if (item.platform === 'linux') {
    closed(item, ['platform', 'desktopId', 'executablePath', 'installSource'], layer, field)
    return {
      platform: 'linux',
      desktopId: nonEmpty(item.desktopId, 255, layer, `${field}.desktopId`),
      executablePath: nonEmpty(item.executablePath, 4096, layer, `${field}.executablePath`),
      installSource: nonEmpty(item.installSource, 1024, layer, `${field}.installSource`),
    }
  }
  return fail(layer, `${field}.platform`, 'unsupported-platform')
}

function appAllowlist(value: unknown, layer: Layer): readonly ComputerUseAppIdentity[] {
  if (!Array.isArray(value) || value.length > 128) fail(layer, 'appAllowlist', 'invalid-array')
  const out = value.map((item, index) => appIdentity(item, layer, index))
  const seen = new Set<string>()
  for (const item of out) {
    const key = canonicalJson(item)
    if (seen.has(key)) fail(layer, 'appAllowlist', 'duplicate-identity')
    seen.add(key)
  }
  return out
}

function capture(value: unknown, layer: Layer): ComputerUseCapturePolicy {
  const input = record(value, layer, 'capture')
  closed(input, ['allowFullDesktop', ...Object.keys(CAPTURE_LIMITS)], layer, 'capture')
  const out: ComputerUseCapturePolicy = {}
  if (Object.hasOwn(input, 'allowFullDesktop')) {
    if (typeof input.allowFullDesktop !== 'boolean') fail(layer, 'capture.allowFullDesktop', 'boolean')
    out.allowFullDesktop = input.allowFullDesktop
  }
  for (const [key, range] of Object.entries(CAPTURE_LIMITS) as [
    keyof typeof CAPTURE_LIMITS,
    { min: number; max: number },
  ][])
    if (Object.hasOwn(input, key)) out[key] = boundedInteger(input[key], range, layer, `capture.${key}`)
  return out
}

function retention(value: unknown, layer: Layer): ComputerUseRetentionPolicy {
  const input = record(value, layer, 'retention')
  closed(input, Object.keys(RETENTION_LIMITS), layer, 'retention')
  const out: ComputerUseRetentionPolicy = {}
  for (const [key, range] of Object.entries(RETENTION_LIMITS) as [
    keyof typeof RETENTION_LIMITS,
    { min: number; max: number },
  ][])
    if (Object.hasOwn(input, key)) out[key] = boundedInteger(input[key], range, layer, `retention.${key}`)
  return out
}

function inspect(value: unknown, layer: Layer): ComputerUseProfile {
  const input = record(value, layer, '')
  closed(input, ['enabled', 'appAccess', 'appAllowlist', 'capture', 'retention'], layer, '')
  const out: ComputerUseProfile = {}
  if (Object.hasOwn(input, 'enabled')) {
    if (typeof input.enabled !== 'boolean') fail(layer, 'enabled', 'boolean')
    out.enabled = input.enabled
  }
  if (Object.hasOwn(input, 'appAccess')) {
    if (input.appAccess !== 'allowlist' && input.appAccess !== 'all')
      fail(layer, 'appAccess', 'unsupported-mode')
    out.appAccess = input.appAccess
  }
  if (Object.hasOwn(input, 'appAllowlist')) out.appAllowlist = appAllowlist(input.appAllowlist, layer)
  if (Object.hasOwn(input, 'capture')) out.capture = capture(input.capture, layer)
  if (Object.hasOwn(input, 'retention')) out.retention = retention(input.retention, layer)
  return out
}

function ensureTightening(base: ResolvedComputerUseProfile, next: ComputerUseProfile, layer: Layer): void {
  if (next.enabled === true) fail(layer, 'enabled', 'workspace-cannot-enable')
  if (next.appAccess === 'all') fail(layer, 'appAccess', 'workspace-cannot-enable-all-apps')
  if (next.capture?.allowFullDesktop === true)
    fail(layer, 'capture.allowFullDesktop', 'workspace-cannot-enable')
  if (next.appAllowlist) {
    const prior = new Set(base.appAllowlist.map((item) => canonicalJson(item)))
    if (next.appAllowlist.some((item) => !prior.has(canonicalJson(item))))
      fail(layer, 'appAllowlist', 'workspace-can-only-select-existing-identities')
  }
  for (const key of Object.keys(CAPTURE_LIMITS) as (keyof typeof CAPTURE_LIMITS)[]) {
    const requested = next.capture?.[key]
    if (requested !== undefined && requested > base.capture[key])
      fail(layer, `capture.${key}`, 'workspace-cannot-raise-limit')
  }
  for (const key of Object.keys(RETENTION_LIMITS) as (keyof typeof RETENTION_LIMITS)[]) {
    const requested = next.retention?.[key]
    if (requested !== undefined && requested > base.retention[key])
      fail(layer, `retention.${key}`, 'workspace-cannot-raise-limit')
  }
}

export function resolveComputerUse(
  baseValue: ComputerUseProfile | undefined,
  nextValue: ComputerUseProfile | undefined,
  layer: Layer,
): ResolvedComputerUseProfile {
  const base =
    baseValue === undefined ? DEFAULT_COMPUTER_USE : mergeComputerUse(DEFAULT_COMPUTER_USE, baseValue, layer)
  return nextValue === undefined ? base : mergeComputerUse(base, nextValue, layer)
}

export function mergeComputerUse(
  baseValue: ComputerUseProfile | ResolvedComputerUseProfile,
  nextValue: ComputerUseProfile,
  layer: Layer,
): ResolvedComputerUseProfile {
  const baseInput = inspect(baseValue, layer)
  const base: ResolvedComputerUseProfile = {
    enabled: baseInput.enabled ?? DEFAULT_COMPUTER_USE.enabled,
    appAccess: baseInput.appAccess ?? DEFAULT_COMPUTER_USE.appAccess,
    appAllowlist: baseInput.appAllowlist ?? [...DEFAULT_COMPUTER_USE.appAllowlist],
    capture: { ...DEFAULT_COMPUTER_USE.capture, ...baseInput.capture },
    retention: { ...DEFAULT_COMPUTER_USE.retention, ...baseInput.retention },
  }
  const next = inspect(nextValue, layer)
  if (layer === 'workspace') ensureTightening(base, next, layer)
  const resolved: ResolvedComputerUseProfile = {
    enabled: next.enabled ?? base.enabled,
    // Older user profiles expressed their restriction with appAllowlist alone. A new local
    // template default must not silently turn those explicit lists into unrestricted app access.
    appAccess: next.appAccess ?? (next.appAllowlist !== undefined ? 'allowlist' : base.appAccess),
    appAllowlist: next.appAllowlist ?? base.appAllowlist,
    capture: { ...base.capture, ...next.capture },
    retention: { ...base.retention, ...next.retention },
  }
  if (resolved.capture.maxImagesPerResult > resolved.capture.maxImagesPerMutationResult)
    fail(layer, 'capture.maxImagesPerMutationResult', 'must-cover-normal-result')
  if (resolved.capture.maxImagesPerMutationResult > resolved.capture.maxImagesPerModelRequest)
    fail(layer, 'capture.maxImagesPerModelRequest', 'must-cover-mutation-result')
  if (resolved.retention.ttlMs > resolved.retention.maxExtendedTtlMs)
    fail(layer, 'retention.maxExtendedTtlMs', 'must-not-be-shorter-than-ttl')
  return resolved
}
