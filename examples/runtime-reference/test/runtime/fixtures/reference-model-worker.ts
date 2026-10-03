import { existsSync } from 'node:fs'
import { referenceModelFixture } from '../reference-model-fixture.js'

const endpoint = process.argv[2],
  receipt = process.argv[3]
if (!endpoint || !receipt || !process.send) throw new Error('Fixture owner arguments missing')
// This fixed private IPC channel drives a restricted fixture owner; payloads cannot issue identity.
const fixture = await referenceModelFixture(endpoint, receipt)
process.on('message', async (message) => {
  const command = message as { id?: unknown; op?: unknown }
  if (typeof command.id !== 'number') return
  try {
    if (command.op === 'execute') {
      if (existsSync(receipt)) throw new Error('Completed fixture attempt cannot resend')
      const result = await fixture.action.execute(fixture.frame, fixture.call)
      process.send?.({ id: command.id, result, pid: process.pid })
    } else if (command.op === 'reconcile') {
      const result = await fixture.action.reconcile(fixture.frame, [], fixture.call)
      process.send?.({ id: command.id, result, pid: process.pid })
    } else {
      process.send?.({ id: command.id, error: 'Unknown fixture command', pid: process.pid })
    }
  } catch {
    process.send?.({ id: command.id, error: 'Fixture operation refused', pid: process.pid })
  }
})
process.send({ ready: true, pid: process.pid })
