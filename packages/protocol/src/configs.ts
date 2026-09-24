import * as AZ from '../gen/ts/authz.js'
import * as BR from '../gen/ts/bridge.js'
import * as CH from '../gen/ts/channel.js'
import * as DEPLOY_MANIFEST from '../gen/ts/deploy-manifest.js'
import * as EXTENSION_MANIFEST from '../gen/ts/extension-manifest.js'
import * as JOBS from '../gen/ts/jobs.js'
import * as LOCKFILE from '../gen/ts/lockfile.js'
import * as PACKAGE_ADMIN from '../gen/ts/package-admin.js'
import * as P from '../gen/ts/preset.js'
import * as PROFILE from '../gen/ts/profile.js'
import { inspectJsonData } from './json-data.js'
import { validateSurfacePackageMetadata } from './surfaces.js'
import { type ValidationResult, validateAgainst } from './validate.js'

/** Validate a document without merging inheritance or injecting consumer defaults. */
export const validatePreset = (x: unknown): ValidationResult<P.PresetDoc> =>
  validateAgainst<P.PresetDoc>(P.PresetDoc, x)

export const validateProfileManifest = (x: unknown): ValidationResult<PROFILE.RuntimeProfileManifest> =>
  validateAgainst<PROFILE.RuntimeProfileManifest>(PROFILE.RuntimeProfileManifest, x)

export const validateProfileFragment = (x: unknown): ValidationResult<PROFILE.ProfileFragment> =>
  validateAgainst<PROFILE.ProfileFragment>(PROFILE.ProfileFragment, x)

export const validateResolvedProfile = (x: unknown): ValidationResult<PROFILE.ResolvedProfile> =>
  validateAgainst<PROFILE.ResolvedProfile>(PROFILE.ResolvedProfile, x)

export const validateManagedPolicy = (x: unknown): ValidationResult<PROFILE.ManagedPolicy> =>
  validateAgainst<PROFILE.ManagedPolicy>(PROFILE.ManagedPolicy, x)

export const validateLockfile = (x: unknown): ValidationResult<LOCKFILE.Lockfile> => {
  const result = validateAgainst<LOCKFILE.Lockfile>(LOCKFILE.Lockfile, x)
  if (!result.ok) return result
  for (const entry of Object.values(result.value.packages)) {
    for (const snapshot of [entry, entry.previous]) {
      if (!snapshot?.surfaces) continue
      const checked = validateSurfacePackageMetadata({ surfaces: snapshot.surfaces })
      if (!checked.ok) return checked
    }
  }
  return result
}

export const validateExtensionManifest = (
  x: unknown,
): ValidationResult<EXTENSION_MANIFEST.ExtensionManifest> => {
  const checked = validateAgainst<EXTENSION_MANIFEST.ExtensionManifest>(
    EXTENSION_MANIFEST.ExtensionManifest,
    x,
  )
  if (!checked.ok) return checked
  for (const kind of ['services', 'projections'] as const) {
    const names = new Set<string>()
    for (const [index, projection] of (checked.value.capabilities[kind] ?? []).entries()) {
      if (names.has(projection.name))
        return {
          ok: false,
          errors: [
            {
              path: `/capabilities/${kind}/${index}/name`,
              code: 'OTHER',
              message: `duplicate ${kind} name`,
            },
          ],
        }
      names.add(projection.name)
    }
  }
  return checked
}

export const validateSkinListResult = (x: unknown): ValidationResult<PACKAGE_ADMIN.SkinListResult> =>
  validateAgainst<PACKAGE_ADMIN.SkinListResult>(PACKAGE_ADMIN.SkinListResult, x)

export const validateSkinReadParams = (x: unknown): ValidationResult<PACKAGE_ADMIN.SkinReadParams> =>
  validateAgainst<PACKAGE_ADMIN.SkinReadParams>(PACKAGE_ADMIN.SkinReadParams, x)

export const validateSkinReadResult = (x: unknown): ValidationResult<PACKAGE_ADMIN.SkinReadResult> =>
  validateAgainst<PACKAGE_ADMIN.SkinReadResult>(PACKAGE_ADMIN.SkinReadResult, x)

export const validateClientModuleListResult = (
  x: unknown,
): ValidationResult<PACKAGE_ADMIN.ClientModuleListResult> =>
  validateAgainst<PACKAGE_ADMIN.ClientModuleListResult>(PACKAGE_ADMIN.ClientModuleListResult, x)

export const validateClientModuleReadParams = (
  x: unknown,
): ValidationResult<PACKAGE_ADMIN.ClientModuleReadParams> =>
  validateAgainst<PACKAGE_ADMIN.ClientModuleReadParams>(PACKAGE_ADMIN.ClientModuleReadParams, x)

export const validateClientModuleReadResult = (
  x: unknown,
): ValidationResult<PACKAGE_ADMIN.ClientModuleReadResult> =>
  validateAgainst<PACKAGE_ADMIN.ClientModuleReadResult>(PACKAGE_ADMIN.ClientModuleReadResult, x)

