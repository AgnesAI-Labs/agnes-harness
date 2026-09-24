import type { Host } from '@agnes/host'
import type { Section } from './doctor-local.js'

export async function doctorExtensions(host: Pick<Host, 'extensions'>): Promise<Section> {
  try {
    const extensions = host.extensions()
    return {
      name: 'extensions',
      status: extensions.some((entry) => !entry.loaded || entry.error !== undefined) ? 'warn' : 'ok',
      detail:
        extensions.length === 0
          ? ['no extensions declared']
          : extensions.map((entry) =>
              JSON.stringify({
                id: entry.id,
                package: entry.package,
                loaded: entry.loaded,
                // `registered` (tool names) does not exist on the managed host's ExtensionStatus -
                // it never listed tool names, only hooks/slots/resources ownership, which lives
                // behind Host.extensions() as a plain count rather than a name list. `trust` and
                // `version` are what replace it here, both real fields of the new status shape.
                trust: entry.trust,
                version: entry.version,
                ...(entry.error ? { errorCode: entry.error.code } : {}),
              }),
            ),
    }
  } catch {
    return { name: 'extensions', status: 'fail', detail: ['extension diagnostic failed'] }
  }
}
