import { join } from 'node:path'
import { createCompositionAdmin } from '@agnes/host'
import { profileNameFrom } from '../boot/inputs.js'
import type { BootDeps, ParsedArgs } from '../types.js'
import { resolveDoctorProfile } from './doctor-profile.js'

/** Shares boot profile/lock/config resolution; no plugin entry modules or model calls are needed. */
export function compositionAdminFor(parsed: ParsedArgs, deps: BootDeps) {
  return createCompositionAdmin({
    profileDir: join(deps.home, 'profiles', profileNameFrom(parsed, deps.env)),
    resolveProfile: (adminBundles) =>
      resolveDoctorProfile(deps, parsed, adminBundles ? { adminBundles } : {}),
  })
}
export async function configDumpCommand(parsed: ParsedArgs, deps: BootDeps): Promise<string> {
  if (parsed.connect || parsed.positional.length !== 1 || parsed.positional[0] !== 'dump')
    throw new Error('config dump requires a local profile and accepts no additional arguments')
  return JSON.stringify(await compositionAdminFor(parsed, deps).dump(parsed.preset), null, 2)
}
