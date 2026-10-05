import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { auditContractDriver } from '../../../../packages/host/test/runtime/audit-conformance-fixture.js'

const [providerId, directory, mode] = process.argv.slice(2)
if (
  !directory ||
  (providerId !== 'default' && providerId !== 'reference') ||
  (mode !== 'hold' && mode !== 'once')
)
  throw new Error('Invalid Audit cold fixture arguments')
const driver = auditContractDriver(providerId === 'reference', { directory, retainOnClose: true })
const fixture = await driver.open()
const service = await fixture.factory.create(
  fixture.configuration,
  fixture.dependencies,
  fixture.factoryContext,
)
try {
  if (!service.control) throw new Error('Audit append method is absent')
  const database = new DatabaseSync(join(directory, 'owner.db'))
  let priorRows: number
  try {
    const countSql =
      providerId === 'default'
        ? 'SELECT COUNT(*) AS n FROM audit_rows'
        : "SELECT COUNT(*) AS n FROM facts WHERE tag='audit'"
    priorRows = Number((database.prepare(countSql).get() as { n: number }).n)
  } finally {
    database.close()
  }
  if (priorRows !== (mode === 'hold' ? 0 : 1))
    throw new Error('Original durable Audit row was not retained across process death')
  const result = await service.control(
    {
      target: {
        bindingId: fixture.factoryContext.bindingId,
        contract: 'agh.audit',
        logicalName: fixture.factory.descriptor.logicalName,
        providerId: fixture.factory.descriptor.providerId,
      },
      method: 'append',
      input: fixture.appendInput,
    },
    fixture.call,
  )
  if (!result.ok || result.value.kind !== 'inline') throw new Error('Audit durable append failed')
  process.stdout.write(`${JSON.stringify({ pid: process.pid, priorRows, result: result.value })}\n`)
  if (mode === 'hold') setInterval(() => {}, 1000)
} finally {
  if (mode === 'once') {
    await service.close('shutdown')
    await driver.close()
  }
}
