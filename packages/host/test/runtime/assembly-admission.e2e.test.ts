import { fork, spawnSync } from 'node:child_process'
import { once } from 'node:events'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  admissionFixtureInput,
  exerciseAssemblyAdmission,
} from '../../../extension-api/testkit/runtime/contracts/assembly-admission.js'
import {
  exerciseAssemblyPublication,
  maintenanceData,
  upgradeAssemblyFixture,
} from '../../../extension-api/testkit/runtime/contracts/assembly-publish.js'
import {
  admissionCold,
  admissionProcessScript,
  admissionTestBinding,
} from './fixtures/assembly-admission-binding.js'
import { openAdmissionFixture } from './fixtures/assembly-admission-fixture.js'
import { assemblyMaintenanceContext } from './fixtures/assembly-maintenance.js'
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

describe('restricted persistent State admission process recovery', { timeout: 120_000 }, () => {
  it.each(['default', 'reference'] as const)(
    '%s races creation and cancellation in two real State processes',
    async (provider) => {
      const directory = mkdtempSync(join(tmpdir(), 'agnes-admission-race-'))
      const seed = await openAdmissionFixture(directory, provider, admissionFixtureInput())
      const issued = await seed.tickets.issue(seed.draft(), assemblyMaintenanceContext())
      expect(issued.ok).toBe(true)
      await seed.close()
      const children = ['coordinate', 'cancel'].map((operation) => {
        const child = fork(admissionProcessScript, [provider, directory, operation, 'race-start'], {
          execArgv: ['--import', 'tsx'],
          stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
        })
        let stdout = '',
          stderr = ''
        child.stdout?.on('data', (chunk) => {
          stdout += String(chunk)
        })
        child.stderr?.on('data', (chunk) => {
          stderr += String(chunk)
        })
        const ready = Promise.race([
          once(child, 'message'),
          once(child, 'exit').then(([code]) => {
            throw new Error(`Race fixture exited ${code}: ${stderr}`)
          }),
        ])
        const done = once(child, 'exit').then(([code]) => {
          expect(code, stderr).toBe(0)
          return JSON.parse(stdout) as ReturnType<typeof admissionCold>
        })
        // A bootstrap failure can reject before ready; keep cleanup from leaking another rejection.
        void done.catch(() => undefined)
        return { child, ready, done }
      })
      try {
        await Promise.all(children.map((entry) => entry.ready))
        for (const entry of children) entry.child.send('go')
        const [created, cancelled] = await Promise.all(children.map((entry) => entry.done))
        expect(created?.result).toEqual(cancelled?.result)
        expect(created?.result.ok).toBe(true)
        const recovered = admissionCold(provider, directory)
        expect(recovered.result).toEqual(created?.result)
        expect(recovered.state.admissions).toHaveLength(1)
        expect(recovered.state.runs.length).toBe(
          recovered.state.admissions[0]?.proof.state === 'created' ? 1 : 0,
        )
      } finally {
        for (const { child } of children)
          if (child.exitCode === null && child.signalCode === null) {
            const exited = once(child, 'exit')
            child.kill('SIGKILL')
            await exited
          }
        rmSync(directory, { recursive: true, force: true })
      }
    },
  )
  it.each(['default', 'reference'] as const)(
    '%s executes the admission cold-recover contract',
    async (provider) => {
      expect(
        (await exerciseAssemblyAdmission(admissionTestBinding(provider, admissionFixtureInput()), 'recover'))
          .passed,
      ).toBe(true)
    },
  )
  it.each(
    (['default', 'reference'] as const).flatMap((provider) =>
      [
        ['coordinate', 'issue:before'],
        ['coordinate', 'issue:after'],
        ['coordinate', 'create:before'],
        ['coordinate', 'create:after'],
        ['confirm-created', 'confirm:before'],
        ['confirm-created', 'confirm:after'],
        ['cancel', 'cancel:before'],
        ['cancel', 'cancel:after'],
        ['confirm-cancelled', 'confirm:before'],
        ['confirm-cancelled', 'confirm:after'],
        ['parameters', 'create:before'],
        ['parameters', 'create:after'],
      ].map(([operation, checkpoint]) => ({
        provider,
        operation: operation ?? '',
        checkpoint: checkpoint ?? '',
      })),
    ),
  )(
    '$provider survives SIGKILL at $operation/$checkpoint with one durable result and no lost pin',
    async ({ provider, operation, checkpoint }) => {
      const directory = mkdtempSync(join(tmpdir(), 'agnes-admission-state-kill-'))
      const child = fork(admissionProcessScript, [provider, directory, operation, checkpoint], {
        execArgv: ['--import', 'tsx'],
        stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      })
      let stderr = ''
      child.stderr?.on('data', (value) => {
        stderr += String(value)
      })
      let timer: ReturnType<typeof setTimeout> | undefined
      try {
        const message = await Promise.race([
          once(child, 'message').then(([value]) => value),
          once(child, 'exit').then(([code]) => {
            throw new Error(`State fixture exited ${code}: ${stderr}`)
          }),
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(new Error(`State checkpoint timeout: ${stderr}`)), 30_000)
          }),
        ])
        expect(message).toMatchObject({ checkpoint })
        const exited = once(child, 'exit')
        child.kill('SIGKILL')
        await exited
        const killed = admissionCold(provider, directory, 'inspect')
        const active = killed.snapshot.pins.filter((pin) => pin.status === 'active')
        for (const run of killed.snapshot.runs)
          expect(active.some((pin) => pin.ticketId === run.admission.ticketId)).toBe(true)
        const ticket = killed.maintenance.records.find(
          (row) => row.recordId === `ticket:fixture-ticket-${operation === 'parameters' ? 'new' : 'old'}`,
        )
        const pin = killed.snapshot.pins.find(
          (row) => row.ticketId === `fixture-ticket-${operation === 'parameters' ? 'new' : 'old'}`,
        )
        expect(Boolean(ticket)).toBe(Boolean(pin))
        if (operation === 'parameters') {
          expect(
            killed.state.runs.find((run) => run.admission.runId === 'fixture-run-old')?.binding.providers[0]
              ?.descriptor.packageVersion,
          ).toBe('1.0.0')
          expect(killed.state.runs.length).toBe(checkpoint === 'create:before' ? 1 : 2)
          expect(killed.control).toMatchObject({
            ok: true,
            value: { status: checkpoint === 'create:before' ? 'accepted' : 'applied' },
          })
          expect(killed.state.session.activeRunId).toBe(
            checkpoint === 'create:before' ? 'fixture-run-old' : 'fixture-run-new',
          )
          const recovered = admissionCold(provider, directory, 'parameters')
          expect(recovered.result).toMatchObject({
            ok: true,
            value: { state: 'created', runId: 'fixture-run-new' },
          })
          expect(recovered.state.runs).toHaveLength(2)
          const old = recovered.state.runs.find((run) => run.admission.runId === 'fixture-run-old')
          expect(old).toEqual(killed.state.runs.find((run) => run.admission.runId === 'fixture-run-old'))
          expect(
            recovered.state.runs.find((run) => run.admission.runId === 'fixture-run-new')?.binding
              .providers[0]?.descriptor.packageVersion,
          ).toBe('2.0.0')
        } else {
          const recovered = admissionCold(
            provider,
            directory,
            operation === 'cancel' || operation === 'confirm-cancelled' ? 'cancel' : 'coordinate',
          )
          expect(recovered.result.ok).toBe(true)
          const outcome = recovered.state.admissions[0]?.proof
          expect(recovered.state.admissions).toHaveLength(1)
          expect(recovered.state.runs.length).toBe(outcome?.state === 'created' ? 1 : 0)
          expect(recovered.snapshot.pins[0]?.status).toBe(
            outcome?.state === 'created' ? 'active' : 'released',
          )
          expect(admissionCold(provider, directory, 'coordinate').result).toEqual(recovered.result)
        }
      } finally {
        clearTimeout(timer)
        if (child.exitCode === null && child.signalCode === null) {
          const exited = once(child, 'exit')
          child.kill('SIGKILL')
          await exited
        }
        rmSync(directory, { recursive: true, force: true })
      }
    },
  )
})
