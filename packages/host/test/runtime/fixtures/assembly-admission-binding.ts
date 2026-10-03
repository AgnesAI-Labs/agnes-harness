import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import type { Outcome } from '@agnes/extension-api/runtime'
import type { AdmissionProbe } from '@agnes/protocol/runtime'
import type { createAdmissionTickets } from '../../../src/runtime/assembly/admission-ticket.js'
import { type AdmissionFixtureInput, openAdmissionFixture } from './assembly-admission-fixture.js'
import { assemblyMaintenanceContext, maintenancePayload } from './assembly-maintenance.js'

export const admissionProcessScript = fileURLToPath(
  new URL('../../../../../tools/acceptance/runtime/fixtures/assembly-admission-process.ts', import.meta.url),
)
export function admissionCold(
  provider: 'default' | 'reference',
  directory: string,
  operation = 'coordinate',
) {
  const child = spawnSync(
    process.execPath,
    ['--import', 'tsx', admissionProcessScript, provider, directory, operation],
    { encoding: 'utf8', timeout: 30_000 },
  )
  if (child.status !== 0 || child.error)
    throw new Error(`Restricted State process failed: ${child.stderr}`, { cause: child.error })
  return JSON.parse(child.stdout) as {
    result: Outcome<AdmissionProbe>
    snapshot: {
      runs: ReturnType<Awaited<ReturnType<typeof openAdmissionFixture>>['state']['inspect']>['runs']
      pins: { ticketId: string; status: string }[]
    }
  } & {
    state: ReturnType<Awaited<ReturnType<typeof openAdmissionFixture>>['state']['inspect']>
    control: Awaited<
      ReturnType<Awaited<ReturnType<typeof openAdmissionFixture>>['coordinator']['sessionControlStatus']>
    >
    maintenance: ReturnType<
      Awaited<ReturnType<typeof openAdmissionFixture>>['maintenance']['database']['inspect']
    >
  }
}
export function admissionTestBinding(providerId: 'default' | 'reference', input: AdmissionFixtureInput) {
  return {
    providerId,
    providerDigest: '0'.repeat(64),
    command: 'vitest restricted State admission',
    build: {
      codeSha: 'fixture',
      buildDigest: '0'.repeat(64),
      lockDigest: '0'.repeat(64),
      specVersion: 'fixture',
      sdkVersion: 'fixture',
      sdkDigest: '0'.repeat(64),
      platform: 'fixture',
    },
    context: assemblyMaintenanceContext,
    async open(directory: string) {
      const fixture = await openAdmissionFixture(directory, providerId, input)
      return {
        subject: fixture.coordinator,
        draft: fixture.draft,
        nextDraft: () => fixture.draft('new'),
        switchRoute: fixture.switchRoute,
        nextPreset: {
          id: fixture.input.configuration.preset.id,
          digest: fixture.input.configuration.presetDigest,
        },
        issue: (draft: Parameters<ReturnType<typeof createAdmissionTickets>['issue']>[0]) =>
          fixture.tickets.issue(draft, assemblyMaintenanceContext()),
        snapshot() {
          return {
            runs: fixture.state.inspect().runs,
            pins: fixture.maintenance.database
              .inspect()
              .records.filter((row) => row.recordId.startsWith('pin:admission:'))
              .map((row) => {
                const data = maintenancePayload(row)
                return { ticketId: String(data.ownerId), status: String(data.status) }
              }),
          }
        },
        close: fixture.close,
      }
    },
    coldRecover: (directory: string) => Promise.resolve(admissionCold(providerId, directory)),
  }
}
