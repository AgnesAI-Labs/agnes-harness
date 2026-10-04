import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { AdmissionFixtureInput } from './assembly-admission-fixture.js'
import { openJointAdmission } from './assembly-admission-joint.js'

const [directory, operation = 'coordinate', stop] = process.argv.slice(2)
if (!directory) throw Error('isolated directory required')
const input: AdmissionFixtureInput = JSON.parse(readFileSync(join(directory, 'input.json'), 'utf8'))
let paused = false
const fixture = await openJointAdmission(directory, input, (checkpoint) => {
  if (checkpoint !== stop || paused) return
  paused = true
  process.send?.({ checkpoint })
  if (stop === 'read:ticket' || stop === 'cancel:result')
    return new Promise<void>((resolve) => process.once('message', () => resolve()))
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0)
})
try {
  let result: unknown = null
  const ticketId = fixture.draft().admission.ticketId
  const issued = async () => {
    const reply = await fixture.tickets.issue(fixture.draft(), fixture.context())
    if (!reply.ok) throw Error(reply.error.detailCode)
    return reply.value.admission
  }
  if (stop === 'race-start') {
    process.send?.({ checkpoint: stop })
    await new Promise<void>((resolve) => process.once('message', () => resolve()))
  }
  if (operation === 'coordinate')
    result = await fixture.coordinator.coordinate(fixture.draft(), fixture.context())
  else if (operation === 'cancel') {
    const admission = await issued()
    result = await fixture.coordinator.cancel(ticketId, admission.fingerprint, fixture.context())
  } else if (operation === 'confirm-created' || operation === 'confirm-cancelled') {
    const admission = await issued()
    result =
      operation === 'confirm-created'
        ? await fixture.store.createRun(admission, fixture.context())
        : await fixture.store.cancelAdmission(ticketId, admission.fingerprint, fixture.context())
    if (result && typeof result === 'object' && 'ok' in result && result.ok !== true)
      throw Error(JSON.stringify(result))
    result = await fixture.coordinator.confirm(ticketId, fixture.context())
  } else if (operation === 'create-original') {
    const admission = await issued()
    result = await fixture.store.createRun(admission, fixture.context())
  } else if (operation !== 'inspect') throw Error('unknown fixture operation')
  process.stdout.write(JSON.stringify({ result, snapshot: fixture.inspect() }))
} finally {
  await fixture.close()
  process.disconnect?.()
}
