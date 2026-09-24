import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { TEMPLATE_NAMES } from '@agnes/host'
import type { NodeClient } from '@agnes/sdk'
import type { ParsedArgs } from '../args.js'
import type { LocalBootDeps } from '../boot/local.js'
import { newPackageCommandId } from '../tui/package-admin.js'
import { doctorResolvedProfile, resolveDoctorProfile } from './doctor-profile.js'

export function profileList(home: string): string {
  const dir = join(home, 'profiles')
  const userProfiles = existsSync(dir)
    ? readdirSync(dir).filter((name) => existsSync(join(dir, name, 'profile.yaml')))
    : []
  return [
    ...TEMPLATE_NAMES.map((name) => `${name}\t(builtin template)`),
    ...userProfiles.map((name) => `${name}\t${join(dir, name)}`),
  ].join('\n')
}

export async function profileInspect(parsed: ParsedArgs, deps: LocalBootDeps, name: string): Promise<string> {
  const profile = await resolveDoctorProfile(deps, { ...parsed, profile: name })
  return parsed.resolved ? JSON.stringify(profile, null, 2) : doctorResolvedProfile(profile).detail.join('\n')
}

export async function profileTrust(client: NodeClient, profile: string, deployDir: string): Promise<string> {
  const { hash } = await client.packages.trustWorkspace({
    profile,
    clientId: await client.clientId(),
    commandId: newPackageCommandId('profile-trust'),
    deployDir,
  })
  return `trusted ${deployDir} (hash ${hash}) for profile ${profile}`
}
