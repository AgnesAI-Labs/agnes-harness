import { readFileSync } from 'node:fs'
import { createReferenceContextFactory } from '../../../../examples/runtime-reference/src/providers/context.js'
import { createContextFactory } from '../../../../packages/core/src/runtime/providers/context.js'
import { contextFixtureData } from '../../../../packages/extension-api/testkit/runtime/contracts/context.js'
import { createTestServiceContainer } from '../../../../packages/extension-api/testkit/runtime/harness.js'
import { canonicalJsonDigest, type JsonValue } from '../../../../packages/protocol/src/runtime/index.js'

const [id, path, mode, currentPolicy] = process.argv.slice(2)
if (
  !path ||
  (id !== 'default' && id !== 'reference') ||
  (mode !== 'hold' && mode !== 'once') ||
  (currentPolicy !== 'allow' && currentPolicy !== 'deny')
)
  throw new Error('Invalid Context cold fixture arguments')
const data = contextFixtureData(id === 'default' ? 'agh.default/context' : 'reference/context')
// Bootstrap reads a saved fixture before creating the pure provider. Query performs no file IO.
const persisted = JSON.parse(readFileSync(path, 'utf8')) as {
  request: typeof data.request
  source: typeof data.source
}
// Current authority is an independent synthetic deployment choice, never saved in the input.
const allowed = currentPolicy === 'allow'
const sourceDigest = canonicalJsonDigest(persisted.source as unknown as JsonValue)
const factory = (id === 'default' ? createContextFactory : createReferenceContextFactory)({
  ...data,
  deployment: {
    capture: () => ({ ok: true, value: persisted.source }),
    checkCurrent: () => allowed,
    sourceCurrent: (source) =>
      allowed && canonicalJsonDigest(source as unknown as JsonValue) === sourceDigest,
  },
})
const provider = await factory.create(
  data.config,
  createTestServiceContainer().dependencies,
  data.factoryContext,
)
const ready = await provider.ready(data.context)
if (!provider.query) throw new Error('Context query handler absent')
const reply = ready.ok ? await provider.query(persisted.request, data.context) : ready
process.stdout.write(`${JSON.stringify({ pid: process.pid, reply })}\n`)
if (mode === 'hold') setInterval(() => {}, 1000)
else await provider.close('shutdown')
