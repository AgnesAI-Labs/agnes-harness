// Starter contract: deterministic model output invokes a real registered tool.
export const scriptedToolTest = `import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createPluginTestHost, scriptedModel } from '@agnes/host/author-testkit'
import { main, echo } from '../src/index.ts'
test('scripted model invokes the plugin tool', async () => {
  const host = await createPluginTestHost(main)
  const scripted = scriptedModel([[{ type: 'toolcall_end', via: 'native', call: { toolUseId: 'echo-1', ordinal: 0, name: echo.name, args: { message: 'hello' } } }]])
  try {
    const request = { kind: 'inference', sessionKey: 'test', slot: 'primary', route: 'demo', model: 'demo', contractId: null, derivedHash: '0'.repeat(64), system: 'test', messages: [], tools: [] }
    for (const event of await scripted.model.complete(request, new AbortController().signal)) {
      if (event.type === 'toolcall_end') assert.deepEqual((await host.invoke(event.call.name, event.call.args)).structured, { message: 'hello' })
    }
    assert.equal(scripted.remaining, 0)
  } finally { await host.dispose() }
})
`
