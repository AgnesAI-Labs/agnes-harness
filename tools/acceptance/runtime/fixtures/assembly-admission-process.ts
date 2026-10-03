import { once } from 'node:events'
import { admissionFixtureInput } from '../../../../packages/extension-api/testkit/runtime/contracts/assembly-admission.js'
import { openAdmissionFixture } from '../../../../packages/host/test/runtime/fixtures/assembly-admission-fixture.js'
import {
  assemblyMaintenanceContext,
  maintenancePayload,
} from '../../../../packages/host/test/runtime/fixtures/assembly-maintenance.js'

const [provider, directory, operation = 'coordinate', killPoint] = process.argv.slice(2)
if ((provider !== 'default' && provider !== 'reference') || !directory)
  throw new Error('fixture arguments missing')
let armed = operation !== 'parameters'
const fixture = await openAdmissionFixture(directory, provider, admissionFixtureInput(), async (point) => {
  if (!armed || point !== killPoint) return
  process.send?.({ checkpoint: point })
  await new Promise<void>(() => {
    setInterval(() => {}, 1_000)
  })
})
const ctx = assemblyMaintenanceContext()
if (killPoint === 'race-start') {
  process.send?.({ checkpoint: 'race-start' })
  await once(process, 'message')
}
try {
  const draft = fixture.draft()
  let result: Awaited<ReturnType<typeof fixture.coordinator.coordinate>> | null
  if (operation === 'cancel' || operation === 'confirm-created' || operation === 'confirm-cancelled') {
    const issued = await fixture.tickets.issue(draft, ctx)
    if (!issued.ok) throw new Error(issued.error.detailCode)
    if (operation === 'cancel')
      result = await fixture.coordinator.cancel(
        draft.admission.ticketId,
        issued.value.admission.fingerprint,
        ctx,
      )
    else {
      const terminal =
        operation === 'confirm-created'
          ? await fixture.state.ports.store.createRun(issued.value.admission, ctx)
          : await fixture.state.ports.store.cancelAdmission(
              draft.admission.ticketId,
              issued.value.admission.fingerprint,
              ctx,
            )
      if (!terminal.ok) throw new Error(terminal.error.detailCode)
      result = await fixture.coordinator.confirm(draft.admission.ticketId, ctx)
    }
  } else if (operation === 'parameters') {
    const old = await fixture.coordinator.coordinate(draft, ctx)
    if (!old.ok) throw new Error(old.error.detailCode)
    await fixture.switchRoute()
    const pending = await fixture.coordinator.submitSessionControl(
      {
        sessionId: 'fixture-session',
        requestId: 'fixture-preset-change',
        expectedRevision: 1,
        command: {
          kind: 'set-preset',
          presetId: fixture.input.configuration.preset.id,
          presetDigest: fixture.input.configuration.presetDigest,
          apply: 'next-run',
        },
      },
      ctx,
    )
    if (!pending.ok) throw new Error(pending.error.detailCode)
    armed = true
    result = await fixture.coordinator.coordinate(fixture.draft('new'), ctx)
  } else if (operation === 'inspect') result = null
  else if (operation === 'probe') result = await fixture.coordinator.probe(draft.admission.ticketId, ctx)
  else result = await fixture.coordinator.coordinate(draft, ctx)
  const state = fixture.state.inspect()
  const snapshot = {
    runs: state.runs,
    pins: fixture.maintenance.database
      .inspect()
      .records.filter((row) => row.recordId.startsWith('pin:admission:'))
      .map((row) => {
        const pin = maintenancePayload(row)
        return { ticketId: String(pin.ownerId), status: String(pin.status) }
      }),
  }
  const control = await fixture.coordinator.sessionControlStatus(
    'fixture-session',
    'fixture-preset-change',
    ctx,
  )
  process.stdout.write(
    JSON.stringify({
      result,
      snapshot,
      state,
      control,
      maintenance: {
        ...fixture.maintenance.database.inspect(),
        records: fixture.maintenance.database
          .inspect()
          .records.filter(
            (row) => row.recordId.startsWith('ticket:') || row.recordId.startsWith('pin:admission:'),
          ),
      },
    }),
  )
} finally {
  await fixture.close()
}
