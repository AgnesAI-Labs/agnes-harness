import { runtimeDoctor } from '@agnes/code'
import type { Host } from '@agnes/host'
import type { Section } from './doctor-local.js'

type RuntimeHost = Pick<Host, 'profile' | 'runtimes'>
type DiagnosticRuntime = Exclude<Parameters<typeof runtimeDoctor>[0], undefined>

const silentLogger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
}

/**
 * Instantiates only runtimes selected by the resolved profile. The Host package deliberately keeps
 * package exports as `unknown`; code's doctor is the contract validator at this boundary, so the
 * value is narrowed only for that call and never used to execute user code.
 */
export async function doctorCodeRuntime(
  host: RuntimeHost,
  options: { signal?: AbortSignal } = {},
): Promise<Section> {
  const languages = host.profile.runtimes
  if (languages.length === 0) {
    const report = await runtimeDoctor(undefined)
    return {
      name: report.name,
      status: report.status,
      detail: report.checks.map((check) => `${check.id}: ${check.status} ${check.detail}`),
    }
  }

  const detail: string[] = []
  let status: Section['status'] = 'ok'
  const worsen = (next: Section['status']): void => {
    if (next === 'fail' || (next === 'warn' && status === 'ok')) status = next
  }

  for (const language of languages) {
    const factory = host.runtimes[language]
    if (factory === undefined) {
      worsen('fail')
      detail.push(`${language}/installed: fail no runtime factory is installed for this profile`)
      continue
    }

    let runtime: DiagnosticRuntime | undefined
    try {
      runtime = (await factory({
        log: silentLogger,
        signal: options.signal ?? new AbortController().signal,
      })) as DiagnosticRuntime
    } catch {
      worsen('fail')
      detail.push(`${language}/factory: fail runtime factory failed`)
      continue
    }

    try {
      const report = await runtimeDoctor(runtime)
      worsen(report.status)
      detail.push(...report.checks.map((check) => `${language}/${check.id}: ${check.status} ${check.detail}`))
    } catch {
      worsen('fail')
      detail.push(`${language}/probe: fail runtime diagnostic failed`)
    } finally {
      try {
        await runtime.shutdown()
      } catch {
        worsen('fail')
        detail.push(`${language}/cleanup: fail runtime cleanup failed`)
      }
    }
  }

  return { name: 'code-runtime', status, detail }
}
