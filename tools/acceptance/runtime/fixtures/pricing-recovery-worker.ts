import { canonicalJsonDigest, validateRuntime } from '../../../../packages/protocol/src/runtime/index.js'
import { createPricingContractFixture } from './pricing.js'

const [kind, databasePath, phase, providerId] = process.argv.slice(2)
if ((kind !== 'default' && kind !== 'reference') || !databasePath || (phase !== 'hold' && phase !== 'read'))
  throw Error('Invalid pricing recovery worker invocation')

const fixture = createPricingContractFixture(kind, {
  databasePath,
  reopen: true,
  ...(providerId === undefined ? {} : { providerId }),
})
const service = await fixture.factory.create(fixture.config, fixture.dependencies, fixture.factoryContext)
try {
  const ready = await service.ready(fixture.context)
  if (!ready.ok) throw Error('Recovered pricing service not ready')
  if (!service.compute) throw Error('Recovered pricing compute absent')
  const quote = await service.compute(fixture.request, fixture.context)
  if (!quote.ok) throw Error(`Recovered pricing quote rejected: ${quote.error.detailCode}`)
  if (!process.send) throw Error('Recovery worker requires IPC')
  const catalog = validateRuntime('JsonValue', fixture.prices())
  if (!catalog.ok) throw Error('Recovered pricing catalog invalid')
  process.send({
    pid: process.pid,
    input: fixture.request.input,
    output: quote.value,
    catalogDigest: canonicalJsonDigest(catalog.value),
  })
  if (phase === 'hold')
    await new Promise(() => {
      setInterval(() => {}, 1000)
    })
} finally {
  if (phase === 'read') {
    await service.close('shutdown')
    await fixture.finish()
  }
}
