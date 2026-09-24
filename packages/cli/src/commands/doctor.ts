import { daemonDoctor, daemonStatus } from '@agnes/daemon'
import { createPrompterBridge } from '@agnes/daemon/local'
import {
  createConfigurationService,
  type Host,
  dataDir as hostDataDir,
  type ResolvedProfile,
} from '@agnes/host'
import type { ParsedArgs } from '../args.js'
import { profileNameFrom } from '../boot/inputs.js'
import { assembleLocalHost, type LocalBootDeps } from '../boot/local.js'
import { doctorCodeRuntime } from './doctor-code-runtime.js'
import { doctorExtensions } from './doctor-extensions.js'
import { doctorBinary, doctorStorage, type Section } from './doctor-local.js'
import { doctorPlatform, doctorResolvedProfile, resolveDoctorProfile } from './doctor-profile.js'
import { doctorProvider } from './doctor-provider.js'
import { doctorSubagents } from './doctor-subagents.js'

export type { Section } from './doctor-local.js'
export type DoctorCommandDeps = LocalBootDeps

export const DOCTOR_SECTIONS = [
  'platform',
  'provider',
  'storage',
  'profile',
  'extensions',
  'daemon',
  'binary',
  'code-runtime',
] as const

export type DoctorSectionName = (typeof DOCTOR_SECTIONS)[number]

const hostSections = new Set<DoctorSectionName>(['provider', 'extensions', 'code-runtime'])

const failed = (name: DoctorSectionName, detail: string): Section => ({
  name,
  status: 'fail',
  detail: [detail],
})

/** Read-only daemon health through the package-owned owner/process/socket probes (ERRATA B23). */
export async function doctorDaemon(deps: Pick<DoctorCommandDeps, 'home'>): Promise<Section> {
  const dataDir = hostDataDir(deps.home)
  try {
    const state = await daemonStatus(dataDir)
    if (!state.running) return { name: 'daemon', status: 'warn', detail: ['not running'] }

    const report = await daemonDoctor({ dataDir, clock: Date.now })
    const status = report.sections.some((section) => section.status === 'fail')
      ? 'fail'
      : report.sections.some((section) => section.status === 'warn')
        ? 'warn'
        : 'ok'
    return {
      name: 'daemon',
      status,
      // The daemon owns its diagnostic detail. The CLI deliberately projects only the stable
      // section names and statuses instead of serialising owner paths or implementation objects.
      detail: report.sections.map((section) => `${section.name}: ${section.status}`),
    }
  } catch {
    return failed('daemon', 'daemon diagnostic failed')
  }
}

export function renderSections(sections: Section[]): string {
  const mark = { ok: '✓', warn: '!', fail: '✗' } as const
  return sections
    .map(
      (section) =>
        `${mark[section.status]} ${section.name}\n${section.detail.map((line) => `    ${line}`).join('\n')}`,
    )
    .join('\n')
}

export async function doctorCommand(
  parsed: ParsedArgs,
  deps: DoctorCommandDeps,
): Promise<{ text: string; json: Section[]; exitCode: number }> {
  if (parsed.include !== undefined || parsed.skip !== undefined)
    return {
      text: '--include and --skip are only supported by doctor computer-use',
      json: [],
      exitCode: 2,
    }
  if (parsed.positional[0] === 'subagents') {
    const result = await doctorSubagents(deps, { repair: parsed.repair, json: parsed.json })
    return { text: result.text, json: [result.section], exitCode: result.exitCode }
  }
  const selected = selectSections(parsed.positional)
  if (selected === undefined) return { text: 'unknown or extra doctor section', json: [], exitCode: 2 }

  const commandDeps: DoctorCommandDeps = { ...deps, cwd: parsed.cwd ?? deps.cwd }
  let resolvedProfilePromise: Promise<ResolvedProfile> | undefined
  const resolvedProfile = (): Promise<ResolvedProfile> =>
    (resolvedProfilePromise ??= resolveDoctorProfile(commandDeps, parsed))

  let host: Host | undefined
  let hostPromise: Promise<Host> | undefined
  const assembledHost = (): Promise<Host> => {
    hostPromise ??= resolvedProfile().then(async (profile) => {
      const bridge = createPrompterBridge()
      const profileName = profileNameFrom(parsed, commandDeps.env)
      host = await assembleLocalHost(profile, profileName, commandDeps.cwd, commandDeps, bridge.prompter)
      return host
    })
    return hostPromise
  }

  const sections: Section[] = []
  try {
    for (const name of selected) {
      switch (name) {
        case 'platform':
          sections.push(await doctorPlatform(commandDeps))
          break
        case 'storage':
          sections.push(await doctorStorage(commandDeps))
          break
        case 'daemon':
          sections.push(await doctorDaemon(commandDeps))
          break
        case 'profile':
          try {
            sections.push(doctorResolvedProfile(await resolvedProfile()))
          } catch {
            sections.push(failed('profile', 'profile resolution failed'))
          }
          break
        case 'binary':
          try {
            sections.push(await doctorBinary(commandDeps, (await resolvedProfile()).cacheDir))
          } catch {
            sections.push(failed('binary', 'binary cache path resolution failed'))
          }
          break
        case 'provider':
          try {
            const configuration =
              commandDeps.configuration ??
              createConfigurationService({
                home: commandDeps.home,
                profile: profileNameFrom(parsed, commandDeps.env),
              })
            const snapshot = await configuration.get()
            const accounts = snapshot.accounts ?? []
            if (accounts.length === 0) {
              sections.push(
                await doctorProvider(undefined, {
                  signal: commandDeps.signal ?? new AbortController().signal,
                  accounts,
                }),
              )
              break
            }
            sections.push(
              await doctorProvider(await assembledHost(), {
                signal: commandDeps.signal ?? new AbortController().signal,
                timeoutMs: 15_000,
                probe: parsed.probe,
                json: parsed.json,
                accounts,
              }),
            )
          } catch {
            sections.push(failed('provider', 'provider host assembly failed'))
          }
          break
        case 'extensions':
          try {
            sections.push(await doctorExtensions(await assembledHost()))
          } catch {
            sections.push(failed('extensions', 'extension host assembly failed'))
          }
          break
        case 'code-runtime':
          try {
            sections.push(
              await doctorCodeRuntime(await assembledHost(), {
                ...(commandDeps.signal ? { signal: commandDeps.signal } : {}),
              }),
            )
          } catch {
            sections.push(failed('code-runtime', 'code runtime host assembly failed'))
          }
          break
      }
    }
  } finally {
    if (host !== undefined) {
      try {
        await host.close()
      } catch {
        for (const section of sections) {
          if (!hostSections.has(section.name as DoctorSectionName)) continue
          section.status = 'fail'
          section.detail.push('host cleanup failed')
        }
      }
    }
  }

  return {
    text: parsed.json ? JSON.stringify(sections, null, 2) : renderSections(sections),
    json: sections,
    exitCode: sections.some((section) => section.status === 'fail') ? 1 : 0,
  }
}

function selectSections(positional: string[]): DoctorSectionName[] | undefined {
  if (positional.length === 0) return [...DOCTOR_SECTIONS]
  if (positional.length !== 1) return undefined
  const name = positional[0]
  return (DOCTOR_SECTIONS as readonly string[]).includes(name ?? '') ? [name as DoctorSectionName] : undefined
}
