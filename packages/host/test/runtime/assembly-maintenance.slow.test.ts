import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { jcs } from '@agnes/protocol'
import { beforeAll, describe, expect, it } from 'vitest'
import { createReferenceAssemblyProvider } from '../../../../examples/runtime-reference/src/providers/assembly.js'
import {
  createReferenceAdmissionTickets,
  createReferenceMaintenancePackagePins,
  referenceTicketDecision as referenceDecision,
} from '../../../../examples/runtime-reference/src/providers/assembly-admission.js'
import {
  migrationAssemblyFixture,
  pairAssemblyFixture,
} from '../../../extension-api/testkit/runtime/contracts/assembly-cases.js'
import { fixtureHash, fixtureRef } from '../../../extension-api/testkit/runtime/contracts/assembly-fixture.js'
import {
  exerciseAssemblyPublication,
  upgradeAssemblyFixture,
} from '../../../extension-api/testkit/runtime/contracts/assembly-publish.js'
import {
  admissionTicketDecision,
  createAdmissionTickets,
} from '../../src/runtime/assembly/admission-ticket.js'
import { createMaintenancePackagePins } from '../../src/runtime/assembly/package-pins.js'
import { createAssemblyProvider } from '../../src/runtime/providers/assembly.js'
import {
  assemblyMaintenanceContext as context,
  maintenanceFixtureRecord,
  maintenancePayload,
  persistentAssemblyFixture,
} from './fixtures/assembly-maintenance.js'
import { assemblyTestBinding } from './fixtures/assembly-publish-binding.js'

