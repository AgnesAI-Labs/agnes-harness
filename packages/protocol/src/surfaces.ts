import type { TSchema } from '@sinclair/typebox'
import * as S from '../gen/ts/surface.js'
import { inspectJsonData } from './json-data.js'
import { type ValidationResult, validateAgainst } from './validate.js'

const invalid = (path: string, message: string): ValidationResult<never> => ({
  ok: false,
  errors: [{ path, message, code: 'OTHER' }],
})
function json<T>(schema: TSchema, value: unknown, maxBytes = 65536): ValidationResult<T> {
  const data = inspectJsonData(value, maxBytes)
  return data.ok ? validateAgainst<T>(schema, data.value) : invalid('', 'invalid or oversized Surface JSON')
}
function uniqueGrants(grants: S.SurfaceServiceGrant[]): boolean {
  return new Set(grants.map((grant) => `${grant.extension}/${grant.name}`)).size === grants.length
}
export const validateSurfaceServiceGrant = (value: unknown) =>
  json<S.SurfaceServiceGrant>(S.SurfaceServiceGrant, value)
export const validateSurfaceArtifact = (value: unknown) => json<S.SurfaceArtifact>(S.SurfaceArtifact, value)
export const validateSurfaceConfigValue = (value: unknown) =>
  json<S.SurfaceConfigValue>(S.SurfaceConfigValue, value)
export function validateSurfaceDescriptor(value: unknown): ValidationResult<S.SurfaceDescriptor> {
  const result = json<S.SurfaceDescriptor>(S.SurfaceDescriptor, value)
  return result.ok && !uniqueGrants(result.value.requires.services)
    ? invalid('/requires/services', 'duplicate service grant')
    : result
}
export function validateSurfaceInstance(value: unknown): ValidationResult<S.SurfaceInstance> {
  const result = json<S.SurfaceInstance>(S.SurfaceInstance, value)
  return result.ok && !uniqueGrants(result.value.grants)
    ? invalid('/grants', 'duplicate service grant')
    : result
}
export function validateSurfacePackageMetadata(value: unknown): ValidationResult<S.SurfacePackageMetadata> {
  const result = json<S.SurfacePackageMetadata>(S.SurfacePackageMetadata, value, 1048576)
  if (!result.ok) return result
  const ids = new Set<string>()
  for (const descriptor of result.value.surfaces) {
    if (ids.has(descriptor.id)) return invalid('/surfaces', 'duplicate surface id')
    ids.add(descriptor.id)
    const checked = validateSurfaceDescriptor(descriptor)
    if (!checked.ok) return checked
  }
  return result
}
