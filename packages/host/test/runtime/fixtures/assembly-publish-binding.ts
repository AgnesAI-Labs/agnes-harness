import { spawnSync } from 'node:child_process'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Outcome } from '@agnes/extension-api/runtime'
import type {
  AssemblyPublishResult,
  DataRef,
  MaintenanceEnvelopeJsonValue,
  OutboxRecord,
} from '@agnes/protocol/runtime'
import { createReferenceAssemblyProvider } from '../../../../../examples/runtime-reference/src/providers/assembly.js'
import { createAssemblyProvider } from '../../../src/runtime/providers/assembly.js'
import {
  assemblyMaintenanceContext,
  type MaintenanceAssemblyInput,
  persistentAssemblyFixture,
} from './assembly-maintenance.js'

export function assemblyTestBinding(providerId: 'default' | 'reference') {
  return {
    providerId,
    providerDigest: '0'.repeat(64),
    command: 'vitest persistent maintenance fixture',
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
    create: providerId === 'default' ? createAssemblyProvider : createReferenceAssemblyProvider,
    async open(input: MaintenanceAssemblyInput, directory: string) {
      const fixture = await persistentAssemblyFixture(input, join(directory, 'maintenance.sqlite'))
      if (!fixture.memory) throw new Error('fixture lifecycle missing')
      return { ...fixture, lifecycle: fixture.memory.lifecycle, snapshot: fixture.database.inspect }
    },
    async coldReplay(directory: string) {
      const script = fileURLToPath(
        new URL('../../../../../tools/acceptance/runtime/fixtures/assembly-cold-process.ts', import.meta.url),
      )
      const child = spawnSync(
        process.execPath,
        ['--import', 'tsx', script, providerId, directory, 'replay'],
        { encoding: 'utf8', timeout: 30_000 },
      )
      if (child.error || child.status !== 0)
        throw new Error(`fixture cold process failed: ${child.stderr}`, { cause: child.error })
      return JSON.parse(child.stdout) as {
        published: Outcome<AssemblyPublishResult>
        activePins: Outcome<DataRef[]>
        snapshot: { records: MaintenanceEnvelopeJsonValue[]; outbox: OutboxRecord[]; transactions: string[] }
      }
    },
  }
}