const implementations = [
  {
    name: 'default' as const,
    create: createAssemblyProvider,
    tickets: createAdmissionTickets,
    pins: createMaintenancePackagePins,
    decision: admissionTicketDecision,
  },
  {
    name: 'reference' as const,
    create: createReferenceAssemblyProvider,
    tickets: createReferenceAdmissionTickets,
    pins: createReferenceMaintenancePackagePins,
    decision: referenceDecision,
  },
]
describe('persistent maintenance assembly', { timeout: 120_000 }, () => {
  const recipes = new Map<string, ReturnType<typeof upgradeAssemblyFixture>>()
  beforeAll(() => {
    for (const recipe of ['upgrade', 'joint', 'migration']) {
      const input = upgradeAssemblyFixture()
      if (recipe === 'joint') pairAssemblyFixture(input)
      if (recipe === 'migration') migrationAssemblyFixture(input)
      const freeze = (value: unknown): void => {
        if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
          Object.values(value).forEach(freeze)
          Object.freeze(value)
        }
      }
      freeze(input)
      recipes.set(recipe, input)
    }
  })
  const inputFor = (recipe = 'upgrade') => {
    const seed = recipes.get(recipe)
    if (!seed) throw new Error('maintenance recipe missing')
    return structuredClone(seed)
  }

  it.each(
    implementations.flatMap(({ name }) =>
      ['select', 'normal', 'deny', 'cancel', 'dispose'].map((scenario) => ({ name, scenario })),
    ),
  )('$name executes maintenance $scenario', async ({ name, scenario }) => {
    expect(
      (
        await exerciseAssemblyPublication(
          assemblyTestBinding(name),
          scenario as 'select' | 'normal' | 'deny' | 'cancel' | 'dispose',
        )
      ).passed,
    ).toBe(true)
  })
  it.each(
    implementations.flatMap((implementation) =>
      [
        'directory',
        'joint',
        'migration',
        'expiry',
        'authorization',
        'route',
        'pin',
        'release',
        'candidate',
        'cas',
      ].map((change) => ({ ...implementation, change })),
    ),
  )('$name rechecks $change before publish', async ({ create, pins, change }) => {
    const directory = mkdtempSync(join(tmpdir(), 'agnes-publish-refusal-')),
      input = inputFor(change === 'joint' || change === 'migration' ? change : 'upgrade')
    const fixture = await persistentAssemblyFixture(input, join(directory, 'maintenance.sqlite'))
    const subject = create(input, fixture.memory?.lifecycle, fixture.ports)
    try {
      const prepared = await subject.prepare({ graph: input.graph }, context())
      expect(prepared.ok).toBe(true)
      if (!prepared.ok) throw new Error(prepared.error.detailCode)
      const request = { candidateRef: prepared.value.candidateRef, expectedPublishedRevision: 1 }
      if (change === 'authorization') fixture.control.authorized = false
      if (change === 'expiry') fixture.control.now = '2040-01-01T00:00:00Z'
      if (change === 'directory')
        await fixture.updateHead((data) => {
          const head = data.directory as Record<string, unknown>
          head.locatorRevision = 2
        })
      if (change === 'joint')
        await fixture.updateHead((data) => {
          const domains = data.jointDomains as { revision: number }[]
          if (!domains[0]) throw new Error('joint fixture missing')
          domains[0].revision++
        })
      if (change === 'migration')
        await fixture.updateHead((data) => {
          const receipts = data.migrations as { receipt: { state: string } }[]
          if (!receipts[0]) throw new Error('migration fixture missing')
          receipts[0].receipt.state = 'aborted'
        })
      if (change === 'candidate') request.candidateRef = fixtureRef({ forged: true })
      if (change === 'release') {
        const record = fixture.database.get(`release:${input.plan.targetReleaseSet.releaseSetId}`)
        if (!record) throw new Error('release snapshot missing')
        const data = maintenancePayload(record)
        data.canonicalJson = `${data.canonicalJson} `
        expect(
          await fixture.ports.store.commit(
            {
              transactionId: 'fixture-alter-release',
              authority: fixture.ports.authority,
              expectedWriterEpoch: 1,
              outbox: [],
              mutations: [
                {
                  recordId: record.recordId,
                  expectedRevision: record.revision,
                  next: maintenanceFixtureRecord(
                    record.recordId,
                    'release-snapshot',
                    data,
                    record.revision + 1,
                  ),
                },
              ],
            },
            context(),
          ),
        ).toMatchObject({ ok: true })
        expect(
          await pins(fixture.ports).retain(
            {
              pinId: 'invalid-release-reader',
              releaseSetId: input.plan.targetReleaseSet.releaseSetId,
              ownerKind: 'reader',
              ownerId: 'reader',
            },
            context(),
          ),
        ).toMatchObject({ ok: false, error: { detailCode: 'release_digest_mismatch' } })
      }
      if (change === 'pin') {
        const pin = fixture.database.get(`pin:${input.plan.requiredPins[0]}`)
        if (!pin) throw new Error('pin missing')
        const payload = maintenancePayload(pin)
        payload.status = 'released'
        expect(
          await fixture.ports.store.commit(
            {
              transactionId: 'fixture-release-pin',
              authority: fixture.ports.authority,
              expectedWriterEpoch: 1,
              mutations: [
                {
                  recordId: pin.recordId,
                  expectedRevision: pin.revision,
                  next: maintenanceFixtureRecord(
                    pin.recordId,
                    'package-pin-receipt',
                    payload,
                    pin.revision + 1,
                  ),
                },
              ],
              outbox: [],
            },
            context(),
          ),
        ).toMatchObject({ ok: true })
      }
      if (change === 'route') {
        const route = fixture.database.get(`release-route:${input.plan.routeId}`)
        if (!route) throw new Error('route missing')
        expect(
          await fixture.ports.store.commit(
            {
              transactionId: 'fixture-new-route',
              authority: fixture.ports.authority,
              expectedWriterEpoch: 1,
              mutations: [
                {
                  recordId: route.recordId,
                  expectedRevision: route.revision,
                  next: maintenanceFixtureRecord(
                    route.recordId,
                    'release-route',
                    maintenancePayload(route),
                    route.revision + 1,
                  ),
                },
              ],
              outbox: [],
            },
            context(),
          ),
        ).toMatchObject({ ok: true })
      }
      const before = fixture.database.inspect()
      if (change === 'cas') {
        const commit = fixture.ports.store.commit.bind(fixture.ports.store)
        fixture.ports.store.commit = async (request, call) => {
          if (request.transactionId.startsWith('publish:'))
            await fixture.updateHead((data) => {
              const head = data.directory as Record<string, unknown>
              head.locatorRevision = 2
            })
          return commit(request, call)
        }
      }
      const result = await subject.publish(
        request,
        change === 'expiry' ? { ...context(), deadline: '2050-01-01T00:00:00Z' } : context(),
      )
      expect(result).toMatchObject({
        ok: false,
        error: {
          detailCode: (
            {
              directory: 'locator_route_stale',
              joint: 'joint_dispatch_stale',
              migration: 'prerequisite_migration_incomplete',
              expiry: 'plan_stale',
              authorization: 'maintenance_denied',
              route: 'plan_stale',
              pin: 'package_pin_missing',
              release: 'release_digest_mismatch',
              candidate: 'candidate_journal_mismatch',
              cas: 'maintenance_revision_mismatch',
            } as Record<string, string>
          )[change],
        },
      })
      const after = fixture.database.inspect()
      if (change === 'cas') {
        expect(after.records.filter((row) => row.recordId !== fixture.ports.headRecordId)).toEqual(
          before.records.filter((row) => row.recordId !== fixture.ports.headRecordId),
        )
        expect(after.outbox).toEqual(before.outbox)
        expect(after.transactions.filter((id) => !id.startsWith('fixture-head-change:'))).toEqual(
          before.transactions,
        )
      } else expect(after).toEqual(before)
      expect(fixture.current()?.staged).toBe(true)
    } finally {
      await subject.dispose()
      await fixture.close()
      rmSync(directory, { recursive: true, force: true })
    }
  })
  it('returns identical default/reference publication, ticket and pin results, refusing unfinished coordination', async () => {
    const traces: unknown[] = []
    for (const { create, tickets, pins, decision } of implementations) {
      const directory = mkdtempSync(join(tmpdir(), 'agnes-admission-ticket-')),
        input = inputFor()
      const fixture = await persistentAssemblyFixture(input, join(directory, 'maintenance.sqlite'))
      const subject = create(input, fixture.memory?.lifecycle, fixture.ports)
      try {
        const invalid = create({ ...input, fixture: {} }, fixture.memory?.lifecycle, fixture.ports)
        expect(
          await invalid.publish({ candidateRef: fixtureRef({}), expectedPublishedRevision: 1 }, context()),
        ).toMatchObject({ ok: false, error: { detailCode: 'schema_invalid' } })
        await invalid.dispose()
        const prepared = await subject.prepare({ graph: input.graph }, context())
        if (!prepared.ok) throw new Error(prepared.error.detailCode)
        expect(
          await subject.publish(
            { candidateRef: prepared.value.candidateRef, expectedPublishedRevision: 1 },
            context(),
          ),
        ).toMatchObject({ ok: true })
        const service = tickets(fixture.ports),
          pinService = pins(fixture.ports)
        const draft = {
          runKey: 'run-key',
          stateAuthorityRef: fixture.stateAuthorityRef,
          grantRef: 'fixture-authorization',
          admission: {
            ticketId: 'ticket',
            releaseSetId: input.plan.targetReleaseSet.releaseSetId,
            bindingId: 'binding',
            runId: 'run',
            sessionId: 'session',
            lane: 'main',
            workspaceId: 'workspace',
            input: fixtureRef({ prompt: 'synthetic' }),
            admittedAt: input.fixture.now,
            deadline: '2030-01-01T00:00:00Z',
            conversation: null,
          },
        }
        const releaseRecord = fixture.database.get(`release:${draft.admission.releaseSetId}`)
        const previousRelease = input.fixture.previousRelease
        if (!releaseRecord || !previousRelease) throw new Error('release identity fixture missing')
        const writeSnapshot = async (
          data: Record<string, unknown>,
          expectedRevision: number,
          suffix: string,
        ) => {
          expect(
            await fixture.ports.store.commit(
              {
                transactionId: `fixture-release-identity-${suffix}`,
                authority: fixture.ports.authority,
                expectedWriterEpoch: 1,
                outbox: [],
                mutations: [
                  {
                    recordId: releaseRecord.recordId,
                    expectedRevision,
                    next: maintenanceFixtureRecord(
                      releaseRecord.recordId,
                      'release-snapshot',
                      data,
                      expectedRevision + 1,
                    ),
                  },
                ],
              },
              context(),
            ),
          ).toMatchObject({ ok: true })
        }
        await writeSnapshot(
          { canonicalJson: jcs(previousRelease), contentDigest: fixtureHash(previousRelease) },
          releaseRecord.revision,
          'swap',
        )
        expect(await service.issue(draft, context())).toMatchObject({
          ok: false,
          error: { detailCode: 'release_digest_mismatch' },
        })
        await writeSnapshot(maintenancePayload(releaseRecord), releaseRecord.revision + 1, 'restore')
        const issued = await service.issue(draft, context())
        expect(issued.ok).toBe(true)
        const trace: unknown[] = [prepared, issued]
        if (!issued.ok) throw new Error(issued.error.detailCode)
        const admission = issued.value.admission
        const { fingerprint, ...body } = admission
        expect(fingerprint).toBe(fixtureHash(body))
        const before = fixture.database.inspect()
        expect(await service.issue(draft, context())).toEqual(issued)
        expect(fixture.database.inspect()).toEqual(before)
        expect(
          await service.issue({ ...draft, admission: { ...draft.admission, ticketId: 'other' } }, context()),
        ).toMatchObject({ ok: false, error: { detailCode: 'admission_ticket_conflict' } })
        expect(
          await service.issue(
            { ...draft, admission: { ...draft.admission, input: fixtureRef({ prompt: 'changed' }) } },
            context(),
          ),
        ).toMatchObject({ ok: false, error: { detailCode: 'admission_ticket_conflict' } })
        expect(await service.coordinate()).toMatchObject({
          ok: false,
          error: { detailCode: 'runtime_admission_unimplemented' },
        })
        expect(decision('issued', null)).toEqual({ next: 'probe-required', keepPin: true })
        expect(decision('cancelled', null).keepPin).toBe(true)
        const pin = {
            pinId: 'resource-reader',
            releaseSetId: draft.admission.releaseSetId,
            ownerKind: 'reader',
            ownerId: 'reader',
          },
          retained = await pinService.retain(pin, context())
        expect(retained.ok).toBe(true)
        expect(await pinService.retain(pin, context())).toEqual(retained)
        expect(await pinService.retain({ ...pin, ownerId: 'another' }, context())).toMatchObject({
          ok: false,
          error: { detailCode: 'package_pin_conflict' },
        })
        expect(await pinService.release()).toMatchObject({
          ok: false,
          error: { detailCode: 'package_pin_release_unimplemented' },
        })
        const activePins = await pinService.active(context())
        expect(activePins).toMatchObject({ ok: true })
        const query = fixture.ports.store.query
        try {
          for (const [change, code] of [
            ['digest', 'content_identity_mismatch'],
            ['shape', 'schema_invalid'],
            ['json-limit', 'schema_invalid'],
          ]) {
            fixture.ports.store.query = async (...args) => {
              const result = await query(...args)
              if (!result.ok || result.value.kind !== 'value') return result
              const reply = structuredClone(result.value)
              if (reply.output.kind !== 'inline') throw new Error('fixture inline reply missing')
              if (change === 'digest') reply.output.digest = 'a'.repeat(64)
              if (change === 'shape') Object.assign(reply, { unexpected: true })
              if (change === 'json-limit') reply.output.value = Array.from({ length: 10_001 }, () => 0)
              return { ok: true, value: reply }
            }
            const rejected = await pinService.active(context())
            expect(rejected).toMatchObject({ ok: false, error: { detailCode: code } })
            if (!rejected.ok) trace.push(rejected.error.detailCode)
          }
        } finally {
          fixture.ports.store.query = query
        }
        trace.push(retained, activePins)
        traces.push(trace)
        expect(
          await subject.drain(
            { releaseSetId: draft.admission.releaseSetId, deadline: context().deadline },
            context(),
          ),
        ).toMatchObject({ ok: false, error: { detailCode: 'persistent_pin_drain_unimplemented' } })
        fixture.control.authorized = false
        expect(await service.issue(draft, context())).toMatchObject({
          ok: false,
          error: { detailCode: 'maintenance_denied' },
        })
      } finally {
        await subject.dispose()
        await fixture.close()
        rmSync(directory, { recursive: true, force: true })
      }
    }
    expect(traces[0]).toEqual(traces[1])
  })
})