export const validateClientModuleServiceCallParams = (
  x: unknown,
): ValidationResult<PACKAGE_ADMIN.ClientModuleServiceCallParams> =>
  validateAgainst<PACKAGE_ADMIN.ClientModuleServiceCallParams>(PACKAGE_ADMIN.ClientModuleServiceCallParams, x)

export const validateClientModuleServiceCallResult = (
  x: unknown,
): ValidationResult<PACKAGE_ADMIN.ClientModuleServiceCallResult> =>
  validateAgainst<PACKAGE_ADMIN.ClientModuleServiceCallResult>(PACKAGE_ADMIN.ClientModuleServiceCallResult, x)

export const validateClientModuleEffectCallParams = (
  x: unknown,
): ValidationResult<PACKAGE_ADMIN.ClientModuleEffectCallParams> =>
  validateAgainst<PACKAGE_ADMIN.ClientModuleEffectCallParams>(PACKAGE_ADMIN.ClientModuleEffectCallParams, x)

export const validateClientModuleEffectCallResult = (
  x: unknown,
): ValidationResult<PACKAGE_ADMIN.ClientModuleEffectCallResult> =>
  validateAgainst<PACKAGE_ADMIN.ClientModuleEffectCallResult>(PACKAGE_ADMIN.ClientModuleEffectCallResult, x)

export const validateDeployManifest = (x: unknown): ValidationResult<DEPLOY_MANIFEST.DeployManifest> =>
  validateAgainst<DEPLOY_MANIFEST.DeployManifest>(DEPLOY_MANIFEST.DeployManifest, x)

export const validateJobSpec = (x: unknown): ValidationResult<JOBS.JobSpec> =>
  validateAgainst<JOBS.JobSpec>(JOBS.JobSpec, x)

export const validateJobStatus = (x: unknown): ValidationResult<JOBS.JobStatus> =>
  validateAgainst<JOBS.JobStatus>(JOBS.JobStatus, x)

export const validateActor = (x: unknown): ValidationResult<AZ.Actor> =>
  validateAgainst<AZ.Actor>(AZ.Actor, x)

export const validateTarget = (x: unknown): ValidationResult<AZ.Target> =>
  validateAgainst<AZ.Target>(AZ.Target, x)

export const validateAction = (x: unknown): ValidationResult<AZ.Action> =>
  validateAgainst<AZ.Action>(AZ.Action, x)

export const validateDecision = (x: unknown): ValidationResult<AZ.Decision> =>
  validateAgainst<AZ.Decision>(AZ.Decision, x)

export const validateCredential = (x: unknown): ValidationResult<CH.Credential> =>
  validateAgainst<CH.Credential>(CH.Credential, x)

export const validateChannelManifest = (x: unknown): ValidationResult<CH.ChannelManifest> =>
  validateAgainst<CH.ChannelManifest>(CH.ChannelManifest, x)

export const validateApprovalAction = (x: unknown): ValidationResult<CH.ApprovalAction> =>
  validateAgainst<CH.ApprovalAction>(CH.ApprovalAction, x)

export const validateDirectoryEntry = (x: unknown): ValidationResult<CH.DirectoryEntry> =>
  validateAgainst<CH.DirectoryEntry>(CH.DirectoryEntry, x)

export const validateChannelCapabilities = (x: unknown): ValidationResult<CH.ChannelCapabilities> =>
  validateAgainst<CH.ChannelCapabilities>(CH.ChannelCapabilities, x)

export const validateBridgeFrame = (x: unknown): ValidationResult<BR.BridgeRequest | BR.BridgeResponse> =>
  x && typeof x === 'object' && 'method' in x
    ? validateAgainst<BR.BridgeRequest>(BR.BridgeRequest, x)
    : validateAgainst<BR.BridgeResponse>(BR.BridgeResponse, x)
/** Error names come from the schema; frame byte-size enforcement belongs to the bridge transport. */
export const BRIDGE_ERRORS = Object.freeze(BR.X_AGNES_BRIDGE_ERRORS)

export function validateExtensionIsolationPolicy(
  x: unknown,
): ValidationResult<PROFILE.ExtensionIsolationPolicy> {
  const data = inspectJsonData(x, 65536)
  return data.ok
    ? validateAgainst<PROFILE.ExtensionIsolationPolicy>(PROFILE.ExtensionIsolationPolicy, data.value)
    : { ok: false, errors: [{ path: '', code: 'OTHER', message: 'invalid isolation JSON' }] }
}
export function validateCommandHooksPolicy(x: unknown): ValidationResult<PROFILE.CommandHooksPolicy> {
  const data = inspectJsonData(x, 65536)
  return data.ok
    ? validateAgainst<PROFILE.CommandHooksPolicy>(PROFILE.CommandHooksPolicy, data.value)
    : { ok: false, errors: [{ path: '', code: 'OTHER', message: 'invalid command hooks JSON' }] }
}
export function validateExtensionIsolationRequest(
  x: unknown,
): ValidationResult<PROFILE.ExtensionIsolationRequest> {
  const data = inspectJsonData(x, 65536)
  return data.ok
    ? validateAgainst<PROFILE.ExtensionIsolationRequest>(PROFILE.ExtensionIsolationRequest, data.value)
    : { ok: false, errors: [{ path: '', code: 'OTHER', message: 'invalid isolation JSON' }] }
}
