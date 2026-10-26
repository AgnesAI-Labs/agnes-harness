import { validatePackageAdminData, validatePluginMetadata } from '@agnes/protocol'
import { validAgentDeclarations, validApplicationDeclaration } from './agent-declarations.js'
import { PackageError } from './errors.js'
import { canonical, capabilityHash } from './integrity.js'
import { assertCurrentPackageFormat } from './package-format.js'
import { runtimeSnapshotId } from './runtime-snapshot-entry.js'
import type { PinRecord, RuntimePinPurpose, SnapshotRecord } from './runtime-snapshot-types.js'

export const SHA256 = /^sha256-[a-f0-9]{64}$/
export const INTEGRITY = /^(?:sha256-[a-f0-9]{64}|sha512-[A-Za-z0-9+/]{86}==)$/
const TOKEN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/
export const PURPOSES = new Set<RuntimePinPurpose>(['active', 'candidate', 'recovery', 'rollback', 'turn'])

/**
 * With `path`, the detail names the file or directory that failed the check. It stays out of the
 * message: hashed path names would make the message read as a secret and be omitted.
 */
export function integrityFailure(reason: string, path?: string): never {
  throw new PackageError('E_LOCK_MISMATCH', 'runtime snapshot store requires recovery', {
    detail: { reason, ...(path ? { path } : {}) },
  })
}

export function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return canonical(Object.keys(value).sort()) === canonical([...keys].sort())
}

export function validateToken(value: unknown, reason: string): asserts value is string {
  if (
    typeof value !== 'string' ||
    !TOKEN.test(value) ||
    ['__proto__', 'prototype', 'constructor'].includes(value)
  )
    integrityFailure(reason)
}
export function validateRecord(raw: unknown): SnapshotRecord {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) integrityFailure('snapshot-shape')
  const value = raw as Record<string, unknown>
  assertCurrentPackageFormat(value)
  if (value.version !== 2)
    throw new PackageError(
      'E_LOCK_MISMATCH',
      'Retired runtime snapshot format; select a new, empty AGH_HOME (clean home).',
      { detail: { reason: 'clean-home-required' } },
    )
  if (
    !exactKeys(value, [
      'version',
      'snapshotId',
      'packageId',
      'packageVersion',
      'integrity',
      'treeIntegrity',
      'capabilityHash',
      'source',
      'license',
      'releasedAt',
      'dependencies',
      'contributions',
      ...(value.metadata === undefined ? [] : ['metadata']),
      ...(value.agents === undefined ? [] : ['agents']),
      ...(value.application === undefined ? [] : ['application']),
      ...(value.declaredCapabilities === undefined ? [] : ['declaredCapabilities']),
    ]) ||
    (value.declaredCapabilities !== undefined &&
      !validatePackageAdminData('PluginCapabilities', value.declaredCapabilities).ok) ||
    (value.metadata !== undefined && !validatePluginMetadata(value.metadata).ok) ||
    typeof value.snapshotId !== 'string' ||
    !SHA256.test(value.snapshotId) ||
    typeof value.packageId !== 'string' ||
    typeof value.packageVersion !== 'string' ||
    value.packageVersion.length > 64 ||
    typeof value.integrity !== 'string' ||
    !INTEGRITY.test(value.integrity) ||
    typeof value.treeIntegrity !== 'string' ||
    !SHA256.test(value.treeIntegrity) ||
    typeof value.capabilityHash !== 'string' ||
    !/^[a-f0-9]{64}$/.test(value.capabilityHash) ||
    typeof value.license !== 'string' ||
    value.license.length > 64 ||
    (value.releasedAt !== null &&
      (typeof value.releasedAt !== 'string' || !Number.isFinite(Date.parse(value.releasedAt)))) ||
    !validatePackageAdminData('PackageSource', value.source).ok ||
    !value.dependencies ||
    typeof value.dependencies !== 'object' ||
    Array.isArray(value.dependencies) ||
    !Array.isArray(value.contributions) ||
    value.contributions.length > 128
  )
    integrityFailure('snapshot-shape')
  for (const [id, range] of Object.entries(value.dependencies as Record<string, unknown>))
    if (!id || id.length > 256 || typeof range !== 'string' || range.length > 1024)
      integrityFailure('snapshot-dependencies')
  for (const contribution of value.contributions)
    if (!validatePackageAdminData('PackageContributionSummary', contribution).ok)
      integrityFailure('snapshot-contribution')
  if (
    !validApplicationDeclaration(value.application) ||
    !validAgentDeclarations(value.agents, String(value.packageId))
  )
    integrityFailure('snapshot-launch-declarations')
  const record = value as unknown as SnapshotRecord
  if (
    record.snapshotId !==
      runtimeSnapshotId({
        packageId: record.packageId,
        version: record.packageVersion,
        integrity: record.integrity,
        treeIntegrity: record.treeIntegrity,
        capabilityHash: record.capabilityHash,
        recordVersion: 2,
      }) ||
    capabilityHash(record) !== record.capabilityHash
  )
    integrityFailure('snapshot-identity')
  return structuredClone(record)
}
export function validatePin(raw: unknown): PinRecord {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) integrityFailure('pin-shape')
  const value = raw as Record<string, unknown>
  if (!exactKeys(value, ['pinId', 'operationId', 'purpose', 'packageId', 'snapshotId', 'requestHash']))
    integrityFailure('pin-shape')
  validateToken(value.pinId, 'pin-id')
  validateToken(value.operationId, 'operation-id')
  if (typeof value.purpose !== 'string' || !PURPOSES.has(value.purpose as RuntimePinPurpose))
    integrityFailure('pin-purpose')
  if (
    typeof value.packageId !== 'string' ||
    typeof value.snapshotId !== 'string' ||
    !SHA256.test(value.snapshotId) ||
    typeof value.requestHash !== 'string' ||
    !/^[a-f0-9]{64}$/.test(value.requestHash)
  )
    integrityFailure('pin-shape')
  return structuredClone(value as unknown as PinRecord)
}
