import { inspectCredentialMetadata } from '@agnes/host'
import type { BootDeps } from '../types.js'
import type { Section } from './doctor-local.js'

export async function doctorCredentials(deps: BootDeps): Promise<Section> {
  const rows = await inspectCredentialMetadata(deps.home)
  return {
    name: 'credentials',
    status: rows.some((row) => !['ok', 'missing'].includes(row.check)) ? 'fail' : 'ok',
    detail: rows.map(
      (row) =>
        `${row.part}: ${row.check}${row.mode ? ` mode=${row.mode}` : ''} ${row.target.replace(/\p{Cc}/gu, '?')}`,
    ),
  }
}
