import { createReferencePolicyFactory } from '../../../../examples/runtime-reference/src/providers/policy.js'
import { createDefaultPolicyFactory } from '../../../../packages/core/src/runtime/providers/policy.js'
import { createPolicyFixture } from '../../../../packages/core/test/runtime/policy-fixture.js'

const [providerId, directory, mode] = process.argv.slice(2)
if (
  !directory ||
  (providerId !== 'default' && providerId !== 'reference') ||
  (mode !== 'hold' && mode !== 'once')
)
  throw new Error('Invalid Policy cold fixture arguments')
const factory = providerId === 'default' ? createDefaultPolicyFactory : createReferencePolicyFactory
const fixture = createPolicyFixture(factory, providerId, { directory, retainOnFinish: true })
const service = await fixture.factory.create(fixture.config, fixture.dependencies, fixture.factoryContext)
try {
  if (!service.control || !service.compute) throw new Error('Policy methods are absent')
  const priorDecisions = fixture.decisions()
  if (priorDecisions !== (mode === 'hold' ? 0 : 1))
    throw new Error('Original durable Policy decision was not retained across process death')
  const result = await service.control(fixture.revoke, fixture.context)
  if (!result.ok || result.value.kind !== 'inline') throw new Error('Policy durable revoke failed')
  if (fixture.decisions() !== 1) throw new Error('Policy revoke did not retain one durable decision')
  const evaluation = await service.compute(fixture.evaluate, fixture.context)
  if (!evaluation.ok) throw new Error('Policy current evaluation failed')
  process.stdout.write(`${JSON.stringify({ pid: process.pid, priorDecisions, result: result.value })}\n`)
  if (mode === 'hold') setInterval(() => {}, 1000)
} finally {
  if (mode === 'once') {
    await service.close('shutdown')
    await fixture.finish()
  }
}
