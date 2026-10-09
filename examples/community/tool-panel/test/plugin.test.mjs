import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createPluginTestRegistration } from '@agnes/host/testkit'
import { createPluginTestHost } from '@agnes/plugin-runtime/testkit'
import { main } from '../dist/index.js'

test('configured tool validates inputs, returns deterministic results and unregisters', async () => {
  const host = await createPluginTestHost(main, {
    registration: createPluginTestRegistration(),
    config: { prefix: 'Hello: ' },
  })
  try {
    const name = 'plugin_tool_panel'
    assert.deepEqual((await host.invoke(name, { message: '  Agnes  ' })).structured, {
      message: 'Hello: Agnes',
      characters: 5,
    })
    assert.equal((await host.invoke(name, { message: ' ' })).isError, true)
    await assert.rejects(host.invoke(name, { message: 1 }), /Invalid arguments/)
    const stop = new AbortController()
    stop.abort(new DOMException('Stopped', 'AbortError'))
    await assert.rejects(host.invoke(name, { message: 'Agnes' }, stop.signal), /Stopped/)
  } finally {
    await host.dispose()
  }
  assert.equal(host.tools.size, 0)
})

test('missing extension service and invalid config report useful author errors', async () => {
  assert.throws(() => main.apply({}), /Missing required service: extension/)
  await assert.rejects(
    createPluginTestHost(main, { registration: createPluginTestRegistration(), config: { prefix: 42 } }),
    /prefix must be a string/,
  )
})
