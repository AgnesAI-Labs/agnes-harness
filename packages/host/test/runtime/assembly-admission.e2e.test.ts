import { fork, spawnSync } from 'node:child_process'
import { once } from 'node:events'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  exerciseAssemblyPublication,
  maintenanceData,
  upgradeAssemblyFixture,
} from '../../../extension-api/testkit/runtime/contracts/assembly-publish.js'
import { assemblyTestBinding } from './fixtures/assembly-publish-binding.js'

const script = fileURLToPath(
  new URL('../../../../tools/acceptance/runtime/fixtures/assembly-cold-process.ts', import.meta.url),
)
function cold(provider: string, directory: string, command: string) {
  const processResult = spawnSync(
    process.execPath,
    ['--import', 'tsx', script, provider, directory, command],
    { encoding: 'utf8', timeout: 30_000 },
  )
  expect(processResult.error).toBeUndefined()
  expect(processResult.status, processResult.stderr).toBe(0)
  return JSON.parse(processResult.stdout) as Awaited<
    ReturnType<ReturnType<typeof assemblyTestBinding>['coldReplay']>
  > & { ticket: { ok: boolean; value?: unknown } }
}
async function killAt(provider: string, directory: string, checkpoint: string) {
  const child = fork(
    script,
    [provider, directory, checkpoint.startsWith('ticket') ? 'ticket' : 'publish', checkpoint],
    { execArgv: ['--import', 'tsx'], stdio: ['ignore', 'pipe', 'pipe', 'ipc'] },
  )
  let stderr = ''
  child.stderr?.on('data', (chunk) => {
    stderr += String(chunk)
  })
  try {
    const message = await Promise.race([
      once(child, 'message').then(([value]) => value),
      once(child, 'exit').then(([code]) => {
        throw new Error(`fixture exited ${code}: ${stderr}`)
      }),
      new Promise<never>((_, reject) => {
        const timer = setTimeout(() => reject(new Error(`fixture checkpoint timeout: ${stderr}`)), 30_000)
        timer.unref()
      }),
    ])
    expect(message).toMatchObject({ checkpoint })
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, 'exit')
      child.kill('SIGKILL')
      await exited
    }
  }
}

describe('maintenance process persistence (Runtime State admission unavailable)', {
  timeout: 120_000,
}, () => {
  it.each(['default', 'reference'] as const)(
    '%s replays committed route and pins in a cold process',
    async (provider) => {
      expect((await exerciseAssemblyPublication(assemblyTestBinding(provider), 'recover')).passed).toBe(true)
    },
  )
  it.each(
    (['default', 'reference'] as const).flatMap((provider) =>
      ['publish-before', 'publish-after', 'ticket-before', 'ticket-after'].map((checkpoint) => ({
        provider,
        checkpoint,
      })),
    ),
  )(
    '$provider preserves atomic facts after kill at $checkpoint',
    async ({ provider, checkpoint }) => {
      const directory = mkdtempSync(join(tmpdir(), 'agnes-assembly-kill-')),
        input = upgradeAssemblyFixture()
      writeFileSync(join(directory, 'input.json'), JSON.stringify(input), { mode: 0o600 })
      try {
        await killAt(provider, directory, checkpoint)
        const recovered = cold(provider, directory, 'inspect'),
          snapshot = recovered.snapshot
        const route = snapshot.records.find((row) => row.recordId === `release-route:${input.plan.routeId}`)
        const operation = snapshot.records.find((row) => row.recordId === `upgrade:${input.plan.upgradeId}`)
        expect(route).toBeDefined()
        expect(operation).toBeDefined()
        if (!route || !operation) throw new Error('durable fixture facts missing')
        if (checkpoint === 'publish-before') {
          expect(route.revision).toBe(1)
          expect(maintenanceData(route).activeReleaseSetId).toBe(input.plan.sourceReleaseSetId)
          expect(maintenanceData(operation).state).toBe('verified')
          expect(snapshot.outbox).toEqual([])
          expect(snapshot.transactions).not.toContain(`publish:${input.plan.upgradeId}`)
          expect(cold(provider, directory, 'replay').published).toMatchObject({
            ok: false,
            error: { detailCode: 'candidate_not_prepared' },
          })
          expect(cold(provider, directory, 'publish').published).toMatchObject({ ok: true })
        } else {
          expect(route.revision).toBe(2)
          expect(maintenanceData(route).activeReleaseSetId).toBe(input.plan.targetReleaseSet.releaseSetId)
          expect(maintenanceData(operation).state).toBe('committed')
          expect(snapshot.outbox).toHaveLength(1)
          expect(
            snapshot.records.find((row) => row.recordId === `cutover:${input.plan.upgradeId}`),
          ).toBeDefined()
          expect(cold(provider, directory, 'replay').published).toMatchObject({ ok: true })
          expect(cold(provider, directory, 'inspect').snapshot).toEqual(snapshot)
        }
        if (checkpoint.startsWith('ticket')) {
          const ticket = snapshot.records.find((row) => row.recordId === 'ticket:fixture-ticket')
          const pin = snapshot.records.find((row) => row.recordId === 'pin:admission:fixture-ticket')
          expect(Boolean(ticket)).toBe(checkpoint === 'ticket-after')
          expect(Boolean(pin)).toBe(checkpoint === 'ticket-after')
          const issued = cold(provider, directory, 'ticket-replay')
          expect(issued.ticket).toMatchObject({ ok: true })
          const replayed = cold(provider, directory, 'ticket-replay')
          expect(replayed.ticket).toEqual(issued.ticket)
          expect(replayed.snapshot).toEqual(issued.snapshot)
          expect(
            JSON.parse(readFileSync(join(directory, 'ticket-draft.json'), 'utf8')).admission.ticketId,
          ).toBe('fixture-ticket')
        }
        expect(recovered.activePins.ok).toBe(true)
        if (recovered.activePins.ok) expect(recovered.activePins.value.length).toBeGreaterThan(0)
      } finally {
        rmSync(directory, { recursive: true, force: true })
      }
    },
    120_000,
  )
})
