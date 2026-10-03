import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createReferenceAssemblyProvider } from '../../../../examples/runtime-reference/src/providers/assembly.js'
import { createReferenceAdmissionCoordinator } from '../../../../examples/runtime-reference/src/providers/assembly-admission-coordinator.js'
import {
  admissionFixtureInput,
  exerciseAssemblyAdmission,
} from '../../../extension-api/testkit/runtime/contracts/assembly-admission.js'
import { fixtureHash } from '../../../extension-api/testkit/runtime/contracts/assembly-fixture.js'
import { createAdmissionCoordinator } from '../../src/runtime/assembly/admission.js'
import { createAssemblyProvider } from '../../src/runtime/providers/assembly.js'
import { admissionTestBinding } from './fixtures/assembly-admission-binding.js'
import { openAdmissionFixture } from './fixtures/assembly-admission-fixture.js'
import { assemblyMaintenanceContext, maintenancePayload } from './fixtures/assembly-maintenance.js'

const ctx = assemblyMaintenanceContext
type Fixture = Awaited<ReturnType<typeof openAdmissionFixture>>
async function withFixture(provider: 'default' | 'reference', body: (fixture: Fixture) => Promise<void>) {
  const directory = mkdtempSync(join(tmpdir(), 'agnes-admission-'))
  const fixture = await openAdmissionFixture(directory, provider, admissionFixtureInput())
  try {
    await body(fixture)
  } finally {
    await fixture.close()
    rmSync(directory, { recursive: true, force: true })
  }
}

