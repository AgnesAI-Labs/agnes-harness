import { inspectCredentialMetadata } from '@agnes/host'
import type { BootDeps } from '../types.js'
import type { Section } from './doctor-local.js'

export async function doctorCredentials(deps: BootDeps): Promise<Section> {
  const rows = await inspectCredentialMetadata(deps.home)
  return {
    name: 'credentials',
    status: rows.some((row) => !['ok', 'missing'].includes(row.check)) ? 'fail' : 'ok',
    detail: rows.map((row) => {
      const target = row.target.replace(/\p{Cc}/gu, '?')
      const mode = row.mode ? ` mode=${row.mode}` : ''
      const expected = row.expectedMode ? ` expectedMode=${row.expectedMode}` : ''
      const repair =
        row.repair === 'chmod' && !/\p{Cc}/u.test(row.target)
          ? `; chmod -- ${row.expectedMode} '${row.target.replace(/'/g, `'"'"'`)}'`
          : ''
      return `${row.part}: ${row.check}${mode}${expected} ${target}${repair}`
    }),
  }
}
