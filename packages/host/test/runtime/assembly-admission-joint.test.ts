import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { expect, it } from 'vitest'
import { admissionFixtureInput } from '../../../extension-api/testkit/runtime/contracts/assembly-admission.js'
import { openJointAdmission } from './fixtures/assembly-admission-joint.js'
import { maintenancePayload } from './fixtures/assembly-maintenance.js'

it('uses original C14 contexts and State creation to arbitrate unproven absence, then replays the locked binding', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'agnes-joint-context-'))
  const fixture = await openJointAdmission(directory, admissionFixtureInput())
  try {
    const issued = await fixture.tickets.issue(fixture.draft(), fixture.context())
    if (!issued.ok) throw Error(issued.error.detailCode)
    expect(
      await fixture.store.probeAdmission(issued.value.admission.ticketId, fixture.context()),
    ).toMatchObject({ ok: false, error: { code: 'denied', detailCode: 'admission_absence_unproven' } })
    const result = await fixture.coordinator.coordinate(fixture.draft(), fixture.context())
    expect(result).toMatchObject({ ok: true, value: { state: 'created', runId: 'fixture-run-old' } })
    const snapshot = fixture.inspect()
    expect(snapshot.bindings.map((row) => JSON.parse(String(row.value_json)))).toEqual([fixture.binding])
    expect(await fixture.coordinator.coordinate(fixture.draft(), fixture.context())).toEqual(result)
    expect(await fixture.coordinator.confirm(issued.value.admission.ticketId, fixture.context())).toEqual(
      result,
    )
    expect(
      await fixture.coordinator.cancel(
        issued.value.admission.ticketId,
        issued.value.admission.fingerprint,
        fixture.context(),
      ),
    ).toEqual(result)
    expect(
      await fixture.store.createRun(
        { ...issued.value.admission, fingerprint: '0'.repeat(64) },
        fixture.context(),
      ),
    ).toMatchObject({ ok: false, error: { code: 'conflict', detailCode: 'idempotency_conflict' } })
    expect(
      await fixture.coordinator.coordinate({ ...fixture.draft(), runKey: 'changed' }, fixture.context()),
    ).toMatchObject({ ok: false, error: { detailCode: 'admission_ticket_conflict' } })
    expect(fixture.inspect()).toEqual(snapshot)
  } finally {
    await fixture.close()
    rmSync(directory, { recursive: true, force: true })
  }
})

it('retains the pin when C14 refuses a copied context and only a verified cancellation releases it', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'agnes-joint-cancel-'))
  const fixture = await openJointAdmission(directory, admissionFixtureInput())
  try {
    const issued = await fixture.tickets.issue(fixture.draft(), fixture.context())
    if (!issued.ok) throw Error(issued.error.detailCode)
    const before = fixture.inspect()
    expect(
      await fixture.coordinator.confirm(issued.value.admission.ticketId, { ...fixture.context() }),
    ).toMatchObject({ ok: false })
    expect(fixture.inspect()).toEqual(before)
    fixture.db
      .prepare('UPDATE runtime_admission_source_issued SET revoked=1 WHERE ticket_id=?')
      .run(issued.value.admission.ticketId)
    expect(await fixture.coordinator.coordinate(fixture.draft(), fixture.context())).toMatchObject({
      ok: false,
      error: { code: 'denied', detailCode: 'admission_source' },
    })
    expect(fixture.inspect().records).toEqual(before.records)
    expect(fixture.inspect().created).toHaveLength(0)
    expect(fixture.inspect().cancelled).toHaveLength(0)
    fixture.db
      .prepare('UPDATE runtime_admission_source_issued SET revoked=0 WHERE ticket_id=?')
      .run(issued.value.admission.ticketId)
    expect(
      await fixture.coordinator.cancel(issued.value.admission.ticketId, '0'.repeat(64), fixture.context()),
    ).toMatchObject({ ok: false, error: { detailCode: 'admission_ticket_conflict' } })
    expect(fixture.inspect()).toEqual(before)
    const cancelled = await fixture.coordinator.cancel(
      issued.value.admission.ticketId,
      issued.value.admission.fingerprint,
      fixture.context(),
    )
    expect(cancelled).toMatchObject({ ok: true, value: { state: 'cancelled' } })
    const snapshot = fixture.inspect()
    expect(snapshot.cancelled).toHaveLength(1)
    expect(snapshot.created).toHaveLength(0)
    expect(
      await fixture.store.cancelAdmission(issued.value.admission.ticketId, '0'.repeat(64), fixture.context()),
    ).toMatchObject({ ok: false, error: { code: 'conflict', detailCode: 'idempotency_conflict' } })
    expect(
      snapshot.records.filter((row) => row.recordId.startsWith('pin:')).map(maintenancePayload),
    ).toMatchObject([{ status: 'released' }])
    expect(await fixture.coordinator.coordinate(fixture.draft(), fixture.context())).toEqual(cancelled)
    expect(
      await fixture.coordinator.cancel(
        issued.value.admission.ticketId,
        issued.value.admission.fingerprint,
        fixture.context(),
      ),
    ).toEqual(cancelled)
    expect(fixture.inspect()).toEqual(snapshot)
    await fixture.coordinator.dispose()
    expect(
      await fixture.coordinator.confirm(issued.value.admission.ticketId, fixture.context()),
    ).toMatchObject({ ok: false, error: { detailCode: 'admission_disposed' } })
    expect(fixture.inspect()).toEqual(snapshot)
  } finally {
    await fixture.close()
    rmSync(directory, { recursive: true, force: true })
  }
})

it.each(['separate-file', 'separate-connection'] as const)(
  'refuses %s issuer installation with stable admission_source and no State writes',
  async (split) => {
    const directory = mkdtempSync(join(tmpdir(), 'agnes-joint-split-'))
    try {
      await expect(
        openJointAdmission(directory, admissionFixtureInput(), undefined, split),
      ).rejects.toMatchObject({ failure: { code: 'denied', detailCode: 'admission_source' } })
      const db = new DatabaseSync(join(directory, 'joint.sqlite'))
      const issuer = new DatabaseSync(
        join(directory, split === 'separate-file' ? 'maintenance.sqlite' : 'joint.sqlite'),
      )
      try {
        for (const table of [
          'runtime_admissions',
          'runtime_admission_tombstones',
          'runtime_admission_source_proofs',
        ])
          expect(db.prepare(`SELECT count(*) n FROM ${table}`).get()?.n).toBe(0)
        expect(issuer.prepare('SELECT count(*) n FROM runtime_admission_source_issued').get()?.n).toBe(0)
      } finally {
        issuer.close()
        db.close()
      }
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  },
)
