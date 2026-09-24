import {
  type ConfigurationService,
  createConfigurationService,
  createPlatform,
  type LockState,
  type ResolvedProfile,
  resolveConfiguredPowerShell,
  resolveProfile,
} from '@agnes/host'
import { profileNameFrom, readProfileInputs } from '../boot/inputs.js'
import type { BootDeps, ParsedArgs } from '../types.js'
import type { Section } from './doctor-local.js'

export async function doctorPlatform(d: BootDeps): Promise<Section> {
  try {
    const platform = createPlatform()
    await platform.probe({ root: d.cwd })
    const snapshot = platform.snapshot()
    const shellDetail: string[] = []
    if (platform.os === 'win32' && platform.matches()) {
      try {
        const shell = await resolveConfiguredPowerShell({ ...process.env, ...d.env })
        shellDetail.push(
          `PowerShell ${shell.version} (${shell.edition})`,
          `shell path ${shell.path}`,
          `native arguments ${shell.nativeArguments}`,
        )
      } catch {
        return {
          name: 'platform',
          status: 'fail',
          detail: [
            `os ${snapshot.os} ${snapshot.arch}`,
            'Selected PowerShell is unavailable. Check AGNES_POWERSHELL (auto, 5.1, 7 or an absolute executable path).',
          ],
        }
      }
    }
    return {
      name: 'platform',
      status: Object.values(snapshot.capabilities).some((value) => value !== 'full') ? 'warn' : 'ok',
      detail: [
        `os ${snapshot.os} ${snapshot.arch}`,
        ...shellDetail,
        ...Object.entries(snapshot.capabilities).map(([key, value]) => `${key}=${value}`),
      ],
    }
  } catch {
    return { name: 'platform', status: 'fail', detail: ['platform probe failed'] }
  }
}

/**
 * Shared resolved profile for all diagnostic sections; no host or provider is started here. It
 * layers the saved account configuration exactly as bootLocal does: routes set up through
 * `agnes config` live there, and a profile without them assembles a host with no provider.routes.
 */
export async function resolveDoctorProfile(
  d: BootDeps & { lock?: LockState; configuration?: ConfigurationService },
  p: ParsedArgs,
): Promise<ResolvedProfile> {
  const cwd = p.cwd ?? d.cwd
  const name = profileNameFrom(p, d.env)
  // Same overlay bootLocal and the daemon apply: providers saved through onboarding or Web settings
  // live in configuration.json, and without them the resolved profile has no routes at all.
  const configuration = d.configuration ?? createConfigurationService({ home: d.home, profile: name })
  const inputs = await readProfileInputs({
    home: d.home,
    cwd,
    flags: { profile: name, park: false, cwd },
    agnesVersion: d.agnesVersion,
    ...(d.lock ? { lock: d.lock } : {}),
    configuration: await configuration.profileInput(),
  })
  const platform = createPlatform()
  await platform.probe({ root: cwd })
  return resolveProfile(inputs, {
    platform: platform.snapshot(),
    agnesVersion: d.agnesVersion,
    now: new Date().toISOString(),
    // Without this, an unset dataDir/cacheDir would expand against the raw OS home instead of
    // d.home (AGH_HOME), which for a plain `agnes doctor` run are the same directory anyway --
    // but not for a custom AGH_HOME or an `--ephemeral` run, where it would resolve a profile
    // that assembleLocalHost never would, and could put a probe's own writes in the real home.
    homeDir: d.home,
  })
}

export async function doctorProfile(d: BootDeps & { lock?: LockState }, p: ParsedArgs): Promise<Section> {
  try {
    const profile = await resolveDoctorProfile(d, p)
    return doctorResolvedProfile(profile)
  } catch {
    return { name: 'profile', status: 'fail', detail: ['profile resolution failed'] }
  }
}

/** Projects the one profile resolved by the aggregate command without resolving it a second time. */
export function doctorResolvedProfile(profile: ResolvedProfile): Section {
  return {
    name: 'profile',
    status: 'ok',
    detail: [
      `${profile.name} hash ${profile.hash}`,
      `packages ${profile.packages.map((pkg) => pkg.id).join(', ')}`,
      `dataDir ${profile.dataDir}`,
      `cacheDir ${profile.cacheDir}`,
    ],
  }
}
