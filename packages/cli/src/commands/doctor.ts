import { daemonDoctor, daemonStatus, runtimeDoctor } from '@agnes/daemon'
import { createPrompterBridge } from '@agnes/daemon/local'
import {
  CONFIGURATION_ERROR_CODES,
  createConfigurationService,
  HOST_ERROR_CODES,
  type Host,
  dataDir as hostDataDir,
  type ResolvedProfile,
} from '@agnes/host'
import { deploymentProxyHosts } from '@agnes/system-node/deployment-network'
import type { ParsedArgs } from '../args.js'
import { profileNameFrom } from '../boot/inputs.js'
import { assembleLocalHost, type LocalBootDeps } from '../boot/local.js'
import { doctorCodeRuntime } from './doctor-code-runtime.js'
import { doctorCredentials } from './doctor-credentials.js'
import { doctorExtensions } from './doctor-extensions.js'
import { doctorBinary, doctorStorage, type Section } from './doctor-local.js'
import { doctorPlatform, doctorResolvedProfile, resolveDoctorProfile } from './doctor-profile.js'
import { doctorProvider } from './doctor-provider.js'
import { doctorSubagents } from './doctor-subagents.js'
import { doctorText } from './first-run-locales.js'

export type { Section } from './doctor-local.js'
export type DoctorCommandDeps = LocalBootDeps

export const DOCTOR_SECTIONS = [
  'platform',
  'network',
  'provider',
  'storage',
  'credentials',
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

function assemblyFailure(name: DoctorSectionName, error: unknown): Section {
  const value =
    error && typeof error === 'object' ? (error as { code?: unknown; detail?: { reason?: unknown } }) : {}
  if (value.code === 'E_PRESET_UNRESOLVED' && value.detail?.reason === 'no-routes')
    return {
      name,
      status: 'warn',
      detail: ['No model provider is configured. Run agh config to complete setup.'],
    }

  return failed(
    name,
    `${name} host assembly failed${[...HOST_ERROR_CODES, ...CONFIGURATION_ERROR_CODES].some((code) => code === value.code) ? ` (${value.code})` : ''}`,
  )
}

/** Read-only daemon health through the package-owned owner/process/socket probes. */
export async function doctorDaemon(deps: Pick<DoctorCommandDeps, 'home'>): Promise<Section> {
  const dataDir = hostDataDir(deps.home)
  try {
    const state = await daemonStatus(deps.home)
    if (!state.running) return { name: 'daemon', status: 'warn', detail: ['not running'] }

    const report = await daemonDoctor({ dataDir, home: deps.home, clock: Date.now })
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
        `${mark[section.status]} ${section.title ?? section.name}\n${section.detail.map((line) => `    ${line}`).join('\n')}`,
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
  if (parsed.positional.length === 0) {
    const report = await runtimeDoctor({
      home: deps.home,
      profile: profileNameFrom(parsed, deps.env),
      probeAccounts: parsed.probe,
      ...(deps.configuration ? { configuration: deps.configuration } : {}),
      ...(deps.signal ? { signal: deps.signal } : {}),
      connection: async () => (await daemonStatus(deps.home)).socketReachable === true,
    })
    const sections = report.checks.map((check) => ({
      name: check.id,
      title: doctorText(deps.env, `doctor.check.${check.id}`),
      status: check.status,
      fixHintKey: check.fixHintKey,
      detail: check.status === 'ok' ? [] : [doctorText(deps.env, check.fixHintKey)],
    }))
    return {
      text: parsed.json ? JSON.stringify(sections, null, 2) : renderSections(sections),
      json: sections,
      exitCode: report.status === 'fail' ? 1 : 0,
    }
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
        case 'network': {
          const proxies = deploymentProxyHosts()
          sections.push({
            name: 'network',
            status: proxies.http === 'invalid' || proxies.https === 'invalid' ? 'fail' : 'ok',
            detail: [
              `HTTP proxy: ${proxies.http}`,
              `HTTPS proxy: ${proxies.https}`,
              `NO_PROXY exclusions: ${proxies.exclusionsConfigured ? 'configured' : 'none'}`,
            ],
          })
          break
        }
        case 'credentials':
          sections.push(await doctorCredentials(commandDeps))
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
          } catch (error) {
            sections.push(assemblyFailure('profile', error))
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
            if (!accounts.some((account) => account.enabled && account.credentialConfigured)) {
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
          } catch (error) {
            sections.push(assemblyFailure('provider', error))
          }
          break
        case 'extensions':
          try {
            sections.push(await doctorExtensions(await assembledHost()))
          } catch (error) {
            sections.push(assemblyFailure('extensions', error))
          }
          break
        case 'code-runtime':
          try {
            sections.push(
              await doctorCodeRuntime(await assembledHost(), {
                ...(commandDeps.signal ? { signal: commandDeps.signal } : {}),
              }),
            )
          } catch (error) {
            sections.push(assemblyFailure('code-runtime', error))
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
