import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createReferenceAssemblyProvider } from '../../../../examples/runtime-reference/src/providers/assembly.js'
import {
  createReferenceAdmissionTickets,
  createReferenceMaintenancePackagePins,
} from '../../../../examples/runtime-reference/src/providers/assembly-admission.js'
import {
  type AssemblyFixture,
  fixtureRef,
} from '../../../../packages/extension-api/testkit/runtime/contracts/assembly-fixture.js'
import { createAdmissionTickets } from '../../../../packages/host/src/runtime/assembly/admission-ticket.js'
import { createMaintenancePackagePins } from '../../../../packages/host/src/runtime/assembly/package-pins.js'
import { createAssemblyProvider } from '../../../../packages/host/src/runtime/providers/assembly.js'
import {
  assemblyMaintenanceContext,
  persistentAssemblyFixture,
} from '../../../../packages/host/test/runtime/fixtures/assembly-maintenance.js'

// Test-only process boundary. No production service or startup registration.
const [providerId, directory, command, pauseAt] = process.argv.slice(2)
if (
  !directory ||
  !['default', 'reference'].includes(providerId ?? '') ||
  !['publish', 'ticket', 'replay', 'inspect', 'ticket-replay'].includes(command ?? '')
)
  throw new Error('Invalid assembly process fixture invocation')
const input = JSON.parse(readFileSync(join(directory, 'input.json'), 'utf8')) as AssemblyFixture
const checkpoint = async (transactionId: string, side: string) => {
  const stage = transactionId.split(':')[0]
  if (`${stage}-${side}` !== pauseAt) return
  process.send?.({ checkpoint: pauseAt, transactionId })
  await new Promise<void>((resolve) => {
    process.once('message', () => resolve())
  })
}
const fixture = await persistentAssemblyFixture(input, join(directory, 'maintenance.sqlite'), {
  lifecycle: command === 'publish' || command === 'ticket',
  beforeCommit: (request) => checkpoint(request.transactionId, 'before'),
  afterCommit: (request) => checkpoint(request.transactionId, 'after'),
})
const create = providerId === 'default' ? createAssemblyProvider : createReferenceAssemblyProvider
const provider = create(input, fixture.memory?.lifecycle, fixture.ports)
const tickets =
  providerId === 'default'
    ? createAdmissionTickets(fixture.ports)
    : createReferenceAdmissionTickets(fixture.ports)
const pins =
  providerId === 'default'
    ? createMaintenancePackagePins(fixture.ports)
    : createReferenceMaintenancePackagePins(fixture.ports)
try {
  let published: unknown = null,
    ticket: unknown = null
  if (command === 'publish' || command === 'ticket') {
    const prepared = await provider.prepare({ graph: input.graph }, assemblyMaintenanceContext())
    if (!prepared.ok) throw new Error(prepared.error.detailCode)
    const request = {
      candidateRef: prepared.value.candidateRef,
      expectedPublishedRevision: input.plan.expectedRouteRevision ?? 0,
    }
    writeFileSync(join(directory, 'request.json'), JSON.stringify(request), { mode: 0o600 })
    const result = await provider.publish(request, assemblyMaintenanceContext())
    published = result
    if (!result.ok) throw new Error(result.error.detailCode)
  }
  if (command === 'replay') {
    const request = JSON.parse(readFileSync(join(directory, 'request.json'), 'utf8'))
    published = await provider.publish(request, assemblyMaintenanceContext())
  }
  if (command === 'ticket') {
    const draft = {
      runKey: 'fixture-run-key',
      stateAuthorityRef: fixture.stateAuthorityRef,
      grantRef: 'fixture-authorization',
      admission: {
        ticketId: 'fixture-ticket',
        releaseSetId: input.plan.targetReleaseSet.releaseSetId,
        bindingId: 'fixture-run-binding',
        runId: 'fixture-run',
        sessionId: 'fixture-session',
        lane: 'main',
        workspaceId: 'fixture-workspace',
        input: fixtureRef({ prompt: 'synthetic input' }),
        admittedAt: input.fixture.now,
        deadline: '2030-01-01T00:00:00Z',
        conversation: null,
      },
    }
    writeFileSync(join(directory, 'ticket-draft.json'), JSON.stringify(draft), { mode: 0o600 })
    ticket = await tickets.issue(draft, assemblyMaintenanceContext())
  }
  if (command === 'ticket-replay') {
    const draft = JSON.parse(readFileSync(join(directory, 'ticket-draft.json'), 'utf8'))
    ticket = await tickets.issue(draft, assemblyMaintenanceContext())
  }
  const activePins = await pins.active(assemblyMaintenanceContext())
  process.stdout.write(
    JSON.stringify({ published, ticket, activePins, snapshot: fixture.database.inspect() }),
  )
} finally {
  await provider.dispose()
  await fixture.close()
}