describe('restricted persistent State admission coordination', () => {
  it.each(['default', 'reference'] as const)(
    '%s explicitly refuses unqualified production admission and session control',
    async (provider) => {
      const factory = provider === 'default' ? createAssemblyProvider : createReferenceAssemblyProvider
      const subject = factory(admissionFixtureInput())
      expect(await subject.admission.readSessionControl('fixture-session', ctx())).toMatchObject({
        ok: false,
        error: { code: 'incompatible', detailCode: 'unsupported' },
      })
      await subject.dispose()
    },
  )
  it.each(
    (['default', 'reference'] as const).flatMap((provider) =>
      (['select', 'normal', 'deny', 'cancel', 'dispose'] as const).map((scenario) => ({
        provider,
        scenario,
      })),
    ),
  )(
    '$provider executes admission $scenario through public State signatures',
    async ({ provider, scenario }) => {
      expect(
        (await exerciseAssemblyAdmission(admissionTestBinding(provider, admissionFixtureInput()), scenario))
          .passed,
      ).toBe(true)
    },
  )
  it.each(['default', 'reference'] as const)(
    '%s preserves a signed ticket across route cutover and atomically consumes pending selection',
    async (provider) => {
      await withFixture(provider, async (fixture) => {
        const draft = fixture.draft(),
          issued = await fixture.tickets.issue(draft, ctx())
        expect(issued.ok).toBe(true)
        await fixture.switchRoute()
        const old = await fixture.coordinator.coordinate(draft, ctx())
        expect(old).toMatchObject({ ok: true, value: { state: 'created', runId: 'fixture-run-old' } })
        const oldRun = structuredClone(fixture.state.inspect().runs[0])
        const request = {
          sessionId: 'fixture-session',
          requestId: 'fixture-change',
          expectedRevision: 1,
          command: {
            kind: 'set-preset' as const,
            presetId: fixture.input.configuration.preset.id,
            presetDigest: fixture.input.configuration.presetDigest,
            apply: 'next-run' as const,
          },
        }
        const pending = await fixture.coordinator.submitSessionControl(request, ctx())
        expect(pending).toMatchObject({ ok: true, value: { status: 'accepted' } })
        expect(await fixture.coordinator.submitSessionControl(request, ctx())).toEqual(pending)
        expect(
          await fixture.coordinator.submitSessionControl(
            { ...request, command: { ...request.command, presetId: 'changed' } },
            ctx(),
          ),
        ).toMatchObject({ ok: false, error: { detailCode: 'session_control_conflict' } })
        expect(await fixture.coordinator.readSessionControl('fixture-session', ctx())).toMatchObject({
          ok: true,
          value: { parameters: oldRun?.parameters, activeRunId: 'fixture-run-old' },
        })
        fixture.maintenance.control.authorized = false
        expect(await fixture.coordinator.coordinate(fixture.draft('new'), ctx())).toMatchObject({
          ok: false,
          error: { detailCode: 'maintenance_denied' },
        })
        fixture.maintenance.control.authorized = true
        expect(
          await fixture.coordinator.sessionControlStatus('fixture-session', request.requestId, ctx()),
        ).toEqual(pending)
        const abandoned = fixture.draft('new', 'cancelled-new')
        const ticket = await fixture.tickets.issue(abandoned, ctx())
        if (!ticket.ok) throw new Error(ticket.error.detailCode)
        expect(
          await fixture.coordinator.cancel(
            abandoned.admission.ticketId,
            ticket.value.admission.fingerprint,
            ctx(),
          ),
        ).toMatchObject({ ok: true, value: { state: 'cancelled' } })
        expect(
          await fixture.coordinator.sessionControlStatus('fixture-session', request.requestId, ctx()),
        ).toEqual(pending)
        expect(fixture.state.inspect().session.parameters).toEqual(oldRun?.parameters)
        const created = await fixture.coordinator.coordinate(fixture.draft('new'), ctx())
        expect(created).toMatchObject({ ok: true, value: { state: 'created', runId: 'fixture-run-new' } })
        expect(fixture.state.inspect().runs.find((run) => run.admission.runId === 'fixture-run-old')).toEqual(
          oldRun,
        )
        const current = fixture.state.inspect().session
        expect(current.activeRunId).toBe('fixture-run-new')
        expect(current.parameters.presetDigest).toBe(fixture.input.configuration.presetDigest)
        expect(
          await fixture.coordinator.sessionControlStatus('fixture-session', request.requestId, ctx()),
        ).toMatchObject({ ok: true, value: { status: 'applied', runId: 'fixture-run-new' } })
      })
    },
  )
  it.each(['default', 'reference'] as const)(
    '%s uses one durable outcome in competing create/cancel and conflicts on changed fingerprints',
    async (provider) => {
      await withFixture(provider, async (fixture) => {
        const draft = fixture.draft(),
          issued = await fixture.tickets.issue(draft, ctx())
        if (!issued.ok) throw new Error(issued.error.detailCode)
        const second = fixture.another()
        try {
          const results = await Promise.all([
            fixture.coordinator.coordinate(draft, ctx()),
            second.cancel(draft.admission.ticketId, issued.value.admission.fingerprint, ctx()),
          ])
          expect(results[0]).toEqual(results[1])
          expect(results[0]?.ok).toBe(true)
          const snapshot = fixture.state.inspect()
          expect(snapshot.admissions).toHaveLength(1)
          expect(snapshot.runs.length).toBe(snapshot.admissions[0]?.proof.state === 'created' ? 1 : 0)
          const pin = maintenancePayload(
            fixture.maintenance.database.get('pin:admission:fixture-ticket-old') ?? undefined,
          )
          expect(pin.status).toBe(snapshot.runs.length ? 'active' : 'released')
          expect(
            await fixture.coordinator.coordinate(
              { ...draft, admission: { ...draft.admission, lane: 'changed' } },
              ctx(),
            ),
          ).toMatchObject({ ok: false, error: { detailCode: 'admission_ticket_conflict' } })
          expect(await second.cancel(draft.admission.ticketId, '0'.repeat(64), ctx())).toMatchObject({
            ok: false,
            error: { detailCode: 'admission_ticket_conflict' },
          })
          expect(
            await fixture.coordinator.coordinate(
              { ...draft, admission: { ...draft.admission, ticketId: 'different-ticket' } },
              ctx(),
            ),
          ).toMatchObject({ ok: false, error: { detailCode: 'admission_ticket_conflict' } })
        } finally {
          await second.dispose()
        }
      })
    },
  )
  it.each(['default', 'reference'] as const)(
    '%s converges identical concurrent requests and retains pins for absent, unreachable and malformed probes',
    async (provider) => {
      await withFixture(provider, async (fixture) => {
        const draft = fixture.draft(),
          second = fixture.another()
        try {
          const results = await Promise.all([
            fixture.coordinator.coordinate(draft, ctx()),
            second.coordinate(draft, ctx()),
          ])
          expect(results[0]).toEqual(results[1])
          expect(results[0]).toMatchObject({ ok: true, value: { state: 'created' } })
          expect(fixture.state.inspect().runs).toHaveLength(1)
        } finally {
          await second.dispose()
        }
      })
      await withFixture(provider, async (fixture) => {
        const issued = await fixture.tickets.issue(fixture.draft(), ctx())
        if (!issued.ok) throw new Error(issued.error.detailCode)
        const before = fixture.maintenance.database.inspect()
        expect(await fixture.coordinator.probe('fixture-ticket-old', ctx())).toEqual({
          ok: true,
          value: { state: 'absent' },
        })
        const factory =
          provider === 'default' ? createAdmissionCoordinator : createReferenceAdmissionCoordinator
        fixture.maintenance.control.now = '2028-01-01T00:00:00Z'
        expect(await fixture.coordinator.coordinate(fixture.draft(), ctx())).toMatchObject({
          ok: false,
          error: { detailCode: 'admission_expired' },
        })
        fixture.maintenance.control.now = fixture.input.fixture.now
        // Fault replies surround a real durable State; they are never used as normal/recover evidence.
        const unknown = factory(fixture.maintenance.ports, {
          ...fixture.state.ports,
          store: {
            ...fixture.state.ports.store,
            async probeAdmission() {
              return { ok: true, value: JSON.parse('{"state":"unknown"}') }
            },
          },
        })
        try {
          expect(await unknown.probe('fixture-ticket-old', ctx())).toMatchObject({
            ok: false,
            error: { detailCode: 'schema_invalid' },
          })
          expect(fixture.maintenance.database.inspect()).toEqual(before)
        } finally {
          await unknown.dispose()
        }
        const missing = factory(fixture.maintenance.ports, {
          ...fixture.state.ports,
          store: {
            ...fixture.state.ports.store,
            async probeAdmission() {
              throw new Error('unreachable')
            },
          },
        })
        try {
          expect(await missing.probe('fixture-ticket-old', ctx())).toMatchObject({
            ok: false,
            error: { detailCode: 'maintenance_unavailable' },
          })
          expect(
            await missing.cancel('fixture-ticket-old', issued.value.admission.fingerprint, ctx()),
          ).toMatchObject({ ok: false })
          expect(fixture.maintenance.database.inspect()).toEqual(before)
          expect(fixture.state.inspect().admissions[0]?.proof.state).toBe('cancelled')
          expect(await fixture.coordinator.probe('fixture-ticket-old', ctx())).toMatchObject({
            ok: true,
            value: { state: 'cancelled' },
          })
          expect(
            maintenancePayload(
              fixture.maintenance.database.get('pin:admission:fixture-ticket-old') ?? undefined,
            ).status,
          ).toBe('released')
        } finally {
          await missing.dispose()
        }
      })
    },
  )
  it('keeps the admission reference independent and returns the same public result and refusal codes', async () => {
    const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8')
    const defaultSource = read('../../src/runtime/assembly/admission.ts')
    const reference = read(
      '../../../../examples/runtime-reference/src/providers/assembly-admission-coordinator.ts',
    )
    expect(reference).not.toMatch(/@agnes\/host|packages\/host|createAdmissionCoordinator/)
    const lines = (source: string) =>
      new Set(
        source
          .split('\n')
          .map((line) => line.replace(/\s/g, ''))
          .filter(Boolean),
      )
    const a = lines(defaultSource),
      b = lines(reference)
    expect([...a].filter((line) => b.has(line)).length / Math.min(a.size, b.size)).toBeLessThanOrEqual(0.5)
    const results: unknown[] = []
    for (const provider of ['default', 'reference'] as const)
      await withFixture(provider, async (fixture) => {
        const result = await fixture.coordinator.coordinate(fixture.draft(), ctx())
        const failure = await fixture.coordinator.coordinate({ ...fixture.draft(), runKey: 'changed' }, ctx())
        results.push({
          result,
          error: failure.ok ? null : { code: failure.error.code, detailCode: failure.error.detailCode },
          snapshot: fixture.state.inspect(),
        })
      })
    expect(fixtureHash(results[0])).toBe(fixtureHash(results[1]))
  })
})
